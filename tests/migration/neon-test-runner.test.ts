import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXPECTED_LAST_MIGRATION_SHA256,
  createNeonTestPlanEvidence,
  verifyOrderedMigrationManifest,
} from "../../scripts/db/migration-manifest.ts";
import {
  MIGRATION_CREATED_ROLES,
  NeonTestMigrationSafetyError,
  createNeonTestMigrationEvidence,
  createNeonTestMigrationOptions,
  executeNeonTestMigrationRun,
  readNeonTestMigrationMode,
  readNeonTestMigrationTarget,
  validateNeonTestApplyResult,
  validateNeonTestPreflight,
  validateNeonTestRollback,
  type NeonTestDatabaseState,
} from "../../scripts/db/run-neon-test-migrations.ts";

const MIGRATION_URL =
  "postgresql://env01_migration_login:synthetic-secret@ep-synthetic-123.us-east-1.aws.neon.tech:5432/txgj_env01_test";
const CELL_MIGRATION_URL = MIGRATION_URL.replace(
  ".us-east-1",
  ".c-2.us-east-1",
);

test("requires one explicit Neon migration mode", () => {
  assert.equal(readNeonTestMigrationMode(["--dry-run"]), "dry-run");
  assert.equal(readNeonTestMigrationMode(["--apply"]), "apply");
  assert.throws(() => readNeonTestMigrationMode([]), NeonTestMigrationSafetyError);
  assert.throws(
    () => readNeonTestMigrationMode(["--dry-run", "--apply"]),
    NeonTestMigrationSafetyError,
  );
});

test("accepts only the fixed Neon us-east-1 direct migration target", () => {
  assert.deepEqual(readNeonTestMigrationTarget(validEnvironment()), {
    connectionString: MIGRATION_URL,
    host: "ep-synthetic-123.us-east-1.aws.neon.tech",
    port: 5432,
    database: "txgj_env01_test",
    user: "env01_migration_login",
  });

  assert.deepEqual(readNeonTestMigrationTarget(withUrl(CELL_MIGRATION_URL)), {
    connectionString: CELL_MIGRATION_URL,
    host: "ep-synthetic-123.c-2.us-east-1.aws.neon.tech",
    port: 5432,
    database: "txgj_env01_test",
    user: "env01_migration_login",
  });

  const invalidEnvironments: Record<string, string | undefined>[] = [
    {},
    { ...validEnvironment(), APP_ENV: "production" },
    { ...validEnvironment(), DATABASE_URL: MIGRATION_URL },
    { ...validEnvironment(), MIGRATION_DATABASE_URL: MIGRATION_URL },
    { ...validEnvironment(), VERCEL: "1" },
    withUrl(MIGRATION_URL.replace("postgresql:", "postgres:")),
    withUrl(MIGRATION_URL.replace("ep-synthetic-123", "ep-synthetic-123-pooler")),
    withUrl(CELL_MIGRATION_URL.replace("ep-synthetic-123", "ep-synthetic-123-pooler")),
    withUrl(CELL_MIGRATION_URL.replace(".c-2.", ".cell-2.")),
    withUrl(CELL_MIGRATION_URL.replace(".c-2.", ".c-two.")),
    withUrl(CELL_MIGRATION_URL.replace(".c-2.", ".c-2.extra.")),
    withUrl(MIGRATION_URL.replace("us-east-1", "ap-southeast-1")),
    withUrl(CELL_MIGRATION_URL.replace("us-east-1", "ap-southeast-1")),
    withUrl(MIGRATION_URL.replace("ep-synthetic-123.us-east-1.aws.neon.tech", "127.0.0.1")),
    withUrl(MIGRATION_URL.replace("ep-synthetic-123.us-east-1.aws.neon.tech", "localhost")),
    withUrl(MIGRATION_URL.replace(":5432", "")),
    withUrl(MIGRATION_URL.replace("env01_migration_login", "neondb_owner")),
    withUrl(MIGRATION_URL.replace("txgj_env01_test", "neondb")),
    withUrl(MIGRATION_URL.replace("synthetic-secret", "")),
    withUrl(`${MIGRATION_URL}?sslmode=require`),
    withUrl(`${MIGRATION_URL}#fragment`),
  ];
  for (const environment of invalidEnvironments) {
    assert.throws(() => readNeonTestMigrationTarget(environment), NeonTestMigrationSafetyError);
  }
});

