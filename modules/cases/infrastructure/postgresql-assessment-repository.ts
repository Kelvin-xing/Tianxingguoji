import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type {
  AssessmentCompletionResult,
  AssessmentRepository,
  AssessmentSnapshot,
  StoredAssessmentAnswer,
  UpdateAssessmentAnswerResult,
} from "../application/assessment-service.ts";
import { AssessmentServiceError } from "../application/assessment-service.ts";
import type { AssessmentStatus, K12ManifestComposition } from "../domain/contract.ts";
import { resolveAssessmentSchema } from "../domain/schema-resolver.ts";
import type { PostgreSqlAdapter, PostgreSqlTransaction } from "./postgresql.ts";
import { getApprovedK12Catalogue } from "./approved-k12-catalogue.ts";

interface AssessmentHeaderRow extends Record<string, unknown> {
  assessment_id: string;
  manifest_id: string;
  assessment_status: AssessmentStatus;
  assessment_record_version: number | string;
  manifest_status: "candidate" | "approved" | "retired";
  application_type: string;
  composition_version: string;
  primary_user_id: string;
  case_stage: string;
  case_workflow_status: string;
  student_status: string;
  base_module_id: string;
  base_module_version: string;
  education_stage_module_id: string;
  education_stage_module_version: string;
  school_system_module_id: string;
  school_system_module_version: string;
  admission_route_module_id: string;
  admission_route_module_version: string;
  access_mode: "full" | "education_profile";
  access_can_edit: boolean;
  access_can_complete_background: boolean;
}

interface ManifestFieldRow extends Record<string, unknown> {
  module_layer: "base" | "education_stage" | "school_system" | "admission_route";
  module_id: string;
  module_version: string;
  field_id: string;
  value_type: string;
  visibility: string;
  blocking_stages: unknown;
}

interface AnswerRow extends Record<string, unknown> {
  id: string;
  field_id: string;
  semantic_state: StoredAssessmentAnswer["semanticState"];
  value_json: StoredAssessmentAnswer["value"];
  value_type: string | null;
  record_version: number | string;
}

interface IdempotencyRow extends Record<string, unknown> {
  request_hash: string;
  state: string;
  result_reference: string | null;
  response_hash: string | null;
}

export class PostgresqlAssessmentRepository implements AssessmentRepository {
  private readonly database: PostgreSqlAdapter;

  constructor(database: PostgreSqlAdapter) {
    this.database = database;
  }

  readCaseAssessment(input: Parameters<AssessmentRepository["readCaseAssessment"]>[0]) {
    return this.database.transaction(input, async (transaction) => {
      const header = await readAuthorizedHeader(transaction, input, false, "read");
      const fields = await readManifestFields(transaction, header.manifest_id);
      const manifest = resolvePinnedManifest(header, fields);
      const canonicalSchema = resolveAssessmentSchema({
        manifestId: header.manifest_id,
        manifest,
      });
      const visibleFieldIds = canonicalSchema.fields
        .filter((field) => header.access_mode === "full" ||
          field.moduleId === "k12-education-profile")
        .map((field) => field.fieldId);
      const answers = await transaction.query<AnswerRow>(
        `SELECT id, field_id, semantic_state, value_json, value_type, record_version
           FROM cases_assessment_answers
          WHERE assessment_id = $1 AND manifest_id = $2
            AND field_id = ANY($3::text[])
          ORDER BY field_id`,
        [header.assessment_id, header.manifest_id, visibleFieldIds],
      );
      return Object.freeze({
        assessmentId: header.assessment_id,
        manifestId: header.manifest_id,
        recordVersion: Number(header.assessment_record_version),
        status: header.assessment_status,
        manifestStatus: header.manifest_status,
        manifest,
        answers: projectAnswersInCanonicalOrder(answers.rows, visibleFieldIds),
        access: Object.freeze({
          mode: header.access_mode,
          canEdit: header.access_can_edit,
          editableFieldIds: Object.freeze(header.access_can_edit ? visibleFieldIds : []),
          canCompleteBackground: header.access_can_complete_background,
        }),
      }) satisfies AssessmentSnapshot;
    });
  }

