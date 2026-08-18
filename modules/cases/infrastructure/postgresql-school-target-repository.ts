import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import {
  PostgresqlResolvedSchoolTransaction,
  resolvedSchoolDisplayName,
  SchoolResolutionError,
  type ResolvedSchoolTargetView,
} from "../../schools/server.ts";
import {
  SchoolTargetError,
  type SchoolTargetItem,
  type SchoolTargetRepository,
  type SchoolTargetState,
  type SchoolTargetWorkspaceSnapshot,
} from "../application/school-target-service.ts";
import type { PostgreSqlAdapter, PostgreSqlTransaction } from "./postgresql.ts";

const OPERATION = "cases.school_target.create";

interface AuthorizedCaseRow extends Record<string, unknown> {
  id: string;
  stage: SchoolTargetWorkspaceSnapshot["caseStage"];
  intake_year: number;
  admission_type: string;
}

interface TargetRow extends Record<string, unknown> {
  target_id: string;
  school_id: string;
  state: SchoolTargetState;
  intake_year: number;
  admission_type: string;
  record_version: number | string;
  resolved_revision_id: string | null;
  resolution_sha256: string | null;
  created_at: Date | string;
  fields_json: unknown;
  source_school_key: string | null;
}

interface IdempotencyRow extends Record<string, unknown> {
  request_hash: string;
  state: "in_progress" | "completed";
  result_reference: string | null;
}

interface CandidateDecisionRow extends Record<string, unknown> {
  decision: string;
  target_id: string | null;
  school_id: string | null;
  intake_year: number | null;
  admission_type: string | null;
  state: "candidate" | null;
  record_version: number | string | null;
  resolved_revision_id: string | null;
  resolution_sha256: string | null;
  created_at: Date | string | null;
}

export class PostgresqlSchoolTargetRepository implements SchoolTargetRepository {
  private readonly database: PostgreSqlAdapter;
  private readonly schools: Pick<
    PostgresqlResolvedSchoolTransaction,
    "listCurrentResolvedSchools" | "readCurrentResolvedSchool" | "appendResolvedRevision"
  >;

  constructor(
    database: PostgreSqlAdapter,
    schools: Pick<
      PostgresqlResolvedSchoolTransaction,
      "listCurrentResolvedSchools" | "readCurrentResolvedSchool" | "appendResolvedRevision"
    >,
  ) {
    this.database = database;
    this.schools = schools;
  }

  readSchoolTargetWorkspace(
    input: Parameters<SchoolTargetRepository["readSchoolTargetWorkspace"]>[0],
  ): Promise<SchoolTargetWorkspaceSnapshot> {
    return this.database.transaction(input, async (transaction) => {
      const serviceCase = await readAuthorizedCase(transaction, input, false);
      const items = await readTargetItems(transaction, input.caseId);
      let current: readonly ResolvedSchoolTargetView[];
      try {
        current = await this.schools.listCurrentResolvedSchools({
          transaction,
          organizationId: input.organizationId,
        });
      } catch (error) {
        throw mapResolutionError(error);
      }
      const targeted = new Set(items.map((item) => item.schoolId));
      const schoolOptions = current
        .filter((resolved) => !targeted.has(resolved.view.schoolId))
        .map((resolved) => Object.freeze({
          schoolId: resolved.view.schoolId,
          displayName: resolvedSchoolDisplayName(
            resolved.view.fields,
            resolved.view.sourceSchoolKey,
          ),
          resolutionSha256: resolved.view.resolutionSha256,
        }))
        .sort(compareOptions)
        .slice(0, 3);
      return Object.freeze({
        caseId: serviceCase.id,
        caseStage: serviceCase.stage,
        intakeYear: serviceCase.intake_year,
        admissionType: serviceCase.admission_type,
        items: Object.freeze(items),
        schoolOptions: Object.freeze(schoolOptions),
      });
    });
  }

