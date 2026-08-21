import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Client, Pool } from "pg";

import { checkLocalSyntheticReadiness } from "../../lib/runtime/local-synthetic-readiness.ts";
import { hashOpaqueSecret } from "../../modules/identity/application/opaque-secret.ts";
import { IdentityRepositoryError } from "../../modules/identity/application/session-port.ts";
import {
  DatabaseTestRepositoryUnavailable,
  PostgresqlDatabaseTestSessionRepository,
} from "../../modules/identity/infrastructure/postgresql-database-test-repository.ts";

import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_VERSION,
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
  assertOneRoleBaselinePostflight,
  assertOneRoleBaselinePreflight,
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  type OneRoleBaselineDatabaseState,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const FOUNDER = NEON_TEST_PRINCIPALS[0]!;
const FOREIGN_ORGANIZATION_ID = "52000000-0000-4000-8000-000000000001";

test("database-test login works through the local Next Dev HTTP runtime", {
  timeout: 300_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-login-dev-pg17-${suffix}`;
  const secretVolumeName = `tianxing-login-dev-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const identityPassword = randomBytes(32).toString("base64url");
  const appDirectory = await createIsolatedAppDirectory();
  let containerStarted = false;
  let secretVolumeCreated = false;
  let devServer: ChildProcess | undefined;
  let safeEvidence: Readonly<Record<string, unknown>> | undefined;

  try {
    await runDocker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_missing");
    await runDocker([
      "volume",
      "create",
      secretVolumeName,
    ], "postgres_secret_volume_create");
    secretVolumeCreated = true;
    await runDocker([
      "run",
      "--rm",
      "--interactive",
      "--pull=never",
      "--volume",
      `${secretVolumeName}:/run/secrets`,
      POSTGRES_IMAGE,
      "/bin/sh",
      "-c",
      "umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password",
    ], "postgres_secret_volume_populate", applicationPassword);
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
      "POSTGRES_DB=tianxing",
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      "POSTGRES_PASSWORD_FILE=/run/secrets/local_postgres_password",
      "--volume",
      `${secretVolumeName}:/run/secrets:ro`,
      "--volume",
      `${resolve("infra/local/postgres/init")}:/docker-entrypoint-initdb.d:ro`,
      "--volume",
      `${resolve("infra/local/postgres/healthcheck.sh")}:/usr/local/bin/tianxing-postgres-healthcheck:ro`,
      "--publish",
      "127.0.0.1::5432",
      POSTGRES_IMAGE,
    ], "postgres_container_start");
    containerStarted = true;
    await waitForPostgres(containerName);

    const portOutput = await runDocker(
      ["port", containerName, "5432/tcp"],
      "postgres_port_inspection",
    );
    const target = localTarget(readLoopbackPort(portOutput.stdout), applicationPassword);
    const postgresVersion = await readPostgresVersion(target);
    assert.equal(Number(postgresVersion.split(".")[0]), 17);
    await assertLocalBootstrapContract(target);

    const build = await verifyCommittedOneRoleBaseline();
    const manifestSha256 = createHash("sha256").update(build.manifestJson).digest("hex");
    const dryRun = await executeOneRoleBaselineRun({
      mode: "dry-run",
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
    assert.equal(dryRun.status, "pass");
    assert.equal(dryRun.postflight_state, "clean");
    assert.equal(dryRun.marker, "rolled_back");
    const cleanAfterDryRun = await inspectBaselineWithNewClient(target);
    assertOneRoleBaselinePreflight(cleanAfterDryRun, target);
    assert.equal(cleanAfterDryRun.publicObjectCount, 0);
    assert.equal(cleanAfterDryRun.marker, null);

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
    assert.equal(baseline.baseline_id, ONE_ROLE_BASELINE_ID);
    assert.equal(baseline.source_migrations, ONE_ROLE_SOURCE_COUNT);
    assert.equal(baseline.generated_files, 28);
    assert.equal(baseline.postflight_state, "installed");
    assert.deepEqual(baseline.verification, {
      role_contract: "verified",
      member_of_neon_superuser: false,
      granted_role_count: 0,
      marker_ownership: "verified",
      public_object_count: baseline.verification.public_object_count,
      public_wrong_owner_count: 0,
      rls_not_forced_count: 0,
      unsafe_security_definer_count: 0,
      migration_metadata: "absent",
      stale_dry_run_schema_count: 0,
    });
    assert.ok(baseline.verification.public_object_count > 0);

    const seed = await seedNeonTestRelease1(target, "apply");
    assert.equal(seed.status, "pass");
    assert.equal(seed.baseline.id, ONE_ROLE_BASELINE_ID);
    assert.equal(seed.baseline.transform_version, ONE_ROLE_TRANSFORM_VERSION);
    assert.equal(seed.baseline.source_migration_count, ONE_ROLE_SOURCE_COUNT);
    assert.equal(seed.baseline.manifest_sha256, manifestSha256);
    assert.ok(seed.public_table_count > 0);

    const readiness = await checkLocalSyntheticReadiness({
      environment: localReadinessEnvironment(target.connectionString),
      probes: {
        localstack: async () => ({ s3: true, sqs: true }),
        clamav: async () => undefined,
      },
    });
    assert.deepEqual(readiness, {
      mode: "local-synthetic",
      status: "ready",
      dependencies: {
        postgresql: "ready",
        postgresql_identity: "ready",
        postgresql_application: "ready",
        localstack_s3: "ready",
        localstack_sqs: "ready",
        clamav: "ready",
      },
    });

    assert.equal(await runDatabaseTestProvisionCli({
      arguments: ["--password-stdin", `--email=${FOUNDER.email}`],
      inputStream: streamOf(Buffer.from(`${identityPassword}\n`)),
      readTarget: () => localProvisionTarget(target),
    }), "created");

    const databaseContract = await inspectBaselineWithNewClient(target);
    assertDatabaseContract(databaseContract, target, manifestSha256);
    const httpPort = await reserveLoopbackPort();
    devServer = startNextDev(appDirectory, httpPort, target.connectionString);
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    await waitForNextDev(baseUrl, devServer);

    const wrongPassword = await postLogin(baseUrl, {
      email: FOUNDER.email,
      password: "incorrect-synthetic-password",
    });
    assertRedirect(wrongPassword, "/login?error=authentication_failed");
    assert.equal(wrongPassword.headers.get("set-cookie"), null);
    assert.deepEqual(await inspectSessionState(target), {
      failedAttemptCount: 1,
      sessionCount: 0,
      activeSessionCount: 0,
    });

    for (const field of ["organization_id", "role", "next"] as const) {
      const injected = await postLogin(baseUrl, {
        email: FOUNDER.email,
        password: identityPassword,
        [field]: field === "organization_id" ? NEON_TEST_ORGANIZATION.id : "founder",
      });
      assertRedirect(injected, "/login?error=authentication_failed");
      assert.equal(injected.headers.get("set-cookie"), null);
    }
    assert.deepEqual(await inspectSessionState(target), {
      failedAttemptCount: 1,
      sessionCount: 0,
      activeSessionCount: 0,
    });

    await switchToForeignOrganization(target);
    try {
      const crossTenant = await postLogin(baseUrl, {
        email: FOUNDER.email,
        password: identityPassword,
      });
      assertRedirect(crossTenant, "/login?error=authentication_failed");
      assert.equal(crossTenant.headers.get("set-cookie"), null);
    } finally {
      await restoreSyntheticOrganization(target);
    }
    assert.equal((await inspectSessionState(target)).sessionCount, 0);

    const successful = await postLogin(baseUrl, {
      email: FOUNDER.email,
      password: identityPassword,
    });
    assertRedirect(successful, "/today");
    const setCookie = requiredHeader(successful, "set-cookie");
    assert.match(setCookie, /^tx_session=[A-Za-z0-9_-]{43};/);
    assert.match(setCookie, /; HttpOnly/i);
    assert.match(setCookie, /; SameSite=Lax/i);
    assert.match(setCookie, /; Path=\//i);
    assert.doesNotMatch(setCookie, /; Secure/i);
    const cookie = setCookie.split(";", 1)[0]!;

    const me = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(me.status, 200);
    const meBody = await me.json() as {
      data?: { user_id?: string; organization_id?: string; role?: string };
    };
    assert.deepEqual({
      user_id: meBody.data?.user_id,
      organization_id: meBody.data?.organization_id,
      role: meBody.data?.role,
    }, {
      user_id: FOUNDER.userId,
      organization_id: NEON_TEST_ORGANIZATION.id,
      role: "founder",
    });
    const beforeFault = await inspectSessionState(target);
    assert.equal(beforeFault.activeSessionCount, 1);

    await installSessionInsertFailure(target);
    try {
      const failedReplacement = await postLogin(baseUrl, {
        email: FOUNDER.email,
        password: identityPassword,
      });
      assertRedirect(failedReplacement, "/login?error=service_unavailable");
      assert.equal(failedReplacement.headers.get("set-cookie"), null);
      assert.deepEqual(await inspectSessionState(target), beforeFault);
      assert.equal((await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { cookie },
      })).status, 200);
    } finally {
      await removeSessionInsertFailure(target);
    }

    const logout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    assertRedirect(logout, "/login");
    const clearedCookie = requiredHeader(logout, "set-cookie");
    assert.match(clearedCookie, /^tx_session=;/);
    assert.match(clearedCookie, /Max-Age=0/i);
    assert.match(clearedCookie, /HttpOnly/i);
    assert.match(clearedCookie, /SameSite=Lax/i);
    assert.doesNotMatch(clearedCookie, /; Secure/i);
    assert.equal((await inspectSessionState(target)).activeSessionCount, 0);
    await assertRepositoryRejectsRevokedSession(target, cookie);
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { cookie },
    })).status, 401);

    assertDatabaseContract(await inspectBaselineWithNewClient(target), target, manifestSha256);
    safeEvidence = Object.freeze({
      status: "pass",
      postgres: Object.freeze({
        version: postgresVersion,
        endpoint: "loopback",
        temporary_container: "removed_after_test",
      }),
      database_contract: Object.freeze({
        local_bootstrap: "verified",
        baseline_id: ONE_ROLE_BASELINE_ID,
        dry_run: "clean_rollback_independently_verified",
        transform_version: ONE_ROLE_TRANSFORM_VERSION,
        source_migrations: ONE_ROLE_SOURCE_COUNT,
        generated_files: baseline.generated_files,
        manifest_sha256: manifestSha256,
        canonical_role: ONE_ROLE_CANONICAL_ROLE,
        public_object_count: baseline.verification.public_object_count,
        public_table_count: seed.public_table_count,
        wrong_owner_count: 0,
        rls_not_forced_count: 0,
        unsafe_security_definer_count: 0,
        migration_metadata: "absent",
        stale_schema_count: 0,
        release1_seed: "same_definition_verified",
        readiness_postgresql: "all_three_probes_ready",
      }),
      dev_http: Object.freeze({
        login_entry: "database_test_route_contract",
        success: "303_cookie_and_actor_verified",
        invalid_fields: "rejected",
        invalid_credential_attempt: "fixed_failure_no_session",
        cross_tenant: "rejected",
        fault_rollback: "existing_session_preserved",
        logout: "revoked",
      }),
    });
  } finally {
    await stopNextDev(devServer);
    await rm(appDirectory, { recursive: true, force: true });
    if (containerStarted) {
      await runDocker(["rm", "--force", containerName], "postgres_container_cleanup");
    }
    if (secretVolumeCreated) {
      await runDocker(["volume", "rm", "--force", secretVolumeName], "postgres_secret_cleanup");
    }
  }

  process.stdout.write(`${JSON.stringify(safeEvidence)}\n`);
});

