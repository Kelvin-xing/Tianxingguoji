import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXPECTED_LAST_MIGRATION_SHA256,
  MIGRATION_DIRECTORY,
  createNeonTestPlanEvidence,
  verifyOrderedMigrationManifest,
} from "../../scripts/db/migration-manifest.ts";
import {
  EXPECTED_EMPTY_MIGRATION_METADATA_OBJECTS,
  MIGRATION_EXTERNAL_DEPENDENCY_SQL,
  MIGRATION_METADATA_INVENTORY_SQL,
  MIGRATION_CREATED_ROLES,
  NeonTestMigrationRunError,
  NeonTestMigrationSafetyError,
  createNeonTestDryRunClientOptions,
  createNeonTestMigrationEvidence,
  createNeonTestMigrationRunError,
  createNeonTestMigrationApplyOptions,
  executeNeonTestMigrationRun,
  executeNeonTestTransactionalDryRun,
  formatNeonTestMigrationFailure,
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

test("pins aligned dry-run and apply TLS and timeout contracts", () => {
  const target = readNeonTestMigrationTarget(validEnvironment());
  const dryRun = createNeonTestDryRunClientOptions(target);
  const apply = createNeonTestMigrationApplyOptions(target);

  assert.equal(apply.checkOrder, true);
  assert.equal(apply.singleTransaction, true);
  assert.equal(apply.noLock, false);
  assert.equal(apply.advisoryLockMode, "fail");
  assert.equal(apply.direction, "up");
  assert.equal(apply.dir, "db/migrations/*.sql");
  assert.equal(apply.useGlob, true);
  assert.equal(apply.migrationsTable, "schema_migrations");
  assert.equal("databaseUrl" in apply, true);
  const databaseUrl = "databaseUrl" in apply ? apply.databaseUrl : undefined;
  assert.equal(typeof databaseUrl, "object");
  assert.equal(dryRun.statement_timeout, 5_000);
  assert.equal(dryRun.lock_timeout, 5_000);
  assert.equal(
    dryRun.statement_timeout,
    typeof databaseUrl === "object" ? databaseUrl.statement_timeout : undefined,
  );
  assert.equal(
    dryRun.lock_timeout,
    typeof databaseUrl === "object" ? databaseUrl.lock_timeout : undefined,
  );
  assert.deepEqual(dryRun.ssl, { rejectUnauthorized: true });
  assert.deepEqual(
    typeof databaseUrl === "object" ? databaseUrl.ssl : undefined,
    { rejectUnauthorized: true },
  );
  assert.equal(apply.dryRun, false);
  assert.equal(apply.migrationsSchema, "migration");
});

test("keeps metadata inspection SQL aliases away from PostgreSQL keyword collisions", async () => {
  const source = await readFile("scripts/db/run-neon-test-migrations.ts", "utf8");
  assert.doesNotMatch(
    source,
    /(?:FROM|JOIN)\s+pg_[a-z_]+\s+AS\s+(?:constraint|database|role|namespace|class|dependency|reference)\b/i,
  );
  assert.doesNotMatch(source, /\bconstraint\./i);
  for (const sql of [MIGRATION_METADATA_INVENTORY_SQL, MIGRATION_EXTERNAL_DEPENDENCY_SQL]) {
    assert.doesNotMatch(sql, /\bAS\s+(?:constraint|database|role|namespace|class|dependency|reference)\b/i);
    assert.doesNotMatch(sql, /\b(?:constraint|database|role|namespace|class|dependency|reference)\./i);
  }
  assert.match(MIGRATION_METADATA_INVENTORY_SQL, /pg_constraint\s+AS\s+constraint_row/i);
  assert.match(MIGRATION_EXTERNAL_DEPENDENCY_SQL, /pg_constraint\s+AS\s+constraint_row/i);
});

test("formats preflight and postflight inspection failures as fixed redacted evidence", () => {
  const secretError = Object.assign(
    new Error("secret message with hostname and password"),
    {
      code: "42601",
      severity: "ERROR",
      detail: "secret detail",
      query: "SELECT secret_query",
      where: "secret where",
    },
  );
  for (const stage of [
    "preflight_database_inspection",
    "postflight_database_inspection",
    "rollback_database_inspection",
  ] as const) {
    const output = formatNeonTestMigrationFailure(
      createNeonTestMigrationRunError(stage, secretError),
    )!;
    assert.deepEqual(JSON.parse(output), {
      original_failure: {
        failure_stage: stage,
        postgres_code: "42601",
      },
    });
    assert.doesNotMatch(output, /secret|hostname|password|query|detail|where|stack/i);
  }

  const nodeError = Object.assign(new Error("secret ENOENT details"), {
    code: "ENOENT",
    severity: "ERROR",
    detail: "secret detail",
  });
  const nodeOutput = formatNeonTestMigrationFailure(
    createNeonTestMigrationRunError("preflight_database_inspection", nodeError),
  )!;
  assert.deepEqual(JSON.parse(nodeOutput), {
    original_failure: { failure_stage: "preflight_database_inspection" },
  });
  assert.doesNotMatch(nodeOutput, /ENOENT|secret|detail/i);
});

test("uses a neutral message for a safety gate without rollback state", () => {
  const error = createNeonTestMigrationRunError("preflight_database_inspection");
  assert.equal(error.message, "Migration safety gate failed; stop without retry.");
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

test("classifies clean rollback and exact empty node-pg-migrate metadata residue", async () => {
  const manifest = await verifyOrderedMigrationManifest();
  const applied = applyState(manifest.migrations.map(({ name }) => name.replace(/\.sql$/, "")));
  assert.doesNotThrow(() => validateNeonTestApplyResult(applied, manifest));
  assert.throws(
    () => validateNeonTestApplyResult({ ...applied, publicTableCount: 62 }, manifest),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestApplyResult({
      ...applied,
      migrationSchemaOwner: "neondb_owner",
    }, manifest),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestApplyResult({
      ...applied,
      migrationClassObjectOwners: [
        "env01_migration_login",
        "neondb_owner",
        "env01_migration_login",
      ],
    }, manifest),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestApplyResult({
      ...applied,
      migrationExternalUserDependencyCount: 1,
    }, manifest),
    NeonTestMigrationSafetyError,
  );
  assert.deepEqual(validateNeonTestRollback(preflightState()), { state: "clean" });

  const metadataResidue = emptyMigrationMetadataResidueState();
  assert.deepEqual(
    validateNeonTestRollback(metadataResidue),
    { state: "metadata_cleanup_required" },
  );
  assert.throws(() => validateNeonTestPreflight(metadataResidue), NeonTestMigrationSafetyError);
  assert.throws(
    () => validateNeonTestRollback({ ...preflightState(), existingMigrationRoles: ["tianxing_app"] }),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestRollback({
      ...preflightState(),
      migrationRoles: [role("tianxing_app", { login: true })],
    }),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestRollback({
      ...preflightState(),
      migrationExternalUserDependencyCount: 1,
    }),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestRollback({
      ...metadataResidue,
      migrationSchemaOwner: "neondb_owner",
    }),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestRollback({
      ...metadataResidue,
      migrationClassObjectOwners: [
        "env01_migration_login",
        "neondb_owner",
        "env01_migration_login",
      ],
    }),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestRollback({
      ...metadataResidue,
      migrationExternalUserDependencyCount: 1,
    }),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestRollback({
      ...metadataResidue,
      migrationMetadataObjects: [
        ...metadataResidue.migrationMetadataObjects,
        "class:v:unexpected_view",
      ],
    }),
    NeonTestMigrationSafetyError,
  );
  assert.throws(
    () => validateNeonTestRollback({
      ...preflightState(),
      migrationSchemaExists: true,
    }),
    NeonTestMigrationSafetyError,
  );
});

test("executes every frozen SQL file in order and always rolls back without a ledger", async () => {
  const manifest = await verifyOrderedMigrationManifest();
  const contents = await migrationContents(manifest.migrations.map(({ name }) => name));
  const nameBySql = new Map(
    manifest.migrations.map(({ name }) => [contents.get(name)!.toString("utf8"), name]),
  );
  const events: string[] = [];
  const readCounts = new Map<string, number>();

  await executeNeonTestTransactionalDryRun(manifest, {
    query: async (sql, parameters) => {
      if (sql === "BEGIN") {
        events.push("BEGIN");
      } else if (sql.startsWith("SELECT pg_try_advisory_xact_lock")) {
        events.push("ADVISORY_XACT_LOCK");
        assert.deepEqual(parameters, ["7241865325823964"]);
        return { rows: [{ lock_obtained: true }] };
      } else if (sql === "ROLLBACK") {
        events.push("ROLLBACK");
      } else {
        const name = nameBySql.get(sql);
        assert.ok(name, "each query must be one complete manifest SQL file");
        events.push(name);
      }
      return { rows: [] };
    },
    readMigration: async (name) => {
      readCounts.set(name, (readCounts.get(name) ?? 0) + 1);
      return contents.get(name)!;
    },
  });

  assert.deepEqual(events, [
    "BEGIN",
    "ADVISORY_XACT_LOCK",
    ...manifest.migrations.map(({ name }) => name),
    "ROLLBACK",
  ]);
  assert.equal(events.includes("COMMIT"), false);
  for (const { name } of manifest.migrations) assert.equal(readCounts.get(name), 2);
});

test("reports failed dry-run migration name and SQLSTATE without raw PostgreSQL fields", async () => {
  const manifest = await verifyOrderedMigrationManifest();
  const contents = await migrationContents(manifest.migrations.map(({ name }) => name));
  const failedName = manifest.migrations[4]!.name;
  const failedSql = contents.get(failedName)!.toString("utf8");
  const events: string[] = [];

  await assert.rejects(
    executeNeonTestMigrationRun("dry-run", {
      runMigration: async () => executeNeonTestTransactionalDryRun(manifest, {
        query: async (sql) => {
          events.push(sql === failedSql ? failedName : sql);
          if (sql.startsWith("SELECT pg_try_advisory_xact_lock")) {
            return { rows: [{ lock_obtained: true }] };
          }
          if (sql === failedSql) {
            throw Object.assign(new Error("secret query text and hostname"), {
              code: "42P01",
              severity: "ERROR",
              detail: "secret detail",
              query: "secret query",
            });
          }
          return { rows: [] };
        },
        readMigration: async (name) => contents.get(name)!,
      }),
      verifyRollbackAfterFailure: async () => ({ state: "clean" }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof NeonTestMigrationRunError);
      assert.deepEqual(error.originalFailure, {
        failure_stage: "migration_sql",
        migration_name: failedName,
        postgres_code: "42P01",
      });
      assert.equal(error.rollbackState, "clean");
      const output = formatNeonTestMigrationFailure(error)!;
      assert.doesNotMatch(output, /secret|hostname|query|detail|stack/i);
      assert.deepEqual(JSON.parse(output), {
        original_failure: error.originalFailure,
        rollback_state: "clean",
      });
      return true;
    },
  );

  assert.equal(events[0], "BEGIN");
  assert.equal(events.at(-1), "ROLLBACK");
  assert.equal(events.includes("COMMIT"), false);
});

test("rejects arbitrary thrown objects as PostgreSQL error evidence", async () => {
  await assert.rejects(
    executeNeonTestMigrationRun("apply", {
      runMigration: async () => {
        throw { code: "42P01", message: "secret arbitrary object" };
      },
      verifyRollbackAfterFailure: async () => ({ state: "clean" }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof NeonTestMigrationRunError);
      assert.deepEqual(error.originalFailure, { failure_stage: "apply_runner" });
      const output = formatNeonTestMigrationFailure(error)!;
      assert.doesNotMatch(output, /42P01|secret|message/);
      return true;
    },
  );
});

test("reports exact empty apply metadata residue as a separately gated cleanup", async () => {
  await assert.rejects(
    executeNeonTestMigrationRun("apply", {
      runMigration: async () => {
        throw Object.assign(new Error("synthetic apply failure"), {
          code: "42P01",
          severity: "ERROR",
        });
      },
      verifyRollbackAfterFailure: async () =>
        validateNeonTestRollback(emptyMigrationMetadataResidueState()),
    }),
    (error: unknown) => {
      assert.ok(error instanceof NeonTestMigrationRunError);
      assert.equal(error.rollbackState, "metadata_cleanup_required");
      assert.match(error.message, /business rollback passed/i);
      assert.match(error.message, /metadata cleanup is required/i);
      return true;
    },
  );
});

test("prioritizes rollback verification failure while preserving original failure", async () => {
  let runnerCalls = 0;
  let verificationCalls = 0;
  await assert.rejects(
    executeNeonTestMigrationRun("apply", {
      runMigration: async () => {
        runnerCalls += 1;
        throw Object.assign(new Error("secret original migration failure"), {
          code: "42P01",
          severity: "ERROR",
        });
      },
      verifyRollbackAfterFailure: async () => {
        verificationCalls += 1;
        throw Object.assign(new Error("secret verification failure"), {
          code: "08006",
          severity: "FATAL",
        });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NeonTestMigrationRunError);
      assert.equal(
        error.message,
        "Migration rollback verification is incomplete; architecture escalation required.",
      );
      assert.deepEqual(error.originalFailure, {
        failure_stage: "apply_runner",
        postgres_code: "42P01",
      });
      assert.deepEqual(error.rollbackVerificationFailure, {
        failure_stage: "rollback_state_verification",
        postgres_code: "08006",
      });
      const output = formatNeonTestMigrationFailure(error)!;
      assert.match(output, /42P01/);
      assert.match(output, /08006/);
      assert.doesNotMatch(output, /secret|message|stack/i);
      return true;
    },
  );
  assert.equal(runnerCalls, 1);
  assert.equal(verificationCalls, 1);
});

test("emits only approved plan and migration evidence fields", async () => {
  const manifest = await verifyOrderedMigrationManifest();
  assert.equal(manifest.migrations.length, 35);
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

test("keeps the legacy runner isolated while active commands use the one-role baseline", async () => {
  const [example, ignore, packageText, source] = await Promise.all([
    readFile(".env.migration.neon-test.example", "utf8"),
    readFile(".gitignore", "utf8"),
    readFile("package.json", "utf8"),
    readFile("scripts/db/run-neon-test-migrations.ts", "utf8"),
  ]);
  const packageJson = JSON.parse(packageText) as { scripts: Record<string, string> };

  assert.match(example, /^APP_ENV=test$/m);
  assert.match(example, /^NODE_ENV=production$/m);
  assert.match(example, /^ONE_ROLE_BASELINE_EXPECTED_DATABASE=txgj_env01_test$/m);
  assert.match(example, /^ONE_ROLE_BASELINE_DATABASE_URL=postgresql:\/\/tianxing_app:/m);
  assert.doesNotMatch(example, /^DATABASE_URL=/m);
  assert.doesNotMatch(example, /^MIGRATION_DATABASE_URL=/m);
  assert.doesNotMatch(example, /^TEST_MIGRATION_DATABASE_URL=/m);
  assert.doesNotMatch(example, /env01_migration_login/);
  assert.match(ignore, /^!\/\.env\.migration\.neon-test\.example$/m);
  assert.equal(packageJson.scripts["db:plan:neon-test"], "pnpm db:baseline:plan");
  assert.equal(
    packageJson.scripts["db:migrate:neon-test:dry-run"],
    "pnpm db:baseline:neon-test:dry-run",
  );
  assert.equal(packageJson.scripts["db:migrate:neon-test"], "pnpm db:baseline:neon-test");
  assert.match(packageJson.scripts["db:baseline:neon-test:dry-run"], /run-one-role-baseline/);
  assert.equal(
    packageJson.scripts["db:baseline:neon-test:apply"],
    "node --env-file=.env.migration.neon-test scripts/db/run-one-role-baseline.ts --apply",
  );
  assert.doesNotMatch(
    packageJson.scripts["db:baseline:neon-test:apply"],
    /ONE_ROLE_BASELINE_APPLY_CONFIRM/,
  );
  assert.match(packageJson.scripts["db:baseline:neon-test"], /--apply$/);
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

async function migrationContents(names: readonly string[]): Promise<Map<string, Buffer>> {
  return new Map(
    await Promise.all(
      names.map(async (name) => [
        name,
        await readFile(`${MIGRATION_DIRECTORY}/${name}`),
      ] as const),
    ),
  );
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
    migrationSchemaExists: false,
    migrationSchemaOwner: null,
    ledgerExists: false,
    appliedMigrations: [],
    migrationMetadataObjects: [],
    migrationClassObjectOwners: [],
    migrationExternalUserDependencyCount: 0,
    existingMigrationRoles: [],
    migrationRoles: [],
    staleDryRunSchemas: [],
  };
}

function emptyMigrationMetadataResidueState(): NeonTestDatabaseState {
  return {
    ...preflightState(),
    migrationSchemaExists: true,
    migrationSchemaOwner: "env01_migration_login",
    ledgerExists: true,
    migrationMetadataObjects: [...EXPECTED_EMPTY_MIGRATION_METADATA_OBJECTS],
    migrationClassObjectOwners: [
      "env01_migration_login",
      "env01_migration_login",
      "env01_migration_login",
    ],
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
    migrationSchemaExists: true,
    migrationSchemaOwner: "env01_migration_login",
    ledgerExists: true,
    appliedMigrations,
    migrationMetadataObjects: [...EXPECTED_EMPTY_MIGRATION_METADATA_OBJECTS],
    migrationClassObjectOwners: [
      "env01_migration_login",
      "env01_migration_login",
      "env01_migration_login",
    ],
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
