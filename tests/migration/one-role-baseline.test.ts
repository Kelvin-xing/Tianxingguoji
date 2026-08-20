import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_VERSION,
  ONE_ROLE_TRANSFORM_SOURCES,
  OneRoleBaselineGenerationError,
  assertOneRoleTransformAnchors,
  buildOneRoleBaseline,
  verifyCommittedOneRoleBaseline,
  type OneRoleBaselineBuild,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  OneRoleBaselineOperationError,
  OneRoleBaselineRunError,
  assertOneRoleBaselinePostflight,
  assertOneRoleBaselinePreflight,
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  executeOneRoleBaselineTransaction,
  formatOneRoleBaselineFailure,
  readOneRoleBaselineMode,
  readOneRoleBaselineTarget,
  type OneRoleBaselineDatabaseState,
  type OneRoleBaselineQueryClient,
  type OneRoleBaselineRunDependencies,
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
  assert.equal(ONE_ROLE_TRANSFORM_VERSION, "one-role-transform-v2");
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

test("temporarily grants only the fact-table trigger privilege around the first 025 trigger", async () => {
  assert.equal(
    ONE_ROLE_TRANSFORM_SOURCES["202608180090_025_harden_case_stage_transition.sql"],
    "93a22834efb861714d2cdff965a9d5feb8f3e152d7c5e0f810050fb13671dcf5",
  );
  const build = await buildOneRoleBaseline();
  const generated = build.files.find(({ name }) =>
    name === "024_202608180090_025_harden_case_stage_transition.sql"
  );
  assert.ok(generated);
  const grant =
    "GRANT TRIGGER ON TABLE public.cases_service_case_transition_facts TO tianxing_app;";
  const trigger = "CREATE TRIGGER cases_service_case_transition_facts_insert_guard_trg";
  const revoke =
    "REVOKE TRIGGER ON TABLE public.cases_service_case_transition_facts FROM tianxing_app;";
  const grantIndex = generated.contents.indexOf(grant);
  const triggerIndex = generated.contents.indexOf(trigger);
  const revokeIndex = generated.contents.indexOf(revoke);

  assert.ok(grantIndex >= 0);
  assert.ok(grantIndex < triggerIndex);
  assert.ok(triggerIndex < revokeIndex);
  assert.equal(occurrenceCount(generated.contents, grant), 1);
  assert.equal(occurrenceCount(generated.contents, revoke), 1);
  assert.equal(
    build.manifest.source_migrations.find(({ name }) =>
      name === "202608180090_025_harden_case_stage_transition.sql"
    )?.transform,
    "case-stage-trigger-bootstrap-v1",
  );
  assert.equal(
    build.files.reduce((count, file) => count + occurrenceCount(file.contents, grant), 0),
    1,
  );
  assert.equal(
    build.files.reduce((count, file) => count + occurrenceCount(file.contents, revoke), 0),
    1,
  );
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

test("reports generated SQL failure, successful rollback, and independent clean verification", async () => {
  const build = await buildOneRoleBaseline();
  const first = build.files[0]!;
  const rawFailure = postgresError("42501", "super-secret generated SQL failure");
  const client = new RecordingClient((text) => text === first.contents ? rawFailure : undefined);
  const events: string[] = [];
  const dependencies = scenarioDependencies(build, client, events);

  const error = await captureOperationFailure(executeOneRoleBaselineRun({
    mode: "dry-run",
    target: localTarget(),
    build,
    dependencies,
  }));
  const serialized = formatOneRoleBaselineFailure(error);
  const evidence = JSON.parse(serialized) as Record<string, unknown>;

  assert.deepEqual(evidence.original_failure, {
    failure_stage: "generated_sql",
    migration_name: build.manifest.generated_files[0]?.name,
    postgres_code: "42501",
  });
  assert.equal(evidence.rollback_attempt, "succeeded");
  assert.equal(evidence.rollback_state, "clean");
  assert.equal(client.commands.at(-1), "ROLLBACK");
  assert.deepEqual(events, ["inspect:1", "open", "close", "inspect:2"]);
  assertRedacted(serialized);
});

test("returns pass evidence only after an independent clean dry-run postcheck", async () => {
  const build = await buildOneRoleBaseline();
  const client = new RecordingClient();
  const events: string[] = [];

  const evidence = await executeOneRoleBaselineRun({
    mode: "dry-run",
    target: localTarget(),
    build,
    dependencies: scenarioDependencies(build, client, events),
  });

  assert.equal(evidence.status, "pass");
  assert.equal(evidence.postflight_state, "clean");
  assert.equal(evidence.marker, "rolled_back");
  assert.equal(client.commands.at(-1), "ROLLBACK");
  assert.deepEqual(events, ["inspect:1", "open", "close", "inspect:2"]);
});

test("returns apply pass evidence only after an independent installed marker postcheck", async () => {
  const build = await buildOneRoleBaseline();
  const client = new RecordingClient();
  const events: string[] = [];
  const manifestSha256 = createHash("sha256").update(build.manifestJson).digest("hex");

  const evidence = await executeOneRoleBaselineRun({
    mode: "apply",
    target: localTarget(),
    build,
    dependencies: scenarioDependencies(build, client, events, {
      after: {
        ...state(),
        publicObjectCount: 100,
        marker: {
          baselineId: ONE_ROLE_BASELINE_ID,
          transformVersion: ONE_ROLE_TRANSFORM_VERSION,
          manifestSha256,
          sourceMigrationCount: ONE_ROLE_SOURCE_COUNT,
        },
      },
    }),
  });

  assert.equal(evidence.status, "pass");
  assert.equal(evidence.postflight_state, "installed");
  assert.equal(evidence.marker, "installed");
  assert.equal(client.commands.at(-1), "COMMIT");
  assert.deepEqual(events, ["inspect:1", "open", "close", "inspect:2"]);
});

test("preserves rollback failure separately when independent state is clean", async () => {
  const build = await buildOneRoleBaseline();
  const first = build.files[0]!;
  const client = new RecordingClient((text) => {
    if (text === first.contents) return postgresError("42501", "super-secret SQL failure");
    if (text === "ROLLBACK") return postgresError("08006", "super-secret rollback failure");
    return undefined;
  });
  const events: string[] = [];

  const error = await captureOperationFailure(executeOneRoleBaselineRun({
    mode: "dry-run",
    target: localTarget(),
    build,
    dependencies: scenarioDependencies(build, client, events),
  }));
  const serialized = formatOneRoleBaselineFailure(error);
  const evidence = JSON.parse(serialized) as Record<string, unknown>;

  assert.equal(evidence.rollback_attempt, "failed");
  assert.equal(evidence.rollback_state, "clean");
  assert.deepEqual(evidence.transaction_rollback_failure, {
    failure_stage: "transaction_rollback",
    postgres_code: "08006",
  });
  assert.equal(client.commands.filter((command) => command === "ROLLBACK").length, 1);
  assert.deepEqual(events, ["inspect:1", "open", "close", "inspect:2"]);
  assertRedacted(serialized);
});

test("marks rollback verification failed when rollback fails and independent state is dirty", async () => {
  const build = await buildOneRoleBaseline();
  const first = build.files[0]!;
  const client = new RecordingClient((text) => {
    if (text === first.contents) return postgresError("42501", "super-secret SQL failure");
    if (text === "ROLLBACK") return postgresError("08006", "super-secret rollback failure");
    return undefined;
  });

  const error = await captureOperationFailure(executeOneRoleBaselineRun({
    mode: "dry-run",
    target: localTarget(),
    build,
    dependencies: scenarioDependencies(build, client, [], {
      after: { ...state(), publicObjectCount: 1 },
    }),
  }));
  const evidence = JSON.parse(formatOneRoleBaselineFailure(error)) as Record<string, unknown>;

  assert.equal(evidence.rollback_attempt, "failed");
  assert.equal(evidence.rollback_state, "verification_failed");
  assert.deepEqual(evidence.rollback_verification_failure, {
    failure_stage: "rollback_state_verification",
  });
  assert.equal(client.commands.filter((command) => command === "ROLLBACK").length, 1);
});

test("does not report a code without PostgreSQL error severity", async () => {
  const build = await buildOneRoleBaseline();
  const first = build.files[0]!;
  const notDatabaseError = Object.assign(new Error("super-secret Node failure"), {
    code: "42501",
    detail: "detail-secret",
  });
  const client = new RecordingClient((text) => text === first.contents
    ? notDatabaseError
    : undefined);
  const error = await captureOperationFailure(executeOneRoleBaselineRun({
    mode: "dry-run",
    target: localTarget(),
    build,
    dependencies: scenarioDependencies(build, client, []),
  }));
  const serialized = formatOneRoleBaselineFailure(error);
  const evidence = JSON.parse(serialized) as {
    original_failure: Record<string, unknown>;
  };

  assert.equal("postgres_code" in evidence.original_failure, false);
  assertRedacted(serialized);
});

test("reports an independent postcheck failure after a successful dry-run rollback", async () => {
  const build = await buildOneRoleBaseline();
  const client = new RecordingClient();
  const events: string[] = [];

  const error = await captureOperationFailure(executeOneRoleBaselineRun({
    mode: "dry-run",
    target: localTarget(),
    build,
    dependencies: scenarioDependencies(build, client, events, {
      afterError: postgresError("08006", "super-secret postcheck failure"),
    }),
  }));
  const serialized = formatOneRoleBaselineFailure(error);
  const evidence = JSON.parse(serialized) as Record<string, unknown>;

  assert.deepEqual(evidence.original_failure, {
    failure_stage: "postflight_database_inspection",
    postgres_code: "08006",
  });
  assert.equal(evidence.rollback_attempt, "succeeded");
  assert.equal(evidence.rollback_state, "unknown");
  assert.deepEqual(evidence.rollback_verification_failure, {
    failure_stage: "rollback_database_inspection",
    postgres_code: "08006",
  });
  assert.deepEqual(events, ["inspect:1", "open", "close", "inspect:2"]);
  assertRedacted(serialized);
});

test("rejects a dirty preflight before opening an execution transaction", async () => {
  const build = await buildOneRoleBaseline();
  let opens = 0;
  const error = await captureOperationFailure(executeOneRoleBaselineRun({
    mode: "dry-run",
    target: localTarget(),
    build,
    dependencies: {
      inspect: async () => ({ ...state(), publicObjectCount: 1 }),
      openExecutionConnection: async () => {
        opens += 1;
        throw new Error("must not open");
      },
    },
  }));
  const evidence = JSON.parse(formatOneRoleBaselineFailure(error)) as Record<string, unknown>;

  assert.equal(opens, 0);
  assert.equal(evidence.transaction_started, false);
  assert.equal(evidence.rollback_attempt, "not_attempted");
  assert.deepEqual(evidence.original_failure, {
    failure_stage: "preflight_database_inspection",
  });
  assert.equal("rollback_state" in evidence, false);
});

test("marks an uncertain COMMIT without claiming rollback state", async () => {
  const build = await buildOneRoleBaseline();
  const client = new RecordingClient((text) =>
    text === "COMMIT" ? postgresError("08006", "super-secret commit failure") : undefined
  );
  const error = await captureOperationFailure(executeOneRoleBaselineRun({
    mode: "apply",
    target: localTarget(),
    build,
    dependencies: scenarioDependencies(build, client, []),
  }));
  const serialized = formatOneRoleBaselineFailure(error);
  const evidence = JSON.parse(serialized) as Record<string, unknown>;

  assert.deepEqual(evidence.original_failure, {
    failure_stage: "transaction_commit",
    postgres_code: "08006",
  });
  assert.equal(evidence.commit_result, "uncertain");
  assert.equal(evidence.post_failure_state, "clean");
  assert.equal("rollback_state" in evidence, false);
  assertRedacted(serialized);
});

test("CLI returns structured JSON and the correct exit code without database access", () => {
  const plan = spawnSync(process.execPath, ["scripts/db/run-one-role-baseline.ts", "--plan"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.stderr, "");
  assert.equal((JSON.parse(plan.stdout) as Record<string, unknown>).status, "pass");

  const rejected = spawnSync(process.execPath, ["scripts/db/run-one-role-baseline.ts", "--invalid"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  assert.deepEqual(JSON.parse(rejected.stderr), {
    status: "failed",
    baseline_id: ONE_ROLE_BASELINE_ID,
    original_failure: { failure_stage: "cli" },
    transaction_started: false,
    rollback_attempt: "not_attempted",
  });
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
        transformVersion: ONE_ROLE_TRANSFORM_VERSION,
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
  private readonly failureFor?: (text: string) => Error | undefined;

  constructor(failureFor?: (text: string) => Error | undefined) {
    this.failureFor = failureFor;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }> {
    void values;
    this.commands.push(text);
    const failure = this.failureFor?.(text);
    if (failure) throw failure;
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

function scenarioDependencies(
  build: OneRoleBaselineBuild,
  client: RecordingClient,
  events: string[],
  options: Readonly<{
    before?: OneRoleBaselineDatabaseState;
    after?: OneRoleBaselineDatabaseState;
    afterError?: Error;
    closeError?: Error;
  }> = {},
): OneRoleBaselineRunDependencies {
  const files = new Map(build.files.map(({ name, contents }) => [name, contents]));
  let inspections = 0;
  return {
    inspect: async () => {
      inspections += 1;
      events.push(`inspect:${inspections}`);
      if (inspections === 1) return options.before ?? state();
      if (options.afterError) throw options.afterError;
      return options.after ?? state();
    },
    openExecutionConnection: async () => {
      events.push("open");
      return {
        client,
        close: async () => {
          events.push("close");
          if (options.closeError) throw options.closeError;
        },
      };
    },
    readGeneratedFile: async (name) => files.get(name) ?? "",
    inspectLockedPreflight: lockedPreflight(client),
  };
}

async function captureOperationFailure(
  operation: Promise<unknown>,
): Promise<OneRoleBaselineOperationError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof OneRoleBaselineOperationError);
    return error;
  }
  assert.fail("Expected one-role baseline operation to fail.");
}

function postgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    severity: "ERROR",
    code,
    detail: "detail-secret",
    query: "SELECT 'query-secret'",
    host: "host-secret.example",
    connectionString: "postgresql://tianxing_app:url-secret@host-secret.example/db",
  });
}

function assertRedacted(serialized: string): void {
  for (const forbidden of [
    "super-secret",
    "detail-secret",
    "query-secret",
    "host-secret",
    "url-secret",
    "postgresql://",
    "stack",
    "message",
    "detail",
    "query",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
}

function occurrenceCount(source: string, search: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(search, offset)) !== -1) {
    count += 1;
    offset += search.length;
  }
  return count;
}
