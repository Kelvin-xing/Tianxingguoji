import assert from "node:assert/strict";
import test from "node:test";

import { PostgresqlGuardianRelationshipRepository } from "../../../modules/crm/infrastructure/postgresql-guardian-relationship-repository.ts";
import { buildAtomicMutationEffects, buildAuditEvent, buildOutboxMessage } from "../../../modules/audit/public.ts";
import { hashRequestPayload } from "../../../modules/shared/public.ts";
import type { DatabaseQuery, DatabaseQueryResult, TenantDatabaseContext, TenantTransaction, TenantTransactionRunner } from "../../../modules/shared/server.ts";

function result<Row>(rows: readonly Record<string, unknown>[]): DatabaseQueryResult<Row> { return { rows: rows as readonly Row[] }; }

type QueryHandler = (query: DatabaseQuery) => DatabaseQueryResult<Record<string, unknown>> | Promise<DatabaseQueryResult<Record<string, unknown>>>;
function runnerForQuery(handler: QueryHandler): TenantTransactionRunner {
  return { async run<Result>(_context: TenantDatabaseContext, operation: (transaction: TenantTransaction) => Promise<Result>) {
    return operation({ query: async <Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>> => handler(query) as DatabaseQueryResult<Row> });
  } };
}

const org = "71000000-0000-4000-8000-000000000001";
const actor = "71000000-0000-4000-8000-000000000002";
const student = "71000000-0000-4000-8000-000000000003";
const relationship = "71000000-0000-4000-8000-000000000004";
const occurredAt = "2026-08-26T01:00:00.000Z";

function input() {
  return { organizationId: org, actorUserId: actor,
    command: { studentId: student, relationshipId: relationship, expectedRecordVersion: 4, requestId: "req-end", idempotencyKey: "key-end" },
    reason: "guardian.relationship.ended" as const, idempotencyRecordId: "71000000-0000-4000-8000-000000000005",
    requestHash: "a".repeat(64), occurredAt,
    effects: buildAtomicMutationEffects({ audit: buildAuditEvent({ id: "71000000-0000-4000-8000-000000000006", organizationId: org, actorUserId: actor, actorKind: "user", eventType: "crm.guardian_relationship_ended", eventVersion: 1, action: "end", resourceType: "relationship", resourceId: relationship, outcome: "succeeded", requestId: "req-end", occurredAt, metadata: { status: "ended", previous_version: 4, next_version: 5, reason_code: "guardian.relationship.ended", request_id: "req-end" } }), outbox: buildOutboxMessage({ id: "71000000-0000-4000-8000-000000000007", auditEventId: "71000000-0000-4000-8000-000000000006", organizationId: org, aggregateType: "relationship", aggregateId: relationship, eventType: "crm.guardian_relationship_ended", eventVersion: 1, idempotencyKey: "key-end", requestId: "req-end", payload: { aggregate_id: relationship, status: "ended", record_version: 5, reason_code: "guardian.relationship.ended", request_id: "req-end" }, availableAt: occurredAt, createdAt: occurredAt }) }) };
}

