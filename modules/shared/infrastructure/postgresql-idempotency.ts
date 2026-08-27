import "server-only";

import {
  canonicalizeJson,
  completeIdempotencyRecord,
  createIdempotencyRecord,
  evaluateIdempotency,
  failIdempotencyRecord,
  type IdempotencyActorKind,
  type IdempotencyRecord,
} from "../domain/idempotency.ts";
import type {
  TenantTransactionContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "./db.ts";

export type IdempotencyExecutionErrorCode =
  | "IDEMPOTENCY_IN_PROGRESS"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_COMPLETION_CONFLICT";

export class IdempotencyExecutionError extends Error {
  readonly code: IdempotencyExecutionErrorCode;

  constructor(code: IdempotencyExecutionErrorCode) {
    super(code);
    this.name = "IdempotencyExecutionError";
    this.code = code;
  }
}

export interface PostgreSqlIdempotencyClaim {
  readonly id: string;
  readonly organizationId: string;
  readonly actorKind: IdempotencyActorKind;
  readonly actorOpaqueId: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: string;
  readonly createdAt: string;
}

export type IdempotentMutationOutcome<Result> = Readonly<{
  state: "completed" | "failed";
  resultReference: string;
  responseHash: string;
  updatedAt: string;
  value: Result;
}>;

export type IdempotentTransactionResult<Result> =
  | Readonly<{
      status: "executed";
      state: "completed" | "failed";
      resultReference: string;
      responseHash: string;
      recordVersion: number;
      value: Result;
    }>
  | Readonly<{
      status: "replayed";
      state: "completed" | "failed";
      resultReference: string;
      responseHash: string;
      recordVersion: number;
    }>;

export async function runIdempotentTransaction<Result>(input: Readonly<{
  runner: TenantTransactionRunner;
  context: TenantTransactionContext;
  claim: PostgreSqlIdempotencyClaim;
  execute: (
    transaction: TenantTransaction,
    record: IdempotencyRecord,
  ) => Promise<IdempotentMutationOutcome<Result>>;
  revalidate: (transaction: TenantTransaction) => Promise<void>;
}>): Promise<IdempotentTransactionResult<Result>> {
  return input.runner.run(input.context, async (transaction) => {
    const claimed = await claimIdempotencyRecord(transaction, input.claim);
    await input.revalidate(transaction);
    if (claimed.decision.action === "conflict" || claimed.decision.action === "in_progress") {
      throw new IdempotencyExecutionError(claimed.decision.code);
    }
    if (claimed.decision.action === "replay") {
      return Object.freeze({
        status: "replayed" as const,
        state: claimed.decision.state,
        resultReference: claimed.decision.resultReference,
        responseHash: claimed.decision.responseHash,
        recordVersion: claimed.decision.recordVersion,
      });
    }

    const outcome = await input.execute(transaction, claimed.record);
    const completed = outcome.state === "completed"
      ? completeIdempotencyRecord(claimed.record, outcome)
      : failIdempotencyRecord(claimed.record, outcome);
    await persistTerminalRecord(transaction, completed);
    return Object.freeze({
      status: "executed" as const,
      state: completed.state as "completed" | "failed",
      resultReference: outcome.resultReference,
      responseHash: outcome.responseHash,
      recordVersion: completed.recordVersion,
      value: outcome.value,
    });
  });
}

async function claimIdempotencyRecord(
  transaction: TenantTransaction,
  input: PostgreSqlIdempotencyClaim,
) {
  const proposed = createIdempotencyRecord(input);
  const lockScope = canonicalizeJson({
    actor_kind: proposed.actorKind,
    actor_opaque_id: proposed.actorOpaqueId,
    idempotency_key: proposed.key,
    operation: proposed.operation,
    organization_id: proposed.organizationId,
  });
  const lock = await transaction.query<{ acquired: boolean }>({
    text: "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
    values: [lockScope],
  });
  if (lock.rows[0]?.acquired !== true) {
    return Object.freeze({
      decision: { action: "in_progress" as const, code: "IDEMPOTENCY_IN_PROGRESS" as const },
      record: proposed,
    });
  }

  const existing = await readScopedRecord(transaction, proposed);
  if (existing !== null) {
    return Object.freeze({
      decision: evaluateIdempotency({
        actorKind: proposed.actorKind,
        actorOpaqueId: proposed.actorOpaqueId,
        key: proposed.key,
        requestHash: proposed.requestHash,
        existing,
      }),
      record: existing,
    });
  }

  const inserted = await transaction.query<{ id: string }>({
    text: `INSERT INTO shared_idempotency_records
      (id, organization_id, actor_user_id, actor_kind, actor_opaque_id, operation, idempotency_key,
       request_hash, state, result_reference, response_hash, record_version, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'in_progress',NULL,NULL,1,$9,$9)
     ON CONFLICT (organization_id, actor_kind, actor_opaque_id, operation, idempotency_key)
       DO NOTHING
     RETURNING id`,
    values: [proposed.id, proposed.organizationId,
      proposed.actorKind === "user" ? proposed.actorOpaqueId : null,
      proposed.actorKind, proposed.actorOpaqueId, proposed.operation, proposed.key,
      proposed.requestHash, proposed.createdAt],
  });
  if (inserted.rows.length === 1) {
    return Object.freeze({ decision: { action: "start" as const }, record: proposed });
  }

  const raced = await readScopedRecord(transaction, proposed);
  if (raced === null) {
    throw new IdempotencyExecutionError("IDEMPOTENCY_COMPLETION_CONFLICT");
  }
  return Object.freeze({
    decision: evaluateIdempotency({
      actorKind: proposed.actorKind,
      actorOpaqueId: proposed.actorOpaqueId,
      key: proposed.key,
      requestHash: proposed.requestHash,
      existing: raced,
    }),
    record: raced,
  });
}

async function readScopedRecord(
  transaction: TenantTransaction,
  scope: IdempotencyRecord,
): Promise<IdempotencyRecord | null> {
  const result = await transaction.query<IdempotencyRow>({
    text: `SELECT id, organization_id, actor_kind, actor_opaque_id, operation,
                  idempotency_key, request_hash, state, result_reference, response_hash,
                  record_version, created_at, updated_at
             FROM shared_idempotency_records
            WHERE organization_id=$1 AND actor_kind=$2 AND actor_opaque_id=$3
              AND operation=$4 AND idempotency_key=$5
            FOR UPDATE`,
    values: [scope.organizationId, scope.actorKind, scope.actorOpaqueId, scope.operation, scope.key],
  });
  return result.rows[0] === undefined ? null : mapRecord(result.rows[0]);
}

async function persistTerminalRecord(
  transaction: TenantTransaction,
  record: IdempotencyRecord,
): Promise<void> {
  const result = await transaction.query<{ id: string }>({
    text: `UPDATE shared_idempotency_records
              SET state=$6, result_reference=$7, response_hash=$8,
                  record_version=$9, updated_at=$10
            WHERE organization_id=$1 AND actor_kind=$2 AND actor_opaque_id=$3
              AND operation=$4 AND idempotency_key=$5 AND request_hash=$11
              AND state='in_progress' AND record_version=$12
            RETURNING id`,
    values: [record.organizationId, record.actorKind, record.actorOpaqueId, record.operation,
      record.key, record.state, record.resultReference, record.responseHash,
      record.recordVersion, record.updatedAt, record.requestHash, record.recordVersion - 1],
  });
  if (result.rows.length !== 1) {
    throw new IdempotencyExecutionError("IDEMPOTENCY_COMPLETION_CONFLICT");
  }
}

interface IdempotencyRow {
  readonly id: string;
  readonly organization_id: string;
  readonly actor_kind: IdempotencyActorKind;
  readonly actor_opaque_id: string;
  readonly operation: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly state: "in_progress" | "completed" | "failed";
  readonly result_reference: string | null;
  readonly response_hash: string | null;
  readonly record_version: string | number;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

function mapRecord(row: IdempotencyRow): IdempotencyRecord {
  const recordVersion = Number(row.record_version);
  const record = createIdempotencyRecord({
    id: row.id,
    organizationId: row.organization_id,
    actorKind: row.actor_kind,
    actorOpaqueId: row.actor_opaque_id,
    operation: row.operation,
    key: row.idempotency_key,
    requestHash: row.request_hash,
    createdAt: timestamp(row.created_at),
  });
  if (!Number.isSafeInteger(recordVersion) || recordVersion < 1) {
    throw new IdempotencyExecutionError("IDEMPOTENCY_COMPLETION_CONFLICT");
  }
  if (row.state === "in_progress") return record;
  if (row.result_reference === null || row.response_hash === null) {
    throw new IdempotencyExecutionError("IDEMPOTENCY_COMPLETION_CONFLICT");
  }
  const terminal = row.state === "completed"
    ? completeIdempotencyRecord(record, {
        resultReference: row.result_reference,
        responseHash: row.response_hash,
        updatedAt: timestamp(row.updated_at),
      })
    : failIdempotencyRecord(record, {
        resultReference: row.result_reference,
        responseHash: row.response_hash,
        updatedAt: timestamp(row.updated_at),
      });
  if (terminal.recordVersion !== recordVersion) {
    throw new IdempotencyExecutionError("IDEMPOTENCY_COMPLETION_CONFLICT");
  }
  return terminal;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
