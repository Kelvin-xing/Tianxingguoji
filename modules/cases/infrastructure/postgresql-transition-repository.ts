import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import {
  CaseTransitionError,
  type CaseTransitionRepository,
  type CaseTransitionRepositoryInput,
  type CaseTransitionResult,
} from "../application/transition-service.ts";
import type { PostgreSqlAdapter, PostgreSqlTransaction } from "./postgresql.ts";

const OPERATION = "cases.service_case.transition";

interface IdempotencyRow extends Record<string, unknown> {
  request_hash: string;
  state: "in_progress" | "completed";
  result_reference: string | null;
}

interface TransitionDecisionRow extends Record<string, unknown> {
  decision: string;
  result_stage: "signed" | "background_collection" | null;
  result_record_version: number | string | null;
}

interface TransitionFactRow extends Record<string, unknown> {
  service_case_id: string;
  to_stage: "signed" | "background_collection";
  to_record_version: number | string;
}

export class PostgresqlCaseTransitionRepository implements CaseTransitionRepository {
  private readonly database: PostgreSqlAdapter;

  constructor(database: PostgreSqlAdapter) {
    this.database = database;
  }

  transitionServiceCase(input: CaseTransitionRepositoryInput): Promise<CaseTransitionResult> {
    return this.database.transaction(
      { organizationId: input.organizationId, actorUserId: input.actor.userId },
      async (transaction) => {
        const idempotency = await claimIdempotency(transaction, input);
        if (!idempotency.claimed) {
          return readCompletedResult(transaction, idempotency.resultReference);
        }

        const decisionResult = await transaction.query<TransitionDecisionRow>(
          `SELECT decision, result_stage, result_record_version
             FROM cases_apply_service_case_transition(
               $1,$2,$3,$4,$5,$6,$7,to_timestamp($8 / 1000.0)
             )`,
          [input.caseId, input.expectedRecordVersion, input.fromStage, input.toStage,
            input.actor.role, input.reason, input.transitionFactId, input.transitionedAtMs],
        );
        const decision = decisionResult.rows[0];
        if (!decision) throw new CaseTransitionError("CASE_TRANSITION_NOT_ALLOWED");
        assertAllowedDecision(decision);

        await appendAtomicMutationEffects(transaction, input.effects);
        await completeIdempotency(transaction, input);
        return Object.freeze({
          caseId: input.caseId,
          stage: decision.result_stage,
          recordVersion: Number(decision.result_record_version),
        });
      },
    );
  }
}

async function claimIdempotency(
  transaction: PostgreSqlTransaction,
  input: CaseTransitionRepositoryInput,
): Promise<{ readonly claimed: boolean; readonly resultReference: string | null }> {
  const claim = await transaction.query(
    `INSERT INTO shared_idempotency_records
      (id, organization_id, actor_user_id, operation, idempotency_key, request_hash,
       state, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress',
       to_timestamp($6 / 1000.0),to_timestamp($6 / 1000.0))
     ON CONFLICT (organization_id, actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.organizationId, input.actor.userId, OPERATION, input.idempotencyKey,
      input.requestHash, input.transitionedAtMs],
  );
  const receipt = await transaction.query<IdempotencyRow>(
    `SELECT request_hash, state, result_reference
       FROM shared_idempotency_records
      WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3
        AND idempotency_key = $4
      FOR UPDATE`,
    [input.organizationId, input.actor.userId, OPERATION, input.idempotencyKey],
  );
  const row = receipt.rows[0];
  if (!row) throw new CaseTransitionError("CASE_TRANSITION_IDEMPOTENCY_IN_PROGRESS");
  if (row.request_hash !== input.requestHash) {
    throw new CaseTransitionError("CASE_TRANSITION_IDEMPOTENCY_KEY_REUSED");
  }
  if (claim.rowCount === 0 && (row.state !== "completed" || !row.result_reference)) {
    throw new CaseTransitionError("CASE_TRANSITION_IDEMPOTENCY_IN_PROGRESS");
  }
  return { claimed: claim.rowCount === 1, resultReference: row.result_reference };
}

async function completeIdempotency(
  transaction: PostgreSqlTransaction,
  input: CaseTransitionRepositoryInput,
): Promise<void> {
  await transaction.query(
    `UPDATE shared_idempotency_records
        SET state = 'completed', result_reference = $6, response_hash = $5,
            record_version = record_version + 1,
            updated_at = to_timestamp($7 / 1000.0)
      WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3
        AND idempotency_key = $4 AND request_hash = $5 AND state = 'in_progress'`,
    [input.organizationId, input.actor.userId, OPERATION, input.idempotencyKey,
      input.requestHash, input.transitionFactId, input.transitionedAtMs],
  );
}

async function readCompletedResult(
  transaction: PostgreSqlTransaction,
  resultReference: string | null,
): Promise<CaseTransitionResult> {
  if (!resultReference) {
    throw new CaseTransitionError("CASE_TRANSITION_IDEMPOTENCY_IN_PROGRESS");
  }
  const result = await transaction.query<TransitionFactRow>(
    `SELECT service_case_id, to_stage, to_record_version
       FROM cases_service_case_transition_facts
      WHERE id = $1`,
    [resultReference],
  );
  const row = result.rows[0];
  if (!row) throw new CaseTransitionError("CASE_TRANSITION_IDEMPOTENCY_IN_PROGRESS");
  return Object.freeze({
    caseId: row.service_case_id,
    stage: row.to_stage,
    recordVersion: Number(row.to_record_version),
  });
}

function assertAllowedDecision(
  decision: TransitionDecisionRow,
): asserts decision is TransitionDecisionRow & {
  result_stage: "signed" | "background_collection";
  result_record_version: number | string;
} {
  if (decision.decision === "allowed" && decision.result_stage !== null &&
      decision.result_record_version !== null) return;
  const code = decision.decision;
  if (isCaseTransitionErrorCode(code)) {
    throw new CaseTransitionError(code, {
      ...(code === "CASE_TRANSITION_STALE_VERSION" && decision.result_record_version !== null
        ? { currentRecordVersion: Number(decision.result_record_version) }
        : {}),
    });
  }
  throw new CaseTransitionError("CASE_TRANSITION_NOT_ALLOWED");
}

function isCaseTransitionErrorCode(value: string): value is ConstructorParameters<typeof CaseTransitionError>[0] {
  return new Set([
    "CASE_TRANSITION_INVALID",
    "CASE_TRANSITION_NOT_ALLOWED",
    "CASE_TRANSITION_PRIMARY_ADVISOR_REQUIRED",
    "CASE_TRANSITION_FOUNDER_REQUIRED",
    "CASE_TRANSITION_REASON_REQUIRED",
    "CASE_TRANSITION_ASSESSMENT_INCOMPLETE",
    "CASE_TRANSITION_CASE_NOT_FOUND",
    "CASE_TRANSITION_CASE_FORBIDDEN",
    "CASE_TRANSITION_STALE_VERSION",
  ]).has(value);
}