test("end locks scoped Student then current non-primary relationship and completes atomically", async () => {
  const sql: string[] = [];
  const runner: TenantTransactionRunner = { async run<Result>(_context: TenantDatabaseContext, operation: (transaction: TenantTransaction) => Promise<Result>) {
    return operation({ query: async <Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>> => {
      sql.push(query.text);
      if (query.text.includes("pg_try_advisory")) return { rows: [{ acquired: true }] as Row[] };
      if (query.text.includes("FROM shared_idempotency_records")) return { rows: [] as Row[] };
      if (query.text.includes("INSERT INTO shared_idempotency_records")) return { rows: [{ id: input().idempotencyRecordId }] as Row[] };
      if (query.text.includes("FROM identity_users AS actor")) return { rows: [{ binding_id: "founder" }, { binding_id: "advisor" }] as Row[] };
      if (query.text.includes("SELECT id FROM crm_students")) return { rows: [{ id: student }] as Row[] };
      if (query.text.includes("FROM crm_student_guardian_relationships") && query.text.includes("ends_at IS NULL")) return { rows: [{ relationship_id: relationship, student_id: student, is_primary_contact: false, ends_at: null, record_version: 4 }] as Row[] };
      if (query.text.includes("UPDATE crm_student_guardian_relationships")) return { rows: [{ relationship_id: relationship, student_id: student, is_primary_contact: false, ends_at: occurredAt, record_version: 5 }] as Row[] };
      if (query.text.includes("UPDATE shared_idempotency_records")) return { rows: [{ id: input().idempotencyRecordId }] as Row[] };
      return { rows: [{ id: "effect" }] as Row[] };
    } });
  } };
  const result = await new PostgresqlGuardianRelationshipRepository(runner).endRelationship(input());
  assert.deepEqual(result, { relationshipId: relationship, studentId: student, status: "ended", endsAt: occurredAt, recordVersion: 5, occurredAt });
  const studentLock = sql.findIndex((text) => text.includes("SELECT id FROM crm_students"));
  const relationshipLock = sql.findIndex((text) => text.includes("ends_at IS NULL") && text.includes("FOR UPDATE"));
  const update = sql.findIndex((text) => text.includes("UPDATE crm_student_guardian_relationships"));
  assert.ok(studentLock >= 0 && studentLock < relationshipLock && relationshipLock < update);
  assert.match(sql[update]!, /organization_id=\$1.*student_id=\$2.*id=\$3.*record_version=\$7/s);
  assert.ok(sql.some((text) => text.includes("UPDATE shared_idempotency_records")));
});

test("primary relationship is rejected before update and effects", async () => {
  const sql: string[] = [];
  const runner: TenantTransactionRunner = { async run<Result>(_context: TenantDatabaseContext, operation: (transaction: TenantTransaction) => Promise<Result>) { return operation({ query: async <Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>> => {
    sql.push(query.text);
    if (query.text.includes("pg_try_advisory")) return { rows: [{ acquired: true }] as Row[] };
    if (query.text.includes("FROM shared_idempotency_records")) return { rows: [] as Row[] };
    if (query.text.includes("INSERT INTO shared_idempotency_records")) return { rows: [{ id: input().idempotencyRecordId }] as Row[] };
    if (query.text.includes("FROM identity_users AS actor")) return { rows: [{ binding_id: "founder" }] as Row[] };
    if (query.text.includes("SELECT id FROM crm_students")) return { rows: [{ id: student }] as Row[] };
    return { rows: [{ relationship_id: relationship, student_id: student, is_primary_contact: true, ends_at: null, record_version: 4 }] as Row[] };
  } }); } };
  await assert.rejects(new PostgresqlGuardianRelationshipRepository(runner).endRelationship(input()), /PRIMARY_CANNOT_END/);
  assert.equal(sql.some((text) => text.includes("UPDATE crm_student_guardian_relationships")), false);
});

function scenario(studentRows: readonly Record<string, unknown>[], relationshipRows: readonly Record<string, unknown>[]): TenantTransactionRunner {
  return runnerForQuery(async (query) => {
      if (query.text.includes("pg_try_advisory")) return result([{ acquired: true }]);
      if (query.text.includes("FROM shared_idempotency_records")) return result([]);
      if (query.text.includes("INSERT INTO shared_idempotency_records")) return result([{ id: input().idempotencyRecordId }]);
      if (query.text.includes("FROM identity_users AS actor")) return result([{ binding_id: "b" }]);
      if (query.text.includes("SELECT id FROM crm_students")) return result(studentRows);
      if (query.text.includes("FROM crm_student_guardian_relationships")) return result(relationshipRows);
      return result([]);
  });
}

function failureHarness(failAt: "audit" | "outbox" | "terminal"): TenantTransactionRunner {
  return { async run(_c, op) { return op({ query: async <Row>(q: { text: string }) => {
    if (q.text.includes("pg_try_advisory")) return { rows: [{ acquired: true }] as Row[] };
    if (q.text.includes("FROM shared_idempotency_records")) return { rows: [] as Row[] };
    if (q.text.includes("INSERT INTO shared_idempotency_records")) return { rows: [{ id: input().idempotencyRecordId }] as Row[] };
    if (q.text.includes("FROM identity_users AS actor")) return { rows: [{ binding_id: "b" }] as Row[] };
    if (q.text.includes("SELECT id FROM crm_students")) return { rows: [{ id: student }] as Row[] };
    if (q.text.includes("FROM crm_student_guardian_relationships")) return { rows: [{ relationship_id: relationship, student_id: student, is_primary_contact: false, ends_at: null, record_version: 4 }] as Row[] };
    if (q.text.includes("UPDATE crm_student_guardian_relationships")) return { rows: [{ relationship_id: relationship, student_id: student, is_primary_contact: false, ends_at: occurredAt, record_version: 5 }] as Row[] };
    if (q.text.includes("INSERT INTO audit_events") && failAt === "audit") throw new Error("audit failure");
    if (q.text.includes("INSERT INTO audit_outbox") && failAt === "outbox") throw new Error("outbox failure");
    if (q.text.includes("UPDATE shared_idempotency_records")) return { rows: (failAt === "terminal" ? [] : [{ id: input().idempotencyRecordId }]) as Row[] };
    return { rows: [] as Row[] };
  } }); } };
}