  updateAssessmentAnswer(input: Parameters<AssessmentRepository["updateAssessmentAnswer"]>[0]) {
    return this.database.transaction(input, async (transaction) => {
      const idempotency = await claimIdempotency(transaction, {
        ...input,
        operation: "cases.assessment_answer.update",
      });
      const header = await readAuthorizedHeader(transaction, input, true, "write");
      if (header.assessment_id !== input.assessmentId || header.manifest_id !== input.manifestId) {
        throw new AssessmentServiceError("ASSESSMENT_CASE_NOT_FOUND");
      }
      if (!header.access_can_edit) {
        throw new AssessmentServiceError("ASSESSMENT_CASE_NOT_FOUND");
      }
      const current = await transaction.query<AnswerRow>(
        `SELECT id, field_id, semantic_state, value_json, value_type, record_version
           FROM cases_assessment_answers
          WHERE assessment_id = $1 AND field_id = $2
          FOR UPDATE`,
        [header.assessment_id, input.field.fieldId],
      );
      const fields = await readManifestFields(transaction, header.manifest_id, true);
      resolvePinnedManifest(header, fields);
      const storedField = fields.find((field) => field.field_id === input.field.fieldId);
      if (!storedField || !sameField(storedField, input.field)) {
        throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
      }
      if (header.access_mode === "education_profile" &&
          storedField.module_id !== "k12-education-profile") {
        throw new AssessmentServiceError("ASSESSMENT_CASE_NOT_FOUND");
      }
      if (!idempotency.claimed) {
        return replayAcknowledgement(
          idempotency.resultReference,
          idempotency.responseHash,
          "ASSESSMENT_ANSWER_IDEMPOTENCY_IN_PROGRESS",
        );
      }
      const prior = current.rows[0];
      const currentVersion = prior ? Number(prior.record_version) : 0;
      if (currentVersion !== input.expectedRecordVersion) {
        throw new AssessmentServiceError("ASSESSMENT_ANSWER_STALE_VERSION", {
          currentRecordVersion: currentVersion,
        });
      }

      let saved: AnswerRow | undefined;
      if (prior) {
        const result = await transaction.query<AnswerRow>(
          `UPDATE cases_assessment_answers
              SET semantic_state = $3, value_json = $4::jsonb, value_type = $5,
                  source = 'advisor_input', visibility = $6, updated_by_user_id = $7,
                  record_version = record_version + 1,
                  updated_at = to_timestamp($8 / 1000.0)
            WHERE id = $1 AND assessment_id = $2 AND record_version = $9
          RETURNING id, field_id, semantic_state, value_json, value_type, record_version`,
          [prior.id, header.assessment_id, input.semanticState,
            input.value === null ? null : JSON.stringify(input.value), input.valueType,
            input.field.visibility, input.actorUserId, input.updatedAtMs,
            input.expectedRecordVersion],
        );
        saved = result.rows[0];
      } else {
        const result = await transaction.query<AnswerRow>(
          `INSERT INTO cases_assessment_answers
            (id, organization_id, assessment_id, manifest_id, module_layer, module_id,
             module_version, field_id, semantic_state, value_json, value_type, source,
             visibility, is_derived, updated_by_user_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'advisor_input',$12,false,$13,
             to_timestamp($14 / 1000.0),to_timestamp($14 / 1000.0))
           RETURNING id, field_id, semantic_state, value_json, value_type, record_version`,
          [input.answerId, input.organizationId, header.assessment_id, header.manifest_id,
            input.field.layer, input.field.moduleId, input.field.moduleVersion,
            input.field.fieldId, input.semanticState,
            input.value === null ? null : JSON.stringify(input.value), input.valueType,
            input.field.visibility, input.actorUserId, input.updatedAtMs],
        );
        saved = result.rows[0];
      }
      if (!saved) {
        throw new AssessmentServiceError("ASSESSMENT_ANSWER_STALE_VERSION", {
          currentRecordVersion: currentVersion,
        });
      }
      await appendAtomicMutationEffects(transaction, input.effects);
      await completeIdempotency(transaction, {
        ...input,
        operation: "cases.assessment_answer.update",
        resultReference: acknowledgementReference(header.assessment_id, Number(saved.record_version)),
        responseHash: acknowledgementHash(header.assessment_id, Number(saved.record_version)),
      });
      return toUpdateResult(header.assessment_id, saved);
    });
  }

