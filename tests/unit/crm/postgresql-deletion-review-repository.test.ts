import assert from "node:assert/strict";
import test from "node:test";

import {
  DeletionReviewError,
  DeletionReviewService,
  type DeletionReviewRepository,
} from "../../../modules/crm/application/deletion-review-service.ts";
import { PostgresqlDeletionReviewRepository } from
  "../../../modules/crm/infrastructure/postgresql-deletion-review-repository.ts";
import type { IdentitySessionActor } from "../../../modules/identity/public.ts";
import type { TenantDatabaseContext, TenantTransaction, TenantTransactionRunner } from
  "../../../modules/shared/server.ts";

const IDS = Object.freeze({ organization: "51000000-0000-4000-8000-000000000001",
  actor: "51000000-0000-4000-8000-000000000101",
  target: "51000000-0000-4000-8000-000000000601",
  audit: "71000000-0000-4000-8000-000000000001",
  outbox: "71000000-0000-4000-8000-000000000002" });
const REQUESTED_AT = "2026-08-23T00:00:00.000Z";

test("changes an active Student to pending_delete and completes one atomic receipt", async () => {
  const sql: string[] = [];
  const repository = new PostgresqlDeletionReviewRepository(runner(async (text) => {
    sql.push(text);
    if (text.includes("INSERT INTO shared_idempotency_records")) return result([{ id: "receipt" }]);
    if (text.includes("SELECT request_hash,state,result_reference,response_hash")) return result([{
      request_hash: "ignored", state: "in_progress", result_reference: null, response_hash: null,
    }]);
    if (text.includes("SELECT binding.id FROM identity_users")) return result([{ id: "binding" }]);
    if (text.includes("FROM crm_students WHERE id=$1 FOR UPDATE")) return result([target("active", 1, null)]);
    if (text.includes("UPDATE crm_students")) return result([target("pending_delete", 2, REQUESTED_AT)]);
    if (text.includes("INSERT INTO audit_events") || text.includes("INSERT INTO audit_outbox") ||
        text.includes("UPDATE shared_idempotency_records SET state='completed'")) return result([{}]);
    throw new Error("unexpected query");
  }));
  const acknowledgement = await repository.requestDeletion(await input());
  assert.deepEqual(acknowledgement, { entityType: "student", entityId: IDS.target,
    status: "pending_delete", deletionRequestedAt: REQUESTED_AT, recordVersion: 2 });
  const update = sql.find((text) => text.includes("UPDATE crm_students"));
  assert.match(update ?? "", /status='pending_delete'/);
  assert.match(update ?? "", /deletion_requested_by_user_id=\$2/);
  assert.match(update ?? "", /deletion_reason=\$4/);
  assert.equal(sql.filter((text) => text.includes("INSERT INTO audit_events")).length, 1);
  assert.equal(sql.filter((text) => text.includes("INSERT INTO audit_outbox")).length, 1);
});

test("rejects an already-pending target before any lifecycle or effect write", async () => {
  const sql: string[] = [];
  const repository = new PostgresqlDeletionReviewRepository(runner(async (text) => {
    sql.push(text);
    if (text.includes("INSERT INTO shared_idempotency_records")) return result([{ id: "receipt" }]);
    if (text.includes("SELECT request_hash,state,result_reference,response_hash")) return result([]);
    if (text.includes("SELECT binding.id FROM identity_users")) return result([{ id: "binding" }]);
    if (text.includes("FROM crm_students WHERE id=$1 FOR UPDATE")) {
      return result([target("pending_delete", 2, REQUESTED_AT)]);
    }
    throw new Error("unexpected query");
  }));
  await assert.rejects(repository.requestDeletion(await input()),
    (error: unknown) => error instanceof DeletionReviewError && error.code === "DELETION_REVIEW_CONFLICT");
  assert.equal(sql.some((text) => text.includes("UPDATE crm_students")), false);
  assert.equal(sql.some((text) => text.includes("INSERT INTO audit_events")), false);
  assert.equal(sql.some((text) => text.includes("INSERT INTO audit_outbox")), false);
});