test("pins TLS, direct runner policy, advisory locking, and one transaction", () => {
  const target = readNeonTestMigrationTarget(validEnvironment());
  const dryRun = createNeonTestMigrationOptions(
    target,
    "dry-run",
    "migration_dry_run_env01_test",
  );
  const apply = createNeonTestMigrationOptions(target, "apply");

  for (const options of [dryRun, apply]) {
    assert.equal(options.checkOrder, true);
    assert.equal(options.singleTransaction, true);
    assert.equal(options.noLock, false);
    assert.equal(options.advisoryLockMode, "fail");
    assert.equal(options.direction, "up");
    assert.equal(options.dir, "db/migrations/*.sql");
    assert.equal(options.useGlob, true);
    assert.equal(options.migrationsTable, "schema_migrations");
    assert.equal("databaseUrl" in options, true);
    const databaseUrl = "databaseUrl" in options ? options.databaseUrl : undefined;
    assert.equal(typeof databaseUrl, "object");
    assert.deepEqual(
      typeof databaseUrl === "object" ? databaseUrl.ssl : undefined,
      { rejectUnauthorized: true },
    );
  }
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.migrationsSchema, "migration_dry_run_env01_test");
  assert.equal(apply.dryRun, false);
  assert.equal(apply.migrationsSchema, "migration");
});

test("validates the empty Neon bootstrap preflight contract", () => {
  assert.doesNotThrow(() => validateNeonTestPreflight(preflightState()));
  assert.throws(
    () => validateNeonTestPreflight({ ...preflightState(), publicTableCount: 1 }),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestPreflight({
      ...preflightState(),
      migrationRole: { ...preflightState().migrationRole, memberOfNeonSuperuser: true },
    }),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestPreflight({ ...preflightState(), hasRdsIamAdminOption: false }),
    NeonTestMigrationSafetyError,
  );
});

test("validates complete apply and clean rollback states", async () => {
  const manifest = await verifyOrderedMigrationManifest();
  const applied = applyState(manifest.migrations.map(({ name }) => name.replace(/\.sql$/, "")));
  assert.doesNotThrow(() => validateNeonTestApplyResult(applied, manifest));
  assert.throws(
    () => validateNeonTestApplyResult({ ...applied, publicTableCount: 62 }, manifest),
    NeonTestMigrationSafetyError,
  );
  assert.doesNotThrow(() => validateNeonTestRollback(preflightState()));
  assert.throws(
    () => validateNeonTestRollback({ ...preflightState(), ledgerExists: true }),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestRollback({ ...preflightState(), existingMigrationRoles: ["tianxing_app"] }),
    NeonTestMigrationSafetyError,
  );
});

