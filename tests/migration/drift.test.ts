import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  MIGRATION_CONFIG,
  createMigrationRunnerOptions,
} from "../../db/migrate.config.ts";
import { planMigration } from "../../scripts/db/plan-migration.ts";

const SCHEMA_V1_SHA256 = "1".repeat(64);
const SCHEMA_V2_SHA256 = "2".repeat(64);

test("pins the approved SQL-first migration runner policy", () => {
  assert.deepEqual(MIGRATION_CONFIG, {
    tool: {
      name: "node-pg-migrate",
      version: "9.0.0",
      license: "MIT",
    },
    packageManager: "pnpm@10.34.4",
    migrationsDirectory: "db/migrations",
    migrationsGlob: "db/migrations/*.sql",
    schema: "public",
    migrationsSchema: "migration",
    migrationsTable: "schema_migrations",
    createMigrationsSchema: true,
    databaseUrlEnvironmentVariable: "MIGRATION_DATABASE_URL",
    migrationLoader: "sql",
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: "fail",
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 5_000,
    dryRunByDefault: true,
    telemetry: "disabled",
  });
  assert.notEqual(MIGRATION_CONFIG.databaseUrlEnvironmentVariable, "DATABASE_URL");
  assert.equal(Object.isFrozen(MIGRATION_CONFIG), true);
});

test("builds fail-fast dry-run options for an explicit migration role URL", () => {
  assert.deepEqual(createMigrationRunnerOptions("postgres://migration-role@example.invalid/db"), {
    databaseUrl: {
      connectionString: "postgres://migration-role@example.invalid/db",
      application_name: "tianxing-schema-migration",
      statement_timeout: 5_000,
      lock_timeout: 5_000,
    },
    dir: "db/migrations/*.sql",
    useGlob: true,
    schema: "public",
    migrationsSchema: "migration",
    migrationsTable: "schema_migrations",
    createMigrationsSchema: true,
    direction: "up",
    checkOrder: true,
    singleTransaction: true,
    noLock: false,
    advisoryLockMode: "fail",
    dryRun: true,
    migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
  });
  assert.throws(
    () => createMigrationRunnerOptions(""),
    new Error("MIGRATION_DATABASE_URL is required."),
  );
});

test("plans a reproducible bootstrap from an empty schema", async () => {
  const migrationDirectory = await mkdtemp(join(tmpdir(), "migration-plan-empty-"));
  const migrationName = "202608020001_001_expand_shared.sql";
  await writeFile(join(migrationDirectory, migrationName), "SELECT 1;\n", "utf8");

  const plan = await planMigration({
    migrationDirectory,
    snapshot: {
      target: "empty",
      applied: [],
      expectedSchemaSha256: null,
      actualSchemaSha256: null,
    },
  });

  assert.deepEqual(plan, {
    planVersion: 1,
    status: "pass",
    target: "empty",
    migrations: [
      {
        name: migrationName,
        sha256: "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd",
        state: "pending",
      },
    ],
    findings: [],
  });
});

test("accepts every committed SQL migration name under the ordered naming contract", async () => {
  const plan = await planMigration({
    migrationDirectory: "db/migrations",
    snapshot: {
      target: "empty",
      applied: [],
      expectedSchemaSha256: null,
      actualSchemaSha256: null,
    },
  });

  assert.equal(plan.status, "pass");
  assert.deepEqual(
    plan.findings.filter(({ code }) => code === "INVALID_MIGRATION_NAME"),
    [],
  );
});

test("warns when a prior schema is one migration behind", async () => {
  const migrationDirectory = await mkdtemp(join(tmpdir(), "migration-plan-n-minus-one-"));
  const firstMigration = "202608020001_001_expand_shared.sql";
  const secondMigration = "202608020002_002_expand_identity.sql";
  await writeFile(join(migrationDirectory, firstMigration), "SELECT 1;\n", "utf8");
  await writeFile(join(migrationDirectory, secondMigration), "SELECT 2;\n", "utf8");

  const plan = await planMigration({
    migrationDirectory,
    snapshot: {
      target: "prior",
      applied: [
        {
          name: firstMigration,
          sha256: "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd",
        },
      ],
      expectedSchemaSha256: SCHEMA_V1_SHA256,
      actualSchemaSha256: SCHEMA_V1_SHA256,
    },
  });

  assert.deepEqual(plan, {
    planVersion: 1,
    status: "warn",
    target: "prior",
    migrations: [
      {
        name: firstMigration,
        sha256: "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd",
        state: "applied",
      },
      {
        name: secondMigration,
        sha256: "a41109d24069b4822ddc5f367b25d484dc7e839bff338ce7a3e5da641caacda0",
        state: "pending",
      },
    ],
    findings: [
      {
        code: "PENDING_MIGRATIONS",
        severity: "warning",
        migrationNames: [secondMigration],
      },
    ],
  });
});

test("fails when an applied migration checksum changes", async () => {
  const migrationDirectory = await mkdtemp(join(tmpdir(), "migration-plan-checksum-"));
  const migrationName = "202608020001_001_expand_shared.sql";
  await writeFile(join(migrationDirectory, migrationName), "SELECT 1;\n", "utf8");

  const plan = await planMigration({
    migrationDirectory,
    snapshot: {
      target: "prior",
      applied: [{ name: migrationName, sha256: "0".repeat(64) }],
      expectedSchemaSha256: SCHEMA_V1_SHA256,
      actualSchemaSha256: SCHEMA_V1_SHA256,
    },
  });

  assert.equal(plan.status, "fail");
  assert.deepEqual(plan.findings, [
    {
      code: "MIGRATION_CHECKSUM_MISMATCH",
      severity: "error",
      migrationName,
      expectedSha256: "0".repeat(64),
      actualSha256: "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd",
    },
  ]);
});

