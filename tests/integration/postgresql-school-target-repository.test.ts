import assert from "node:assert/strict";
import test from "node:test";

import { buildAtomicMutationEffects, buildAuditEvent, buildOutboxMessage } from "../../modules/audit/public.ts";
import {
  SchoolTargetError,
  type SchoolTargetRepository,
} from "../../modules/cases/application/school-target-service.ts";
import { PostgresqlSchoolTargetRepository } from "../../modules/cases/infrastructure/postgresql-school-target-repository.ts";
import type {
  PostgreSqlAdapter,
  PostgreSqlQueryResult,
  PostgreSqlTransaction,
} from "../../modules/cases/infrastructure/postgresql.ts";
import {
  persistResolvedSchoolPin,
  resolveSchoolTargetView,
  type ResolvedSchoolTargetView,
} from "../../modules/schools/application/resolved-view.ts";

const ids = Object.freeze({
  organization: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  case: "10000000-0000-4000-8000-000000000003",
  school: "10000000-0000-4000-8000-000000000004",
  snapshot: "10000000-0000-4000-8000-000000000005",
  target: "10000000-0000-4000-8000-000000000006",
  revision: "10000000-0000-4000-8000-000000000007",
  audit: "10000000-0000-4000-8000-000000000008",
  outbox: "10000000-0000-4000-8000-000000000009",
});
const CREATED_AT = "2026-08-18T00:00:00.000Z";
const resolved = resolveSchoolTargetView({
  base: {
    organizationId: ids.organization,
    schoolId: ids.school,
    snapshotId: ids.snapshot,
    sourceSchoolKey: "synthetic-school-001",
    fields: { school_name_zh: "Synthetic School", district: "Central" },
  },
  revisions: [],
});

test("creates target, resolved pin and effects through one Cases transaction", async () => {
  const database = new ScriptedAdapter([
    rows([caseRow("background_collection")]),
    rows([{ id: "claim" }]),
    rows([{ request_hash: "a".repeat(64), state: "in_progress", result_reference: null }]),
    empty(),
    rows([decisionRow()]),
    empty(),
    empty(),
    rows([{ id: "completed" }]),
  ]);
  const schools = new ScriptedSchools();
  const repository = new PostgresqlSchoolTargetRepository(database, schools);

  const item = await repository.createSchoolTarget(createInput());

  assert.equal(item.targetId, ids.target);
  assert.equal(item.intakeYear, 2027);
  assert.equal(item.admissionType, "hk_k12_standard_v1");
  assert.equal(item.resolvedRevisionId, ids.revision);
  assert.equal(database.transactions, 1);
  assert.equal(schools.readCalls, 1);
  assert.equal(schools.appendCalls, 1);
  const statements = database.statements.map(compact);
  assert.match(statements[0], /FROM cases_service_cases/);
  assert.match(statements[1], /INSERT INTO shared_idempotency_records/);
  assert.match(statements[3], /FROM cases_school_targets/);
  assert.match(statements[4], /cases_create_candidate_school_target/);
  assert.match(statements[5], /INSERT INTO audit_events/);
  assert.match(statements[6], /INSERT INTO audit_outbox/);
  assert.match(statements[7], /UPDATE shared_idempotency_records/);
  assert.equal(statements.some((sql) => /INSERT INTO schools_/i.test(sql)), false);
});

test("returns at most the first three untargeted school options after stable sorting", async () => {
  const targeted = resolvedSchool("10000000-0000-4000-8000-000000000010", "Already Targeted");
  const alphaLater = resolvedSchool("10000000-0000-4000-8000-000000000015", "Alpha");
  const charlie = resolvedSchool("10000000-0000-4000-8000-000000000012", "Charlie");
  const bravo = resolvedSchool("10000000-0000-4000-8000-000000000014", "Bravo");
  const alphaEarlier = resolvedSchool("10000000-0000-4000-8000-000000000013", "Alpha");
  const database = new ScriptedAdapter([
    rows([caseRow("background_collection")]),
    rows([targetRow(targeted)]),
  ]);
  const schools = new ScriptedSchools([
    targeted,
    alphaLater,
    charlie,
    bravo,
    alphaEarlier,
  ]);
  const repository = new PostgresqlSchoolTargetRepository(database, schools);

  const workspace = await repository.readSchoolTargetWorkspace({
    organizationId: ids.organization,
    actorUserId: ids.actor,
    actorRole: "advisor",
    caseId: ids.case,
  });

  assert.deepEqual(
    workspace.schoolOptions.map(({ schoolId }) => schoolId),
    [alphaEarlier.view.schoolId, alphaLater.view.schoolId, bravo.view.schoolId],
  );
});

