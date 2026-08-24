import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import {
  CaseWorkflowError,
  type CaseWorkflowAcknowledgement,
  type CaseWorkflowRepository,
  type CaseWorkflowRepositoryInput,
} from "../application/workflow-service.ts";
import type { PostgreSqlAdapter, PostgreSqlTransaction } from "./postgresql.ts";

const OPERATION = "cases.service_case.workflow_action";

interface IdempotencyRow extends Record<string, unknown> {
  request_hash: string;
  state: "in_progress" | "completed";
  result_reference: string | null;
  response_hash: string | null;
}

interface WorkflowDecisionRow extends Record<string, unknown> {
  decision: string;
  result_status: string | null;
  result_record_version: number | string | null;
}

interface LifecycleFactRow extends Record<string, unknown> {
  service_case_id: string;
  to_record_version: number | string;
}

export class PostgresqlCaseWorkflowRepository implements CaseWorkflowRepository {
  private readonly database: PostgreSqlAdapter;

  constructor(database: PostgreSqlAdapter) {
    this.database = database;
  }

  applyWorkflowAction(input: CaseWorkflowRepositoryInput): Promise<CaseWorkflowAcknowledgement> {
    return this.database.transaction(
      { organizationId: input.organizationId, actorUserId: input.actor.userId },
      async (transaction) => {
        const idempotency = await claimIdempotency(transaction, input);
        if (!idempotency.claimed) {
          await assertReplayAuthority(transaction, input);
          return readCompletedResult(
            transaction,
            idempotency.resultReference,
            idempotency.responseHash,
          );
        }
        const result = await transaction.query<WorkflowDecisionRow>(
          `SELECT decision, result_status, result_record_version
             FROM cases_apply_service_case_workflow_action(
               $1,$2,$3,$4,$5,$6,to_timestamp($7 / 1000.0)
             )`,
          [input.caseId, input.expectedRecordVersion, input.action, input.actor.role,
            input.reason, input.lifecycleFactId, input.occurredAtMs],
        );
        const decision = result.rows[0];
        if (!decision) throw new CaseWorkflowError("CASE_WORKFLOW_CONFLICT");
        assertAllowedDecision(decision);
        await appendAtomicMutationEffects(transaction, input.effects);
        const recordVersion = Number(decision.result_record_version);
        await completeIdempotency(transaction, input, recordVersion);
        return Object.freeze({
          id: input.caseId,
          recordVersion,
        });
      },
    );
  }
}

async function assertReplayAuthority(
  transaction: PostgreSqlTransaction,
  input: CaseWorkflowRepositoryInput,
): Promise<void> {
  const serviceCase = await transaction.query<{
    primary_user_id: string;
    primary_role: string;
    student_id: string;
  } & Record<string, unknown>>(
    `SELECT primary_user_id, primary_role, student_id
       FROM cases_service_cases
      WHERE id = $1
      FOR UPDATE`,
    [input.caseId],
  );
  const selected = serviceCase.rows[0];
  if (!selected) throw new CaseWorkflowError("CASE_WORKFLOW_CASE_NOT_FOUND");
  const student = await transaction.query(
    `SELECT id FROM crm_students WHERE id = $1 AND status = 'active' FOR SHARE`,
    [selected.student_id],
  );
  if (student.rowCount !== 1) throw new CaseWorkflowError("CASE_WORKFLOW_CASE_NOT_FOUND");
  const actor = await transaction.query(
    `SELECT role_binding.id
       FROM identity_users AS identity_user
       JOIN access_organization_memberships AS membership
         ON membership.organization_id = $1
        AND membership.user_id = identity_user.id
        AND membership.status = 'active'
       JOIN access_role_bindings AS role_binding
         ON role_binding.organization_id = membership.organization_id
        AND role_binding.membership_id = membership.id
        AND role_binding.user_id = identity_user.id
        AND role_binding.role = $3
        AND role_binding.status = 'active'
       JOIN access_organizations AS organization
         ON organization.id = membership.organization_id
        AND organization.status = 'active'
      WHERE identity_user.id = $2 AND identity_user.status = 'active'
      FOR SHARE OF identity_user, membership, role_binding, organization`,
    [input.organizationId, input.actor.userId, input.actor.role],
  );
  if (actor.rowCount !== 1 ||
      (input.actor.role === "advisor" &&
        (selected.primary_role !== "advisor" || selected.primary_user_id !== input.actor.userId))) {
    throw new CaseWorkflowError("CASE_WORKFLOW_CASE_NOT_FOUND");
  }
}