  completeBackgroundCollection(
    input: Parameters<AssessmentRepository["completeBackgroundCollection"]>[0],
  ) {
    return this.database.transaction(input, async (transaction) => {
      const idempotency = await claimIdempotency(transaction, {
        ...input,
        operation: "cases.assessment.background_complete",
      });
      const header = await readAuthorizedHeader(transaction, input, true, "write");
      if (header.assessment_id !== input.assessmentId || header.manifest_id !== input.manifestId) {
        throw new AssessmentServiceError("ASSESSMENT_CASE_NOT_FOUND");
      }
      if (!header.access_can_complete_background) {
        throw new AssessmentServiceError("ASSESSMENT_CASE_NOT_FOUND");
      }
      const fields = await readManifestFields(transaction, header.manifest_id, true);
      resolvePinnedManifest(header, fields);
      const databaseRequired = fields
        .filter((field) => blockingStages(field.blocking_stages).includes("background_complete"))
        .map((field) => field.field_id)
        .sort();
      if (databaseRequired.join("\0") !== [...input.requiredBlockingFieldIds].sort().join("\0")) {
        throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
      }

      if (!idempotency.claimed) {
        return replayAcknowledgement(
          idempotency.resultReference,
          idempotency.responseHash,
          "ASSESSMENT_STATUS_IDEMPOTENCY_IN_PROGRESS",
        );
      }
      if (header.assessment_status !== "draft") {
        throw new AssessmentServiceError("ASSESSMENT_STATUS_INVALID");
      }
      const currentVersion = Number(header.assessment_record_version);
      if (currentVersion !== input.expectedRecordVersion) {
        throw new AssessmentServiceError("ASSESSMENT_STATUS_STALE_VERSION", {
          currentRecordVersion: currentVersion,
        });
      }
      const missing = await transaction.query<{ field_id: string } & Record<string, unknown>>(
        `SELECT field_id
           FROM cases_lock_assessment_background_blockers($1,$2)`,
        [header.assessment_id, header.manifest_id],
      );
      if (missing.rowCount > 0) {
        throw new AssessmentServiceError("ASSESSMENT_STATUS_BLOCKERS_INCOMPLETE", {
          missingFieldIds: missing.rows.map((row) => row.field_id),
        });
      }
      const updated = await transaction.query<{
        id: string;
        status: "background_complete";
        record_version: number | string;
      } & Record<string, unknown>>(
        `UPDATE cases_assessments
            SET status = 'background_complete', record_version = record_version + 1,
                updated_at = to_timestamp($3 / 1000.0)
          WHERE id = $1 AND record_version = $2 AND status = 'draft'
          RETURNING id, status, record_version`,
        [header.assessment_id, input.expectedRecordVersion, input.completedAtMs],
      );
      const row = updated.rows[0];
      if (!row) {
        throw new AssessmentServiceError("ASSESSMENT_STATUS_STALE_VERSION", {
          currentRecordVersion: currentVersion,
        });
      }
      await appendAtomicMutationEffects(transaction, input.effects);
      await completeIdempotency(transaction, {
        ...input,
        operation: "cases.assessment.background_complete",
        resultReference: acknowledgementReference(row.id, Number(row.record_version)),
        responseHash: acknowledgementHash(row.id, Number(row.record_version)),
      });
      return Object.freeze({
        id: row.id,
        recordVersion: Number(row.record_version),
      }) satisfies AssessmentCompletionResult;
    });
  }
}

function projectAnswersInCanonicalOrder(
  rows: readonly AnswerRow[],
  visibleFieldIds: readonly string[],
): readonly StoredAssessmentAnswer[] {
  const byFieldId = new Map(rows.map((row) => [row.field_id, row]));
  return Object.freeze(visibleFieldIds.flatMap((fieldId) => {
    const row = byFieldId.get(fieldId);
    return row ? [toStoredAnswer(row)] : [];
  }));
}

