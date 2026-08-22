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
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
} from "../../scripts/db/neon-test-synthetic-fixture.ts";
import {
  NEON_TEST_SEED_TABLE_COUNTS,
  PROHIBITED_NEON_TEST_SEED_TABLES,
  seedNeonTestRelease1,
} from "../../scripts/db/seed-neon-test-release1.ts";
import {
  assertOneRoleBaselinePostflight,
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const POSTGRES_MAJOR = 17;
const EXPECTED_SEED_ROW_COUNT = Object.values(NEON_TEST_SEED_TABLE_COUNTS)
  .reduce((total, count) => total + count, 0);

type SeedDatabaseState = Readonly<{
  baselineVerified: boolean;
  seedTableCounts: Readonly<Record<string, number>>;
  seedRowCount: number;
  prohibitedRowCount: number;
  nonSeedPublicRowCount: number;
  publicTableCount: number;
}>;

test("dry-runs, applies, and idempotently reapplies the synthetic seed on PostgreSQL 17", {
  timeout: 180_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-neon-seed-pg17-${suffix}`;
  const bootstrapPassword = randomBytes(32).toString("hex");
  const applicationPassword = randomBytes(32).toString("hex");
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
    const target = localIntegrationTarget(
      readLoopbackPort(portOutput.stdout),
      applicationPassword,
    );
    const postgresVersion = await readPostgresVersion(target);
    assert.equal(Number(postgresVersion.split(".")[0]), POSTGRES_MAJOR);

    const build = await verifyCommittedOneRoleBaseline();
    const manifestSha256 = createHash("sha256").update(build.manifestJson).digest("hex");
    const baselineEvidence = await runBaselineApply(target, build);
    assert.equal(baselineEvidence.status, "pass");
    assert.equal(baselineEvidence.baseline_id, ONE_ROLE_BASELINE_ID);
    assert.equal(baselineEvidence.generated_files, ONE_ROLE_SOURCE_COUNT + 1);
    assert.equal(baselineEvidence.postflight_state, "installed");
    assert.equal(baselineEvidence.marker, "installed");

    const beforeSeed = await inspectSeedDatabase(target, manifestSha256, "seed_preflight");
    assertEmptySeedState(beforeSeed, "seed_preflight");

    const dryRunEvidence = await runSeed(target, "dry-run", "seed_dry_run");
    assert.equal(dryRunEvidence.status, "pass");
    assert.equal(dryRunEvidence.mode, "dry-run");
    const afterDryRun = await inspectSeedDatabase(
      target,
      manifestSha256,
      "seed_dry_run_postflight",
    );
    assertEmptySeedState(afterDryRun, "seed_dry_run_postflight");

    const applyEvidence = await runSeed(target, "apply", "seed_first_apply");
    assert.equal(applyEvidence.status, "pass");
    assert.equal(applyEvidence.mode, "apply");
    const afterFirstApply = await inspectSeedDatabase(
      target,
      manifestSha256,
      "seed_first_apply_postflight",
    );
    assertInstalledSeedState(afterFirstApply, "seed_first_apply_postflight");

    const reapplyEvidence = await runSeed(target, "apply", "seed_idempotent_apply");
    assert.equal(reapplyEvidence.status, "pass");
    assert.equal(reapplyEvidence.mode, "apply");
    const afterSecondApply = await inspectSeedDatabase(
      target,
      manifestSha256,
      "seed_idempotent_apply_postflight",
    );
    assertInstalledSeedState(afterSecondApply, "seed_idempotent_apply_postflight");
    if (JSON.stringify(afterFirstApply.seedTableCounts) !== JSON.stringify(afterSecondApply.seedTableCounts)) {
      throw new HarnessError("seed_idempotency_count_mismatch");
    }

    safeEvidence = Object.freeze({
      status: "pass",
      postgres_version: postgresVersion,
      baseline: Object.freeze({
        generated_files: baselineEvidence.generated_files,
        marker: baselineEvidence.marker,
        independent_postflight: "verified",
      }),
      seed: Object.freeze({
        dry_run: Object.freeze({
          transaction: "rolled_back",
          independent_seed_rows: afterDryRun.seedRowCount,
        }),
        first_apply: Object.freeze({
          fixture: "verified",
          seed_rows: afterFirstApply.seedRowCount,
        }),
        idempotent_apply: Object.freeze({
          fixture: "unchanged",
          seed_rows: afterSecondApply.seedRowCount,
        }),
      }),
      isolation: Object.freeze({
        baseline_marker: afterSecondApply.baselineVerified,
        canonical_owner_and_role: true,
        prohibited_domain_rows: afterSecondApply.prohibitedRowCount,
        non_seed_public_rows: afterSecondApply.nonSeedPublicRowCount,
        public_table_count: afterSecondApply.publicTableCount,
      }),
    });
  } finally {
    if (started) {
      await runDocker(
        ["rm", "--force", containerName],
        "postgres_container_cleanup",
      );
    }
  }

  process.stdout.write(`${JSON.stringify({ ...safeEvidence, temporary_container: "removed" })}\n`);
});

async function runBaselineApply(
  target: OneRoleBaselineTarget,
  build: Awaited<ReturnType<typeof verifyCommittedOneRoleBaseline>>,
) {
  try {
    return await executeOneRoleBaselineRun({
      mode: "apply",
      target,
      build,
      dependencies: {
        inspect: () => inspectBaselineWithNewClient(target, "baseline_postflight"),
        openExecutionConnection: async () => {
          const client = new Client(createOneRoleBaselineClientConfig(target));
          await client.connect();
          return Object.freeze({ client, close: () => client.end() });
        },
      },
    });
  } catch {
    throw new HarnessError("baseline_apply");
  }
}

async function runSeed(
  target: OneRoleBaselineTarget,
  mode: "dry-run" | "apply",
  failureStage: string,
) {
  try {
    return await seedNeonTestRelease1(target, mode);
  } catch {
    throw new HarnessError(failureStage);
  }
}

async function inspectSeedDatabase(
  target: OneRoleBaselineTarget,
  manifestSha256: string,
  failureStage: string,
): Promise<SeedDatabaseState> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query("SELECT set_config('app.organization_id', $1, false)", [
      NEON_TEST_ORGANIZATION.id,
    ]);
    await client.query("SELECT set_config('app.actor_user_id', $1, false)", [
      NEON_TEST_PRINCIPALS[0]!.userId,
    ]);
    const baselineState = await inspectOneRoleBaselineDatabase(client);
    assertOneRoleBaselinePostflight({
      state: baselineState,
      target,
      mode: "apply",
      manifestSha256,
    });

    const tables = await client.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    const seedTableNames = new Set(Object.keys(NEON_TEST_SEED_TABLE_COUNTS));
    const prohibitedTableNames = new Set<string>(PROHIBITED_NEON_TEST_SEED_TABLES);
    const seedTableCounts: Record<string, number> = {};
    let seedRowCount = 0;
    let prohibitedRowCount = 0;
    let nonSeedPublicRowCount = 0;

    for (const { tablename } of tables.rows) {
      const result = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM public.${quoteIdentifier(tablename)}`,
      );
      const count = result.rows[0]?.count ?? 0;
      if (seedTableNames.has(tablename)) {
        seedTableCounts[tablename] = count;
        seedRowCount += count;
      } else {
        nonSeedPublicRowCount += count;
      }
      if (prohibitedTableNames.has(tablename)) prohibitedRowCount += count;
    }

    return Object.freeze({
      baselineVerified: true,
      seedTableCounts: Object.freeze(seedTableCounts),
      seedRowCount,
      prohibitedRowCount,
      nonSeedPublicRowCount,
      publicTableCount: tables.rows.length,
    });
  } catch {
    throw new HarnessError(failureStage);
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

async function inspectBaselineWithNewClient(
  target: OneRoleBaselineTarget,
  failureStage: string,
) {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await inspectOneRoleBaselineDatabase(client);
  } catch {
    throw new HarnessError(failureStage);
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

function assertEmptySeedState(state: SeedDatabaseState, failureStage: string): void {
  if (
    !state.baselineVerified ||
    state.seedRowCount !== 0 ||
    state.prohibitedRowCount !== 0 ||
    state.nonSeedPublicRowCount !== 0 ||
    Object.values(state.seedTableCounts).some((count) => count !== 0)
  ) {
    throw new HarnessError(failureStage);
  }
}

function assertInstalledSeedState(state: SeedDatabaseState, failureStage: string): void {
  const expectedEntries = Object.entries(NEON_TEST_SEED_TABLE_COUNTS);
  if (
    !state.baselineVerified ||
    state.seedRowCount !== EXPECTED_SEED_ROW_COUNT ||
    state.prohibitedRowCount !== 0 ||
    state.nonSeedPublicRowCount !== 0 ||
    expectedEntries.some(([table, expected]) => state.seedTableCounts[table] !== expected)
  ) {
    throw new HarnessError(failureStage);
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

function localIntegrationTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({
    connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`,
    host: "127.0.0.1",
    port,
    database: "tianxing",
    user: ONE_ROLE_CANONICAL_ROLE,
    ssl: false,
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

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

class HarnessError extends Error {
  readonly code = "NEON_TEST_SEED_POSTGRESQL_HARNESS_FAILED" as const;
  readonly stage: string;

  constructor(stage: string) {
    super(`Neon test seed PostgreSQL integration harness failed at ${stage}.`);
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
