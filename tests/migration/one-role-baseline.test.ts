import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_SOURCES,
  OneRoleBaselineGenerationError,
  assertOneRoleTransformAnchors,
  buildOneRoleBaseline,
  verifyCommittedOneRoleBaseline,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  OneRoleBaselineRunError,
  assertOneRoleBaselinePostflight,
  assertOneRoleBaselinePreflight,
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineTransaction,
  readOneRoleBaselineMode,
  readOneRoleBaselineTarget,
  type OneRoleBaselineDatabaseState,
  type OneRoleBaselineQueryClient,
} from "../../scripts/db/run-one-role-baseline.ts";

const LOCAL_URL =
  "postgresql://tianxing_app:tianxing-local-app-only@127.0.0.1:5432/tianxing";
const NEON_TEST_URL =
  "postgresql://tianxing_app:synthetic-secret@ep-synthetic-123.c-2.us-east-1.aws.neon.tech:5432/txgj_test";
const PRODUCTION_URL =
  "postgresql://tianxing_app:synthetic-secret@tianxing.cluster-example.ap-east-1.rds.amazonaws.com:5432/tianxing";
const LEGACY_DATABASE_ROLE_IDENTIFIERS = [
  "portal_auth",
  "platform_billing",
  "platform_billing_reader",
  "tianxing_test_application",
  "tianxing_test_identity",
  "tianxing_test_provisioner",
  "rds_iam",
] as const;

test("generates a deterministic executable baseline from all 27 frozen sources", async () => {
  const first = await buildOneRoleBaseline();
  const second = await buildOneRoleBaseline();

  assert.equal(first.manifest.baseline_id, ONE_ROLE_BASELINE_ID);
  assert.equal(first.manifest.status, "executable-unapplied");
  assert.equal(first.manifest.canonical_login_role, ONE_ROLE_CANONICAL_ROLE);
  assert.equal(first.manifest.source_migrations.length, ONE_ROLE_SOURCE_COUNT);
  assert.equal(first.manifest.generated_files.length, ONE_ROLE_SOURCE_COUNT + 1);
  assert.equal(first.manifestJson, second.manifestJson);
  assert.deepEqual(first.files, second.files);
  assert.deepEqual(
    first.manifest.source_migrations.filter(({ transform }) => transform !== "copy-v1")
      .map(({ name }) => name),
    Object.keys(ONE_ROLE_TRANSFORM_SOURCES),
  );
  await assert.doesNotReject(verifyCommittedOneRoleBaseline());
});

test("locks every explicit transform to exactly one set of source anchors", async () => {
  for (const name of Object.keys(ONE_ROLE_TRANSFORM_SOURCES)) {
    const source = await readFile(`db/migrations/${name}`, "utf8");
    assert.doesNotThrow(() => assertOneRoleTransformAnchors(name, source));
    assert.throws(
      () => assertOneRoleTransformAnchors(name, `${source}\n${source}`),
      (error: unknown) => error instanceof OneRoleBaselineGenerationError &&
        error.message.includes("anchor count mismatch"),
    );
  }
});

test("rejects any source drift before generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "one-role-source-drift-"));
  const migrations = join(root, "migrations");
  await cp("db/migrations", migrations, { recursive: true });
  await writeFile(
    join(migrations, "202608021330_001_expand_identity_access.sql"),
    "SELECT 'drift';\n",
    "utf8",
  );
  await assert.rejects(
    buildOneRoleBaseline({
      sourceDirectory: migrations,
      sourceManifestPath: join(migrations, "manifest.json"),
    }),
    /checksum mismatch/i,
  );
});