async function readAuthorizedHeader(
  transaction: PostgreSqlTransaction,
  input: {
    readonly caseId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
  },
  lock: boolean,
  capability: "read" | "write",
): Promise<AssessmentHeaderRow> {
  if (lock) {
    const aggregate = await transaction.query(
      `SELECT service_case.id
         FROM cases_service_cases AS service_case
         JOIN crm_students AS student
           ON student.id = service_case.student_id
          AND student.organization_id = service_case.organization_id
        WHERE service_case.id = $1
        FOR UPDATE OF service_case
        FOR SHARE OF student`,
      [input.caseId],
    );
    if (aggregate.rowCount !== 1) {
      throw new AssessmentServiceError("ASSESSMENT_CASE_NOT_FOUND");
    }
  }
  const result = await transaction.query<AssessmentHeaderRow>(
    `SELECT assessment.id AS assessment_id, assessment.manifest_id,
            assessment.status AS assessment_status,
            assessment.record_version AS assessment_record_version,
            manifest.status AS manifest_status, manifest.application_type,
            manifest.composition_version,
            service_case.primary_user_id, service_case.stage AS case_stage,
            service_case.workflow_status AS case_workflow_status,
            student.status AS student_status,
            manifest.base_module_id, manifest.base_module_version,
            manifest.education_stage_module_id, manifest.education_stage_module_version,
            manifest.school_system_module_id, manifest.school_system_module_version,
            manifest.admission_route_module_id, manifest.admission_route_module_version
       FROM cases_service_cases AS service_case
       JOIN cases_assessments AS assessment
         ON assessment.service_case_id = service_case.id
        AND assessment.organization_id = service_case.organization_id
       JOIN crm_students AS student
         ON student.id = service_case.student_id
        AND student.organization_id = service_case.organization_id
       JOIN LATERAL cases_read_bound_assessment_manifest(assessment.manifest_id) AS manifest
         ON true
      WHERE service_case.id = $1
      ${lock ? "FOR UPDATE OF assessment" : ""}`,
    [input.caseId],
  );
  const header = result.rows[0];
  if (!header) throw new AssessmentServiceError("ASSESSMENT_CASE_NOT_FOUND");

  const role = await transaction.query<{
    role: "founder" | "admin" | "advisor";
    is_primary: boolean;
  } & Record<string, unknown>>(
    `SELECT role_binding.role, ($2::text = 'advisor' AND $3::uuid = $1::uuid) AS is_primary
       FROM access_role_bindings AS role_binding
       JOIN access_organization_memberships AS membership
         ON membership.id = role_binding.membership_id
        AND membership.organization_id = role_binding.organization_id
       JOIN identity_users AS identity_user
         ON identity_user.id = role_binding.user_id
        AND identity_user.status = 'active'
       JOIN access_organizations AS organization
         ON organization.id = role_binding.organization_id
        AND organization.status = 'active'
      WHERE role_binding.user_id = $1::uuid AND role_binding.role::text = $2::text
        AND role_binding.status = 'active' AND membership.status = 'active'
        AND (($2::text IN ('founder','admin') AND $4::text = 'read')
          OR ($2::text = 'advisor' AND $3::uuid = $1::uuid))
      LIMIT 1
      FOR SHARE OF role_binding, membership, identity_user, organization`,
    [input.actorUserId, input.actorRole, header.primary_user_id, capability],
  );
  const direct = role.rows[0];
  if (direct) {
    const canEdit = direct.role === "advisor" && direct.is_primary &&
      isAssessmentWriteBoundaryActive(header);
    return Object.assign(header, {
      access_mode: "full" as const,
      access_can_edit: canEdit,
      access_can_complete_background: canEdit && header.case_stage === "background_collection",
    });
  }

  if (input.actorRole !== "advisor") {
    throw new AssessmentServiceError("ASSESSMENT_CASE_NOT_FOUND");
  }
  const collaborator = await transaction.query<{
    capability: "view" | "edit";
  } & Record<string, unknown>>(
    `SELECT scope_grant.capability
       FROM access_case_collaborators AS collaborator
       JOIN access_scope_grants AS scope_grant
         ON scope_grant.collaborator_id = collaborator.id
        AND scope_grant.organization_id = collaborator.organization_id
        AND scope_grant.case_id = collaborator.case_id
       JOIN access_role_bindings AS role_binding
         ON role_binding.id = collaborator.advisor_role_binding_id
        AND role_binding.organization_id = collaborator.organization_id
        AND role_binding.user_id = collaborator.user_id
        AND role_binding.role = 'advisor'
       JOIN access_organization_memberships AS membership
         ON membership.id = collaborator.membership_id
        AND membership.organization_id = collaborator.organization_id
        AND membership.user_id = collaborator.user_id
       JOIN identity_users AS identity_user
         ON identity_user.id = collaborator.user_id
        AND identity_user.status = 'active'
       JOIN access_organizations AS organization
         ON organization.id = collaborator.organization_id
        AND organization.status = 'active'
      WHERE collaborator.case_id = $1
        AND collaborator.user_id = $2
        AND collaborator.status = 'active'
        AND collaborator.starts_at <= transaction_timestamp()
        AND collaborator.expires_at > transaction_timestamp()
        AND scope_grant.scope = 'education_profile'
        AND scope_grant.status = 'active'
        AND scope_grant.starts_at <= transaction_timestamp()
        AND scope_grant.expires_at > transaction_timestamp()
        AND scope_grant.capability IN ('view','edit')
        AND role_binding.status = 'active'
        AND membership.status = 'active'
        AND ($3::text = 'read' OR scope_grant.capability = 'edit')
      ORDER BY scope_grant.capability
      FOR SHARE OF collaborator, scope_grant, role_binding, membership,
        identity_user, organization`,
    [input.caseId, input.actorUserId, capability],
  );
  if (collaborator.rowCount === 0) {
    throw new AssessmentServiceError("ASSESSMENT_CASE_NOT_FOUND");
  }
  const canEdit = collaborator.rows.some((row) => row.capability === "edit");
  return Object.assign(header, {
    access_mode: "education_profile" as const,
    access_can_edit: canEdit && isAssessmentWriteBoundaryActive(header),
    access_can_complete_background: false,
  });
}