test("fails when the observed schema drifts from the expected fingerprint", async () => {
  const migrationDirectory = await mkdtemp(join(tmpdir(), "migration-plan-drift-"));
  const migrationName = "202608020001_001_expand_shared.sql";
  const migrationSha256 =
    "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd";
  await writeFile(join(migrationDirectory, migrationName), "SELECT 1;\n", "utf8");

  const plan = await planMigration({
    migrationDirectory,
    snapshot: {
      target: "prior",
      applied: [{ name: migrationName, sha256: migrationSha256 }],
      expectedSchemaSha256: SCHEMA_V1_SHA256,
      actualSchemaSha256: SCHEMA_V2_SHA256,
    },
  });

  assert.equal(plan.status, "fail");
  assert.deepEqual(plan.findings, [
    {
      code: "SCHEMA_DRIFT",
      severity: "error",
      expectedSchemaSha256: SCHEMA_V1_SHA256,
      actualSchemaSha256: SCHEMA_V2_SHA256,
    },
  ]);
});

test("fails when the applied ledger is not an ordered migration prefix", async () => {
  const migrationDirectory = await mkdtemp(join(tmpdir(), "migration-plan-order-"));
  const firstMigration = "202608020001_001_expand_shared.sql";
  const secondMigration = "202608020002_002_expand_identity.sql";
  await writeFile(join(migrationDirectory, firstMigration), "SELECT 1;\n", "utf8");
  await writeFile(join(migrationDirectory, secondMigration), "SELECT 2;\n", "utf8");

  const plan = await planMigration({
    migrationDirectory,
    snapshot: {
      target: "prior",
      applied: [
        {
          name: secondMigration,
          sha256: "a41109d24069b4822ddc5f367b25d484dc7e839bff338ce7a3e5da641caacda0",
        },
      ],
      expectedSchemaSha256: SCHEMA_V2_SHA256,
      actualSchemaSha256: SCHEMA_V2_SHA256,
    },
  });

  assert.equal(plan.status, "fail");
  assert.deepEqual(plan.findings[0], {
    code: "APPLIED_MIGRATION_ORDER_MISMATCH",
    severity: "error",
    expectedMigrationNames: [firstMigration],
    actualMigrationNames: [secondMigration],
  });
});

test("fails when a SQL migration name violates the ordered naming contract", async () => {
  const migrationDirectory = await mkdtemp(join(tmpdir(), "migration-plan-name-"));
  await writeFile(join(migrationDirectory, "001_init.sql"), "SELECT 1;\n", "utf8");

  const plan = await planMigration({
    migrationDirectory,
    snapshot: {
      target: "empty",
      applied: [],
      expectedSchemaSha256: null,
      actualSchemaSha256: null,
    },
  });

  assert.equal(plan.status, "fail");
  assert.deepEqual(plan.findings, [
    {
      code: "INVALID_MIGRATION_NAME",
      severity: "error",
      migrationName: "001_init.sql",
    },
  ]);
});

test("emits the migration plan through the command-line interface", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "migration-plan-cli-"));
  const migrationDirectory = join(fixtureDirectory, "migrations");
  const snapshotPath = join(fixtureDirectory, "snapshot.json");
  await mkdir(migrationDirectory);
  await writeFile(
    join(migrationDirectory, "202608020001_001_expand_shared.sql"),
    "SELECT 1;\n",
    "utf8",
  );
  await writeFile(
    snapshotPath,
    JSON.stringify({
      target: "empty",
      applied: [],
      expectedSchemaSha256: null,
      actualSchemaSha256: null,
    }),
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/db/plan-migration.ts"),
      "--migrations",
      migrationDirectory,
      "--snapshot",
      snapshotPath,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    planVersion: 1,
    status: "pass",
    target: "empty",
    migrations: [
      {
        name: "202608020001_001_expand_shared.sql",
        sha256: "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd",
        state: "pending",
      },
    ],
    findings: [],
  });
});

test("rejects non-SHA-256 schema fingerprints at the CLI boundary", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "migration-plan-invalid-snapshot-"));
  const migrationDirectory = join(fixtureDirectory, "migrations");
  const snapshotPath = join(fixtureDirectory, "snapshot.json");
  const migrationName = "202608020001_001_expand_shared.sql";
  await mkdir(migrationDirectory);
  await writeFile(join(migrationDirectory, migrationName), "SELECT 1;\n", "utf8");
  await writeFile(
    snapshotPath,
    JSON.stringify({
      target: "prior",
      applied: [
        {
          name: migrationName,
          sha256: "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd",
        },
      ],
      expectedSchemaSha256: "not-a-sha",
      actualSchemaSha256: SCHEMA_V1_SHA256,
    }),
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/db/plan-migration.ts"),
      "--migrations",
      migrationDirectory,
      "--snapshot",
      snapshotPath,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Snapshot schema fingerprints must be lowercase SHA-256 values.\n",
  );
});