test("generated SQL contains no legacy database role token and preserves business role data", async () => {
  const build = await buildOneRoleBaseline();
  const sql = build.files.map(({ contents }) => contents).join("\n");
  const tokens = new Set(sql.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

  for (const role of LEGACY_DATABASE_ROLE_IDENTIFIERS) assert.equal(tokens.has(role), false, role);
  assert.doesNotMatch(sql, /\b(?:CREATE|ALTER)\s+ROLE\b/i);
  assert.match(sql, /platform_billing_approver/);
  assert.match(sql, /app\.platform_billing_access_mode/);
  assert.match(sql, /aggregate_reader/);
  assert.match(sql, /relrowsecurity/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /procedure_row\.prosecdef/);
  assert.match(sql, /SET search_path = pg_catalog, public/);
  assert.match(sql, /REVOKE ALL ON FUNCTION %s FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION %s TO tianxing_app/);
});

test("binds canonical targets to the development, test, and production host matrix", () => {
  assert.equal(readOneRoleBaselineMode(["--plan"]), "plan");
  assert.equal(readOneRoleBaselineMode(["--dry-run"]), "dry-run");
  assert.equal(readOneRoleBaselineMode(["--apply"]), "apply");
  assert.throws(() => readOneRoleBaselineMode([]), OneRoleBaselineRunError);

  const local = readOneRoleBaselineTarget({
    APP_ENV: "development",
    NODE_ENV: "development",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "tianxing",
    ONE_ROLE_BASELINE_DATABASE_URL: LOCAL_URL,
  });
  assert.equal(local.user, "tianxing_app");
  assert.equal(local.ssl, false);
  const testTarget = readOneRoleBaselineTarget({
    APP_ENV: "test",
    NODE_ENV: "production",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "txgj_test",
    ONE_ROLE_BASELINE_DATABASE_URL: NEON_TEST_URL,
  });
  assert.deepEqual(testTarget.ssl, { rejectUnauthorized: true });
  assert.equal(createOneRoleBaselineClientConfig(testTarget).statement_timeout, 10_000);
  const production = readOneRoleBaselineTarget({
    APP_ENV: "production",
    NODE_ENV: "production",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "tianxing",
    ONE_ROLE_BASELINE_DATABASE_URL: PRODUCTION_URL,
  });
  assert.deepEqual(production.ssl, { rejectUnauthorized: true });

  for (const environment of [
    developmentEnvironment({ MIGRATION_DATABASE_URL: LOCAL_URL }),
    developmentEnvironment({
      ONE_ROLE_BASELINE_DATABASE_URL: LOCAL_URL.replace(
        "tianxing_app",
        "env01_migration_login",
      ),
    }),
    testEnvironment({
      ONE_ROLE_BASELINE_DATABASE_URL: NEON_TEST_URL.replace(
        "ep-synthetic-123.c-2",
        "ep-synthetic-123-pooler.c-2",
      ),
    }),
    testEnvironment({
      ONE_ROLE_BASELINE_DATABASE_URL: NEON_TEST_URL.replace(
        "ep-synthetic-123.c-2.us-east-1.aws.neon.tech",
        "ep-synthetic-123.c-two.us-east-1.aws.neon.tech",
      ),
    }),
    testEnvironment({ ONE_ROLE_BASELINE_DATABASE_URL: PRODUCTION_URL }),
    productionEnvironment({ ONE_ROLE_BASELINE_DATABASE_URL: NEON_TEST_URL }),
    developmentEnvironment({ ONE_ROLE_BASELINE_DATABASE_URL: NEON_TEST_URL }),
    { ...testEnvironment(), NODE_ENV: "test" },
  ]) {
    assert.throws(() => readOneRoleBaselineTarget(environment), OneRoleBaselineRunError);
  }
  assert.throws(
    () => readOneRoleBaselineTarget(testEnvironment(), "apply"),
    OneRoleBaselineRunError,
  );
  assert.doesNotThrow(() => readOneRoleBaselineTarget(testEnvironment({
    ONE_ROLE_BASELINE_APPLY_CONFIRM: ONE_ROLE_BASELINE_ID,
  }), "apply"));
});

test("executes all generated SQL under one lock and rolls dry-run back", async () => {
  const build = await buildOneRoleBaseline();
  const client = new RecordingClient();
  const files = new Map(build.files.map(({ name, contents }) => [name, contents]));

  await executeOneRoleBaselineTransaction({
    client,
    target: localTarget(),
    mode: "dry-run",
    build,
    readGeneratedFile: async (name) => files.get(name) ?? "",
    inspectPreflight: lockedPreflight(client),
  });

  assert.equal(client.commands[0], "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.match(client.commands[1] ?? "", /pg_try_advisory_xact_lock/);
  assert.equal(client.commands[2], "INSPECT LOCKED PREFLIGHT");
  assert.equal(client.commands[3], build.files[0]?.contents);
  assert.equal(client.commands.at(-1), "ROLLBACK");
  assert.equal(client.commands.includes("COMMIT"), false);
  assert.equal(client.commands.filter((command) => command.includes("schema_migrations")).length, 0);
  assert.ok(client.commands.some((command) => command.includes("CREATE SCHEMA tianxing_baseline")));
  for (const file of build.files) assert.ok(client.commands.includes(file.contents));
});

test("commits apply once and rolls a failed generated hash back without executing it", async () => {
  const build = await buildOneRoleBaseline();
  const applyClient = new RecordingClient();
  const files = new Map(build.files.map(({ name, contents }) => [name, contents]));
  await executeOneRoleBaselineTransaction({
    client: applyClient,
    target: localTarget(),
    mode: "apply",
    build,
    readGeneratedFile: async (name) => files.get(name) ?? "",
    inspectPreflight: lockedPreflight(applyClient),
  });
  assert.equal(applyClient.commands.at(-1), "COMMIT");
  assert.equal(applyClient.commands.filter((command) => command === "COMMIT").length, 1);

  const driftClient = new RecordingClient();
  await assert.rejects(
    executeOneRoleBaselineTransaction({
      client: driftClient,
      target: localTarget(),
      mode: "dry-run",
      build,
      readGeneratedFile: async () => "SELECT 'drift';",
      inspectPreflight: lockedPreflight(driftClient),
    }),
    OneRoleBaselineRunError,
  );
  assert.deepEqual(driftClient.commands.slice(0, 3), [
    "BEGIN ISOLATION LEVEL SERIALIZABLE",
    driftClient.commands[1],
    "INSPECT LOCKED PREFLIGHT",
  ]);
  assert.match(driftClient.commands[1] ?? "", /pg_try_advisory_xact_lock/);
  assert.equal(driftClient.commands.at(-1), "ROLLBACK");
  assert.equal(driftClient.commands.includes("SELECT 'drift';"), false);
});

test("requires an empty hardened owner preflight and verifies rollback or marker postflight", () => {
  const target = readOneRoleBaselineTarget({
    APP_ENV: "development",
    NODE_ENV: "development",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "tianxing",
    ONE_ROLE_BASELINE_DATABASE_URL: LOCAL_URL,
  });
  const clean = state();
  assert.doesNotThrow(() => assertOneRoleBaselinePreflight(clean, target));
  assert.throws(
    () => assertOneRoleBaselinePreflight({ ...clean, createRole: true }, target),
    OneRoleBaselineRunError,
  );
  assert.doesNotThrow(() => assertOneRoleBaselinePostflight({
    state: clean,
    target,
    mode: "dry-run",
    manifestSha256: "a".repeat(64),
  }));
  assert.doesNotThrow(() => assertOneRoleBaselinePostflight({
    state: {
      ...clean,
      publicObjectCount: 100,
      marker: {
        baselineId: ONE_ROLE_BASELINE_ID,
        transformVersion: "one-role-transform-v1",
        manifestSha256: "a".repeat(64),
        sourceMigrationCount: 27,
      },
    },
    target,
    mode: "apply",
    manifestSha256: "a".repeat(64),
  }));
  assert.throws(() => assertOneRoleBaselinePostflight({
    state: { ...clean, rlsNotForcedCount: 1 },
    target,
    mode: "dry-run",
    manifestSha256: "a".repeat(64),
  }), OneRoleBaselineRunError);
});

class RecordingClient implements OneRoleBaselineQueryClient {
  readonly commands: string[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }> {
    void values;
    this.commands.push(text);
    if (text.includes("pg_try_advisory_xact_lock")) {
      return { rows: [{ acquired: true } as unknown as Row] };
    }
    return { rows: [] };
  }
}

function state(): OneRoleBaselineDatabaseState {
  return {
    databaseName: "tianxing",
    userName: "tianxing_app",
    databaseOwner: "tianxing_app",
    login: true,
    superuser: false,
    createDatabase: false,
    createRole: false,
    inherit: false,
    replication: false,
    bypassRls: false,
    publicObjectCount: 0,
    marker: null,
    rlsNotForcedCount: 0,
    unsafeSecurityDefinerCount: 0,
  };
}

function developmentEnvironment(
  override: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    APP_ENV: "development",
    NODE_ENV: "development",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "tianxing",
    ONE_ROLE_BASELINE_DATABASE_URL: LOCAL_URL,
    ...override,
  };
}

function testEnvironment(
  override: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    APP_ENV: "test",
    NODE_ENV: "production",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "txgj_test",
    ONE_ROLE_BASELINE_DATABASE_URL: NEON_TEST_URL,
    ...override,
  };
}

function productionEnvironment(
  override: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    APP_ENV: "production",
    NODE_ENV: "production",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "tianxing",
    ONE_ROLE_BASELINE_DATABASE_URL: PRODUCTION_URL,
    ...override,
  };
}

function localTarget() {
  return readOneRoleBaselineTarget(developmentEnvironment());
}

function lockedPreflight(client: RecordingClient) {
  return async (): Promise<OneRoleBaselineDatabaseState> => {
    await client.query("INSPECT LOCKED PREFLIGHT");
    return state();
  };
}
