import assert from "node:assert/strict";
import test from "node:test";

import { buildAuditEvent, buildOutboxMessage, buildAtomicMutationEffects, type MutationEffectBundle } from "../../../modules/audit/public.ts";
import { PostgresqlReferralSourceRepository } from "../../../modules/crm/infrastructure/postgresql-referral-source-repository.ts";
import type { DatabaseQuery, DatabaseQueryResult, TenantDatabaseContext, TenantTransaction, TenantTransactionRunner } from "../../../modules/shared/server.ts";

const ORG = "51000000-0000-4000-8000-000000000001";
const ACTOR = "51000000-0000-4000-8000-000000000101";
const SOURCE = "61000000-0000-4000-8000-000000000001";
const IDEM = "71000000-0000-4000-8000-000000000001";
const AUDIT = "71000000-0000-4000-8000-000000000002";
const OUTBOX = "71000000-0000-4000-8000-000000000003";
const TIME = "2026-08-23T00:00:00.000Z";

test("list uses tenant/filter scope, C collation, cursor boundary, and limit+1", async () => {
  const queries: DatabaseQuery[] = [];
  const repository = new PostgresqlReferralSourceRepository(runnerForQuery((query) => {
    queries.push(query);
    if (query.text.includes("FROM identity_users AS actor")) return dbResult([{ id: ACTOR }]);
    if (query.text.includes("FROM crm_referral_sources")) return dbResult([
      sourceRow("61000000-0000-4000-8000-000000000001", "Alpha"),
      sourceRow("61000000-0000-4000-8000-000000000002", "Beta"),
      sourceRow("61000000-0000-4000-8000-000000000003", "Gamma"),
    ]);
    return dbResult([]);
  }));
  const result = await repository.list({ organizationId: ORG, actorUserId: ACTOR, actorRole: "founder",
    query: "a", status: "active", sourceType: "website", limit: 2,
    cursor: { displayName: "A", id: "61000000-0000-4000-8000-000000000000", filterHash: "a".repeat(64) } });
  assert.equal(result.items.length, 2);
  assert.equal(result.hasMore, true);
  const sql = queries.find((query) => query.text.includes("FROM crm_referral_sources"));
  assert.ok(sql);
  assert.match(sql.text, /organization_id=\$1/);
  assert.match(sql.text, /display_name COLLATE "C"/);
  assert.match(sql.text, /id::text COLLATE "C"/);
  assert.match(sql.text, /LIMIT \$7/);
  assert.deepEqual(sql.values, [ORG, "active", "website", "a", "A", "61000000-0000-4000-8000-000000000000", 3]);
});

test("read revalidation allows Founder/Advisor but rejects Admin; Advisor detail is active-only", async () => {
  const repository = new PostgresqlReferralSourceRepository(runnerForQuery((query) => {
    if (query.text.includes("FROM identity_users AS actor")) return dbResult([{ id: ACTOR }]);
    if (query.text.includes("FROM crm_referral_sources")) return dbResult([sourceRow(SOURCE, "Active")]);
    return dbResult([]);
  }));
  const advisor = await repository.find({ organizationId: ORG, actorUserId: ACTOR, actorRole: "advisor", sourceId: SOURCE });
  assert.equal(advisor?.status, "active");
  const admin = new PostgresqlReferralSourceRepository(runnerForQuery((query) => {
    if (query.text.includes("FROM identity_users AS actor")) return dbResult([{ id: ACTOR }]);
    return dbResult([]);
  }));
  await assert.rejects(() => admin.list({ organizationId: ORG, actorUserId: ACTOR, actorRole: "admin",
    query: null, status: null, sourceType: null, limit: 25, cursor: null }), /REFERRAL_SOURCE_FORBIDDEN/);
});