function isAssessmentWriteBoundaryActive(header: AssessmentHeaderRow): boolean {
  return header.student_status === "active" &&
    header.case_workflow_status === "active" &&
    ["background_collection", "school_selection_confirmed", "application_in_progress"]
      .includes(header.case_stage);
}

async function readManifestFields(
  transaction: PostgreSqlTransaction,
  manifestId: string,
  lock = false,
): Promise<readonly ManifestFieldRow[]> {
  if (lock) {
    const manifest = await transaction.query(
      `SELECT id FROM cases_schema_manifests WHERE id = $1 AND status = 'approved' FOR SHARE`,
      [manifestId],
    );
    if (manifest.rowCount !== 1) {
      throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
    }
  }
  const result = await transaction.query<ManifestFieldRow>(
    `SELECT module_layer, module_id, module_version, field_id, value_type,
            visibility, blocking_stages
       FROM cases_read_bound_assessment_manifest_fields($1)`,
    [manifestId],
  );
  return result.rows;
}

function resolvePinnedManifest(
  header: AssessmentHeaderRow,
  fields: readonly ManifestFieldRow[],
): K12ManifestComposition {
  const catalogue = getApprovedK12Catalogue();
  if (header.application_type !== "k12") {
    throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
  }
  const references = new Map([
    ["base", [header.base_module_id, header.base_module_version]],
    ["education_stage", [header.education_stage_module_id, header.education_stage_module_version]],
    ["school_system", [header.school_system_module_id, header.school_system_module_version]],
    ["admission_route", [header.admission_route_module_id, header.admission_route_module_version]],
  ]);
  if (catalogue.modules.some((module) => {
    const reference = references.get(module.layer);
    return reference?.[0] !== module.moduleId || reference?.[1] !== module.version;
  })) {
    throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
  }
  if (fields.length !== catalogue.fields.length) {
    throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
  }
  const expectedFields = catalogue.modules.flatMap((module) =>
    module.fields.map((field) => ({
      ...field,
      layer: module.layer,
      moduleId: module.moduleId,
      moduleVersion: module.version,
    })),
  );
  for (const field of fields) {
    const expected = expectedFields.find((candidate) => candidate.fieldId === field.field_id);
    if (!expected || !sameField(field, expected)) {
      throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
    }
  }
  return catalogue;
}

function sameField(
  stored: ManifestFieldRow,
  expected: {
    readonly fieldId: string;
    readonly layer: string;
    readonly moduleId?: string;
    readonly moduleVersion?: string;
    readonly valueType: string;
    readonly visibility: string;
    readonly blockingStages: readonly string[];
  },
): boolean {
  const storedBlockers = blockingStages(stored.blocking_stages);
  const expectedBlockers = expected.blockingStages.map(toStoredBlockerStage).sort();
  return stored.field_id === expected.fieldId &&
    stored.module_layer === expected.layer &&
    stored.module_id === expected.moduleId &&
    stored.module_version === expected.moduleVersion &&
    stored.value_type === expected.valueType &&
    stored.visibility === expected.visibility &&
    storedBlockers.join("\0") === expectedBlockers.join("\0");
}

function toStoredBlockerStage(stage: string): string {
  if (stage === "background_collection") return "background_complete";
  if (stage === "school_selection_confirmed") return "selection_ready";
  throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
}

function blockingStages(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
  }
  return Object.freeze([...value].sort());
}

function toStoredAnswer(row: AnswerRow): StoredAssessmentAnswer {
  return Object.freeze({
    id: row.id,
    fieldId: row.field_id,
    semanticState: row.semantic_state,
    value: row.value_json,
    valueType: row.value_type,
    recordVersion: Number(row.record_version),
  });
}

function toUpdateResult(assessmentId: string, row: AnswerRow): UpdateAssessmentAnswerResult {
  return Object.freeze({
    id: assessmentId,
    recordVersion: Number(row.record_version),
  });
}