test("does not retry cleanup when a successful dry-run cleanup fails", async () => {
  const cleanupFailure = new Error("synthetic cleanup failure");
  let runnerCalls = 0;
  let cleanupCalls = 0;
  let rollbackVerificationCalls = 0;

  await assert.rejects(
    executeNeonTestMigrationRun("dry-run", {
      runMigration: async () => {
        runnerCalls += 1;
      },
      cleanupDryRun: async () => {
        cleanupCalls += 1;
        throw cleanupFailure;
      },
      verifyRollbackAfterFailure: async () => {
        rollbackVerificationCalls += 1;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NeonTestMigrationSafetyError);
      assert.equal(error.message, "Dry-run cleanup failed; stop without retry.");
      assert.equal(error.cause, cleanupFailure);
      assert.doesNotMatch(error.message, /synthetic cleanup failure/);
      return true;
    },
  );

  assert.equal(runnerCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(rollbackVerificationCalls, 0);
});

test("does not rerun a failed migration and verifies rollback after one cleanup", async () => {
  const runnerFailure = new Error("synthetic runner failure");
  let runnerCalls = 0;
  let cleanupCalls = 0;
  let rollbackVerificationCalls = 0;

  await assert.rejects(
    executeNeonTestMigrationRun("dry-run", {
      runMigration: async () => {
        runnerCalls += 1;
        throw runnerFailure;
      },
      cleanupDryRun: async () => {
        cleanupCalls += 1;
      },
      verifyRollbackAfterFailure: async () => {
        rollbackVerificationCalls += 1;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NeonTestMigrationSafetyError);
      assert.equal(
        error.message,
        "Migration execution failed and rollback verification passed; stop without retry.",
      );
      assert.equal(error.cause, runnerFailure);
      return true;
    },
  );

  assert.equal(runnerCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(rollbackVerificationCalls, 1);
});

test("verifies state once after both migration and cleanup fail", async () => {
  const cleanupFailure = new Error(
    "postgresql://env01_migration_login:do-not-print@ep-secret.example/test",
  );
  let runnerCalls = 0;
  let cleanupCalls = 0;
  let rollbackVerificationCalls = 0;

  await assert.rejects(
    executeNeonTestMigrationRun("dry-run", {
      runMigration: async () => {
        runnerCalls += 1;
        throw new Error("synthetic runner failure");
      },
      cleanupDryRun: async () => {
        cleanupCalls += 1;
        throw cleanupFailure;
      },
      verifyRollbackAfterFailure: async () => {
        rollbackVerificationCalls += 1;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NeonTestMigrationSafetyError);
      assert.equal(
        error.message,
        "Migration execution failed; dry-run cleanup failed and state verification passed; stop without retry.",
      );
      assert.equal(error.cause, cleanupFailure);
      assert.doesNotMatch(error.message, /do-not-print|ep-secret|postgresql:\/\//);
      return true;
    },
  );

  assert.equal(runnerCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(rollbackVerificationCalls, 1);
});

test("gives failed rollback verification priority over cleanup failure", async () => {
  const verificationFailure = new Error("synthetic state verification failure");
  let runnerCalls = 0;
  let cleanupCalls = 0;
  let rollbackVerificationCalls = 0;

  await assert.rejects(
    executeNeonTestMigrationRun("dry-run", {
      runMigration: async () => {
        runnerCalls += 1;
        throw new Error("synthetic runner failure");
      },
      cleanupDryRun: async () => {
        cleanupCalls += 1;
        throw new Error("synthetic cleanup failure");
      },
      verifyRollbackAfterFailure: async () => {
        rollbackVerificationCalls += 1;
        throw verificationFailure;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NeonTestMigrationSafetyError);
      assert.equal(
        error.message,
        "Migration rollback or state verification is incomplete; architecture escalation required.",
      );
      assert.equal(error.cause, verificationFailure);
      assert.doesNotMatch(error.message, /passed|synthetic/);
      return true;
    },
  );

  assert.equal(runnerCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(rollbackVerificationCalls, 1);
});

test("emits only approved plan and migration evidence fields", async () => {
  const manifest = await verifyOrderedMigrationManifest();
  assert.equal(manifest.migrations.length, 27);
  assert.equal(manifest.migrations.at(-1)?.sha256, EXPECTED_LAST_MIGRATION_SHA256);

  const planText = JSON.stringify(createNeonTestPlanEvidence(manifest));
  const applyText = JSON.stringify(
    createNeonTestMigrationEvidence(
      "apply",
      manifest,
      preflightState(),
      applyState(manifest.migrations.map(({ name }) => name.replace(/\.sql$/, ""))),
    ),
  );
  for (const output of [planText, applyText]) {
    assert.doesNotMatch(output, /ep-synthetic|synthetic-secret|postgresql:\/\//);
    assert.doesNotMatch(output, /hostname|connectionString|password|email/i);
    assert.match(output, /"endpoint_kind":"neon-direct"/);
    assert.match(output, /"reject_unauthorized":true/);
  }
  assert.match(planText, /"verified":false/);
  assert.match(applyText, /"verified":true/);
});

test("keeps Neon migration secrets isolated from app and Vercel variables", async () => {
  const [example, ignore, packageText, source] = await Promise.all([
    readFile(".env.migration.neon-test.example", "utf8"),
    readFile(".gitignore", "utf8"),
    readFile("package.json", "utf8"),
    readFile("scripts/db/run-neon-test-migrations.ts", "utf8"),
  ]);
  const packageJson = JSON.parse(packageText) as { scripts: Record<string, string> };

  assert.match(example, /^APP_ENV=test$/m);
  assert.match(example, /^NODE_ENV=production$/m);
  assert.match(example, /^APP_RUNTIME_MODE=test-database$/m);
  assert.match(example, /^AUTH_MODE=database-test$/m);
  assert.match(example, /^TEST_DATABASE_EXPECTED_NAME=txgj_env01_test$/m);
  assert.match(example, /^TEST_MIGRATION_DATABASE_URL=postgresql:\/\//m);
  assert.doesNotMatch(example, /^DATABASE_URL=/m);
  assert.doesNotMatch(example, /^MIGRATION_DATABASE_URL=/m);
  assert.match(ignore, /^!\/\.env\.migration\.neon-test\.example$/m);
  assert.equal(
    packageJson.scripts["db:plan:neon-test"],
    "node scripts/db/migration-manifest.ts --neon-test-plan",
  );
  assert.match(packageJson.scripts["db:migrate:neon-test:dry-run"], /--dry-run$/);
  assert.match(packageJson.scripts["db:migrate:neon-test"], /--apply$/);
  assert.doesNotMatch(source, /error\.stack/);
});

function validEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "test",
    NODE_ENV: "production",
    APP_RUNTIME_MODE: "test-database",
    AUTH_MODE: "database-test",
    TEST_DATABASE_EXPECTED_NAME: "txgj_env01_test",
    TEST_MIGRATION_DATABASE_URL: MIGRATION_URL,
  };
}

function withUrl(url: string): Record<string, string | undefined> {
  return { ...validEnvironment(), TEST_MIGRATION_DATABASE_URL: url };
}

function preflightState(): NeonTestDatabaseState {
  return {
    databaseName: "txgj_env01_test",
    userName: "env01_migration_login",
    databaseOwner: "env01_migration_login",
    migrationRole: role("env01_migration_login", {
      login: true,
      createRole: true,
    }),
    rdsIamRole: role("rds_iam"),
    hasRdsIamAdminOption: true,
    publicTableCount: 0,
    ledgerExists: false,
    appliedMigrations: [],
    existingMigrationRoles: [],
    migrationRoles: [],
    staleDryRunSchemas: [],
  };
}

function applyState(appliedMigrations: readonly string[]): NeonTestDatabaseState {
  const roles = MIGRATION_CREATED_ROLES.map((name) =>
    role(name, {
      login: ["tianxing_app", "portal_auth", "platform_billing", "platform_billing_reader"].includes(name),
      inherit: name.startsWith("tianxing_test_"),
    }),
  );
  return {
    ...preflightState(),
    publicTableCount: 63,
    ledgerExists: true,
    appliedMigrations,
    existingMigrationRoles: roles.map(({ rolname }) => rolname),
    migrationRoles: roles,
  };
}

function role(
  rolname: string,
  options: Readonly<{ login?: boolean; createRole?: boolean; inherit?: boolean }> = {},
) {
  return {
    rolname,
    rolcanlogin: options.login ?? false,
    rolsuper: false,
    rolcreaterole: options.createRole ?? false,
    rolcreatedb: false,
    rolinherit: options.inherit ?? false,
    rolreplication: false,
    rolbypassrls: false,
    memberOfNeonSuperuser: false,
  };
}