test("audit, outbox, and terminal completion failures are unavailable", async () => {
  for (const failAt of ["audit", "outbox", "terminal"] as const) {
    await assert.rejects(new PostgresqlGuardianRelationshipRepository(failureHarness(failAt)).endRelationship(input()), /UNAVAILABLE/);
  }
});

test("stale version, missing Student, and missing current relationship fail safely", async () => {
  const base = { relationship_id: relationship, student_id: student, is_primary_contact: false, ends_at: null, record_version: 3 };
  await assert.rejects(new PostgresqlGuardianRelationshipRepository(scenario([{ id: student }], [base])).endRelationship(input()), /STALE_VERSION/);
  await assert.rejects(new PostgresqlGuardianRelationshipRepository(scenario([], [])).endRelationship(input()), /STUDENT_NOT_FOUND/);
  await assert.rejects(new PostgresqlGuardianRelationshipRepository(scenario([{ id: student }], [])).endRelationship(input()), /NOT_FOUND/);
});

test("same-hash completed replay returns persisted timestamp without business writes", async () => {
  const original = { relationship_id: relationship, student_id: student, is_primary_contact: false, ends_at: "2026-08-25T00:00:00.000Z", record_version: 5 };
  const receipt = { relationship_id: relationship, student_id: student, status: "ended", ends_at: original.ends_at, record_version: 5, occurred_at: original.ends_at };
  const row = { id: input().idempotencyRecordId, organization_id: org, actor_kind: "user", actor_opaque_id: actor, operation: "crm.end_student_guardian_relationship", idempotency_key: input().command.idempotencyKey, request_hash: input().requestHash, state: "completed", result_reference: relationship, response_hash: hashRequestPayload(receipt), record_version: 2, created_at: occurredAt, updated_at: occurredAt };
  const queries: string[] = [];
  const runner = { async run<Result>(_context: TenantDatabaseContext, operation: (transaction: TenantTransaction) => Promise<Result>) { return operation({ query: async <Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>> => { queries.push(query.text); if (query.text.includes("pg_try_advisory")) return result([{ acquired: true }]) as DatabaseQueryResult<Row>; if (query.text.includes("FROM shared_idempotency_records")) return result([row]) as DatabaseQueryResult<Row>; if (query.text.includes("FROM identity_users AS actor")) return result([{ binding_id: "b" }]) as DatabaseQueryResult<Row>; if (query.text.includes("FROM crm_student_guardian_relationships")) return result([original]) as DatabaseQueryResult<Row>; return result([]) as DatabaseQueryResult<Row>; } }); } };
  const output = await new PostgresqlGuardianRelationshipRepository(runner).endRelationship(input());
  assert.equal(output.endsAt, original.ends_at); assert.equal(output.occurredAt, original.ends_at);
  assert.equal(queries.some((q) => q.includes("UPDATE crm_student_guardian_relationships") || q.includes("INSERT INTO audit_events") || q.includes("UPDATE shared_idempotency_records")), false);
});