async function claimIdempotency(
  transaction: PostgreSqlTransaction,
  input: CaseWorkflowRepositoryInput,
): Promise<{
  readonly claimed: boolean;
  readonly resultReference: string | null;
  readonly responseHash: string | null;
}> {
  const claim = await transaction.query(
    `INSERT INTO shared_idempotency_records
      (id, organization_id, actor_user_id, operation, idempotency_key, request_hash,
       state, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress',
       to_timestamp($6 / 1000.0),to_timestamp($6 / 1000.0))
     ON CONFLICT (organization_id, actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.organizationId, input.actor.userId, OPERATION, input.idempotencyKey,
      input.requestHash, input.occurredAtMs],
  );
  const receipt = await transaction.query<IdempotencyRow>(
    `SELECT request_hash, state, result_reference, response_hash
       FROM shared_idempotency_records
      WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3
        AND idempotency_key = $4
      FOR UPDATE`,
    [input.organizationId, input.actor.userId, OPERATION, input.idempotencyKey],
  );
  const row = receipt.rows[0];
  if (!row) throw new CaseWorkflowError("CASE_WORKFLOW_IDEMPOTENCY_IN_PROGRESS");
  if (row.request_hash !== input.requestHash) {
    throw new CaseWorkflowError("CASE_WORKFLOW_IDEMPOTENCY_KEY_REUSED");
  }
  if (claim.rowCount === 0 && (row.state !== "completed" || !row.result_reference)) {
    throw new CaseWorkflowError("CASE_WORKFLOW_IDEMPOTENCY_IN_PROGRESS");
  }
  return {
    claimed: claim.rowCount === 1,
    resultReference: row.result_reference,
    responseHash: row.response_hash,
  };
}

async function completeIdempotency(
  transaction: PostgreSqlTransaction,
  input: CaseWorkflowRepositoryInput,
  recordVersion: number,
): Promise<void> {
  const responseHash = hashRequestPayload({ id: input.caseId, record_version: recordVersion });
  const result = await transaction.query(
    `UPDATE shared_idempotency_records
        SET state = 'completed', result_reference = $6, response_hash = $7,
            record_version = record_version + 1,
            updated_at = to_timestamp($8 / 1000.0)
      WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3
        AND idempotency_key = $4 AND request_hash = $5 AND state = 'in_progress'`,
    [input.organizationId, input.actor.userId, OPERATION, input.idempotencyKey,
      input.requestHash, input.lifecycleFactId, responseHash, input.occurredAtMs],
  );
  if (result.rowCount !== 1) {
    throw new CaseWorkflowError("CASE_WORKFLOW_IDEMPOTENCY_IN_PROGRESS");
  }
}

async function readCompletedResult(
  transaction: PostgreSqlTransaction,
  resultReference: string | null,
  responseHash: string | null,
): Promise<CaseWorkflowAcknowledgement> {
  if (!resultReference) throw new CaseWorkflowError("CASE_WORKFLOW_IDEMPOTENCY_IN_PROGRESS");
  const result = await transaction.query<LifecycleFactRow>(
    `SELECT service_case_id, to_record_version
       FROM cases_service_case_lifecycle_facts
      WHERE id = $1`,
    [resultReference],
  );
  const row = result.rows[0];
  if (!row) throw new CaseWorkflowError("CASE_WORKFLOW_IDEMPOTENCY_IN_PROGRESS");
  const acknowledgement = Object.freeze({
    id: row.service_case_id,
    recordVersion: Number(row.to_record_version),
  });
  if (responseHash !== hashRequestPayload({
    id: acknowledgement.id,
    record_version: acknowledgement.recordVersion,
  })) {
    throw new CaseWorkflowError("CASE_WORKFLOW_IDEMPOTENCY_IN_PROGRESS");
  }
  return acknowledgement;
}

function assertAllowedDecision(
  decision: WorkflowDecisionRow,
): asserts decision is WorkflowDecisionRow & {
  result_status: string;
  result_record_version: number | string;
} {
  if (
    decision.decision === "allowed" &&
    decision.result_status !== null &&
    decision.result_record_version !== null
  ) return;

  const code = decision.decision;
  if (isDecisionErrorCode(code)) {
    throw new CaseWorkflowError(code, {
      ...(code === "CASE_WORKFLOW_STALE_VERSION" && decision.result_record_version !== null
        ? { currentRecordVersion: Number(decision.result_record_version) }
        : {}),
    });
  }
  throw new CaseWorkflowError("CASE_WORKFLOW_CONFLICT");
}

function isDecisionErrorCode(value: string): value is ConstructorParameters<typeof CaseWorkflowError>[0] {
  return new Set([
    "CASE_WORKFLOW_INVALID",
    "CASE_WORKFLOW_CASE_NOT_FOUND",
    "CASE_WORKFLOW_STALE_VERSION",
    "CASE_WORKFLOW_CONFLICT",
    "CASE_WORKFLOW_SUBMITTED_TARGET_EXISTS",
  ]).has(value);
}