  createSchoolTarget(
    input: Parameters<SchoolTargetRepository["createSchoolTarget"]>[0],
  ): Promise<SchoolTargetItem> {
    return this.database.transaction(
      { organizationId: input.organizationId, actorUserId: input.actorUserId },
      async (transaction) => {
        const serviceCase = await readAuthorizedCase(transaction, input, true);
        const idempotency = await claimIdempotency(transaction, input);
        if (!idempotency.claimed) {
          return readCompletedTarget(transaction, input.caseId, idempotency.resultReference);
        }
        if (serviceCase.stage !== "background_collection") {
          throw new SchoolTargetError("SCHOOL_TARGET_STAGE_NOT_ALLOWED");
        }

        let resolved: ResolvedSchoolTargetView;
        try {
          resolved = await this.schools.readCurrentResolvedSchool({
            transaction,
            organizationId: input.organizationId,
            schoolId: input.schoolId,
          });
        } catch (error) {
          throw mapResolutionError(error);
        }
        if (resolved.view.resolutionSha256 !== input.expectedResolutionSha256) {
          throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_STALE");
        }
        const duplicate = await transaction.query(
          `SELECT id FROM cases_school_targets
            WHERE service_case_id = $1 AND school_id = $2
              AND intake_year = $3 AND admission_type = $4
            LIMIT 1`,
          [input.caseId, input.schoolId, serviceCase.intake_year, serviceCase.admission_type],
        );
        if (duplicate.rowCount > 0) throw new SchoolTargetError("SCHOOL_TARGET_DUPLICATE");

        let persisted: ResolvedSchoolTargetView;
        try {
          persisted = await this.schools.appendResolvedRevision({
            transaction,
            organizationId: input.organizationId,
            proposedResolvedRevisionId: input.proposedResolvedRevisionId,
            resolved,
            createdAtMs: input.createdAtMs,
          });
        } catch (error) {
          throw mapResolutionError(error);
        }
        const resolvedRevisionId = persisted.pin.resolvedRevisionId;
        if (!resolvedRevisionId) {
          throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_INVALID");
        }

        const decisionResult = await transaction.query<CandidateDecisionRow>(
          `SELECT decision, target_id, school_id, intake_year, admission_type, state,
                  record_version, resolved_revision_id, resolution_sha256, created_at
             FROM cases_create_candidate_school_target(
               $1,$2,$3,$4,$5,to_timestamp($6 / 1000.0)
             )`,
          [input.caseId, input.targetId, input.schoolId, resolvedRevisionId,
            persisted.view.resolutionSha256, input.createdAtMs],
        );
        const row = decisionResult.rows[0];
        if (!row) throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_INVALID");
        assertCandidateAllowed(row);
        const item = candidateItem(row, persisted);
        await appendAtomicMutationEffects(transaction, input.effects);
        await completeIdempotency(transaction, input, item.targetId);
        return item;
      },
    ).catch((error: unknown) => {
      if (isTargetIdentityUniqueViolation(error)) {
        throw new SchoolTargetError("SCHOOL_TARGET_DUPLICATE");
      }
      throw error;
    });
  }
}

async function readAuthorizedCase(
  transaction: PostgreSqlTransaction,
  input: {
    readonly caseId: string;
    readonly actorUserId: string;
    readonly actorRole: "founder" | "advisor";
  },
  lock: boolean,
): Promise<AuthorizedCaseRow> {
  const result = await transaction.query<AuthorizedCaseRow>(
    `SELECT service_case.id, service_case.stage, service_case.intake_year,
            service_case.admission_type
       FROM cases_service_cases AS service_case
       JOIN access_role_bindings AS role_binding
         ON role_binding.organization_id = service_case.organization_id
        AND role_binding.user_id = $2
        AND role_binding.role = $3
       JOIN access_organization_memberships AS membership
         ON membership.id = role_binding.membership_id
        AND membership.organization_id = role_binding.organization_id
        AND membership.user_id = role_binding.user_id
       JOIN access_organizations AS organization
         ON organization.id = role_binding.organization_id
       JOIN identity_users AS identity_user
         ON identity_user.id = role_binding.user_id
      WHERE service_case.id = $1
        AND role_binding.status = 'active'
        AND membership.status = 'active'
        AND organization.status = 'active'
        AND identity_user.status = 'active'
        AND (
          $3::text = 'founder'
          OR (
            $3::text = 'advisor'
            AND service_case.primary_user_id = $2
            AND service_case.primary_role = 'advisor'
            AND service_case.primary_role_binding_id = role_binding.id
          )
        )
      LIMIT 1
      ${lock
        ? "FOR UPDATE OF service_case FOR SHARE OF role_binding, membership, organization, identity_user"
        : ""}`,
    [input.caseId, input.actorUserId, input.actorRole],
  );
  const row = result.rows[0];
  if (!row) throw new SchoolTargetError("SCHOOL_TARGET_CASE_NOT_FOUND");
  return row;
}

