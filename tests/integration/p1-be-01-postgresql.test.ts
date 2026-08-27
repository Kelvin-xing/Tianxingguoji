import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { Client, Pool } from "pg";

import {
  ONE_ROLE_SOURCE_COUNT,
  verifyCommittedOneRoleBaseline,
  type OneRoleGeneratedFile,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  createTenantTransactionRunner,
  type DatabasePool,
  type TenantTransaction,
} from "../../modules/shared/infrastructure/db.ts";
import {
  IdempotencyExecutionError,
  runIdempotentTransaction,
} from "../../modules/shared/infrastructure/postgresql-idempotency.ts";
import { hashRequestPayload } from "../../modules/shared/public.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const APP_ROLE = "tianxing_app";

const ids = Object.freeze({
  organization: "12000000-0000-4000-8000-000000000001",
  otherOrganization: "12000000-0000-4000-8000-000000000002",
  user: "12000000-0000-4000-8000-000000000003",
  legacyRecord: "12000000-0000-4000-8000-000000000004",
});

test("P1-BE-01 replays PostgreSQL 17 and freezes atomic actor-scoped transactions", {
  timeout: 180_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-p1-be-01-pg17-${suffix}`;
  const bootstrapPassword = randomBytes(32).toString("hex");
  const applicationPassword = randomBytes(32).toString("hex");
  let started = false;
  let application: Pool | undefined;
  let admin: Pool | undefined;

  try {
    await runDocker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_missing");
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", containerName,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env", "POSTGRES_DB=postgres", "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PASSWORD", "--publish", "127.0.0.1::5432", POSTGRES_IMAGE,
    ], "postgres_container_start", undefined, { ...process.env, POSTGRES_PASSWORD: bootstrapPassword });
    started = true;
    await waitForPostgres(containerName);
    await bootstrapDatabases(containerName, applicationPassword);

    const port = readLoopbackPort((await runDocker(
      ["port", containerName, "5432/tcp"], "postgres_port_inspection",
    )).stdout);
    const applicationUrl = databaseUrl(APP_ROLE, applicationPassword, port, "tianxing");
    const emptyApplicationUrl = databaseUrl(APP_ROLE, applicationPassword, port, "tianxing_empty");
    const adminUrl = databaseUrl("postgres", bootstrapPassword, port, "tianxing");
    const build = await verifyCommittedOneRoleBaseline();
    assert.equal(build.manifest.source_migrations.length, ONE_ROLE_SOURCE_COUNT);
    const sharedActorMigrationIndex = build.files.findIndex(({ name }) =>
      name === "036_202608260010_037_expand_shared_actor_scope.sql");
    const identityMigrationIndex = build.files.findIndex(({ name }) =>
      name === "037_202608260020_038_expand_identity_access_boundaries.sql");
    assert.notEqual(sharedActorMigrationIndex, -1);
    assert.equal(identityMigrationIndex, sharedActorMigrationIndex + 1);

    await applyUpgradeWithLegacyReceipt(applicationUrl, build.files, sharedActorMigrationIndex);
    await applyFiles(emptyApplicationUrl, build.files);
    await assertEmptyReplayContract(emptyApplicationUrl);

    application = new Pool({ connectionString: applicationUrl, max: 8 });
    admin = new Pool({ connectionString: adminUrl, max: 2 });
    await installSyntheticOwnerFactTable(admin);

    const runner = createTenantTransactionRunner(
      application as unknown as DatabasePool,
      { expectedLoginUser: APP_ROLE },
    );
    await assertLegacyReceiptReplay(runner, admin);
    await assertActorScopesDoNotCollide(runner, admin);
    await assertAtomicFailuresAndReplay(runner, admin);
    await assertInProgressIsRejected(runner);
    await assertTenantIsolation(application);
    await assertReturnedConnectionHasNoContext(applicationUrl);
    await assertImmutablePermissions(runner, admin);
  } finally {
    await application?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    if (started) {
      await runDocker(["rm", "--force", containerName], "postgres_container_cleanup")
        .catch(() => undefined);
    }
  }
});

async function applyUpgradeWithLegacyReceipt(
  applicationUrl: string,
  files: readonly OneRoleGeneratedFile[],
  targetMigrationIndex: number,
): Promise<void> {
  await applyFiles(applicationUrl, files.slice(0, targetMigrationIndex));
  const client = new Client({ connectionString: applicationUrl });
  await client.connect();
  try {
    await client.query(
      "INSERT INTO access_organizations (id, display_name, status) VALUES ($1,'P1 Synthetic','active'),($2,'P1 Other','disabled')",
      [ids.organization, ids.otherOrganization],
    );
    await client.query(
      "INSERT INTO identity_users (id, normalized_email, status) VALUES ($1,'p1-be-01@example.invalid','active')",
      [ids.user],
    );
    await client.query(`INSERT INTO shared_idempotency_records
      (id, organization_id, actor_user_id, operation, idempotency_key, request_hash,
       state, result_reference, response_hash, record_version, created_at, updated_at)
      VALUES ($1,$2,$3,'shared.legacy','legacy-user-key',$4,'in_progress',NULL,NULL,1,$5,$5)`,
    [ids.legacyRecord, ids.organization, ids.user, "a".repeat(64), "2026-08-26T00:00:00.000Z"]);
    await client.query(`UPDATE shared_idempotency_records
      SET state='completed', result_reference='legacy-receipt', response_hash=$2,
          record_version=2, updated_at=$3 WHERE id=$1`,
    [ids.legacyRecord, "b".repeat(64), "2026-08-26T00:00:01.000Z"]);
  } finally {
    await client.end();
  }
  await applyFiles(applicationUrl, files.slice(targetMigrationIndex));
}

async function applyFiles(
  connectionString: string,
  files: readonly OneRoleGeneratedFile[],
): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const file of files) {
      try {
        await client.query(file.contents);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${file.name}: ${message}`, { cause: error });
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function assertEmptyReplayContract(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const columns = await client.query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='shared_idempotency_records'
         AND column_name IN ('actor_kind','actor_opaque_id') ORDER BY column_name`);
    assert.deepEqual(columns.rows, [
      { column_name: "actor_kind", is_nullable: "NO" },
      { column_name: "actor_opaque_id", is_nullable: "NO" },
    ]);
    const count = await client.query<{ count: string }>(
      "SELECT count(*) FROM shared_idempotency_records",
    );
    assert.equal(count.rows[0]?.count, "0");
  } finally {
    await client.end();
  }
}

async function installSyntheticOwnerFactTable(admin: Pool): Promise<void> {
  await admin.query(`CREATE TABLE p1_be_01_business_facts (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES access_organizations(id),
    payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$')
  )`);
  await admin.query("REVOKE ALL ON TABLE p1_be_01_business_facts FROM PUBLIC");
  await admin.query(`GRANT SELECT, INSERT ON TABLE p1_be_01_business_facts TO ${APP_ROLE}`);
  await admin.query("ALTER TABLE p1_be_01_business_facts ENABLE ROW LEVEL SECURITY");
  await admin.query("ALTER TABLE p1_be_01_business_facts FORCE ROW LEVEL SECURITY");
  await admin.query(`CREATE POLICY p1_be_01_tenant_boundary ON p1_be_01_business_facts
    FOR ALL TO ${APP_ROLE}
    USING (organization_id::text = current_setting('app.organization_id', true))
    WITH CHECK (organization_id::text = current_setting('app.organization_id', true))`);
}

async function assertLegacyReceiptReplay(
  runner: ReturnType<typeof createTenantTransactionRunner>,
  admin: Pool,
): Promise<void> {
  const migrated = await admin.query<{
    actor_kind: string;
    actor_opaque_id: string;
    actor_user_id: string | null;
  }>("SELECT actor_kind,actor_opaque_id,actor_user_id FROM shared_idempotency_records WHERE id=$1",
  [ids.legacyRecord]);
  assert.deepEqual(migrated.rows[0], {
    actor_kind: "user",
    actor_opaque_id: ids.user,
    actor_user_id: ids.user,
  });

  const replay = await runIdempotentTransaction({
    runner,
    context: actorContext(ids.organization, "user", ids.user, "legacy-replay-request"),
    claim: {
      id: "12000000-0000-4000-8000-000000000005",
      organizationId: ids.organization,
      actorKind: "user",
      actorOpaqueId: ids.user,
      operation: "shared.legacy",
      key: "legacy-user-key",
      requestHash: "a".repeat(64),
      createdAt: "2026-08-26T00:00:02.000Z",
    },
    revalidate: async () => {},
    execute: async () => { throw new Error("legacy receipt executed twice"); },
  });
  assert.deepEqual(replay, {
    status: "replayed",
    state: "completed",
    resultReference: "legacy-receipt",
    responseHash: "b".repeat(64),
    recordVersion: 2,
  });

  const legacyInsert = await runner.run(
    { organizationId: ids.organization, actorUserId: ids.user },
    async (transaction) => transaction.query<{ actor_kind: string; actor_opaque_id: string }>({
      text: `INSERT INTO shared_idempotency_records
        (id,organization_id,actor_user_id,operation,idempotency_key,request_hash,
         state,result_reference,response_hash,record_version,created_at,updated_at)
        VALUES ($1,$2,$3,'shared.legacy.compat','legacy-compat-key',$4,
                'in_progress',NULL,NULL,1,$5,$5)
        ON CONFLICT (organization_id,actor_user_id,operation,idempotency_key)
        DO NOTHING
        RETURNING actor_kind,actor_opaque_id`,
      values: ["12000000-0000-4000-8000-000000000006", ids.organization, ids.user,
        "c".repeat(64), "2026-08-26T00:00:03.000Z"],
    }),
  );
  assert.deepEqual(legacyInsert.rows, [{ actor_kind: "user", actor_opaque_id: ids.user }]);
}

async function assertActorScopesDoNotCollide(
  runner: ReturnType<typeof createTenantTransactionRunner>,
  admin: Pool,
): Promise<void> {
  const requestHash = hashRequestPayload({ operation: "shared.actor-scope", value: 1 });
  for (const [index, actorKind] of (["portal", "worker"] as const).entries()) {
    const result = await runIdempotentTransaction({
      runner,
      context: actorContext(ids.organization, actorKind, ids.user, `scope-${actorKind}-request`),
      claim: {
        id: `12000000-0000-4000-8000-00000000001${index}`,
        organizationId: ids.organization,
        actorKind,
        actorOpaqueId: ids.user,
        operation: "shared.actor-scope",
        key: "same-key",
        requestHash,
        createdAt: `2026-08-26T00:00:0${index + 3}.000Z`,
      },
      revalidate: async () => {},
      execute: async () => ({
        state: "completed" as const,
        resultReference: `${actorKind}-receipt`,
        responseHash: hashRequestPayload({ actor_kind: actorKind }),
        updatedAt: `2026-08-26T00:00:1${index + 3}.000Z`,
        value: actorKind,
      }),
    });
    assert.equal(result.status, "executed");
  }
  const rows = await admin.query<{ actor_kind: string }>(`SELECT actor_kind
    FROM shared_idempotency_records WHERE organization_id=$1 AND operation='shared.actor-scope'
    ORDER BY actor_kind`, [ids.organization]);
  assert.deepEqual(rows.rows.map(({ actor_kind }) => actor_kind), ["portal", "worker"]);
}

async function assertAtomicFailuresAndReplay(
  runner: ReturnType<typeof createTenantTransactionRunner>,
  admin: Pool,
): Promise<void> {
  for (const [index, stage] of (["business", "audit", "outbox", "idempotency"] as const).entries()) {
    const fixture = atomicFixture(index + 20, `rollback-${stage}`);
    await assert.rejects(runAtomicMutation(runner, fixture, stage));
    await assertAtomicCounts(admin, fixture, 0);
  }

  const fixture = atomicFixture(30, "success");
  const first = await runAtomicMutation(runner, fixture, null);
  assert.equal(first.status, "executed");
  const replay = await runAtomicMutation(runner, fixture, null);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.resultReference, fixture.factId);
  await assertAtomicCounts(admin, fixture, 1);

  await assert.rejects(
    runIdempotentTransaction({
      runner,
      context: actorContext(ids.organization, "user", ids.user, "conflict-request"),
      claim: { ...fixture.claim, requestHash: "f".repeat(64) },
      revalidate: async () => {},
      execute: async () => { throw new Error("conflicting payload executed"); },
    }),
    (error: unknown) => error instanceof IdempotencyExecutionError &&
      error.code === "IDEMPOTENCY_KEY_REUSED",
  );
  await assertAtomicCounts(admin, fixture, 1);
}

async function runAtomicMutation(
  runner: ReturnType<typeof createTenantTransactionRunner>,
  fixture: ReturnType<typeof atomicFixture>,
  failAt: "business" | "audit" | "outbox" | "idempotency" | null,
) {
  return runIdempotentTransaction({
    runner,
    context: actorContext(ids.organization, "user", ids.user, fixture.requestId),
    claim: fixture.claim,
    revalidate: async () => {},
    execute: async (transaction) => {
      await transaction.query({
        text: "INSERT INTO p1_be_01_business_facts (id,organization_id,payload_hash) VALUES ($1,$2,$3)",
        values: [fixture.factId, ids.organization, fixture.claim.requestHash],
      });
      if (failAt === "business") throw new Error("synthetic business failure");
      await insertAudit(transaction, fixture, failAt === "audit");
      await insertOutbox(transaction, fixture, failAt === "outbox");
      return {
        state: "completed" as const,
        resultReference: fixture.factId,
        responseHash: failAt === "idempotency" ? "invalid" : fixture.responseHash,
        updatedAt: "2026-08-26T00:01:00.000Z",
        value: fixture.factId,
      };
    },
  });
}

async function insertAudit(
  transaction: TenantTransaction,
  fixture: ReturnType<typeof atomicFixture>,
  invalid: boolean,
): Promise<void> {
  await transaction.query({
    text: `INSERT INTO audit_events
      (id,organization_id,actor_user_id,actor_kind,event_type,event_version,action,
       resource_type,resource_id,outcome,request_id,occurred_at,metadata)
      VALUES ($1,$2,$3,'user','p1_be_01.fact_written',1,'create','P1Fact',$4,
              'succeeded',$5,$6,$7::jsonb)`,
    values: [fixture.auditId, ids.organization, ids.user, fixture.factId, fixture.requestId,
      "2026-08-26T00:00:30.000Z", JSON.stringify(invalid
        ? { unsafe: "x" }
        : { record_version: 1, status: "created", effect_type: "p1_be_01.fact_written" })],
  });
}

async function insertOutbox(
  transaction: TenantTransaction,
  fixture: ReturnType<typeof atomicFixture>,
  invalid: boolean,
): Promise<void> {
  const payload = invalid
    ? { unsafe: "x" }
    : { aggregate_id: fixture.factId, request_id: fixture.requestId,
        effect_type: "p1_be_01.fact_written", record_version: 1, status: "created" };
  await transaction.query({
    text: `INSERT INTO audit_outbox
      (id,audit_event_id,organization_id,aggregate_type,aggregate_id,event_type,
       event_version,idempotency_key,request_id,payload,status,attempt_count,available_at,
       created_at,updated_at)
      VALUES ($1,$2,$3,'P1Fact',$4,'p1_be_01.fact_written',1,$5,$6,$7::jsonb,
              'pending',0,$8,$8,$8)`,
    values: [fixture.outboxId, fixture.auditId, ids.organization, fixture.factId,
      `outbox-${fixture.label}`, fixture.requestId, JSON.stringify(payload),
      "2026-08-26T00:00:30.000Z"],
  });
}

async function assertAtomicCounts(
  admin: Pool,
  fixture: ReturnType<typeof atomicFixture>,
  expected: number,
): Promise<void> {
  const result = await admin.query<{ facts: number; audits: number; outbox: number; receipts: number }>(`
    SELECT
      (SELECT count(*)::int FROM p1_be_01_business_facts WHERE id=$1) AS facts,
      (SELECT count(*)::int FROM audit_events WHERE id=$2) AS audits,
      (SELECT count(*)::int FROM audit_outbox WHERE id=$3) AS outbox,
      (SELECT count(*)::int FROM shared_idempotency_records WHERE id=$4) AS receipts`,
  [fixture.factId, fixture.auditId, fixture.outboxId, fixture.claim.id]);
  assert.deepEqual(result.rows[0], {
    facts: expected,
    audits: expected,
    outbox: expected,
    receipts: expected,
  });
}

async function assertInProgressIsRejected(
  runner: ReturnType<typeof createTenantTransactionRunner>,
): Promise<void> {
  let signalStarted!: () => void;
  let signalFinish!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const finish = new Promise<void>((resolve) => { signalFinish = resolve; });
  const claim = {
    id: "12000000-0000-4000-8000-000000000040",
    organizationId: ids.organization,
    actorKind: "worker" as const,
    actorOpaqueId: "job-in-progress",
    operation: "shared.concurrent",
    key: "concurrent-key",
    requestHash: hashRequestPayload({ operation: "shared.concurrent" }),
    createdAt: "2026-08-26T00:02:00.000Z",
  };
  const first = runIdempotentTransaction({
    runner,
    context: actorContext(ids.organization, "worker", "job-in-progress", "concurrent-first"),
    claim,
    revalidate: async () => {},
    execute: async () => {
      signalStarted();
      await finish;
      return { state: "completed" as const, resultReference: "concurrent-receipt",
        responseHash: "c".repeat(64), updatedAt: "2026-08-26T00:02:01.000Z", value: true };
    },
  });
  await started;
  try {
    await assert.rejects(runIdempotentTransaction({
      runner,
      context: actorContext(ids.organization, "worker", "job-in-progress", "concurrent-second"),
      claim: { ...claim, id: "12000000-0000-4000-8000-000000000041" },
      revalidate: async () => {},
      execute: async () => { throw new Error("concurrent request executed"); },
    }), (error: unknown) => error instanceof IdempotencyExecutionError &&
      error.code === "IDEMPOTENCY_IN_PROGRESS");
  } finally {
    signalFinish();
  }
  assert.equal((await first).status, "executed");
}

async function assertTenantIsolation(application: Pool): Promise<void> {
  const runner = createTenantTransactionRunner(application as unknown as DatabasePool);
  for (const [organizationId, suffix] of [
    [ids.organization, "primary"], [ids.otherOrganization, "other"],
  ] as const) {
    await runIdempotentTransaction({
      runner,
      context: actorContext(organizationId, "system", `system-${suffix}`, `rls-${suffix}`),
      claim: { id: suffix === "primary"
          ? "12000000-0000-4000-8000-000000000050"
          : "12000000-0000-4000-8000-000000000051",
        organizationId, actorKind: "system", actorOpaqueId: `system-${suffix}`,
        operation: "shared.rls", key: "rls-key", requestHash: "d".repeat(64),
        createdAt: "2026-08-26T00:03:00.000Z" },
      revalidate: async () => {},
      execute: async () => ({ state: "completed" as const, resultReference: `rls-${suffix}`,
        responseHash: "e".repeat(64), updatedAt: "2026-08-26T00:03:01.000Z", value: true }),
    });
  }

  const [left, right] = await Promise.all([application.connect(), application.connect()]);
  try {
    await Promise.all([left.query("BEGIN"), right.query("BEGIN")]);
    await Promise.all([
      left.query("SELECT set_config('app.organization_id',$1,true)", [ids.organization]),
      right.query("SELECT set_config('app.organization_id',$1,true)", [ids.otherOrganization]),
    ]);
    const [leftRows, rightRows] = await Promise.all([
      left.query<{ organization_id: string }>(
        "SELECT organization_id FROM shared_idempotency_records WHERE operation='shared.rls'"),
      right.query<{ organization_id: string }>(
        "SELECT organization_id FROM shared_idempotency_records WHERE operation='shared.rls'"),
    ]);
    assert.deepEqual(leftRows.rows.map(({ organization_id }) => organization_id), [ids.organization]);
    assert.deepEqual(rightRows.rows.map(({ organization_id }) => organization_id),
      [ids.otherOrganization]);
  } finally {
    await Promise.all([left.query("ROLLBACK"), right.query("ROLLBACK")]);
    left.release();
    right.release();
  }
}

async function assertReturnedConnectionHasNoContext(applicationUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: applicationUrl, max: 1 });
  try {
    const runner = createTenantTransactionRunner(pool as unknown as DatabasePool);
    await runner.run(
      actorContext(ids.organization, "system", "cleanup-system", "cleanup-request"),
      async (transaction) => {
        const result = await transaction.query<{ organization_id: string }>({
          text: "SELECT current_setting('app.organization_id',true) AS organization_id",
        });
        assert.equal(result.rows[0]?.organization_id, ids.organization);
      },
    );
    const client = await pool.connect();
    try {
      const result = await client.query<Record<string, string | null>>(`SELECT
        current_setting('app.organization_id',true) AS organization_id,
        current_setting('app.actor_kind',true) AS actor_kind,
        current_setting('app.actor_opaque_id',true) AS actor_opaque_id,
        current_setting('app.actor_user_id',true) AS actor_user_id,
        current_setting('app.request_id',true) AS request_id,
        current_setting('app.correlation_id',true) AS correlation_id,
        current_setting('app.causation_id',true) AS causation_id`);
      assert.ok(Object.values(result.rows[0] ?? {}).every((value) => value === "" || value === null));
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function assertImmutablePermissions(
  runner: ReturnType<typeof createTenantTransactionRunner>,
  admin: Pool,
): Promise<void> {
  const privileges = await admin.query<{ privilege_type: string }>(`
    SELECT privilege_type FROM information_schema.role_table_grants
     WHERE grantee=$1 AND table_name='shared_idempotency_records'
     ORDER BY privilege_type`, [APP_ROLE]);
  assert.deepEqual(privileges.rows.map(({ privilege_type }) => privilege_type),
    ["INSERT", "SELECT", "UPDATE"]);
  await assert.rejects(runner.run(
    actorContext(ids.organization, "user", ids.user, "delete-request"),
    (transaction) => transaction.query({
      text: "DELETE FROM shared_idempotency_records WHERE id=$1",
      values: [ids.legacyRecord],
    }),
  ));
  await assert.rejects(runner.run(
    actorContext(ids.organization, "user", ids.user, "truncate-request"),
    (transaction) => transaction.query({
      text: "TRUNCATE TABLE shared_idempotency_records",
    }),
  ));
  const remaining = await admin.query<{ count: string }>(
    "SELECT count(*) FROM shared_idempotency_records WHERE id=$1", [ids.legacyRecord]);
  assert.equal(remaining.rows[0]?.count, "1");
}

function atomicFixture(sequence: number, label: string) {
  const component = String(sequence).padStart(3, "0");
  const factId = `12000000-0000-4000-8000-000000000${component}`;
  const auditId = `12000000-0000-4000-8001-000000000${component}`;
  const outboxId = `12000000-0000-4000-8002-000000000${component}`;
  const receiptId = `12000000-0000-4000-8003-000000000${component}`;
  const requestId = `p1-${label}-request`;
  return Object.freeze({
    label, factId, auditId, outboxId, requestId,
    responseHash: hashRequestPayload({ id: factId, record_version: 1 }),
    claim: Object.freeze({
      id: receiptId,
      organizationId: ids.organization,
      actorKind: "user" as const,
      actorOpaqueId: ids.user,
      operation: "p1_be_01.atomic",
      key: `atomic-${label}`,
      requestHash: hashRequestPayload({ operation: "p1_be_01.atomic", label }),
      createdAt: "2026-08-26T00:00:20.000Z",
    }),
  });
}

function actorContext(
  organizationId: string,
  actorKind: "user" | "portal" | "worker" | "system",
  actorOpaqueId: string,
  requestId: string,
) {
  return Object.freeze({ organizationId, actorKind, actorOpaqueId, requestId,
    correlationId: "p1-be-01-correlation", causationId: "p1-be-01-causation" });
}

async function bootstrapDatabases(containerName: string, applicationPassword: string): Promise<void> {
  await runDocker([
    "exec", "--interactive", containerName, "psql", "--set=ON_ERROR_STOP=1",
    "--username=postgres", "--dbname=postgres",
  ], "postgres_database_bootstrap", [
    `CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${applicationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
    `CREATE DATABASE tianxing OWNER ${APP_ROLE};`,
    `CREATE DATABASE tianxing_empty OWNER ${APP_ROLE};`,
    "",
  ].join("\n"));
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await runDocker(["exec", containerName, "pg_isready", "--username=postgres",
        "--host=127.0.0.1", "--dbname=postgres"], "postgres_readiness");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("P1-BE-01 PostgreSQL readiness failed.");
}

function databaseUrl(user: string, password: string, port: number, database: string): string {
  const url = new URL("postgresql://127.0.0.1");
  url.username = user;
  url.password = password;
  url.port = String(port);
  url.pathname = `/${database}`;
  return url.toString();
}

function readLoopbackPort(output: string): number {
  const match = output.trim().match(/^127\.0\.0\.1:(\d+)$/m);
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("P1-BE-01 PostgreSQL loopback port inspection failed.");
  }
  return port;
}

function runDocker(
  arguments_: readonly string[],
  stage: string,
  input?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", arguments_, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => reject(new Error(`P1-BE-01 Docker stage failed: ${stage}.`)));
    child.on("close", (code) => code === 0
      ? resolve({ stdout })
      : reject(new Error(`P1-BE-01 Docker stage failed: ${stage}.`)));
    child.stdin.end(input);
  });
}