test("deactivate locks scoped source, uses shared idempotency, and returns canonical receipt", async () => {
  const queries: DatabaseQuery[] = [];
  const repository = new PostgresqlReferralSourceRepository(runnerForQuery((query) => {
    queries.push(query);
    if (query.text.includes("pg_try_advisory_xact_lock")) return dbResult([{ acquired: true }]);
    if (query.text.includes("FROM identity_users AS actor")) return dbResult([{ id: ACTOR }]);
    if (query.text.includes("FROM shared_idempotency_records")) return dbResult([]);
    if (query.text.includes("INSERT INTO shared_idempotency_records")) return dbResult([{ id: IDEM }]);
    if (query.text.includes("SELECT id,status,record_version")) return dbResult([{ id: SOURCE, status: "active", record_version: 1 }]);
    if (query.text.includes("UPDATE crm_referral_sources")) return dbResult([sourceRow(SOURCE, "Source", "inactive", 2)]);
    if (query.text.includes("INSERT INTO audit_events") || query.text.includes("INSERT INTO audit_outbox")) return dbResult([]);
    if (query.text.includes("UPDATE shared_idempotency_records")) return dbResult([{ id: IDEM }]);
    return dbResult([]);
  }));
  const result = await repository.deactivate({ organizationId: ORG, actorUserId: ACTOR, actorRole: "founder",
    sourceId: SOURCE, expectedRecordVersion: 1, reasonCode: "record.lifecycle.referral_source_deactivated",
    idempotencyKey: "referral-source-test", requestHash: "a".repeat(64), idempotencyRecordId: IDEM,
    occurredAt: TIME, requestId: "referral-source-request", effects: effects() });
  assert.deepEqual(result, { id: SOURCE, status: "inactive", recordVersion: 2, updatedAt: TIME });
  const lockIndex = queries.findIndex((query) => query.text.includes("SELECT id,status,record_version"));
  const updateIndex = queries.findIndex((query) => query.text.includes("UPDATE crm_referral_sources"));
  assert.ok(lockIndex >= 0 && updateIndex > lockIndex);
  assert.deepEqual(queries[updateIndex]?.values?.slice(0, 2), [ORG, SOURCE]);
});

function sourceRow(id: string, name: string, status: "active" | "inactive" = "active", recordVersion = 1) {
  return { id, display_name: name, source_type: "website", description: null, status,
    record_version: recordVersion, updated_at: TIME };
}

function effects(): MutationEffectBundle {
  const audit = buildAuditEvent({ id: AUDIT, organizationId: ORG, actorUserId: ACTOR, actorKind: "user",
    eventType: "crm.referral_source_deactivated", eventVersion: 1, action: "deactivated",
    resourceType: "ReferralSource", resourceId: SOURCE, outcome: "succeeded", requestId: "referral-source-request", occurredAt: TIME,
    metadata: { effect_type: "referral_source.deactivated", record_version: 2 } });
  const outbox = buildOutboxMessage({ id: OUTBOX, auditEventId: AUDIT, organizationId: ORG,
    aggregateType: "ReferralSource", aggregateId: SOURCE, eventType: "crm.referral_source_deactivated", eventVersion: 1,
    idempotencyKey: "referral-source-event", requestId: "referral-source-request",
    payload: { aggregate_id: SOURCE, effect_type: "referral_source.deactivated", record_version: 2, request_id: "referral-source-request" },
    availableAt: TIME, createdAt: TIME });
  return buildAtomicMutationEffects({ audit, outbox });
}

type QueryHandler = (query: DatabaseQuery) => DatabaseQueryResult<Record<string, unknown>> | Promise<DatabaseQueryResult<Record<string, unknown>>>;
function dbResult<Row>(rows: readonly Record<string, unknown>[]): DatabaseQueryResult<Row> { return { rows: rows as readonly Row[] }; }
function runnerForQuery(handler: QueryHandler): TenantTransactionRunner {
  return { async run<Result>(_context: TenantDatabaseContext, operation: (transaction: TenantTransaction) => Promise<Result>) {
    return operation({ async query<Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>> {
      return await handler(query) as DatabaseQueryResult<Row>;
    } });
  } };
}