async function readTargetItems(
  transaction: PostgreSqlTransaction,
  caseId: string,
  targetId?: string,
): Promise<readonly SchoolTargetItem[]> {
  const result = await transaction.query<TargetRow>(
    `SELECT target.id AS target_id, target.school_id, target.state, target.intake_year,
            target.admission_type, target.record_version,
            target.pinned_resolved_revision_id AS resolved_revision_id,
            target.pinned_resolution_sha256 AS resolution_sha256, target.created_at,
            revision.fields_json, school.source_school_key
       FROM cases_school_targets AS target
       LEFT JOIN schools_resolved_revisions AS revision
         ON revision.id = target.pinned_resolved_revision_id
        AND revision.organization_id = target.organization_id
        AND revision.school_id = target.school_id
       LEFT JOIN schools_schools AS school
         ON school.id = target.school_id
        AND school.organization_id = target.organization_id
      WHERE target.service_case_id = $1
        AND ($2::uuid IS NULL OR target.id = $2)
      ORDER BY target.created_at, target.id`,
    [caseId, targetId ?? null],
  );
  return Object.freeze(result.rows.map(toTargetItem));
}

function toTargetItem(row: TargetRow): SchoolTargetItem {
  if (!row.resolved_revision_id || !row.resolution_sha256 || !row.source_school_key) {
    throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_INVALID");
  }
  return Object.freeze({
    targetId: row.target_id,
    schoolId: row.school_id,
    schoolName: resolvedSchoolDisplayName(jsonObject(row.fields_json), row.source_school_key),
    state: row.state,
    intakeYear: row.intake_year,
    admissionType: row.admission_type,
    recordVersion: Number(row.record_version),
    resolvedRevisionId: row.resolved_revision_id,
    resolutionSha256: row.resolution_sha256,
    createdAt: toIso(row.created_at),
  });
}

