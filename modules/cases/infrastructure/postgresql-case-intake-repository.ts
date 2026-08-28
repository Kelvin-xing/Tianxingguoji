import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import {
  IdempotencyExecutionError,
  runIdempotentTransaction,
} from "../../shared/server.ts";
import {
  CaseIntakeError,
  type CaseIntakeReceipt,
  type CaseIntakeRepository,
  type AccessCaseIntakeOwnerQueries,
  type CrmCaseIntakeOwnerQueries,
} from "../application/intake-service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE = /^ci:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([1-9][0-9]{0,15})$/;
const OPERATION = "cases.create_k12_case";

interface ManifestRow extends Record<string, unknown> {
  id: string;
  composition_version: string;
}

interface ReplayRow extends Record<string, unknown> {
  case_id: string;
  case_stage: string;
  workflow_status: string;
  case_record_version: number | string;
  manifest_id: string;
  composition_version: string;
}

interface Reference {
  readonly caseId: string;
  readonly recordVersion: number;
}

export class PostgresqlCaseIntakeRepository implements CaseIntakeRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly crm: CrmCaseIntakeOwnerQueries;
  private readonly access: AccessCaseIntakeOwnerQueries;

  constructor(
    runner: TenantTransactionRunner,
    crm: CrmCaseIntakeOwnerQueries,
    access: AccessCaseIntakeOwnerQueries,
  ) {
    this.runner = runner;
    this.crm = crm;
    this.access = access;
  }

  createCase(input: Parameters<CaseIntakeRepository["createCase"]>[0]) {
    return runIdempotentTransaction<CaseIntakeReceipt>({
      runner: this.runner,
      context: {
        organizationId: input.organizationId,
        actorKind: "user",
        actorOpaqueId: input.actorUserId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
      },
      claim: {
        id: input.idempotencyRecordId,
        organizationId: input.organizationId,
        actorKind: "user",
        actorOpaqueId: input.actorUserId,
        operation: OPERATION,
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        createdAt: new Date(input.createdAtMs).toISOString(),
      },
      revalidate: async (transaction) => {
        if (!(await this.access.assertCurrentAdvisor(transaction, input))) {
          throw new CaseIntakeError("CASE_INTAKE_FORBIDDEN");
        }
      },
      execute: async (transaction) => {
        const receipt = await createInTransaction(transaction, input, this.crm, this.access);
        return {
          state: "completed" as const,
          resultReference: encodeReference({
            caseId: receipt.caseId,
            recordVersion: receipt.recordVersion,
          }),
          responseHash: hashRequestPayload(receiptJson(receipt)),
          updatedAt: new Date(input.createdAtMs).toISOString(),
          value: receipt,
        };
      },
    }).then(async (result) => {
      if (result.status === "executed") return result.value;
      const reference = parseReference(result.resultReference);
      const receipt = await this.readReplayReceipt(input, reference);
      if (result.responseHash !== hashRequestPayload(receiptJson(receipt))) {
        throw new CaseIntakeError("CASE_INTAKE_UNAVAILABLE");
      }
      return receipt;
    }).catch((cause) => {
      if (cause instanceof CaseIntakeError) throw cause;
      if (isActiveCaseDuplicateViolation(cause)) {
        throw new CaseIntakeError("CASE_INTAKE_CONFLICT");
      }
      if (cause instanceof IdempotencyExecutionError) {
        if (cause.code === "IDEMPOTENCY_KEY_REUSED") {
          throw new CaseIntakeError("CASE_INTAKE_IDEMPOTENCY_CONFLICT");
        }
        if (cause.code === "IDEMPOTENCY_IN_PROGRESS") {
          throw new CaseIntakeError("CASE_INTAKE_IDEMPOTENCY_IN_PROGRESS");
        }
      }
      throw new CaseIntakeError("CASE_INTAKE_UNAVAILABLE");
    });
  }

  private readReplayReceipt(
    input: Parameters<CaseIntakeRepository["createCase"]>[0],
    reference: Reference,
  ): Promise<CaseIntakeReceipt> {
    return this.runner.run(
      { organizationId: input.organizationId, actorUserId: input.actorUserId },
      async (transaction) => {
        const result = await transaction.query<ReplayRow>({
          text: `SELECT service_case.id AS case_id, service_case.stage AS case_stage,
                        service_case.workflow_status, service_case.record_version AS case_record_version,
                        assessment.manifest_id, manifest.composition_version
                   FROM cases_service_cases AS service_case
                   JOIN cases_assessments AS assessment
                     ON assessment.service_case_id=service_case.id
                    AND assessment.organization_id=service_case.organization_id
                   JOIN cases_schema_manifests AS manifest ON manifest.id=assessment.manifest_id
                  WHERE service_case.organization_id=$1 AND service_case.id=$2
                    AND assessment.status='draft'
                  FOR SHARE OF service_case, assessment, manifest`,
          values: [input.organizationId, reference.caseId],
        });
        const row = result.rows[0];
        if (!row || row.case_id !== reference.caseId ||
            Number(row.case_record_version) !== reference.recordVersion ||
            row.case_stage !== "background_collection" || row.workflow_status !== "active" ||
            !UUID.test(row.manifest_id)) {
          throw new CaseIntakeError("CASE_INTAKE_UNAVAILABLE");
        }
        return Object.freeze({
          caseId: row.case_id,
          stage: "background_collection" as const,
          workflowStatus: "active" as const,
          recordVersion: Number(row.case_record_version),
          assessmentManifest: Object.freeze({
            id: row.manifest_id.toLowerCase(),
            version: row.composition_version,
          }),
          assessmentUrl: `/cases/${row.case_id}/assessment`,
        });
      },
    );
  }
}

