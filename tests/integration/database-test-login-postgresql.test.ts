import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { Client, Pool } from "pg";

import {
  DatabaseTestAuthenticationError,
  DatabaseTestLoginService,
} from "../../modules/identity/application/database-test-login.ts";
import { hashOpaqueSecret } from "../../modules/identity/application/opaque-secret.ts";
import {
  PostgresqlDatabaseTestSessionRepository,
  DatabaseTestRepositoryUnavailable,
} from "../../modules/identity/infrastructure/postgresql-database-test-repository.ts";
import { IdentityRepositoryError } from "../../modules/identity/application/session-port.ts";
import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  verifyCommittedOneRoleBaseline,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
} from "../../scripts/db/neon-test-synthetic-fixture.ts";
import {
  runDatabaseTestProvisionCli,
  type DatabaseTestProvisionTarget,
} from "../../scripts/db/provision-database-test-identity.ts";
import { seedNeonTestRelease1 } from "../../scripts/db/seed-neon-test-release1.ts";
import {
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const POSTGRES_MAJOR = 17;
const FOUNDER = NEON_TEST_PRINCIPALS[0]!;
const FOREIGN_ORGANIZATION_ID = "52000000-0000-4000-8000-000000000001";

type LoginDatabaseState = Readonly<{
  credentialCount: number;
  failedAttemptCount: number;
  locked: boolean;
  exactFounderIdentityCount: number;
  sessionCount: number;
  activeSessionCount: number;
  expectedSecretHashCount: number;
  plaintextSecretCount: number;
}>;

test("database-test login honors FORCE RLS on disposable PostgreSQL 17", {
  timeout: 240_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-login-pg17-${suffix}`;
  const bootstrapPassword = randomBytes(32).toString("hex");
  const applicationPassword = randomBytes(32).toString("hex");
  const identityPassword = randomBytes(32).toString("base64url");
  let started = false;
  let pool: Pool | undefined;
  let safeEvidence: Readonly<Record<string, unknown>> | undefined;

  try {
    await runDocker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_missing");
    await runDocker([
      "run",
      "--rm",
      "--detach",
      "--pull=never",
      "--name",
      containerName,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env",
      "POSTGRES_DB=postgres",
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      "POSTGRES_PASSWORD",
      "--publish",
      "127.0.0.1::5432",
      POSTGRES_IMAGE,
    ], "postgres_container_start", undefined, {
      ...process.env,
      POSTGRES_PASSWORD: bootstrapPassword,
    });
    started = true;
    await waitForPostgres(containerName);
    await runDocker([
      "exec",
      "--interactive",
      containerName,
      "psql",
      "--set=ON_ERROR_STOP=1",
      "--username=postgres",
      "--dbname=postgres",
    ], "postgres_database_bootstrap", [
      `CREATE ROLE ${ONE_ROLE_CANONICAL_ROLE} WITH`,
      "  LOGIN",
      `  PASSWORD '${applicationPassword}'`,
      "  NOSUPERUSER",
      "  NOCREATEDB",
      "  NOCREATEROLE",
      "  NOINHERIT",
      "  NOREPLICATION",
      "  NOBYPASSRLS;",
      `CREATE DATABASE tianxing OWNER ${ONE_ROLE_CANONICAL_ROLE};`,
      "",
    ].join("\n"));

    const portOutput = await runDocker(
      ["port", containerName, "5432/tcp"],
      "postgres_port_inspection",
    );
    const target = localBaselineTarget(readLoopbackPort(portOutput.stdout), applicationPassword);
    const postgresVersion = await readPostgresVersion(target);
    assert.equal(Number(postgresVersion.split(".")[0]), POSTGRES_MAJOR);

    const build = await verifyCommittedOneRoleBaseline();
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply",
      target,
      build,
      dependencies: {
        inspect: () => inspectBaselineWithNewClient(target),
        openExecutionConnection: async () => {
          const client = new Client(createOneRoleBaselineClientConfig(target));
          await client.connect();
          return Object.freeze({ client, close: () => client.end() });
        },
      },
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.generated_files, ONE_ROLE_SOURCE_COUNT + 1);
    assert.equal(baseline.marker, "installed");

    const seed = await seedNeonTestRelease1(target, "apply");
    assert.equal(seed.status, "pass");
    const provisioned = await runDatabaseTestProvisionCli({
      arguments: ["--password-stdin", `--email=${FOUNDER.email}`],
      inputStream: streamOf(Buffer.from(`${identityPassword}\n`)),
      readTarget: () => localProvisionTarget(target),
    });
    assert.equal(provisioned, "created");

    pool = new Pool({
      connectionString: target.connectionString,
      application_name: "tianxing-database-test-login-integration",
      max: 8,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      ssl: false,
    });
    const repository = new PostgresqlDatabaseTestSessionRepository(pool, ONE_ROLE_CANONICAL_ROLE);
    const login = new DatabaseTestLoginService(repository);

    const session = await login.createSession({
      email: FOUNDER.email,
      password: identityPassword,
    });
    assert.equal(session.actor.userId, FOUNDER.userId);
    assert.equal(session.actor.organizationId, NEON_TEST_ORGANIZATION.id);
    assert.equal(session.actor.role, "founder");
    assert.match(session.cookieSecret, /^[A-Za-z0-9_-]{43}$/);

    const resolved = await repository.findActorBySessionSecretHash({
      secretHash: hashOpaqueSecret(session.cookieSecret),
      nowMs: Date.now(),
      sensitiveAction: false,
    });
    assert.equal(resolved.userId, FOUNDER.userId);
    assert.equal(resolved.membershipId, FOUNDER.membershipId);
    assert.equal(resolved.roleBindingId, FOUNDER.roleBindingId);
    assert.equal(resolved.role, "founder");

    const afterFirstLogin = await inspectLoginDatabase(target, session.cookieSecret);
    assert.deepEqual(afterFirstLogin, {
      credentialCount: 1,
      failedAttemptCount: 0,
      locked: false,
      exactFounderIdentityCount: 1,
      sessionCount: 1,
      activeSessionCount: 1,
      expectedSecretHashCount: 1,
      plaintextSecretCount: 0,
    });

    const duplicateSessionLogin = new DatabaseTestLoginService(repository, {
      createId: () => session.actor.sessionId,
    });
    await assert.rejects(
      duplicateSessionLogin.createSession({
        email: FOUNDER.email,
        password: identityPassword,
      }),
      DatabaseTestRepositoryUnavailable,
    );
    assert.deepEqual(
      await inspectLoginDatabase(target, session.cookieSecret),
      afterFirstLogin,
    );

    const concurrentAttempts = await Promise.allSettled([
      login.createSession({ email: FOUNDER.email, password: identityPassword }),
      login.createSession({ email: FOUNDER.email, password: identityPassword }),
    ]);
    const concurrentFailures = concurrentAttempts.filter((result) => result.status === "rejected");
    assert.equal(concurrentFailures.length, 0, JSON.stringify({
      stage: "concurrent_login",
      postgres_codes: concurrentFailures.map((result) => safePostgresCode(result.reason)),
    }));
    const concurrentSessions = concurrentAttempts
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const concurrentResolution = await Promise.allSettled(
      concurrentSessions.map((created) => repository.findActorBySessionSecretHash({
        secretHash: hashOpaqueSecret(created.cookieSecret),
        nowMs: Date.now(),
        sensitiveAction: false,
      })),
    );
    assert.equal(
      concurrentResolution.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const revokedResolution = concurrentResolution.find((result) => result.status === "rejected");
    assert.ok(revokedResolution?.status === "rejected");
    assert.ok(revokedResolution.reason instanceof IdentityRepositoryError);
    const afterConcurrentLogin = await inspectLoginDatabase(target);
    assert.equal(afterConcurrentLogin.sessionCount, 3);
    assert.equal(afterConcurrentLogin.activeSessionCount, 1);

    await switchToForeignOrganization(target);
    try {
      await assert.rejects(
        login.createSession({ email: FOUNDER.email, password: identityPassword }),
        DatabaseTestAuthenticationError,
      );
    } finally {
      await restoreSyntheticOrganization(target);
    }
    assert.deepEqual(await inspectLoginDatabase(target), afterConcurrentLogin);

    const firstFourFailures = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        login.createSession({ email: FOUNDER.email, password: "wrong password" })
      ),
    );
    assert.equal(firstFourFailures.every((result) =>
      result.status === "rejected" && result.reason instanceof DatabaseTestAuthenticationError
    ), true);
    const afterFourFailures = await inspectLoginDatabase(target);
    assert.equal(afterFourFailures.failedAttemptCount, 4);
    assert.equal(afterFourFailures.locked, false);
    assert.equal(afterFourFailures.activeSessionCount, 1);

    await assert.rejects(
      login.createSession({ email: FOUNDER.email, password: "wrong password" }),
      DatabaseTestAuthenticationError,
    );
    const afterLock = await inspectLoginDatabase(target);
    assert.equal(afterLock.failedAttemptCount, 5);
    assert.equal(afterLock.locked, true);
    assert.equal(afterLock.activeSessionCount, 1);
    await assert.rejects(
      login.createSession({ email: FOUNDER.email, password: identityPassword }),
      DatabaseTestAuthenticationError,
    );
    assert.deepEqual(await inspectLoginDatabase(target), afterLock);

    safeEvidence = Object.freeze({
      status: "pass",
      postgres_version: postgresVersion,
      baseline: Object.freeze({
        baseline_id: ONE_ROLE_BASELINE_ID,
        generated_files: baseline.generated_files,
        marker: baseline.marker,
      }),
      login: Object.freeze({
        credential: "verified",
        session: "created_and_resolved",
        actor: "founder",
        organization_scope: "verified",
        opaque_cookie: "hash_only",
        injected_failure_rollback: "clean",
        concurrent_active_sessions: afterConcurrentLogin.activeSessionCount,
        foreign_tenant_attempt: "denied",
        lock_boundary: `${afterFourFailures.failedAttemptCount}_open_${afterLock.failedAttemptCount}_locked`,
      }),
    });
  } finally {
    if (pool) await pool.end().catch(() => {});
    if (started) {
      await runDocker(["rm", "--force", containerName], "postgres_container_cleanup");
    }
  }

  process.stdout.write(`${JSON.stringify({ ...safeEvidence, temporary_container: "removed" })}\n`);
});

async function inspectLoginDatabase(
  target: OneRoleBaselineTarget,
  cookieSecret?: string,
): Promise<LoginDatabaseState> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query(
      "SELECT set_config('app.organization_id', $1, false), set_config('app.actor_user_id', $2, false)",
      [NEON_TEST_ORGANIZATION.id, FOUNDER.userId],
    );
    const result = await client.query<{
      credential_count: number;
      failed_attempt_count: number;
      locked: boolean;
      exact_founder_identity_count: number;
      session_count: number;
      active_session_count: number;
      expected_secret_hash_count: number;
      plaintext_secret_count: number;
    }>(`
      SELECT
        (SELECT count(*)::int
           FROM public.identity_database_test_credentials AS credential
          WHERE credential.user_id = $1) AS credential_count,
        (SELECT credential.failed_attempt_count::int
           FROM public.identity_database_test_credentials AS credential
          WHERE credential.user_id = $1) AS failed_attempt_count,
        coalesce((SELECT credential.locked_until > transaction_timestamp()
                    FROM public.identity_database_test_credentials AS credential
                   WHERE credential.user_id = $1), false) AS locked,
        (SELECT count(*)::int
           FROM public.access_organization_memberships AS membership
           JOIN public.access_role_bindings AS role_binding
             ON role_binding.membership_id = membership.id
            AND role_binding.organization_id = membership.organization_id
            AND role_binding.user_id = membership.user_id
          WHERE membership.id = $2
            AND membership.organization_id = $3
            AND membership.user_id = $1
            AND membership.status = 'active'
            AND role_binding.id = $4
            AND role_binding.role = 'founder'
            AND role_binding.status = 'active') AS exact_founder_identity_count,
        (SELECT count(*)::int
           FROM public.identity_sessions AS session
          WHERE session.user_id = $1
            AND session.session_kind = 'database_test') AS session_count,
        (SELECT count(*)::int
           FROM public.identity_sessions AS session
          WHERE session.user_id = $1
            AND session.session_kind = 'database_test'
            AND session.status = 'active') AS active_session_count,
        (SELECT count(*)::int
           FROM public.identity_sessions AS session
          WHERE $5::bytea IS NOT NULL
            AND session.secret_hash = $5::bytea) AS expected_secret_hash_count,
        (SELECT count(*)::int
           FROM public.identity_sessions AS session
          WHERE $6::bytea IS NOT NULL
            AND session.secret_hash = $6::bytea) AS plaintext_secret_count
    `, [
      FOUNDER.userId,
      FOUNDER.membershipId,
      NEON_TEST_ORGANIZATION.id,
      FOUNDER.roleBindingId,
      cookieSecret ? Buffer.from(hashOpaqueSecret(cookieSecret), "hex") : null,
      cookieSecret ? Buffer.from(cookieSecret, "utf8") : null,
    ]);
    const row = result.rows[0];
    if (!row) throw new HarnessError("login_state_inspection");
    return Object.freeze({
      credentialCount: row.credential_count,
      failedAttemptCount: row.failed_attempt_count,
      locked: row.locked,
      exactFounderIdentityCount: row.exact_founder_identity_count,
      sessionCount: row.session_count,
      activeSessionCount: row.active_session_count,
      expectedSecretHashCount: row.expected_secret_hash_count,
      plaintextSecretCount: row.plaintext_secret_count,
    });
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("login_state_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

async function switchToForeignOrganization(target: OneRoleBaselineTarget): Promise<void> {
  await updateActiveOrganization(target, [
    ["UPDATE public.access_organizations SET status = 'disabled' WHERE id = $1", [NEON_TEST_ORGANIZATION.id]],
    [
      `INSERT INTO public.access_organizations (id, display_name, status)
       VALUES ($1, 'ENV01 Foreign Synthetic Organization', 'active')`,
      [FOREIGN_ORGANIZATION_ID],
    ],
  ]);
}

async function restoreSyntheticOrganization(target: OneRoleBaselineTarget): Promise<void> {
  await updateActiveOrganization(target, [
    ["DELETE FROM public.access_organizations WHERE id = $1", [FOREIGN_ORGANIZATION_ID]],
    ["UPDATE public.access_organizations SET status = 'active' WHERE id = $1", [NEON_TEST_ORGANIZATION.id]],
  ]);
}

async function updateActiveOrganization(
  target: OneRoleBaselineTarget,
  statements: readonly (readonly [string, readonly unknown[]])[],
): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    for (const [sql, values] of statements) await client.query(sql, [...values]);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new HarnessError("organization_isolation_setup");
  } finally {
    await client.end().catch(() => {});
  }
}

async function inspectBaselineWithNewClient(target: OneRoleBaselineTarget) {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    return await inspectOneRoleBaselineDatabase(client);
  } catch {
    throw new HarnessError("baseline_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

async function readPostgresVersion(target: OneRoleBaselineTarget): Promise<string> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    const result = await client.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    const version = result.rows[0]?.version;
    if (!version) throw new HarnessError("postgres_version_inspection");
    return version;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("postgres_version_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

function localBaselineTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({
    connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`,
    host: "127.0.0.1",
    port,
    database: "tianxing",
    user: ONE_ROLE_CANONICAL_ROLE,
    ssl: false,
  });
}