test("same key different hash is rejected as key reused", async () => {
  const row = { id: input().idempotencyRecordId, organization_id: org, actor_kind: "user", actor_opaque_id: actor, operation: "crm.end_student_guardian_relationship", idempotency_key: input().command.idempotencyKey, request_hash: "b".repeat(64), state: "completed", result_reference: relationship, response_hash: "a".repeat(64), record_version: 2, created_at: occurredAt, updated_at: occurredAt };
  const runner = scenario([], []); (runner as unknown as { run: unknown });
  await assert.rejects(new PostgresqlGuardianRelationshipRepository({ async run(_c, op) { return op({ query: async <Row>(q: { text: string }) => q.text.includes("FROM shared_idempotency_records") ? { rows: [row] as Row[] } : q.text.includes("pg_try_advisory") ? { rows: [{ acquired: true }] as Row[] } : q.text.includes("FROM identity_users AS actor") ? { rows: [{ binding_id: "b" }] as Row[] } : { rows: [] as Row[] } }); } }).endRelationship(input()), /IDEMPOTENCY_KEY_REUSED/);
});

test("advisory lock refusal maps to in-progress", async () => {
  await assert.rejects(new PostgresqlGuardianRelationshipRepository({ async run(_c, op) { return op({ query: async <Row>(q: { text: string }) => q.text.includes("pg_try_advisory") ? { rows: [{ acquired: false }] as Row[] } : q.text.includes("FROM identity_users AS actor") ? { rows: [{ binding_id: "b" }] as Row[] } : { rows: [] as Row[] } }); } }).endRelationship(input()), /IDEMPOTENCY_IN_PROGRESS/);
});

test("replay missing or hash-mismatched ended row is unavailable", async () => {
  for (const relationshipRows of [[], [{ relationship_id: relationship, student_id: student, is_primary_contact: false, ends_at: occurredAt, record_version: 5 }]]) {
    const row = { id: input().idempotencyRecordId, organization_id: org, actor_kind: "user", actor_opaque_id: actor, operation: "crm.end_student_guardian_relationship", idempotency_key: input().command.idempotencyKey, request_hash: input().requestHash, state: "completed", result_reference: relationship, response_hash: "f".repeat(64), record_version: 2, created_at: occurredAt, updated_at: occurredAt };
    const runner = { async run(_c: unknown, op: (tx: unknown) => Promise<unknown>) { return op({ query: async <R>(q: { text: string }) => q.text.includes("pg_try_advisory") ? { rows: [{ acquired: true }] as R[] } : q.text.includes("FROM shared_idempotency_records") ? { rows: [row] as R[] } : q.text.includes("FROM identity_users AS actor") ? { rows: [{ binding_id: "b" }] as R[] } : q.text.includes("FROM crm_student_guardian_relationships") ? { rows: relationshipRows as R[] } : { rows: [] as R[] } }); } } as TenantTransactionRunner;
    await assert.rejects(new PostgresqlGuardianRelationshipRepository(runner).endRelationship(input()), /UNAVAILABLE/);
  }
});

test("update/effects/terminal failures never return success", async () => {
  const runner = scenario([{ id: student }], [{ relationship_id: relationship, student_id: student, is_primary_contact: false, ends_at: null, record_version: 4 }]);
  await assert.rejects(new PostgresqlGuardianRelationshipRepository(runner).endRelationship(input()), /UNAVAILABLE|STALE/);
});

test("explicit update DB failure stops before effects", async () => {
  const queries: string[] = [];
  const runner: TenantTransactionRunner = { async run(_c, op) { return op({ query: async <Row>(q: { text: string }) => { queries.push(q.text); if (q.text.includes("pg_try_advisory")) return { rows: [{ acquired: true }] as Row[] }; if (q.text.includes("FROM shared_idempotency_records")) return { rows: [] as Row[] }; if (q.text.includes("INSERT INTO shared_idempotency_records")) return { rows: [{ id: input().idempotencyRecordId }] as Row[] }; if (q.text.includes("FROM identity_users AS actor")) return { rows: [{ binding_id: "b" }] as Row[] }; if (q.text.includes("SELECT id FROM crm_students")) return { rows: [{ id: student }] as Row[] }; if (q.text.includes("FROM crm_student_guardian_relationships")) return { rows: [{ relationship_id: relationship, student_id: student, is_primary_contact: false, ends_at: null, record_version: 4 }] as Row[] }; if (q.text.includes("UPDATE crm_student_guardian_relationships")) throw new Error("db"); return { rows: [] as Row[] }; } }); } };
  await assert.rejects(new PostgresqlGuardianRelationshipRepository(runner).endRelationship(input()), /UNAVAILABLE/);
  assert.equal(queries.some((q) => q.includes("INSERT INTO audit_events")), false);
});
