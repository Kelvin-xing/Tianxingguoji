import assert from "node:assert/strict";
import test from "node:test";

import { buildAtomicMutationEffects, buildAuditEvent, buildOutboxMessage } from "../../modules/audit/domain/contract.ts";
import { CaseTransitionError, type CaseTransitionRepositoryInput } from "../../modules/cases/application/transition-service.ts";
import { PostgresqlCaseTransitionRepository } from "../../modules/cases/infrastructure/postgresql-transition-repository.ts";
import type {
  PostgreSqlAdapter,
  PostgreSqlQueryResult,
  PostgreSqlTransaction,
} from "../../modules/cases/infrastructure/postgresql.ts";

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  actor: "00000000-0000-4000-8000-000000000002",
  case: "00000000-0000-4000-8000-000000000003",
  session: "00000000-0000-4000-8000-000000000004",
  fact: "00000000-0000-4000-8000-000000000005",
  audit: "00000000-0000-4000-8000-000000000006",
  outbox: "00000000-0000-4000-8000-000000000007",
};

test("transition repository applies the guarded function and effects in one transaction", async () => {
  const database = new ScriptedAdapter([
    rows([{ id: "claim" }]),
    rows([{ request_hash: "a".repeat(64), state: "in_progress", result_reference: null }]),
    rows([{ decision: "allowed", result_stage: "background_collection", result_record_version: 2 }]),
    empty(),
    empty(),
    empty(),
  ]);
  const repository = new PostgresqlCaseTransitionRepository(database);

  assert.deepEqual(await repository.transitionServiceCase(createInput()), {
    caseId: ids.case,
    stage: "background_collection",
    recordVersion: 2,
  });
  assert.equal(database.transactions, 1);
  assert.deepEqual(database.contexts, [{ organizationId: ids.organization, actorUserId: ids.actor }]);
  const sql = database.statements.map((statement) => statement.replace(/\s+/g, " ").trim());
  assert.match(sql[0], /INSERT INTO shared_idempotency_records/);
  assert.match(sql[2], /cases_apply_service_case_transition/);
  assert.match(sql[3], /INSERT INTO audit_events/);
  assert.match(sql[4], /INSERT INTO audit_outbox/);
  assert.match(sql[5], /UPDATE shared_idempotency_records/);
});

test("transition repository maps database decisions and rolls back before effects", async () => {
  const database = new ScriptedAdapter([
    rows([{ id: "claim" }]),
    rows([{ request_hash: "a".repeat(64), state: "in_progress", result_reference: null }]),
    rows([{ decision: "CASE_TRANSITION_STALE_VERSION", result_stage: "signed", result_record_version: 4 }]),
  ]);
  const repository = new PostgresqlCaseTransitionRepository(database);

  await assert.rejects(
    repository.transitionServiceCase(createInput()),
    (error: unknown) => error instanceof CaseTransitionError &&
      error.code === "CASE_TRANSITION_STALE_VERSION" && error.currentRecordVersion === 4,
  );
  assert.equal(database.failedTransactions, 1);
  assert.equal(database.statements.some((statement) => statement.includes("audit_events")), false);
});

test("transition repository replays the immutable fact without applying a second mutation", async () => {
  const database = new ScriptedAdapter([
    empty(),
    rows([{ request_hash: "a".repeat(64), state: "completed", result_reference: ids.fact }]),
    rows([{ service_case_id: ids.case, to_stage: "background_collection", to_record_version: 2 }]),
  ]);
  const repository = new PostgresqlCaseTransitionRepository(database);

  assert.deepEqual(await repository.transitionServiceCase(createInput()), {
    caseId: ids.case,
    stage: "background_collection",
    recordVersion: 2,
  });
  assert.equal(database.statements.some((statement) => statement.includes("cases_apply_service_case_transition")), false);
});

class ScriptedAdapter implements PostgreSqlAdapter, PostgreSqlTransaction {
  readonly statements: string[] = [];
  readonly contexts: Array<Readonly<{ organizationId: string; actorUserId: string }>> = [];
  transactions = 0;
  failedTransactions = 0;
  private readonly results: PostgreSqlQueryResult<Record<string, unknown>>[];

  constructor(results: PostgreSqlQueryResult<Record<string, unknown>>[]) {
    this.results = [...results];
  }

  async transaction<T>(
    context: Readonly<{ organizationId: string; actorUserId: string }>,
    work: (transaction: PostgreSqlTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactions += 1;
    this.contexts.push(context);
    try {
      return await work(this);
    } catch (error) {
      this.failedTransactions += 1;
      throw error;
    }
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
  ): Promise<PostgreSqlQueryResult<Row>> {
    this.statements.push(text);
    const result = this.results.shift();
    if (!result) throw new Error("Unexpected repository query.");
    return result as PostgreSqlQueryResult<Row>;
  }
}

function createInput(): CaseTransitionRepositoryInput {
  const occurredAt = "2026-08-18T00:00:00.000Z";
  const audit = buildAuditEvent({
    id: ids.audit,
    organizationId: ids.organization,
    actorUserId: ids.actor,
    actorKind: "user",
    eventType: "cases.service_case_stage_transitioned",
    eventVersion: 1,
    action: "transition",
    resourceType: "ServiceCase",
    resourceId: ids.case,
    outcome: "succeeded",
    requestId: "request-phase2c",
    occurredAt,
    metadata: { record_version: 2 },
  });
  const outbox = buildOutboxMessage({
    id: ids.outbox,
    auditEventId: ids.audit,
    organizationId: ids.organization,
    aggregateType: "ServiceCase",
    aggregateId: ids.case,
    eventType: "cases.service_case_stage_transitioned",
    eventVersion: 1,
    idempotencyKey: "phase2c-outbox",
    requestId: "request-phase2c",
    payload: { aggregate_id: ids.case, request_id: "request-phase2c" },
    availableAt: occurredAt,
    createdAt: occurredAt,
  });
  return {
    organizationId: ids.organization,
    actor: {
      userId: ids.actor,
      organizationId: ids.organization,
      role: "advisor",
      sessionId: ids.session,
      capturedSessionVersion: 1,
      reauthenticatedAtMs: Date.parse(occurredAt),
    },
    caseId: ids.case,
    fromStage: "signed",
    toStage: "background_collection",
    expectedRecordVersion: 1,
    reason: null,
    transitionFactId: ids.fact,
    requestId: "request-phase2c",
    idempotencyKey: "phase2c-transition",
    requestHash: "a".repeat(64),
    transitionedAtMs: Date.parse(occurredAt),
    effects: buildAtomicMutationEffects({ audit, outbox }),
  };
}

function rows<Row extends Record<string, unknown>>(values: readonly Row[]): PostgreSqlQueryResult<Row> {
  return { rows: values, rowCount: values.length };
}

function empty(): PostgreSqlQueryResult<Record<string, unknown>> {
  return { rows: [], rowCount: 0 };
}
