import "server-only";

import type { AuditEvent, MutationEffectBundle, OutboxMessage } from "../domain/contract.ts";
import type { TenantDatabaseContext, TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";

export type SupportingRepositoryErrorCode =
  | "SUPPORTING_ADAPTER_UNAVAILABLE"
  | "SUPPORTING_MODULE_OWNERSHIP_VIOLATION"
  | "SUPPORTING_DOCUMENT_UNAVAILABLE"
  | "SUPPORTING_EFFECT_CONFLICT";

export class SupportingRepositoryError extends Error {
  readonly code: SupportingRepositoryErrorCode;
  readonly status: 403 | 409 | 503;
  readonly retryable: false;

  constructor(code: SupportingRepositoryErrorCode) {
    super(`Supporting production repository rejected ${code}.`);
    this.name = "SupportingRepositoryError";
    this.code = code;
    this.status = code === "SUPPORTING_ADAPTER_UNAVAILABLE" ? 503
      : code === "SUPPORTING_EFFECT_CONFLICT" ? 409 : 403;
    this.retryable = false;
  }
}

export type SupportingModule = "schools" | "tasks" | "documents" | "audit" | "notifications";

export interface OwnedSupportingTransaction {
  query<Row = Record<string, unknown>>(query: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<readonly Row[]>;
  appendEffects(effects: MutationEffectBundle): Promise<void>;
}

export interface AtomicMutationTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number }>;
}

const TABLE_REFERENCE = /\b(?:from|join|into|update|delete\s+from)\s+([a-z][a-z0-9_]*)/gi;
const SHARED_TABLES = new Set(["shared_idempotency_records"]);

export function requireSupportingTransactionRunner(
  runner: TenantTransactionRunner | null | undefined,
): TenantTransactionRunner {
  if (!runner) throw new SupportingRepositoryError("SUPPORTING_ADAPTER_UNAVAILABLE");
  return runner;
}

export async function runSupportingModuleTransaction<Result>(input: {
  readonly runner: TenantTransactionRunner;
  readonly module: SupportingModule;
  readonly context: TenantDatabaseContext;
  readonly operation: (transaction: OwnedSupportingTransaction) => Promise<Result>;
}): Promise<Result> {
  return input.runner.run(input.context, async (transaction) =>
    input.operation(createOwnedTransaction(input.module, input.context, transaction)));
}

export async function appendAtomicMutationEffects(
  transaction: AtomicMutationTransaction,
  effects: MutationEffectBundle,
): Promise<void> {
  await transaction.query(
    `INSERT INTO audit_events
      (id, organization_id, actor_user_id, actor_kind, event_type, event_version, action,
       resource_type, resource_id, outcome, request_id, occurred_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [effects.audit.id, effects.audit.organizationId, effects.audit.actorUserId,
      effects.audit.actorKind, effects.audit.eventType, effects.audit.eventVersion,
      effects.audit.action, effects.audit.resourceType, effects.audit.resourceId,
      effects.audit.outcome, effects.audit.requestId, effects.audit.occurredAt,
      JSON.stringify(effects.audit.metadata)],
  );
  await transaction.query(
    `INSERT INTO audit_outbox
      (id, audit_event_id, organization_id, aggregate_type, aggregate_id, event_type,
       event_version, idempotency_key, request_id, payload, status, available_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'pending',$11,$12)`,
    [effects.outbox.id, effects.outbox.auditEventId, effects.outbox.organizationId,
      effects.outbox.aggregateType, effects.outbox.aggregateId, effects.outbox.eventType,
      effects.outbox.eventVersion, effects.outbox.idempotencyKey, effects.outbox.requestId,
      JSON.stringify(effects.outbox.payload), effects.outbox.availableAt, effects.outbox.createdAt],
  );
}

function createOwnedTransaction(
  module: SupportingModule,
  context: TenantDatabaseContext,
  transaction: TenantTransaction,
): OwnedSupportingTransaction {
  return Object.freeze({
    async query<Row>(query: { readonly text: string; readonly values?: readonly unknown[] }) {
      assertOwnedTables(module, query.text);
      return (await transaction.query<Row>(query)).rows;
    },
    async appendEffects(effects: MutationEffectBundle): Promise<void> {
      assertEffectContext(effects, context);
      await insertAudit(transaction, effects.audit);
      await insertOutbox(transaction, effects.outbox);
    },
  });
}

function assertOwnedTables(module: SupportingModule, sql: string): void {
  TABLE_REFERENCE.lastIndex = 0;
  for (const match of sql.matchAll(TABLE_REFERENCE)) {
    const table = match[1];
    if (!table.startsWith(`${module}_`) && !SHARED_TABLES.has(table)) {
      throw new SupportingRepositoryError("SUPPORTING_MODULE_OWNERSHIP_VIOLATION");
    }
  }
}

function assertEffectContext(effects: MutationEffectBundle, context: TenantDatabaseContext): void {
  if (effects.audit.id !== effects.outbox.auditEventId ||
      effects.audit.organizationId !== effects.outbox.organizationId ||
      effects.audit.organizationId !== context.organizationId ||
      effects.audit.resourceId !== effects.outbox.aggregateId) {
    throw new SupportingRepositoryError("SUPPORTING_EFFECT_CONFLICT");
  }
}

async function insertAudit(transaction: TenantTransaction, event: AuditEvent): Promise<void> {
  await transaction.query({
    text: `INSERT INTO audit_events
      (id, organization_id, actor_user_id, actor_kind, event_type, event_version, action,
       resource_type, resource_id, outcome, request_id, occurred_at, before_hash_sha256,
       after_hash_sha256, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
    values: [event.id, event.organizationId, event.actorUserId, event.actorKind, event.eventType,
      event.eventVersion, event.action, event.resourceType, event.resourceId, event.outcome,
      event.requestId, event.occurredAt, event.beforeHashSha256, event.afterHashSha256,
      JSON.stringify(event.metadata)],
  });
}

async function insertOutbox(transaction: TenantTransaction, message: OutboxMessage): Promise<void> {
  await transaction.query({
    text: `INSERT INTO audit_outbox
      (id, audit_event_id, organization_id, aggregate_type, aggregate_id, event_type,
       event_version, idempotency_key, request_id, payload, status, attempt_count, available_at, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)`,
    values: [message.id, message.auditEventId, message.organizationId, message.aggregateType,
      message.aggregateId, message.eventType, message.eventVersion, message.idempotencyKey,
      message.requestId, JSON.stringify(message.payload), message.status, message.attemptCount,
      message.availableAt, message.createdAt],
  });
}