async function claimIdempotency(
  transaction: PostgreSqlTransaction,
  input: Parameters<SchoolTargetRepository["createSchoolTarget"]>[0],
): Promise<{ readonly claimed: boolean; readonly resultReference: string | null }> {
  const claim = await transaction.query(
    `INSERT INTO shared_idempotency_records
      (id, organization_id, actor_user_id, operation, idempotency_key, request_hash,
       state, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress',
       to_timestamp($6 / 1000.0),to_timestamp($6 / 1000.0))
     ON CONFLICT (organization_id, actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.organizationId, input.actorUserId, OPERATION, input.idempotencyKey,
      input.requestHash, input.createdAtMs],
  );
  const receipt = await transaction.query<IdempotencyRow>(
    `SELECT request_hash, state, result_reference
       FROM shared_idempotency_records
      WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3
        AND idempotency_key = $4
      FOR UPDATE`,
    [input.organizationId, input.actorUserId, OPERATION, input.idempotencyKey],
  );
  const row = receipt.rows[0];
  if (!row) throw new SchoolTargetError("SCHOOL_TARGET_IDEMPOTENCY_IN_PROGRESS");
  if (row.request_hash !== input.requestHash) {
    throw new SchoolTargetError("SCHOOL_TARGET_IDEMPOTENCY_KEY_REUSED");
  }
  if (claim.rowCount === 0 && (row.state !== "completed" || !row.result_reference)) {
    throw new SchoolTargetError("SCHOOL_TARGET_IDEMPOTENCY_IN_PROGRESS");
  }
  return Object.freeze({ claimed: claim.rowCount === 1, resultReference: row.result_reference });
}

async function completeIdempotency(
  transaction: PostgreSqlTransaction,
  input: Parameters<SchoolTargetRepository["createSchoolTarget"]>[0],
  resultReference: string,
): Promise<void> {
  const completed = await transaction.query(
    `UPDATE shared_idempotency_records
        SET state = 'completed', result_reference = $6, response_hash = $5,
            record_version = record_version + 1,
            updated_at = to_timestamp($7 / 1000.0)
      WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3
        AND idempotency_key = $4 AND request_hash = $5 AND state = 'in_progress'`,
    [input.organizationId, input.actorUserId, OPERATION, input.idempotencyKey,
      input.requestHash, resultReference, input.createdAtMs],
  );
  if (completed.rowCount !== 1) {
    throw new SchoolTargetError("SCHOOL_TARGET_IDEMPOTENCY_IN_PROGRESS");
  }
}

async function readCompletedTarget(
  transaction: PostgreSqlTransaction,
  caseId: string,
  resultReference: string | null,
): Promise<SchoolTargetItem> {
  if (!resultReference) {
    throw new SchoolTargetError("SCHOOL_TARGET_IDEMPOTENCY_IN_PROGRESS");
  }
  const items = await readTargetItems(transaction, caseId, resultReference);
  const item = items[0];
  if (!item) throw new SchoolTargetError("SCHOOL_TARGET_IDEMPOTENCY_IN_PROGRESS");
  return item;
}

function assertCandidateAllowed(
  row: CandidateDecisionRow,
): asserts row is CandidateDecisionRow & {
  target_id: string;
  school_id: string;
  intake_year: number;
  admission_type: string;
  state: "candidate";
  record_version: number | string;
  resolved_revision_id: string;
  resolution_sha256: string;
  created_at: Date | string;
} {
  if (row.decision === "allowed" && row.target_id && row.school_id && row.intake_year &&
      row.admission_type && row.state === "candidate" && row.record_version !== null &&
      row.resolved_revision_id && row.resolution_sha256 && row.created_at) return;
  switch (row.decision) {
    case "SCHOOL_TARGET_CASE_NOT_FOUND":
      throw new SchoolTargetError("SCHOOL_TARGET_CASE_NOT_FOUND");
    case "SCHOOL_TARGET_STAGE_NOT_ALLOWED":
      throw new SchoolTargetError("SCHOOL_TARGET_STAGE_NOT_ALLOWED");
    case "SCHOOL_TARGET_RESOLUTION_NOT_FOUND":
      throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_NOT_FOUND");
    case "SCHOOL_TARGET_DUPLICATE":
      throw new SchoolTargetError("SCHOOL_TARGET_DUPLICATE");
    default:
      throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_INVALID");
  }
}

function candidateItem(
  row: CandidateDecisionRow & {
    target_id: string;
    school_id: string;
    intake_year: number;
    admission_type: string;
    state: "candidate";
    record_version: number | string;
    resolved_revision_id: string;
    resolution_sha256: string;
    created_at: Date | string;
  },
  resolved: ResolvedSchoolTargetView,
): SchoolTargetItem {
  return Object.freeze({
    targetId: row.target_id,
    schoolId: row.school_id,
    schoolName: resolvedSchoolDisplayName(resolved.view.fields, resolved.view.sourceSchoolKey),
    state: row.state,
    intakeYear: row.intake_year,
    admissionType: row.admission_type,
    recordVersion: Number(row.record_version),
    resolvedRevisionId: row.resolved_revision_id,
    resolutionSha256: row.resolution_sha256,
    createdAt: toIso(row.created_at),
  });
}

function mapResolutionError(error: unknown): SchoolTargetError {
  if (error instanceof SchoolTargetError) return error;
  if (error instanceof SchoolResolutionError) {
    if (error.code === "SCHOOL_RESOLUTION_NOT_FOUND") {
      return new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_NOT_FOUND");
    }
    return new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_INVALID");
  }
  throw error;
}

function jsonObject(value: unknown): Readonly<Record<string, never>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_INVALID");
  }
  return value as Readonly<Record<string, never>>;
}

function compareOptions(
  left: { readonly displayName: string; readonly schoolId: string },
  right: { readonly displayName: string; readonly schoolId: string },
): number {
  if (left.displayName < right.displayName) return -1;
  if (left.displayName > right.displayName) return 1;
  return left.schoolId.localeCompare(right.schoolId);
}

function toIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_INVALID");
  }
  return parsed.toISOString();
}

function isTargetIdentityUniqueViolation(error: unknown): error is {
  readonly code: "23505";
  readonly constraint: "cases_school_targets_identity_idx";
} {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "23505" &&
    "constraint" in error && error.constraint === "cases_school_targets_identity_idx";
}