test("reports only a fixed deletion stage and an allowlisted PostgreSQL SQLSTATE", async () => {
  const evidence: unknown[] = [];
  const repository = new PostgresqlDeletionReviewRepository(runner(async (text) => {
    if (text.includes("INSERT INTO shared_idempotency_records")) return result([{ id: "receipt" }]);
    if (text.includes("SELECT request_hash,state,result_reference,response_hash")) return result([{
      request_hash: "ignored", state: "in_progress", result_reference: null, response_hash: null,
    }]);
    if (text.includes("SELECT binding.id FROM identity_users")) return result([{ id: "binding" }]);
    if (text.includes("FROM crm_students WHERE id=$1 FOR UPDATE")) {
      throw Object.assign(new Error("raw-secret message"), { code: "57014", severity: "ERROR",
        detail: "raw-secret detail", query: "SELECT raw-secret", stack: "raw-secret stack" });
    }
    throw new Error("unexpected query");
  }), (item) => evidence.push(item));

  await assert.rejects(repository.requestDeletion(await input()), unavailable());
  assert.deepEqual(evidence, [{ stage: "target_lock", postgresCode: "57014" }]);
  assert.doesNotMatch(JSON.stringify(evidence), /raw-secret|message|detail|query|stack/);
});

test("classifies unknown PostgreSQL states as OTHER and non-database failures as null", async () => {
  for (const [cause, postgresCode] of [
    [Object.assign(new Error("redacted"), { code: "22012", severity: "ERROR" }), "OTHER"],
    [Object.assign(new Error("redacted"), { code: "ENOENT" }), null],
    [{ code: "42501", severity: "ERROR" }, null],
  ] as const) {
    const evidence: unknown[] = [];
    const repository = new PostgresqlDeletionReviewRepository(failingRunner(cause),
      (item) => evidence.push(item));
    await assert.rejects(repository.requestDeletion(await input()));
    assert.deepEqual(evidence, [{ stage: "receipt_claim", postgresCode }]);
  }
});

async function input(): Promise<Parameters<DeletionReviewRepository["requestDeletion"]>[0]> {
  let captured: Parameters<DeletionReviewRepository["requestDeletion"]>[0] | undefined;
  const ids = [IDS.audit, IDS.outbox];
  const service = new DeletionReviewService({ async requestDeletion(value) { captured = value; return {
    entityType: "student", entityId: IDS.target, status: "pending_delete",
    deletionRequestedAt: REQUESTED_AT, recordVersion: 2 }; }, async listDeletionRequests() { return []; } },
  () => ids.shift()!, () => Date.parse(REQUESTED_AT));
  await service.requestDeletion({ actor: actor(), command: { entityType: "student", entityId: IDS.target,
    expectedRecordVersion: 1, reasonCode: "record.lifecycle.pending_delete_requested",
    requestId: "crm05-request", idempotencyKey: "crm05-request" } });
  if (!captured) throw new Error("capture failed"); return captured;
}
function actor(): IdentitySessionActor { return Object.freeze({ userId: IDS.actor,
  organizationId: IDS.organization, role: "founder", sessionId: "session", capturedSessionVersion: 1,
  reauthenticatedAtMs: null }); }
function target(status: string, record_version: number, deletion_requested_at: string | null) {
  return { id: IDS.target, display_name: "Synthetic", status, deletion_requested_at, record_version };
}
function runner(execute: (text: string, values?: readonly unknown[]) => Promise<unknown> | unknown): TenantTransactionRunner {
  return Object.freeze({ async run<Result>(_context: TenantDatabaseContext,
    operation: (transaction: TenantTransaction) => Promise<Result>): Promise<Result> {
    return operation({ query: ({ text, values }) => execute(text, values) as never });
  } });
}
function failingRunner(cause: unknown): TenantTransactionRunner {
  return runner(() => { throw cause; });
}
function result(rows: readonly Record<string, unknown>[], rowCount = rows.length) {
  return Object.freeze({ rows, rowCount });
}
function unavailable() {
  return (error: unknown) => error instanceof DeletionReviewError &&
    error.code === "DELETION_REVIEW_UNAVAILABLE";
}
