import assert from "node:assert/strict";
import test from "node:test";

import { buildAtomicMutationEffects, buildAuditEvent, buildOutboxMessage } from "../../modules/audit/domain/contract.ts";
import {
  createProductionCaseCreationRepository,
} from "../../modules/cases/infrastructure/production-repository.ts";
import {
  ProductionRepositoryError,
  type PostgreSqlAdapter,
  type PostgreSqlQueryResult,
  type PostgreSqlTransaction,
} from "../../modules/cases/infrastructure/postgresql.ts";

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  actor: "00000000-0000-4000-8000-000000000002",
  student: "00000000-0000-4000-8000-000000000003",
  serviceCase: "00000000-0000-4000-8000-000000000004",
  assessment: "00000000-0000-4000-8000-000000000005",
  manifest: "00000000-0000-4000-8000-000000000006",
  role: "00000000-0000-4000-8000-000000000007",
  membership: "00000000-0000-4000-8000-000000000008",
  audit: "00000000-0000-4000-8000-000000000009",
  outbox: "00000000-0000-4000-8000-00000000000a",
};

test("production repository fails closed with typed 503 without PostgreSQL adapter", () => {
  assert.throws(
    () => createProductionCaseCreationRepository(),
    (error: unknown) =>
      error instanceof ProductionRepositoryError &&
      error.code === "PRODUCTION_POSTGRES_ADAPTER_UNAVAILABLE" &&
      error.httpStatus === 503 &&
      error.retryable === false,
  );
});

test("case creation preserves request-time authz and cross-CRM/Case atomic ordering", async () => {
  const database = new RecordingAdapter();
  const repository = createProductionCaseCreationRepository(database);
  const result = await repository.createStudentAndK12Case(createInput());

  assert.equal(database.transactions, 1);
  assert.deepEqual(database.contexts, [{ organizationId: ids.organization, actorUserId: ids.actor }]);
  assert.equal(result.serviceCaseId, ids.serviceCase);
  const sql = database.statements.map((statement) => statement.replace(/\s+/g, " ").trim());
  assert.match(sql[0], /INSERT INTO shared_idempotency_records.*'in_progress'.*ON CONFLICT/s);
  assert.match(sql[2], /identity_user_is_active.*access_organization_is_active.*FOR UPDATE OF rb, m/s);
  assert.match(sql[3], /cases_manifest_is_approved/);
  assert.deepEqual(
    sql.slice(4, 9).map((statement) => statement.match(/(?:INSERT INTO) ([a-z_]+)/)?.[1]),
    ["crm_students", "cases_service_cases", "cases_assessments", "audit_events", "audit_outbox"],
  );
  assert.match(sql[9], /UPDATE shared_idempotency_records.*record_version = record_version \+ 1/s);
});

test("adapter receives one failed transaction when a cross-module write fails", async () => {
  const database = new RecordingAdapter("cases_service_cases");
  const repository = createProductionCaseCreationRepository(database);
  await assert.rejects(repository.createStudentAndK12Case(createInput()), /injected failure/);
  assert.equal(database.transactions, 1);
  assert.equal(database.failedTransactions, 1);
  assert.equal(database.statements.some((statement) => statement.includes("cases_assessments")), false);
});

class RecordingAdapter implements PostgreSqlAdapter, PostgreSqlTransaction {
  readonly statements: string[] = [];
  readonly contexts: Array<Readonly<{ organizationId: string; actorUserId: string }>> = [];
  transactions = 0;
  failedTransactions = 0;
  private readonly failOnTable: string | undefined;

  constructor(failOnTable?: string) {
    this.failOnTable = failOnTable;
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
    if (this.failOnTable && text.includes(this.failOnTable)) throw new Error("injected failure");
    if (text.includes("INSERT INTO shared_idempotency_records")) return rows([{ id: "claim" }]) as PostgreSqlQueryResult<Row>;
    if (text.includes("shared_idempotency_records") && text.includes("SELECT")) return empty();
    if (text.includes("access_role_bindings")) {
      return rows([{ role_binding_id: ids.role, membership_id: ids.membership, user_id: ids.actor }]) as PostgreSqlQueryResult<Row>;
    }
    if (text.includes("cases_manifest_is_approved")) return rows([{ id: ids.manifest }]) as PostgreSqlQueryResult<Row>;
    return empty();
  }
}

function rows<Row extends Record<string, unknown>>(value: readonly Row[]): PostgreSqlQueryResult<Row> {
  return { rows: value, rowCount: value.length };
}

function empty<Row extends Record<string, unknown>>(): PostgreSqlQueryResult<Row> {
  return { rows: [], rowCount: 0 };
}

function createInput() {
  const occurredAt = "2026-08-13T00:00:00.000Z";
  const audit = buildAuditEvent({
    id: ids.audit, organizationId: ids.organization, actorUserId: ids.actor, actorKind: "user",
    eventType: "cases.service_case_created", eventVersion: 1, action: "create",
    resourceType: "ServiceCase", resourceId: ids.serviceCase, outcome: "succeeded",
    requestId: "request-p3-08", occurredAt, metadata: { record_version: 1 },
  });
  const outbox = buildOutboxMessage({
    id: ids.outbox, auditEventId: ids.audit, organizationId: ids.organization,
    aggregateType: "ServiceCase", aggregateId: ids.serviceCase,
    eventType: "cases.service_case_created", eventVersion: 1,
    idempotencyKey: "p3-08-outbox", requestId: "request-p3-08",
    payload: { aggregate_id: ids.serviceCase, request_id: "request-p3-08" },
    availableAt: occurredAt, createdAt: occurredAt,
  });
  return {
    organizationId: ids.organization, actorUserId: ids.actor,
    student: { studentId: ids.student, displayName: "Synthetic Student", dateOfBirth: null,
      contactEmail: null, contactPhone: null, status: "active" as const },
    serviceCaseId: ids.serviceCase, assessmentId: ids.assessment, intakeYear: 2027,
    admissionType: "s1", caseNumber: "SYN-P3-08", schemaManifestId: ids.manifest,
    requestId: "request-p3-08", idempotencyKey: "idempotency-p3-08",
    requestHash: "a".repeat(64), createdAtMs: Date.parse(occurredAt),
    effects: buildAtomicMutationEffects({ audit, outbox }),
  };
}