function assertDatabaseContract(
  state: OneRoleBaselineDatabaseState,
  target: OneRoleBaselineTarget,
  manifestSha256: string,
): void {
  assertOneRoleBaselinePostflight({ state, target, mode: "apply", manifestSha256 });
  assert.equal(state.marker?.baselineId, ONE_ROLE_BASELINE_ID);
  assert.equal(state.marker?.transformVersion, ONE_ROLE_TRANSFORM_VERSION);
  assert.equal(state.marker?.sourceMigrationCount, ONE_ROLE_SOURCE_COUNT);
  assert.equal(state.marker?.manifestSha256, manifestSha256);
  assert.equal(state.userName, ONE_ROLE_CANONICAL_ROLE);
  assert.equal(state.databaseOwner, ONE_ROLE_CANONICAL_ROLE);
  assert.equal(state.login, true);
  assert.equal(state.superuser, false);
  assert.equal(state.createDatabase, false);
  assert.equal(state.createRole, false);
  assert.equal(state.inherit, false);
  assert.equal(state.replication, false);
  assert.equal(state.bypassRls, false);
  assert.equal(state.grantedRoleCount, 0);
  assert.equal(state.publicWrongOwnerCount, 0);
  assert.equal(state.rlsNotForcedCount, 0);
  assert.equal(state.unsafeSecurityDefinerCount, 0);
  assert.equal(state.migrationSchemaPresent, false);
  assert.equal(state.migrationLedgerPresent, false);
  assert.equal(state.staleDryRunSchemaCount, 0);
}

function localTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({
    connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`,
    host: "127.0.0.1",
    port,
    database: "tianxing",
    user: ONE_ROLE_CANONICAL_ROLE,
    ssl: false,
  });
}

function localReadinessEnvironment(
  connectionString: string,
): Record<string, string | undefined> {
  return {
    APP_ENV: "development",
    APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "database-test",
    NODE_ENV: "development",
    LOCAL_SYNTHETIC_DATABASE_URL: connectionString,
    LOCAL_SYNTHETIC_LOCALSTACK_ENDPOINT: "http://127.0.0.1:4566",
    LOCAL_SYNTHETIC_AWS_REGION: "ap-east-1",
    LOCAL_SYNTHETIC_S3_BUCKET: "tianxing-local-documents",
    LOCAL_SYNTHETIC_SQS_QUEUE: "tianxing-local-document-scan",
    LOCAL_SYNTHETIC_SQS_DLQ: "tianxing-local-document-scan-dlq",
    LOCAL_SYNTHETIC_CLAMAV_HOST: "127.0.0.1",
    LOCAL_SYNTHETIC_CLAMAV_PORT: "3310",
    LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: "2000",
  };
}

async function assertLocalBootstrapContract(target: OneRoleBaselineTarget): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    const result = await client.query<{ contract_matches: boolean }>(`
      SELECT
        current_user = 'tianxing_app'
        AND current_database() = 'tianxing'
        AND application_role.rolcanlogin
        AND NOT application_role.rolsuper
        AND NOT application_role.rolcreatedb
        AND NOT application_role.rolcreaterole
        AND NOT application_role.rolinherit
        AND NOT application_role.rolreplication
        AND NOT application_role.rolbypassrls
        AND database_owner.rolname = 'tianxing_app'
        AND bootstrap_role.rolsuper
        AND NOT bootstrap_role.rolcanlogin
        AND (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolcanlogin) = 1
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.member = application_role.oid
        ) AS contract_matches
      FROM pg_catalog.pg_roles AS application_role
      JOIN pg_catalog.pg_database AS application_database
        ON application_database.datname = current_database()
      JOIN pg_catalog.pg_roles AS database_owner
        ON database_owner.oid = application_database.datdba
      JOIN pg_catalog.pg_roles AS bootstrap_role
        ON bootstrap_role.rolname = 'postgres'
      WHERE application_role.rolname = 'tianxing_app'
    `);
    assert.equal(result.rows[0]?.contract_matches, true);
  } catch {
    throw new HarnessError("local_bootstrap_contract");
  } finally {
    await client.end().catch(() => {});
  }
}

function localProvisionTarget(target: OneRoleBaselineTarget): DatabaseTestProvisionTarget {
  return Object.freeze({
    connectionString: target.connectionString,
    loginUser: target.user,
    databaseName: target.database,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
    ssl: false,
  });
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

async function inspectSessionState(target: OneRoleBaselineTarget) {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query(
      "SELECT set_config('app.organization_id', $1, false), set_config('app.actor_user_id', $2, false)",
      [NEON_TEST_ORGANIZATION.id, FOUNDER.userId],
    );
    const result = await client.query<{
      failed_attempt_count: number;
      session_count: number;
      active_session_count: number;
    }>(`
      SELECT
        (SELECT failed_attempt_count::int
           FROM public.identity_database_test_credentials
          WHERE user_id = $1) AS failed_attempt_count,
        (SELECT count(*)::int
           FROM public.identity_sessions
          WHERE user_id = $1 AND session_kind = 'database_test') AS session_count,
        (SELECT count(*)::int
           FROM public.identity_sessions
          WHERE user_id = $1 AND session_kind = 'database_test' AND status = 'active')
          AS active_session_count
    `, [FOUNDER.userId]);
    const row = result.rows[0];
    if (!row) throw new HarnessError("session_state_inspection");
    return Object.freeze({
      failedAttemptCount: row.failed_attempt_count,
      sessionCount: row.session_count,
      activeSessionCount: row.active_session_count,
    });
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("session_state_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

async function assertRepositoryRejectsRevokedSession(
  target: OneRoleBaselineTarget,
  cookie: string,
): Promise<void> {
  const secret = cookie.slice(cookie.indexOf("=") + 1);
  const pool = new Pool({
    ...createOneRoleBaselineClientConfig(target),
    max: 1,
  });
  try {
    const repository = new PostgresqlDatabaseTestSessionRepository(
      pool,
      ONE_ROLE_CANONICAL_ROLE,
    );
    try {
      await repository.findActorBySessionSecretHash({
        secretHash: hashOpaqueSecret(secret),
        nowMs: Date.now(),
        sensitiveAction: false,
      });
    } catch (error) {
      if (error instanceof IdentityRepositoryError) return;
      if (error instanceof DatabaseTestRepositoryUnavailable) {
        throw new HarnessError("revoked_session_repository_unavailable");
      }
      throw new HarnessError("revoked_session_repository_unexpected");
    }
    throw new HarnessError("revoked_session_repository_allowed");
  } finally {
    await pool.end().catch(() => {});
  }
}

async function switchToForeignOrganization(target: OneRoleBaselineTarget): Promise<void> {
  await updateOrganizations(target, [
    ["UPDATE public.access_organizations SET status = 'disabled' WHERE id = $1", [NEON_TEST_ORGANIZATION.id]],
    [
      "INSERT INTO public.access_organizations (id, display_name, status) VALUES ($1, 'Foreign Synthetic Organization', 'active')",
      [FOREIGN_ORGANIZATION_ID],
    ],
  ]);
}

async function restoreSyntheticOrganization(target: OneRoleBaselineTarget): Promise<void> {
  await updateOrganizations(target, [
    ["DELETE FROM public.access_organizations WHERE id = $1", [FOREIGN_ORGANIZATION_ID]],
    ["UPDATE public.access_organizations SET status = 'active' WHERE id = $1", [NEON_TEST_ORGANIZATION.id]],
  ]);
}

async function updateOrganizations(
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

async function installSessionInsertFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    CREATE FUNCTION public.test_fail_database_test_session_insert()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = 'XX001'; END; $$;
    CREATE TRIGGER test_fail_database_test_session_insert_trg
    BEFORE INSERT ON public.identity_sessions
    FOR EACH ROW WHEN (NEW.session_kind = 'database_test')
    EXECUTE FUNCTION public.test_fail_database_test_session_insert()
  `, "fault_injection_install");
}