function acknowledgementReference(id: string, recordVersion: number): string {
  return `${id}:${recordVersion}`;
}

function acknowledgementHash(id: string, recordVersion: number): string {
  return hashRequestPayload({ id, record_version: recordVersion });
}

function replayAcknowledgement(
  reference: string | null,
  responseHash: string | null,
  errorCode:
    | "ASSESSMENT_ANSWER_IDEMPOTENCY_IN_PROGRESS"
    | "ASSESSMENT_STATUS_IDEMPOTENCY_IN_PROGRESS",
): Readonly<{ id: string; recordVersion: number }> {
  const match = reference?.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([1-9][0-9]*)$/i,
  );
  if (!match) throw new AssessmentServiceError(errorCode);
  const id = match[1]!;
  const recordVersion = Number(match[2]);
  if (!Number.isSafeInteger(recordVersion) ||
      responseHash !== acknowledgementHash(id, recordVersion)) {
    throw new AssessmentServiceError(errorCode);
  }
  return Object.freeze({ id, recordVersion });
}

async function claimIdempotency(
  transaction: PostgreSqlTransaction,
  input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly updatedAtMs?: number;
    readonly completedAtMs?: number;
  },
): Promise<{
  readonly claimed: boolean;
  readonly resultReference: string | null;
  readonly responseHash: string | null;
}> {
  const occurredAtMs = input.updatedAtMs ?? input.completedAtMs;
  const claim = await transaction.query(
    `INSERT INTO shared_idempotency_records
      (id, organization_id, actor_user_id, operation, idempotency_key, request_hash,
       state, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress',
       to_timestamp($6 / 1000.0),to_timestamp($6 / 1000.0))
     ON CONFLICT (organization_id, actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.organizationId, input.actorUserId, input.operation, input.idempotencyKey,
      input.requestHash, occurredAtMs],
  );
  const receipt = await transaction.query<IdempotencyRow>(
    `SELECT request_hash, state, result_reference, response_hash
       FROM shared_idempotency_records
      WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3
        AND idempotency_key = $4
      FOR UPDATE`,
    [input.organizationId, input.actorUserId, input.operation, input.idempotencyKey],
  );
  const row = receipt.rows[0];
  if (!row) throw new AssessmentServiceError("ASSESSMENT_ANSWER_IDEMPOTENCY_IN_PROGRESS");
  if (row.request_hash !== input.requestHash) {
    throw new AssessmentServiceError(
      input.operation.endsWith("background_complete")
        ? "ASSESSMENT_STATUS_IDEMPOTENCY_KEY_REUSED"
        : "ASSESSMENT_ANSWER_IDEMPOTENCY_KEY_REUSED",
    );
  }
  if (claim.rowCount === 0 && (row.state !== "completed" || !row.result_reference)) {
    throw new AssessmentServiceError(
      input.operation.endsWith("background_complete")
        ? "ASSESSMENT_STATUS_IDEMPOTENCY_IN_PROGRESS"
        : "ASSESSMENT_ANSWER_IDEMPOTENCY_IN_PROGRESS",
    );
  }
  return {
    claimed: claim.rowCount === 1,
    resultReference: row.result_reference,
    responseHash: row.response_hash,
  };
}

async function completeIdempotency(
  transaction: PostgreSqlTransaction,
  input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly resultReference: string;
    readonly responseHash: string;
    readonly updatedAtMs?: number;
    readonly completedAtMs?: number;
  },
): Promise<void> {
  const occurredAtMs = input.updatedAtMs ?? input.completedAtMs;
  const completed = await transaction.query(
    `UPDATE shared_idempotency_records
        SET state = 'completed', result_reference = $6, response_hash = $7,
            record_version = record_version + 1,
            updated_at = to_timestamp($8 / 1000.0)
      WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3
        AND idempotency_key = $4 AND request_hash = $5 AND state = 'in_progress'`,
    [input.organizationId, input.actorUserId, input.operation, input.idempotencyKey,
      input.requestHash, input.resultReference, input.responseHash, occurredAtMs],
  );
  if (completed.rowCount !== 1) {
    throw new AssessmentServiceError(
      input.operation.endsWith("background_complete")
        ? "ASSESSMENT_STATUS_IDEMPOTENCY_IN_PROGRESS"
        : "ASSESSMENT_ANSWER_IDEMPOTENCY_IN_PROGRESS",
    );
  }
}