function localProvisionTarget(target: OneRoleBaselineTarget): DatabaseTestProvisionTarget {
  return Object.freeze({
    connectionString: target.connectionString,
    loginUser: target.user,
    databaseName: target.database,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
    ssl: target.ssl,
  });
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = await runDocker([
      "exec",
      containerName,
      "pg_isready",
      "--host=127.0.0.1",
      "--username=postgres",
      "--dbname=postgres",
    ], "postgres_readiness", undefined, process.env, true);
    if (probe.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new HarnessError("postgres_readiness_timeout");
}

function readLoopbackPort(output: string): number {
  const match = /^127\.0\.0\.1:([0-9]+)\s*$/.exec(output);
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new HarnessError("postgres_port_inspection");
  }
  return port;
}

async function* streamOf(chunk: Buffer): AsyncIterable<Buffer> {
  yield chunk;
}

class HarnessError extends Error {
  readonly code = "DATABASE_TEST_LOGIN_POSTGRESQL_HARNESS_FAILED" as const;
  readonly stage: string;

  constructor(stage: string) {
    super(`Database test login PostgreSQL integration harness failed at ${stage}.`);
    this.name = "HarnessError";
    this.stage = stage;
  }
}

async function runDocker(
  arguments_: readonly string[],
  failureStage: string,
  input?: string,
  environment: NodeJS.ProcessEnv = process.env,
  allowFailure = false,
): Promise<Readonly<{ exitCode: number; stdout: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", () => {});
    child.once("error", () => reject(new HarnessError(failureStage)));
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !allowFailure) {
        reject(new HarnessError(failureStage));
        return;
      }
      resolve(Object.freeze({ exitCode, stdout }));
    });
    child.stdin.end(input);
  });
}

function safePostgresCode(error: unknown): string | null {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!candidate || typeof candidate !== "object") return null;
    const record = candidate as { code?: unknown; severity?: unknown; cause?: unknown };
    if (
      typeof record.code === "string" &&
      /^[0-9A-Z]{5}$/.test(record.code) &&
      (record.severity === "ERROR" || record.severity === "FATAL" || record.severity === "PANIC")
    ) {
      return record.code;
    }
    candidate = record.cause;
  }
  return null;
}
