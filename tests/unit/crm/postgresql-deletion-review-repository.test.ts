import assert from "node:assert/strict";
import test from "node:test";

import {
  workspaceCapabilitiesForRole,
  type RequestAccessActor,
} from "../../../modules/access/public.ts";
import type { CustomerDeletionGuardPort } from "../../../modules/cases/server.ts";
import {
  DeletionReviewError,
  DeletionReviewService,
  type DeletionReviewRepository,
} from "../../../modules/crm/application/deletion-review-service.ts";
import {
  PostgresqlDeletionReviewRepository,
  type DeletionReviewFailureEvidence,
} from "../../../modules/crm/infrastructure/postgresql-deletion-review-repository.ts";
import { hashRequestPayload } from "../../../modules/shared/public.ts";
import type {
  DatabaseQuery,
  DatabaseQueryResult,
  TenantDatabaseContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../../modules/shared/server.ts";

const IDS = {
  organization: "51000000-0000-4000-8000-000000000001",
  actor: "51000000-0000-4000-8000-000000000101",
  target: "51000000-0000-4000-8000-000000000601",
  idempotency: "71000000-0000-4000-8000-000000000001",
  audit: "71000000-0000-4000-8000-000000000002",
  outbox: "71000000-0000-4000-8000-000000000003",
} as const;
const NOW = "2026-08-23T00:00:00.000Z";
type Handler = (
  query: DatabaseQuery,
) => DatabaseQueryResult<Record<string, unknown>>;
const rows = (
  values: readonly Record<string, unknown>[],
  rowCount = values.length,
) => ({ rows: values, rowCount });
function runner(
  handler: Handler,
  contexts: TenantDatabaseContext[] = [],
): TenantTransactionRunner {
  return {
    async run<Result>(
      context: TenantDatabaseContext,
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ) {
      contexts.push(context);
      return operation({
        async query<Row = Record<string, unknown>>(
          query: DatabaseQuery,
        ): Promise<DatabaseQueryResult<Row>> {
          return handler(query) as DatabaseQueryResult<Row>;
        },
      });
    },
  };
}
function guard(
  overrides: Partial<{ actorScoped: boolean; hasOpenCase: boolean }> = {},
  calls: unknown[] = [],
): CustomerDeletionGuardPort {
  return {
    async evaluateStudentDeletion(input) {
      calls.push(input);
      return { actorScoped: true, hasOpenCase: false, ...overrides };
    },
  };
}
function actor(role: "founder" | "advisor" = "founder"): RequestAccessActor {
  return {
    userId: IDS.actor,
    organizationId: IDS.organization,
    roles: [role],
    workspaceCapabilities: workspaceCapabilitiesForRole(role),
  };
}

async function decisionInput(
  entityType: "student" | "guardian" = "student",
  decision: "approve" | "reject" = "approve",
  entityId: string = IDS.target,
) {
  let captured:
    | Parameters<DeletionReviewRepository["decideDeletion"]>[0]
    | undefined;
  const ids = [IDS.idempotency, IDS.audit, IDS.outbox];
  const stub: DeletionReviewRepository = {
    async requestDeletion() {
      throw Error("unused");
    },
    async listDeletionRequests() {
      return [];
    },
    async decideDeletion(input) {
      captured = input;
      return {
        entityType,
        entityId: input.command.entityId,
        status: decision === "approve" ? "deleted" : "active",
        recordVersion: 3,
        occurredAt: input.occurredAt,
      };
    },
  };
  await new DeletionReviewService(
    stub,
    () => ids.shift()!,
    () => Date.parse(NOW),
  ).decideDeletion({
    actor: actor(),
    command: {
      entityType,
      entityId,
      decision,
      expectedRecordVersion: 2,
      correlationRequestId: "decision-request",
      idempotencyKey: "decision-key",
    },
  });
  if (!captured) throw Error("capture");
  return captured;
}

function newHandler(
  input: Awaited<ReturnType<typeof decisionInput>>,
  sql: DatabaseQuery[],
  options: {
    current?: number;
    target?: readonly Record<string, unknown>[];
    update?: readonly Record<string, unknown>[];
    fail?: "update" | "audit" | "outbox" | "terminal";
  } = {},
): Handler {
  return (query) => {
    sql.push(query);
    if (query.text.includes("pg_try_advisory_xact_lock"))
      return rows([{ acquired: true }]);
    if (query.text.includes("FROM shared_idempotency_records")) return rows([]);
    if (query.text.includes("INSERT INTO shared_idempotency_records"))
      return rows([{ id: IDS.idempotency }]);
    if (query.text.includes("SELECT binding.id FROM identity_users"))
      return rows([{ id: "binding" }]);
    if (
      query.text.includes("SELECT id,display_name,status") &&
      query.text.includes("FOR UPDATE")
    )
      return rows(
        options.target ?? [
          {
            id: input.command.entityId,
            display_name: "Synthetic",
            status: "pending_delete",
            deletion_requested_at: NOW,
            record_version: 2,
          },
        ],
      );
    if (query.text.includes("FROM crm_student_guardian_relationships"))
      return rows(
        Array.from({ length: options.current ?? 0 }, (_, i) => ({
          id: `r${i}`,
        })),
      );
    if (
      query.text.includes(
        `UPDATE ${input.command.entityType === "student" ? "crm_students" : "crm_guardians"}`,
      )
    ) {
      if (options.fail === "update") throw Error("update");
      return rows(
        options.update ?? [
          {
            id: input.command.entityId,
            display_name: "Synthetic",
            status: input.command.decision === "approve" ? "deleted" : "active",
            deletion_requested_at:
              input.command.decision === "approve" ? NOW : null,
            record_version: 3,
          },
        ],
      );
    }
    if (query.text.includes("INSERT INTO audit_events")) {
      if (options.fail === "audit") throw Error("audit");
      return rows([{}]);
    }
    if (query.text.includes("INSERT INTO audit_outbox")) {
      if (options.fail === "outbox") throw Error("outbox");
      return rows([{}]);
    }
    if (query.text.includes("UPDATE shared_idempotency_records"))
      return options.fail === "terminal"
        ? rows([], 0)
        : rows([{ id: IDS.idempotency }]);
    throw Error(`unexpected ${query.text}`);
  };
}

test("approve Student follows Access-CRM-Cases-effects-terminal order", async () => {
  const input = await decisionInput();
  const sql: DatabaseQuery[] = [];
  const calls: unknown[] = [];
  const contexts: TenantDatabaseContext[] = [];
  const output = await new PostgresqlDeletionReviewRepository(
    runner(newHandler(input, sql), contexts),
    guard({}, calls),
  ).decideDeletion(input);
  assert.deepEqual(output, {
    entityType: "student",
    entityId: IDS.target,
    status: "deleted",
    recordVersion: 3,
    occurredAt: NOW,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(contexts[0], {
    organizationId: IDS.organization,
    actorKind: "user",
    actorOpaqueId: IDS.actor,
    actorUserId: IDS.actor,
    requestId: "decision-request",
  });
  const lock = sql.findIndex(
    (q) =>
      q.text.includes("FROM crm_students") && q.text.includes("FOR UPDATE"),
  );
  const update = sql.findIndex((q) => q.text.includes("UPDATE crm_students"));
  assert.ok(lock >= 0 && lock < update);
  assert.deepEqual(sql[lock]!.values, [IDS.organization, IDS.target]);
  assert.match(
    sql[update]!.text,
    /organization_id=\$1 AND id=\$2 AND status='pending_delete' AND record_version=\$3/,
  );
  assert.ok(sql.some((q) => q.text.includes("INSERT INTO audit_events")));
  assert.ok(sql.some((q) => q.text.includes("INSERT INTO audit_outbox")));
  assert.ok(
    sql.some((q) => q.text.includes("UPDATE shared_idempotency_records")),
  );
});

test("uppercase entity UUID is canonical in repository SQL and receipt", async () => {
  const uppercaseId = "A1000000-ABCD-4000-8000-000000000601";
  const canonicalId = uppercaseId.toLowerCase();
  const input = await decisionInput("student", "approve", uppercaseId);
  const sql: DatabaseQuery[] = [];
  const output = await new PostgresqlDeletionReviewRepository(
    runner(newHandler(input, sql)),
    guard(),
  ).decideDeletion(input);
  assert.equal(output.entityId, canonicalId);
  const lock = sql.find(
    (query) =>
      query.text.includes("FROM crm_students") &&
      query.text.includes("FOR UPDATE"),
  );
  assert.deepEqual(lock?.values, [IDS.organization, canonicalId]);
  assert.equal(
    sql.some((query) => query.values?.includes(uppercaseId)),
    false,
  );
});

test("approve Guardian locks current relationships without Cases guard", async () => {
  const input = await decisionInput("guardian");
  const sql: DatabaseQuery[] = [];
  const calls: unknown[] = [];
  const output = await new PostgresqlDeletionReviewRepository(
    runner(newHandler(input, sql)),
    guard({}, calls),
  ).decideDeletion(input);
  assert.equal(output.status, "deleted");
  assert.equal(calls.length, 0);
  assert.match(
    sql.find((q) => q.text.includes("FROM crm_student_guardian_relationships"))
      ?.text ?? "",
    /relationship\.organization_id=\$1\s+AND relationship\.guardian_id=\$2.*ORDER BY relationship\.id FOR UPDATE/s,
  );
});

test("reject Student and Guardian clear lifecycle fields and skip guards", async () => {
  for (const entityType of ["student", "guardian"] as const) {
    const input = await decisionInput(entityType, "reject");
    const sql: DatabaseQuery[] = [];
    const calls: unknown[] = [];
    const output = await new PostgresqlDeletionReviewRepository(
      runner(newHandler(input, sql)),
      guard({}, calls),
    ).decideDeletion(input);
    assert.equal(output.status, "active");
    assert.equal(calls.length, 0);
    assert.equal(
      sql.some((q) =>
        q.text.includes("FROM crm_student_guardian_relationships"),
      ),
      false,
    );
    const update = sql.find((q) =>
      q.text.includes(
        `UPDATE crm_${entityType === "student" ? "students" : "guardians"}`,
      ),
    );
    assert.match(
      update?.text ?? "",
      /deletion_requested_at=CASE WHEN \$5 THEN deletion_requested_at ELSE NULL END/,
    );
    assert.match(
      update?.text ?? "",
      /deletion_approved_at=CASE WHEN \$5 THEN \$6 ELSE NULL END/,
    );
    assert.match(
      update?.text ?? "",
      /deleted_at=CASE WHEN \$5 THEN \$6 ELSE NULL END/,
    );
  }
});

test("guards, missing target, wrong state, and stale version reject without update", async () => {
  const student = await decisionInput();
  const guardian = await decisionInput("guardian");
  await assert.rejects(
    new PostgresqlDeletionReviewRepository(
      runner(newHandler(student, [])),
      guard({ hasOpenCase: true }),
    ).decideDeletion(student),
    code("DELETION_REVIEW_CONFLICT"),
  );
  await assert.rejects(
    new PostgresqlDeletionReviewRepository(
      runner(newHandler(guardian, [], { current: 1 })),
      guard(),
    ).decideDeletion(guardian),
    code("DELETION_REVIEW_CONFLICT"),
  );
  for (const target of [
    [],
    [
      {
        id: IDS.target,
        display_name: "x",
        status: "active",
        deletion_requested_at: null,
        record_version: 2,
      },
    ],
    [
      {
        id: IDS.target,
        display_name: "x",
        status: "pending_delete",
        deletion_requested_at: NOW,
        record_version: 1,
      },
    ],
  ]) {
    const sql: DatabaseQuery[] = [];
    await assert.rejects(
      new PostgresqlDeletionReviewRepository(
        runner(newHandler(student, sql, { target })),
        guard(),
      ).decideDeletion(student),
    );
    assert.equal(
      sql.some((q) => q.text.includes("UPDATE crm_students")),
      false,
    );
  }
});

test("Advisor direct repository input is forbidden before SQL", async () => {
  const input = { ...(await decisionInput()), actorRole: "advisor" };
  let calls = 0;
  await assert.rejects(
    new PostgresqlDeletionReviewRepository(
      runner(() => {
        calls++;
        return rows([]);
      }),
      guard(),
    ).decideDeletion(input),
    code("DELETION_REVIEW_FORBIDDEN"),
  );
  assert.equal(calls, 0);
});

function completed(
  input: Awaited<ReturnType<typeof decisionInput>>,
  requestHash = input.requestHash,
  reference = `d:s:${IDS.target}:d:3:${NOW}`,
  responseHash?: string,
) {
  return {
    id: IDS.idempotency,
    organization_id: IDS.organization,
    actor_kind: "user",
    actor_opaque_id: IDS.actor,
    operation: "crm.decide_soft_deletion",
    idempotency_key: input.command.idempotencyKey,
    request_hash: requestHash,
    state: "completed",
    result_reference: reference,
    response_hash:
      responseHash ??
      hashRequestPayload({
        entity_type: "student",
        entity_id: IDS.target,
        status: "deleted",
        record_version: 3,
        occurred_at: NOW,
      }),
    record_version: 2,
    created_at: NOW,
    updated_at: NOW,
  };
}

test("same-hash replay reauthorizes and performs no business/effect/terminal write", async () => {
  const input = await decisionInput();
  const sql: DatabaseQuery[] = [];
  const row = completed(input);
  const handler: Handler = (q) => {
    sql.push(q);
    if (q.text.includes("pg_try_advisory_xact_lock"))
      return rows([{ acquired: true }]);
    if (q.text.includes("FROM shared_idempotency_records")) return rows([row]);
    if (q.text.includes("SELECT binding.id FROM identity_users"))
      return rows([{ id: "binding" }]);
    throw Error("unexpected replay query");
  };
  const output = await new PostgresqlDeletionReviewRepository(
    runner(handler),
    guard(),
  ).decideDeletion(input);
  assert.equal(output.occurredAt, NOW);
  assert.ok(
    sql.some((q) => q.text.includes("SELECT binding.id FROM identity_users")),
  );
  assert.equal(
    sql.some((q) =>
      /crm_students|audit_events|audit_outbox|UPDATE shared_idempotency_records/.test(
        q.text,
      ),
    ),
    false,
  );
});

test("different hash, advisory in-progress, bad reference, and bad hash fail closed", async () => {
  const input = await decisionInput();
  for (const row of [
    completed(input, "b".repeat(64)),
    completed(input, input.requestHash, `d|s|${IDS.target}|d|3|${NOW}`),
    completed(input, input.requestHash, undefined, "f".repeat(64)),
  ]) {
    const handler: Handler = (q) =>
      q.text.includes("pg_try_advisory_xact_lock")
        ? rows([{ acquired: true }])
        : q.text.includes("FROM shared_idempotency_records")
          ? rows([row])
          : q.text.includes("SELECT binding.id FROM identity_users")
            ? rows([{ id: "binding" }])
            : rows([]);
    await assert.rejects(
      new PostgresqlDeletionReviewRepository(
        runner(handler),
        guard(),
      ).decideDeletion(input),
    );
  }
  const busy: Handler = (q) =>
    q.text.includes("pg_try_advisory_xact_lock")
      ? rows([{ acquired: false }])
      : q.text.includes("SELECT binding.id FROM identity_users")
        ? rows([{ id: "binding" }])
        : rows([]);
  await assert.rejects(
    new PostgresqlDeletionReviewRepository(
      runner(busy),
      guard(),
    ).decideDeletion(input),
    code("DELETION_REVIEW_IDEMPOTENCY_IN_PROGRESS"),
  );
});

test("row validation and update/audit/outbox/terminal failures never succeed", async () => {
  const input = await decisionInput();
  for (const update of [
    [
      {
        id: "51000000-0000-4000-8000-000000000999",
        display_name: "x",
        status: "deleted",
        deletion_requested_at: NOW,
        record_version: 3,
      },
    ],
    [
      {
        id: IDS.target,
        display_name: "x",
        status: "active",
        deletion_requested_at: null,
        record_version: 3,
      },
    ],
    [
      {
        id: IDS.target,
        display_name: "x",
        status: "deleted",
        deletion_requested_at: NOW,
        record_version: 4,
      },
    ],
  ])
    await assert.rejects(
      new PostgresqlDeletionReviewRepository(
        runner(newHandler(input, [], { update })),
        guard(),
      ).decideDeletion(input),
      code("DELETION_REVIEW_UNAVAILABLE"),
    );
  for (const fail of ["update", "audit", "outbox", "terminal"] as const)
    await assert.rejects(
      new PostgresqlDeletionReviewRepository(
        runner(newHandler(input, [], { fail })),
        guard(),
      ).decideDeletion(input),
      code("DELETION_REVIEW_UNAVAILABLE"),
    );
});

test("observer reports fixed stage and allowlisted SQLSTATE only", async () => {
  const input = await decisionInput();
  const evidence: DeletionReviewFailureEvidence[] = [];
  const cause = Object.assign(Error("private"), {
    code: "57014",
    severity: "ERROR",
    query: "private",
  });
  const base = newHandler(input, []);
  const handler: Handler = (q) =>
    q.text.includes("SELECT id,display_name,status") &&
    q.text.includes("FOR UPDATE")
      ? (() => {
          throw cause;
        })()
      : base(q);
  await assert.rejects(
    new PostgresqlDeletionReviewRepository(runner(handler), guard(), (item) =>
      evidence.push(item),
    ).decideDeletion(input),
    code("DELETION_REVIEW_UNAVAILABLE"),
  );
  assert.deepEqual(evidence, [{ stage: "target_lock", postgresCode: "57014" }]);
  assert.doesNotMatch(JSON.stringify(evidence), /private|message|query/);
});

test("legacy requestDeletion remains operational", async () => {
  const input = await requestInput();
  const sql: DatabaseQuery[] = [];
  const handler: Handler = (q) => {
    sql.push(q);
    if (q.text.includes("INSERT INTO shared_idempotency_records"))
      return rows([{ id: IDS.idempotency }]);
    if (
      q.text.includes(
        "SELECT request_hash,state,result_reference,response_hash",
      )
    )
      return rows([
        {
          request_hash: input.requestHash,
          state: "in_progress",
          result_reference: null,
          response_hash: null,
        },
      ]);
    if (q.text.includes("SELECT binding.id FROM identity_users"))
      return rows([{ id: "binding" }]);
    if (
      q.text.includes("FROM crm_students") &&
      q.text.includes("organization_id=$1") &&
      q.text.includes("FOR UPDATE")
    )
      return rows([
        {
          id: IDS.target,
          display_name: "x",
          status: "active",
          deletion_requested_at: null,
          record_version: 1,
        },
      ]);
    if (q.text.includes("UPDATE crm_students"))
      return rows([
        {
          id: IDS.target,
          display_name: "x",
          status: "pending_delete",
          deletion_requested_at: NOW,
          record_version: 2,
        },
      ]);
    return rows([{}]);
  };
  const output = await new PostgresqlDeletionReviewRepository(
    runner(handler),
    guard(),
  ).requestDeletion(input);
  assert.equal(output.status, "pending_delete");
  const lock = sql.find(
    (query) =>
      query.text.includes("FROM crm_students") &&
      query.text.includes("FOR UPDATE"),
  );
  const update = sql.find((query) =>
    query.text.includes("UPDATE crm_students"),
  );
  assert.deepEqual(lock?.values, [IDS.organization, IDS.target]);
  assert.deepEqual(update?.values?.slice(0, 3), [
    IDS.organization,
    IDS.target,
    1,
  ]);
  assert.ok(
    sql.some((query) => query.text.includes("INSERT INTO audit_events")),
  );
});

test("Guardian request locks current relationships and only Advisors need historical Case scope", async () => {
  const founderInput = await guardianRequestInput("founder");
  const founderSql: string[] = [];
  const founderHandler: Handler = (query) => {
    founderSql.push(query.text);
    if (query.text.includes("INSERT INTO shared_idempotency_records"))
      return rows([{ id: IDS.idempotency }]);
    if (
      query.text.includes(
        "SELECT request_hash,state,result_reference,response_hash",
      )
    )
      return rows([
        {
          request_hash: founderInput.requestHash,
          state: "in_progress",
          result_reference: null,
          response_hash: null,
        },
      ]);
    if (query.text.includes("SELECT binding.id FROM identity_users"))
      return rows([{ id: "binding" }]);
    if (
      query.text.includes("FROM crm_guardians") &&
      query.text.includes("FOR UPDATE")
    )
      return rows([
        {
          id: IDS.target,
          display_name: "x",
          status: "active",
          deletion_requested_at: null,
          record_version: 1,
        },
      ]);
    if (query.text.includes("FROM crm_student_guardian_relationships"))
      return rows([]);
    if (query.text.includes("UPDATE crm_guardians"))
      return rows([
        {
          id: IDS.target,
          display_name: "x",
          status: "pending_delete",
          deletion_requested_at: NOW,
          record_version: 2,
        },
      ]);
    if (query.text.includes("UPDATE shared_idempotency_records"))
      return rows([{ id: IDS.idempotency }]);
    return rows([{}]);
  };
  const founderOutput = await new PostgresqlDeletionReviewRepository(
    runner(founderHandler),
    guard(),
  ).requestDeletion(founderInput);
  assert.equal(founderOutput.status, "pending_delete");
  assert.equal(
    founderSql.some((text) => text.includes("SELECT DISTINCT student_id")),
    false,
  );
  assert.match(
    founderSql.find((text) =>
      text.includes("FROM crm_student_guardian_relationships"),
    ) ?? "",
    /relationship\.organization_id=\$1\s+AND relationship\.guardian_id=\$2\s+AND relationship\.ends_at IS NULL/,
  );

  const advisorInput = await guardianRequestInput("advisor");
  const advisorSql: string[] = [];
  const calls: unknown[] = [];
  const advisorHandler: Handler = (query) => {
    advisorSql.push(query.text);
    if (query.text.includes("INSERT INTO shared_idempotency_records"))
      return rows([{ id: IDS.idempotency }]);
    if (
      query.text.includes(
        "SELECT request_hash,state,result_reference,response_hash",
      )
    )
      return rows([
        {
          request_hash: advisorInput.requestHash,
          state: "in_progress",
          result_reference: null,
          response_hash: null,
        },
      ]);
    if (query.text.includes("SELECT binding.id FROM identity_users"))
      return rows([{ id: "binding" }]);
    if (
      query.text.includes("FROM crm_guardians") &&
      query.text.includes("FOR UPDATE")
    )
      return rows([
        {
          id: IDS.target,
          display_name: "x",
          status: "active",
          deletion_requested_at: null,
          record_version: 1,
        },
      ]);
    if (
      query.text.includes("ends_at IS NULL") &&
      query.text.includes("FOR UPDATE")
    )
      return rows([]);
    if (query.text.includes("SELECT DISTINCT student_id"))
      return rows([{ student_id: "52000000-0000-4000-8000-000000000701" }]);
    if (query.text.includes("UPDATE crm_guardians"))
      return rows([
        {
          id: IDS.target,
          display_name: "x",
          status: "pending_delete",
          deletion_requested_at: NOW,
          record_version: 2,
        },
      ]);
    if (query.text.includes("UPDATE shared_idempotency_records"))
      return rows([{ id: IDS.idempotency }]);
    return rows([{}]);
  };
  const advisorOutput = await new PostgresqlDeletionReviewRepository(
    runner(advisorHandler),
    guard({}, calls),
  ).requestDeletion(advisorInput);
  assert.equal(advisorOutput.status, "pending_delete");
  assert.equal(calls.length, 1);
  assert.ok(
    advisorSql.some(
      (text) =>
        text.includes("SELECT DISTINCT relationship.student_id") &&
        text.includes("relationship.organization_id=$1"),
    ),
  );
});

test("Guardian current relationship conflict occurs before historical scope or writes", async () => {
  const input = await guardianRequestInput("advisor");
  const sql: string[] = [];
  const handler: Handler = (query) => {
    sql.push(query.text);
    if (query.text.includes("INSERT INTO shared_idempotency_records"))
      return rows([{ id: IDS.idempotency }]);
    if (
      query.text.includes(
        "SELECT request_hash,state,result_reference,response_hash",
      )
    )
      return rows([
        {
          request_hash: input.requestHash,
          state: "in_progress",
          result_reference: null,
          response_hash: null,
        },
      ]);
    if (query.text.includes("SELECT binding.id FROM identity_users"))
      return rows([{ id: "binding" }]);
    if (
      query.text.includes("FROM crm_guardians") &&
      query.text.includes("FOR UPDATE")
    )
      return rows([
        {
          id: IDS.target,
          display_name: "x",
          status: "active",
          deletion_requested_at: null,
          record_version: 1,
        },
      ]);
    if (
      query.text.includes("ends_at IS NULL") &&
      query.text.includes("FOR UPDATE")
    )
      return rows([{ id: "relationship" }]);
    return rows([{}]);
  };
  await assert.rejects(
    new PostgresqlDeletionReviewRepository(
      runner(handler),
      guard(),
    ).requestDeletion(input),
    code("DELETION_REVIEW_CONFLICT"),
  );
  assert.equal(
    sql.some((text) => text.includes("SELECT DISTINCT student_id")),
    false,
  );
  assert.equal(
    sql.some((text) => text.includes("UPDATE crm_guardians")),
    false,
  );
});

test("Student guard failures report customer_deletion_guard without private details", async () => {
  const input = await requestInput();
  const evidence: DeletionReviewFailureEvidence[] = [];
  const handler: Handler = (query) => {
    if (query.text.includes("INSERT INTO shared_idempotency_records"))
      return rows([{ id: IDS.idempotency }]);
    if (
      query.text.includes(
        "SELECT request_hash,state,result_reference,response_hash",
      )
    )
      return rows([
        {
          request_hash: input.requestHash,
          state: "in_progress",
          result_reference: null,
          response_hash: null,
        },
      ]);
    if (query.text.includes("SELECT binding.id FROM identity_users"))
      return rows([{ id: "binding" }]);
    if (
      query.text.includes("FROM crm_students") &&
      query.text.includes("FOR UPDATE")
    )
      return rows([
        {
          id: IDS.target,
          display_name: "x",
          status: "active",
          deletion_requested_at: null,
          record_version: 1,
        },
      ]);
    return rows([{}]);
  };
  const failingGuard: CustomerDeletionGuardPort = {
    async evaluateStudentDeletion() {
      throw Object.assign(new Error("private details"), {
        code: "XX000",
        severity: "ERROR",
      });
    },
  };
  await assert.rejects(
    new PostgresqlDeletionReviewRepository(
      runner(handler),
      failingGuard,
      (item) => evidence.push(item),
    ).requestDeletion(input),
    code("DELETION_REVIEW_UNAVAILABLE"),
  );
  assert.deepEqual(evidence, [
    { stage: "customer_deletion_guard", postgresCode: "OTHER" },
  ]);
});

async function requestInput() {
  let captured:
    | Parameters<DeletionReviewRepository["requestDeletion"]>[0]
    | undefined;
  const ids = [IDS.audit, IDS.outbox];
  const stub: DeletionReviewRepository = {
    async requestDeletion(value) {
      captured = value;
      return {
        entityType: "student",
        entityId: IDS.target,
        status: "pending_delete",
        deletionRequestedAt: NOW,
        recordVersion: 2,
      };
    },
    async listDeletionRequests() {
      return [];
    },
    async decideDeletion() {
      throw Error("unused");
    },
  };
  await new DeletionReviewService(
    stub,
    () => ids.shift()!,
    () => Date.parse(NOW),
  ).requestDeletion({
    actor: actor(),
    command: {
      entityType: "student",
      entityId: IDS.target,
      expectedRecordVersion: 1,
      reasonCode: "record.lifecycle.pending_delete_requested",
      requestId: "request",
      idempotencyKey: "request-key",
    },
  });
  if (!captured) throw Error("capture");
  return captured;
}
async function guardianRequestInput(actorRole: "founder" | "advisor") {
  let captured:
    | Parameters<DeletionReviewRepository["requestDeletion"]>[0]
    | undefined;
  const stub: DeletionReviewRepository = {
    async requestDeletion(value) {
      captured = value;
      return {
        entityType: "guardian",
        entityId: IDS.target,
        status: "pending_delete",
        deletionRequestedAt: NOW,
        recordVersion: 2,
      };
    },
    async listDeletionRequests() {
      return [];
    },
    async decideDeletion() {
      throw Error("unused");
    },
  };
  await new DeletionReviewService(
    stub,
    () => IDS.audit,
    () => Date.parse(NOW),
  ).requestDeletion({
    actor: actor(actorRole),
    command: {
      entityType: "guardian",
      entityId: IDS.target,
      expectedRecordVersion: 1,
      reasonCode: "record.lifecycle.pending_delete_requested",
      requestId: "guardian-request",
      idempotencyKey: `guardian-${actorRole}`,
    },
  });
  if (!captured) throw Error("capture");
  return captured;
}
const code = (expected: DeletionReviewError["code"]) => (error: unknown) =>
  error instanceof DeletionReviewError && error.code === expected;