async function removeSessionInsertFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    DROP TRIGGER IF EXISTS test_fail_database_test_session_insert_trg
      ON public.identity_sessions;
    DROP FUNCTION IF EXISTS public.test_fail_database_test_session_insert()
  `, "fault_injection_cleanup");
}

async function executeTestDdl(
  target: OneRoleBaselineTarget,
  sql: string,
  stage: string,
): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query(sql);
  } catch {
    throw new HarnessError(stage);
  } finally {
    await client.end().catch(() => {});
  }
}

async function createIsolatedAppDirectory(): Promise<string> {
  const root = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "tianxing-next-dev-http-"));
  const excluded = new Set([".git", ".next", "node_modules"]);
  try {
    for (const entry of await readdir(root)) {
      if (
        excluded.has(entry) ||
        entry.startsWith(".env") ||
        entry === ".DS_Store" ||
        entry === ".idea" ||
        entry === ".kition" ||
        entry === ".pnpm-store"
      ) continue;
      await cp(resolve(root, entry), join(directory, entry), { recursive: true });
    }
    await symlink(resolve(root, "node_modules"), join(directory, "node_modules"), "dir");
    return directory;
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new HarnessError("next_workspace_setup");
  }
}

function startNextDev(
  appDirectory: string,
  port: number,
  connectionString: string,
): ChildProcess {
  const nextBin = resolve("node_modules/next/dist/bin/next");
  return spawn(process.execPath, [
    nextBin,
    "dev",
    "--webpack",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd: appDirectory,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      NEXT_TELEMETRY_DISABLED: "1",
      APP_ENV: "development",
      NODE_ENV: "development",
      APP_RUNTIME_MODE: "local-synthetic",
      AUTH_MODE: "database-test",
      LOCAL_SYNTHETIC_DATABASE_URL: connectionString,
      LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  child.stdout?.resume();
  child.stderr?.resume();
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new HarnessError("next_dev_early_exit");
    try {
      const response = await fetch(`${baseUrl}/api/v1/auth/me`, { redirect: "manual" });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new HarnessError("next_dev_readiness_timeout");
}

async function stopNextDev(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise<boolean>((resolveStopped) => child.once("close", () => resolveStopped(true))),
    new Promise<boolean>((resolveStopped) => setTimeout(() => resolveStopped(false), 10_000)),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolveStopped) => child.once("close", () => resolveStopped()));
  }
}

async function postLogin(
  baseUrl: string,
  fields: Readonly<Record<string, string>>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

function assertRedirect(response: Response, pathnameAndSearch: string): void {
  assert.equal(response.status, 303);
  const location = requiredHeader(response, "location");
  const url = new URL(location);
  assert.equal(`${url.pathname}${url.search}`, pathnameAndSearch);
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new HarnessError(`missing_${name}_header`);
  return value;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => reject(new HarnessError("next_port_reservation")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error || port < 1) reject(new HarnessError("next_port_reservation"));
        else resolvePort(port);
      });
    });
  });
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = await runDocker([
      "exec",
      containerName,
      "/bin/sh",
      "/usr/local/bin/tianxing-postgres-healthcheck",
    ], "postgres_readiness", undefined, process.env, true);
    if (probe.exitCode === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
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
  readonly code = "DATABASE_TEST_LOGIN_DEV_HTTP_HARNESS_FAILED" as const;
  readonly stage: string;

  constructor(stage: string) {
    super(`Database-test login Dev HTTP harness failed at ${stage}.`);
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
  return new Promise((resolveRun, reject) => {
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
      resolveRun(Object.freeze({ exitCode, stdout }));
    });
    child.stdin.end(input);
  });
}