test("fails closed before school resolution when the Case stage is not allowed", async () => {
  const database = new ScriptedAdapter([
    rows([caseRow("signed")]),
    rows([{ id: "claim" }]),
    rows([{ request_hash: "a".repeat(64), state: "in_progress", result_reference: null }]),
  ]);
  const schools = new ScriptedSchools();
  const repository = new PostgresqlSchoolTargetRepository(database, schools);

  await assert.rejects(
    repository.createSchoolTarget(createInput()),
    targetError("SCHOOL_TARGET_STAGE_NOT_ALLOWED"),
  );
  assert.equal(database.failedTransactions, 1);
  assert.equal(schools.readCalls, 0);
  assert.equal(database.statements.some((sql) => sql.includes("audit_events")), false);
});

test("completed idempotency replays the pinned target without a second mutation", async () => {
  const database = new ScriptedAdapter([
    rows([caseRow("school_selection_confirmed")]),
    empty(),
    rows([{ request_hash: "a".repeat(64), state: "completed", result_reference: ids.target }]),
    rows([targetRow()]),
  ]);
  const schools = new ScriptedSchools();
  const repository = new PostgresqlSchoolTargetRepository(database, schools);

  const item = await repository.createSchoolTarget(createInput());

  assert.equal(item.targetId, ids.target);
  assert.equal(schools.readCalls, 0);
  assert.equal(database.statements.some((sql) => sql.includes("cases_create_candidate")), false);
});

test("every post-claim failure exits the transaction before idempotency completion", async () => {
  const prefix = () => [
    rows([caseRow("background_collection")]),
    rows([{ id: "claim" }]),
    rows([{ request_hash: "a".repeat(64), state: "in_progress", result_reference: null }]),
    empty(),
  ];
  const scenarios = [
    { results: prefix(), failAppend: true },
    { results: [...prefix(), new Error("target failure")] },
    { results: [...prefix(), rows([decisionRow()]), new Error("audit failure")] },
    { results: [...prefix(), rows([decisionRow()]), empty(), new Error("outbox failure")] },
    {
      results: [...prefix(), rows([decisionRow()]), empty(), empty(),
        new Error("idempotency completion failure")],
    },
  ];

  for (const scenario of scenarios) {
    const database = new ScriptedAdapter(scenario.results);
    const schools = new ScriptedSchools();
    schools.failAppend = scenario.failAppend ?? false;
    const repository = new PostgresqlSchoolTargetRepository(database, schools);
    await assert.rejects(repository.createSchoolTarget(createInput()));
    assert.equal(database.failedTransactions, 1);
    assert.equal(database.transactions, 1);
  }
});

test("maps only the SchoolTarget identity unique constraint to duplicate", async () => {
  const database = new ScriptedAdapter([
    ...creationPrefix(),
    postgresUniqueViolation("cases_school_targets_identity_idx"),
  ]);
  const repository = new PostgresqlSchoolTargetRepository(database, new ScriptedSchools());

  await assert.rejects(
    repository.createSchoolTarget(createInput()),
    targetError("SCHOOL_TARGET_DUPLICATE"),
  );
});

test("preserves unrelated PostgreSQL unique violations", async () => {
  const uniqueViolation = postgresUniqueViolation("audit_events_pkey");
  const database = new ScriptedAdapter([
    ...creationPrefix(),
    rows([decisionRow()]),
    uniqueViolation,
  ]);
  const repository = new PostgresqlSchoolTargetRepository(database, new ScriptedSchools());

  await assert.rejects(
    repository.createSchoolTarget(createInput()),
    (error: unknown) => {
      assert.equal(error, uniqueViolation);
      return true;
    },
  );
});

class ScriptedSchools {
  readCalls = 0;
  appendCalls = 0;
  failAppend = false;
  private readonly current: readonly ResolvedSchoolTargetView[];

  constructor(current: readonly ResolvedSchoolTargetView[] = [resolved]) {
    this.current = current;
  }

  async listCurrentResolvedSchools(): Promise<readonly ResolvedSchoolTargetView[]> {
    return this.current;
  }

  async readCurrentResolvedSchool(): Promise<ResolvedSchoolTargetView> {
    this.readCalls += 1;
    return resolved;
  }

  async appendResolvedRevision(): Promise<ResolvedSchoolTargetView> {
    this.appendCalls += 1;
    if (this.failAppend) throw new Error("resolved revision failure");
    return persistResolvedSchoolPin(resolved, ids.revision);
  }
}

class ScriptedAdapter implements PostgreSqlAdapter, PostgreSqlTransaction {
  readonly statements: string[] = [];
  transactions = 0;
  failedTransactions = 0;
  private readonly results: Array<PostgreSqlQueryResult<Record<string, unknown>> | Error>;