async function createInTransaction(
  transaction: TenantTransaction,
  input: Parameters<CaseIntakeRepository["createCase"]>[0],
  crm: CrmCaseIntakeOwnerQueries,
  access: AccessCaseIntakeOwnerQueries,
): Promise<CaseIntakeReceipt> {
  if (!(await crm.lockStudent(transaction, {
    organizationId: input.organizationId,
    studentId: input.studentId,
  }))) {
    throw new CaseIntakeError("CASE_INTAKE_STUDENT_NOT_FOUND");
  }
  const advisor = await access.lockAdvisor(transaction, {
    organizationId: input.organizationId,
    roleBindingId: input.primaryAdvisorRoleBindingId,
  });
  if (!advisor) throw new CaseIntakeError("CASE_INTAKE_ADVISOR_NOT_FOUND");

  const referral = input.referralSourceId === null
    ? null
    : await crm.lockReferralSource(transaction, {
      organizationId: input.organizationId,
      sourceId: input.referralSourceId,
    });
  if (input.referralSourceId !== null && !referral) {
    throw new CaseIntakeError("CASE_INTAKE_REFERRAL_SOURCE_NOT_FOUND");
  }

  const manifest = await transaction.query<ManifestRow>({
    text: `SELECT id, composition_version
             FROM cases_schema_manifests
            WHERE application_type='k12' AND status='approved'
            ORDER BY composition_version DESC, id
            LIMIT 1 FOR SHARE`,
  });
  const selectedManifest = manifest.rows[0];
  if (!selectedManifest) throw new CaseIntakeError("CASE_INTAKE_MANIFEST_NOT_APPROVED");

  const caseNumber = `TX-${input.intakeYear}-${input.caseId.slice(0, 8).toUpperCase()}`;
  const serverTime = new Date(input.createdAtMs).toISOString();
  await transaction.query({
    text: `INSERT INTO cases_service_cases
      (id, organization_id, student_id, case_number, application_type, intake_year,
       admission_type, primary_role_binding_id, primary_membership_id, primary_user_id,
       primary_role, current_primary_advisor_assignment_id, stage, workflow_status,
       signed_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'k12',$5,$6,$7,$8,$9,'advisor',$10,'signed','active',$11,$12,$12)`,
    values: [input.caseId, input.organizationId, input.studentId, caseNumber, input.intakeYear,
      input.admissionType, advisor.id, advisor.membershipId, advisor.userId,
      input.primaryAssignmentId, input.signedAt, serverTime],
  });
  await transaction.query({
    text: `INSERT INTO cases_primary_advisor_assignments
      (id, organization_id, service_case_id, advisor_role_binding_id, membership_id,
       advisor_user_id, advisor_role, starts_at, assignment_reason, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'advisor',$7,'case_creation',$8,$8)`,
    values: [input.primaryAssignmentId, input.organizationId, input.caseId, advisor.id,
      advisor.membershipId, advisor.userId, input.signedAt, serverTime],
  });
  await transaction.query({
    text: `INSERT INTO cases_assessments
      (id, organization_id, service_case_id, manifest_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'draft',$5,$5)`,
    values: [input.assessmentId, input.organizationId, input.caseId, selectedManifest.id, serverTime],
  });
  if (referral !== null && input.referralSourceAssignmentId !== null) {
    await transaction.query({
      text: `INSERT INTO cases_case_referral_source_assignments
        (id, organization_id, case_id, referral_source_id, source_display_name,
         source_type, source_record_version, starts_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      values: [input.referralSourceAssignmentId, input.organizationId, input.caseId,
        referral.id, referral.displayName, referral.sourceType, referral.recordVersion,
        input.signedAt, serverTime],
    });
  }

  const advanced = await transaction.query<{
    decision: string;
    result_stage: string | null;
    result_record_version: number | string | null;
  }>({
    text: `SELECT decision, result_stage, result_record_version
             FROM cases_advance_new_service_case($1,'advisor',$2,$3::timestamptz)`,
    values: [input.caseId, input.transitionFactId, serverTime],
  });
  const transition = advanced.rows[0];
  if (transition?.decision !== "allowed" || transition.result_stage !== "background_collection" ||
      Number(transition.result_record_version) !== 2) {
    throw new CaseIntakeError("CASE_INTAKE_CONFLICT");
  }

  const receipt = Object.freeze({
    caseId: input.caseId,
    stage: "background_collection" as const,
    workflowStatus: "active" as const,
    recordVersion: 2,
    assessmentManifest: Object.freeze({
      id: selectedManifest.id.toLowerCase(),
      version: selectedManifest.composition_version,
    }),
    assessmentUrl: `/cases/${input.caseId}/assessment`,
  });
  await appendAtomicMutationEffects(asAtomicTransaction(transaction), input.effects);
  return receipt;
}

function asAtomicTransaction(transaction: TenantTransaction) {
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) {
      const result = await transaction.query<Row>({ text, values });
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
  };
}

function receiptJson(receipt: CaseIntakeReceipt) {
  return {
    assessment_manifest: receipt.assessmentManifest,
    assessment_url: receipt.assessmentUrl,
    case_id: receipt.caseId,
    record_version: receipt.recordVersion,
    stage: receipt.stage,
    workflow_status: receipt.workflowStatus,
  };
}

function encodeReference(reference: Reference): string {
  const value = `ci:${reference.caseId.toLowerCase()}:${reference.recordVersion}`;
  if (value.length > 128 || !REFERENCE.test(value)) {
    throw new CaseIntakeError("CASE_INTAKE_UNAVAILABLE");
  }
  return value;
}

function parseReference(value: string): Reference {
  const match = REFERENCE.exec(value);
  if (!match) throw new CaseIntakeError("CASE_INTAKE_UNAVAILABLE");
  const reference = { caseId: match[1]!.toLowerCase(), recordVersion: Number(match[2]) };
  if (encodeReference(reference) !== value) throw new CaseIntakeError("CASE_INTAKE_UNAVAILABLE");
  return reference;
}

function isActiveCaseDuplicateViolation(
  error: unknown,
): error is { code: "23505"; constraint: "cases_service_cases_one_active_student_case_idx" } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly constraint?: unknown };
  return candidate.code === "23505" &&
    candidate.constraint === "cases_service_cases_one_active_student_case_idx";
}
