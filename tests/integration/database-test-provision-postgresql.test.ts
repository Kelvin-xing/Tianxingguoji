import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { Client } from "pg";

import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  verifyCommittedOneRoleBaseline,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  NEON_TEST_PRINCIPALS,
} from "../../scripts/db/neon-test-synthetic-fixture.ts";
import {
  DatabaseTestProvisionOperationError,
  runDatabaseTestProvisionCli,
  type DatabaseTestProvisionTarget,
} from "../../scripts/db/provision-database-test-identity.ts";
import { seedNeonTestRelease1 } from "../../scripts/db/seed-neon-test-release1.ts";
import {
  assertOneRoleBaselinePostflight,
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const POSTGRES_MAJOR = 17;
const FOUNDER_EMAIL = NEON_TEST_PRINCIPALS[0]!.email;
const MISSING_EMAIL = "missing@env01.test.invalid";

type CredentialState = Readonly<{
  totalCount: number;
  founderCount: number;
  missingCount: number;
  founderCredentialVersion: number | null;
}>;

test("provisions a synthetic identity with clean failure rollback on PostgreSQL 17", {
  timeout: 180_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-provision-pg17-${suffix}`;
  const bootstrapPassword = randomBytes(32).toString("hex");
  const applicationPassword = randomBytes(32).toString("hex");
  const identityPassword = randomBytes(32).toString("base64url");
  let started = false;
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
    const baselineTarget = localBaselineTarget(
      readLoopbackPort(portOutput.stdout),
      applicationPassword,
    );
    const provisionTarget = localProvisionTarget(baselineTarget);
    const postgresVersion = await readPostgresVersion(baselineTarget);
    assert.equal(Number(postgresVersion.split(".")[0]), POSTGRES_MAJOR);

    const build = await verifyCommittedOneRoleBaseline();
    const manifestSha256 = createHash("sha256").update(build.manifestJson).digest("hex");
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply",
      target: baselineTarget,
      build,
      dependencies: {
        inspect: () => inspectBaselineWithNewClient(baselineTarget),
        openExecutionConnection: async () => {
          const client = new Client(createOneRoleBaselineClientConfig(baselineTarget));
          await client.connect();
          return Object.freeze({ client, close: () => client.end() });
        },
      },
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.generated_files, ONE_ROLE_SOURCE_COUNT + 1);
    assert.equal(baseline.marker, "installed");

    const seed = await seedNeonTestRelease1(baselineTarget, "apply");
    assert.equal(seed.status, "pass");
    assert.equal(seed.mode, "apply");
    const before = await inspectCredentialState(baselineTarget);
    assert.deepEqual(before, {
      totalCount: 0,
      founderCount: 0,
      missingCount: 0,
      founderCredentialVersion: null,
    });

    const created = await runProvisionCli(
      provisionTarget,
      ["--password-stdin", `--email=${FOUNDER_EMAIL}`],
      identityPassword,
    );
    assert.equal(created, "created");
    const afterCreate = await inspectCredentialState(baselineTarget);
    assert.deepEqual(afterCreate, {
      totalCount: 1,
      founderCount: 1,
      missingCount: 0,
      founderCredentialVersion: 1,
    });

    let failed: DatabaseTestProvisionOperationError | undefined;
    try {
      await runProvisionCli(
        provisionTarget,
        ["--password-stdin", `--email=${MISSING_EMAIL}`],
        identityPassword,
      );
    } catch (error) {
      assert.ok(error instanceof DatabaseTestProvisionOperationError);
      failed = error;
    }
    assert.ok(failed);
    assert.equal(failed.originalFailure.failure_stage, "credential_lookup");
    assert.equal(failed.transactionStarted, true);
    assert.equal(failed.rollbackAttempt, "succeeded");
    assert.equal(failed.rollbackState, "clean");
    assert.equal(failed.commitResult, "not_attempted");
    assert.deepEqual(await inspectCredentialState(baselineTarget), afterCreate);

    const duplicateFlagResult = await runProvisionCli(
      provisionTarget,
      [
        "--password-stdin",
        `--email=${FOUNDER_EMAIL}`,
        "--password-stdin",
      ],
      identityPassword,
    );
    assert.equal(duplicateFlagResult, "unchanged");
    const afterDuplicateFlag = await inspectCredentialState(baselineTarget);
    assert.deepEqual(afterDuplicateFlag, afterCreate);

    const finalBaseline = await inspectBaselineWithNewClient(baselineTarget);
    assertOneRoleBaselinePostflight({
      state: finalBaseline,
      target: baselineTarget,
      mode: "apply",
      manifestSha256,
    });

    safeEvidence = Object.freeze({
      status: "pass",
      postgres_version: postgresVersion,
      baseline: Object.freeze({
        baseline_id: ONE_ROLE_BASELINE_ID,
        generated_files: baseline.generated_files,
        marker: baseline.marker,
      }),
      seed: Object.freeze({ status: seed.status, synthetic_only: true }),
      provision: Object.freeze({
        create: created,
        failed_attempt_stage: failed.originalFailure.failure_stage,
        failed_attempt_rollback: failed.rollbackState,
        credential_rows_after_failure: afterCreate.totalCount,
        duplicate_password_flag: duplicateFlagResult,
        credential_rows_after_duplicate_flag: afterDuplicateFlag.totalCount,
      }),
      final_contract: Object.freeze({
        marker_verified: true,
        canonical_owner_and_role: true,
      }),
    });
  } finally {
    if (started) {
      await runDocker(["rm", "--force", containerName], "postgres_container_cleanup");
    }
  }

  process.stdout.write(`${JSON.stringify({ ...safeEvidence, temporary_container: "removed" })}\n`);
});

async function runProvisionCli(
  target: DatabaseTestProvisionTarget,
  arguments_: readonly string[],
  password: string,
) {
  return runDatabaseTestProvisionCli({
    arguments: arguments_,
    inputStream: streamOf(Buffer.from(`${password}\n`)),
    readTarget: () => target,
  });
}

async function inspectCredentialState(
  target: OneRoleBaselineTarget,
): Promise<CredentialState> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const result = await client.query<{
      total_count: number;
      founder_count: number;
      missing_count: number;
      founder_credential_version: number | null;
    }>(`
      SELECT count(*)::int AS total_count,
             count(*) FILTER (
               WHERE identity_user.normalized_email = $1
             )::int AS founder_count,
             count(*) FILTER (
               WHERE identity_user.normalized_email = $2
             )::int AS missing_count,
             max(credential.credential_version) FILTER (
               WHERE identity_user.normalized_email = $1
             )::int AS founder_credential_version
        FROM public.identity_database_test_credentials AS credential
        JOIN public.identity_users AS identity_user ON identity_user.id = credential.user_id
    `, [FOUNDER_EMAIL, MISSING_EMAIL]);
    const row = result.rows[0];
    if (!row) throw new HarnessError("credential_state_inspection");
    return Object.freeze({
      totalCount: row.total_count,
      founderCount: row.founder_count,
      missingCount: row.missing_count,
      founderCredentialVersion: row.founder_credential_version,
    });
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("credential_state_inspection");
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

async function inspectBaselineWithNewClient(target: OneRoleBaselineTarget) {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await inspectOneRoleBaselineDatabase(client);
  } catch {
    throw new HarnessError("baseline_inspection");
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

async function readPostgresVersion(target: OneRoleBaselineTarget): Promise<string> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  let connected = false;
  try {
    await client.connect();
    connected = true;
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
    if (connected) await client.end().catch(() => {});
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
  readonly code = "DATABASE_TEST_PROVISION_POSTGRESQL_HARNESS_FAILED" as const;
  readonly stage: string;

  constructor(stage: string) {
    super(`Database test provision PostgreSQL integration harness failed at ${stage}.`);
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