  constructor(results: Array<PostgreSqlQueryResult<Record<string, unknown>> | Error>) {
    this.results = [...results];
  }

  async transaction<T>(
    _context: Readonly<{ organizationId: string; actorUserId: string }>,
    work: (transaction: PostgreSqlTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactions += 1;
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
    if (result instanceof Error) throw result;
    return result as PostgreSqlQueryResult<Row>;
  }
}

function createInput(): Parameters<SchoolTargetRepository["createSchoolTarget"]>[0] {
  const audit = buildAuditEvent({
    id: ids.audit,
    organizationId: ids.organization,
    actorUserId: ids.actor,
    actorKind: "user",
    eventType: "cases.school_target_created",
    eventVersion: 1,
    action: "create",
    resourceType: "SchoolTarget",
    resourceId: ids.target,
    outcome: "succeeded",
    requestId: "request-phase2d",
    occurredAt: CREATED_AT,
    metadata: { record_version: 1 },
  });
  const outbox = buildOutboxMessage({
    id: ids.outbox,
    auditEventId: ids.audit,
    organizationId: ids.organization,
    aggregateType: "SchoolTarget",
    aggregateId: ids.target,
    eventType: "cases.school_target_created",
    eventVersion: 1,
    idempotencyKey: "phase2d-outbox",
    requestId: "request-phase2d",
    payload: {
      aggregate_id: ids.target,
      record_version: 1,
      request_id: "request-phase2d",
    },
    availableAt: CREATED_AT,
    createdAt: CREATED_AT,
  });
  return {
    organizationId: ids.organization,
    actorUserId: ids.actor,
    actorRole: "advisor",
    caseId: ids.case,
    targetId: ids.target,
    schoolId: ids.school,
    proposedResolvedRevisionId: ids.revision,
    expectedResolutionSha256: resolved.view.resolutionSha256,
    requestId: "request-phase2d",
    idempotencyKey: "phase2d-target",
    requestHash: "a".repeat(64),
    createdAtMs: Date.parse(CREATED_AT),
    effects: buildAtomicMutationEffects({ audit, outbox }),
  };
}

function caseRow(stage: string) {
  return { id: ids.case, stage, intake_year: 2027, admission_type: "hk_k12_standard_v1" };
}

function decisionRow() {
  return {
    decision: "allowed",
    target_id: ids.target,
    school_id: ids.school,
    intake_year: 2027,
    admission_type: "hk_k12_standard_v1",
    state: "candidate",
    record_version: 1,
    resolved_revision_id: ids.revision,
    resolution_sha256: resolved.view.resolutionSha256,
    created_at: CREATED_AT,
  };
}

function targetRow(view: ResolvedSchoolTargetView = resolved) {
  return {
    target_id: ids.target,
    school_id: view.view.schoolId,
    state: "candidate",
    intake_year: 2027,
    admission_type: "hk_k12_standard_v1",
    record_version: 1,
    resolved_revision_id: ids.revision,
    resolution_sha256: view.view.resolutionSha256,
    created_at: CREATED_AT,
    fields_json: view.view.fields,
    source_school_key: view.view.sourceSchoolKey,
  };
}

function resolvedSchool(schoolId: string, displayName: string): ResolvedSchoolTargetView {
  return resolveSchoolTargetView({
    base: {
      organizationId: ids.organization,
      schoolId,
      snapshotId: ids.snapshot,
      sourceSchoolKey: `synthetic-${schoolId}`,
      fields: { school_name_zh: displayName },
    },
    revisions: [],
  });
}

function creationPrefix(): Array<PostgreSqlQueryResult<Record<string, unknown>> | Error> {
  return [
    rows([caseRow("background_collection")]),
    rows([{ id: "claim" }]),
    rows([{ request_hash: "a".repeat(64), state: "in_progress", result_reference: null }]),
    empty(),
  ];
}

function postgresUniqueViolation(constraint: string): Error & {
  readonly code: "23505";
  readonly constraint: string;
} {
  return Object.assign(new Error(`duplicate key violates ${constraint}`), {
    code: "23505" as const,
    constraint,
  });
}

function rows<Row extends Record<string, unknown>>(values: readonly Row[]): PostgreSqlQueryResult<Row> {
  return { rows: values, rowCount: values.length };
}

function empty(): PostgreSqlQueryResult<Record<string, unknown>> {
  return { rows: [], rowCount: 0 };
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function targetError(code: SchoolTargetError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof SchoolTargetError);
    assert.equal(error.code, code);
    return true;
  };
}
