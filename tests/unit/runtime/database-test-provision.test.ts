import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_VERSION,
} from "../../../scripts/db/generate-one-role-baseline.ts";
import {
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
} from "../../../scripts/db/neon-test-synthetic-fixture.ts";
import {
  DatabaseTestProvisionError,
  DatabaseTestProvisionOperationError,
  formatDatabaseTestProvisionFailure,
  provisionDatabaseTestIdentity,
  readDatabaseTestPasswordFromStream,
  readDatabaseTestProvisionArguments,
  readDatabaseTestProvisionTarget,
  runDatabaseTestProvisionCli,
  type DatabaseTestProvisionDependencies,
  type DatabaseTestProvisionFailureStage,
  type DatabaseTestProvisionQueryClient,
  type DatabaseTestProvisionTarget,
} from "../../../scripts/db/provision-database-test-identity.ts";

test("uses the canonical one-role Neon target", () => {
  assert.deepEqual(readDatabaseTestProvisionTarget(validEnvironment()), TARGET);
});

test("uses the same provision contract for the canonical loopback development target", () => {
  assert.deepEqual(readDatabaseTestProvisionTarget(localEnvironment()), {
    connectionString: LOCAL_BASELINE_URL,
    loginUser: "tianxing_app",
    databaseName: "tianxing",
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
    ssl: false,
  });
});

test("rejects legacy, Vercel, and non-test provision targets", () => {
  for (const environment of [
    { ...validEnvironment(), TEST_PROVISION_DATABASE_URL: BASELINE_URL },
    { ...validEnvironment(), TEST_MIGRATION_DATABASE_URL: BASELINE_URL },
    { ...validEnvironment(), VERCEL: "1" },
    { ...validEnvironment(), APP_ENV: "production" },
    { ...validEnvironment(), ONE_ROLE_BASELINE_DATABASE_URL:
      BASELINE_URL.replace("tianxing_app", "env01_migration_login") },
  ]) {
    assert.throws(() => readDatabaseTestProvisionTarget(environment), DatabaseTestProvisionError);
  }
});

test("accepts the package-owned password flag once or redundantly", () => {
  const expected = { normalizedEmail: "founder@env01.test.invalid", rotate: false };
  assert.deepEqual(readDatabaseTestProvisionArguments([
    "--password-stdin",
    "--email=founder@env01.test.invalid",
  ]), expected);
  assert.deepEqual(readDatabaseTestProvisionArguments([
    "--password-stdin",
    "--email=founder@env01.test.invalid",
    "--password-stdin",
  ]), expected);
});

test("runs the CLI path with a duplicate password flag without duplicating credentials", async () => {
  const client = new ScenarioClient();
  const status = await runDatabaseTestProvisionCli({
    arguments: [
      "--password-stdin",
      "--email=founder@env01.test.invalid",
      "--password-stdin",
    ],
    inputStream: streamOf(Buffer.from("synthetic-password\n")),
    readTarget: () => TARGET,
    dependencies: dependenciesFor(client),
  });
  assert.equal(status, "created");
  assert.equal(client.queries.filter((query) => query === "COMMIT").length, 1);
  const contextIndex = client.queries.findIndex((query) => query.includes("set_config"));
  const lookupIndex = client.queries.findIndex((query) =>
    query.includes("lookup_provision_credential")
  );
  assert.ok(contextIndex > client.queries.indexOf("BEGIN ISOLATION LEVEL SERIALIZABLE"));
  assert.ok(lookupIndex > contextIndex);
  assert.deepEqual(client.values[contextIndex], [
    NEON_TEST_ORGANIZATION.id,
    NEON_TEST_PRINCIPALS[0]!.userId,
  ]);
});

test("clears collected password chunks when the stream exceeds the limit", async () => {
  const chunk = Buffer.alloc(258, 0x61);
  await assert.rejects(
    readDatabaseTestPasswordFromStream(streamOf(chunk)),
    DatabaseTestProvisionError,
  );
  assert.ok(chunk.every((byte) => byte === 0));
});

test("clears collected password chunks when stream iteration fails", async () => {
  const chunk = Buffer.from("temporary-secret");
  const failingStream: AsyncIterable<Buffer> = {
    async *[Symbol.asyncIterator]() {
      yield chunk;
      throw new Error("synthetic stream failure");
    },
  };
  await assert.rejects(
    readDatabaseTestPasswordFromStream(failingStream),
    DatabaseTestProvisionError,
  );
  assert.ok(chunk.every((byte) => byte === 0));
});

test("attributes every database operation boundary to a stable stage", async () => {
  const cases: readonly Readonly<{
    expected: DatabaseTestProvisionFailureStage;
    configure(client: ScenarioClient): DatabaseTestProvisionDependencies;
  }>[] = [
    {
      expected: "baseline_manifest",
      configure: (client) => dependenciesFor(client, {
        verifyBaseline: async () => { throw pgError("XX001"); },
      }),
    },
    {
      expected: "connection",
      configure: (client) => dependenciesFor(client, {
        openConnection: async () => { throw pgError("08006"); },
      }),
    },
    stageCase("transaction_begin", "BEGIN"),
    stageCase("preflight_identity", "FROM pg_database"),
    stageCase("preflight_marker", "FROM tianxing_baseline.installations"),
    stageCase("credential_lookup", "lookup_provision_credential"),
    {
      expected: "password_derivation",
      configure: (client) => dependenciesFor(client, {
        deriveVerifier: async () => { throw pgError("XX002"); },
      }),
    },
    stageCase("provision_function", "SELECT identity_database_test_provision_credential"),
    stageCase("transaction_commit", "COMMIT"),
  ];

  for (const item of cases) {
    const client = new ScenarioClient();
    const dependencies = item.configure(client);
    await assert.rejects(
      provisionDatabaseTestIdentity({
        target: TARGET,
        normalizedEmail: "founder@env01.test.invalid",
        password: Buffer.from("synthetic-password"),
        rotate: false,
        dependencies,
      }),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseTestProvisionOperationError);
        assert.equal(error.originalFailure.failure_stage, item.expected);
        return true;
      },
    );
  }
});

test("reports clean rollback while retaining the original failure", async () => {
  const client = new ScenarioClient({ failOn: "lookup_provision_credential" });
  const error = await rejectedOperation(client);
  assert.deepEqual(error.originalFailure, {
    failure_stage: "credential_lookup",
    postgres_code: "42501",
  });
  assert.equal(error.transactionStarted, true);
  assert.equal(error.rollbackAttempt, "succeeded");
  assert.equal(error.rollbackState, "clean");
  assert.equal(error.commitResult, "not_attempted");
});

test("retains rollback failure and marks state unknown", async () => {
  const client = new ScenarioClient({
    failOn: "lookup_provision_credential",
    failRollback: true,
  });
  const error = await rejectedOperation(client);
  assert.equal(error.originalFailure.failure_stage, "credential_lookup");
  assert.equal(error.rollbackAttempt, "failed");
  assert.equal(error.rollbackState, "unknown");
  assert.deepEqual(error.rollbackFailure, {
    failure_stage: "transaction_rollback",
    postgres_code: "40003",
  });
});

test("never claims clean rollback after an uncertain commit", async () => {
  const client = new ScenarioClient({ failOn: "COMMIT" });
  const error = await rejectedOperation(client);
  const output = formatDatabaseTestProvisionFailure(error);
  assert.equal(error.commitResult, "uncertain");
  assert.equal(error.rollbackAttempt, "succeeded");
  assert.equal(error.rollbackState, "unknown");
  assert.match(output, /"retry":"forbidden"/);
  assert.match(output, /"operator_action":"freeze_and_escalate"/);
});

test("reports connection close separately after a successful commit", async () => {
  const client = new ScenarioClient();
  const dependencies = dependenciesFor(client, {
    openConnection: async () => ({
      client,
      close: async () => { throw pgError("08006"); },
    }),
  });
  const error = await rejectedOperation(client, dependencies);
  assert.equal(error.originalFailure.failure_stage, "connection_close");
  assert.equal(error.commitResult, "succeeded");
  assert.equal(error.rollbackAttempt, "not_attempted");
  assert.equal(error.rollbackState, "not_applicable");
});

test("formats only allowlisted evidence and a verified PostgreSQL SQLSTATE", async () => {
  const client = new ScenarioClient({ failOn: "lookup_provision_credential" });
  const output = formatDatabaseTestProvisionFailure(await rejectedOperation(client));
  assert.deepEqual(JSON.parse(output), {
    status: "failed",
    operation: "database_test_identity_provision",
    original_failure: {
      failure_stage: "credential_lookup",
      postgres_code: "42501",
    },
    transaction_started: true,
    commit_result: "not_attempted",
    rollback_attempt: "succeeded",
    rollback_state: "clean",
  });
  for (const secret of ["raw-secret", "host.internal", "SELECT secret", "stack-secret"]) {
    assert.doesNotMatch(output, new RegExp(secret.replace(".", "\\.")));
  }

  const nodeError = new Error("raw-secret") as Error & { code: string };
  nodeError.code = "ENOENT";
  const nodeOutput = formatDatabaseTestProvisionFailure(nodeError);
  assert.doesNotMatch(nodeOutput, /postgres_code|ENOENT|raw-secret/);
  assert.doesNotMatch(formatDatabaseTestProvisionFailure({
    code: "42P01",
    severity: "ERROR",
    message: "raw-secret",
  }), /postgres_code|42P01|raw-secret/);
});

test("package alias owns exactly one password-stdin flag", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = packageJson.scripts["db:provision:test-identity"];
  assert.ok(command);
  assert.equal(command.match(/--password-stdin/g)?.length, 1);
  assert.doesNotMatch(command, /\s--\s/);
  const localCommand = packageJson.scripts["db:provision:local-identity"];
  assert.ok(localCommand);
  assert.equal(localCommand.match(/--password-stdin/g)?.length, 1);
  assert.match(localCommand, /--env-file=\.env\.migration\.local/);
  assert.doesNotMatch(localCommand, /\.env\.migration\.neon-test|\s--\s/);
});

test("pnpm 10 forwards the supported email argument without a bare separator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxing-pnpm-argv-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({
      private: true,
      packageManager: "pnpm@10.34.4",
      scripts: { capture: "node capture.mjs --password-stdin" },
    }));
    await writeFile(join(directory, "capture.mjs"), [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("argv.json", import.meta.url), JSON.stringify(process.argv.slice(2)));',
      "",
    ].join("\n"));

    assert.equal((await runPnpm(["--version"], directory)).trim(), "10.34.4");
    await runPnpm([
      "run",
      "capture",
      "--email=founder@env01.test.invalid",
    ], directory);
    const supportedArguments = JSON.parse(
      await readFile(join(directory, "argv.json"), "utf8"),
    ) as string[];
    assert.deepEqual(supportedArguments, [
      "--password-stdin",
      "--email=founder@env01.test.invalid",
    ]);
    assert.deepEqual(readDatabaseTestProvisionArguments(supportedArguments), {
      normalizedEmail: "founder@env01.test.invalid",
      rotate: false,
    });

    await unlink(join(directory, "argv.json"));
    await runPnpm([
      "run",
      "capture",
      "--",
      "--email=founder@env01.test.invalid",
    ], directory);
    const rejectedArguments = JSON.parse(
      await readFile(join(directory, "argv.json"), "utf8"),
    ) as string[];
    assert.deepEqual(rejectedArguments, [
      "--password-stdin",
      "--",
      "--email=founder@env01.test.invalid",
    ]);
    assert.throws(
      () => readDatabaseTestProvisionArguments(rejectedArguments),
      DatabaseTestProvisionOperationError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runbook reads the provision password silently without an inline secret", async () => {
  const runbook = await readFile("docs/runbooks/ENV-01_NEON_TEST_DATABASE.md", "utf8");
  const section = runbook.slice(
    runbook.indexOf("## 7.1 Database-test 身份凭据 Provision"),
    runbook.indexOf("## 8. 安全证据模板"),
  );
  const code = /```zsh\n([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(code);
  assert.match(code, /read -r -s 'ENV01_TEST_PASSWORD\?Database-test password: '/);
  assert.match(code, /printf '\\n'/);
  assert.match(code, /printf '%s\\n' "\$ENV01_TEST_PASSWORD"/);
  assert.match(
    code,
    /pnpm db:provision:test-identity --email=founder@env01\.test\.invalid/,
  );
  assert.match(code, /ENV01_TEST_PASSWORD=''\nunset ENV01_TEST_PASSWORD/);
  assert.doesNotMatch(code, /--password-stdin|echo\s|<一次性|<password|['"]password['"]/i);
  assert.doesNotMatch(code, /db:provision:test-identity\s+--\s+/);
});

test("provision CLI requires the baseline marker and never recreates identities or database roles", async () => {
  const source = await readFile("scripts/db/provision-database-test-identity.ts", "utf8");
  assert.match(source, /ONE_ROLE_MARKER_SCHEMA/);
  assert.match(source, /ONE_ROLE_BASELINE_DATABASE_URL|readOneRoleBaselineTarget/);
  assert.doesNotMatch(source, /TEST_PROVISION_DATABASE_URL/);
  assert.doesNotMatch(source, /pg_has_role/);
  assert.doesNotMatch(source, /CREATE\s+ROLE|ALTER\s+ROLE/i);
  assert.doesNotMatch(source, /INSERT\s+INTO/i);
  assert.doesNotMatch(source, /identity_users\s*\(/i);
  assert.doesNotMatch(source, /access_organization_memberships\s*\(/i);
  assert.match(source, /identity_database_test_provision_credential/);
});

const BASELINE_URL =
  "postgresql://tianxing_app:synthetic-secret@ep-synthetic-123.c-2.us-east-1.aws.neon.tech:5432/txgj_env01_test";
const LOCAL_BASELINE_URL =
  "postgresql://tianxing_app:synthetic-secret@127.0.0.1:5432/tianxing";
const TARGET: DatabaseTestProvisionTarget = Object.freeze({
  connectionString: BASELINE_URL,
  loginUser: "tianxing_app",
  databaseName: "txgj_env01_test",
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
  ssl: Object.freeze({ rejectUnauthorized: true as const }),
});
const MANIFEST_JSON = "synthetic-manifest";
const MANIFEST_SHA256 = createHash("sha256").update(MANIFEST_JSON).digest("hex");

class ScenarioClient implements DatabaseTestProvisionQueryClient {
  readonly queries: string[] = [];
  readonly values: (readonly unknown[] | undefined)[] = [];
  private readonly options: Readonly<{
    failOn?: string;
    failRollback?: boolean;
  }>;

  constructor(options: Readonly<{
    failOn?: string;
    failRollback?: boolean;
  }> = {}) {
    this.options = options;
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }> {
    const normalized = text.trim();
    this.queries.push(normalized);
    this.values.push(values);
    if (
      (this.options.failOn && normalized.includes(this.options.failOn)) ||
      (this.options.failRollback && normalized === "ROLLBACK")
    ) {
      throw pgError(normalized === "ROLLBACK" ? "40003" : "42501");
    }
    if (normalized.includes("FROM pg_database")) {
      return { rows: [{
        database_name: TARGET.databaseName,
        user_name: "tianxing_app",
        database_owner: "tianxing_app",
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      } as unknown as Row] };
    }
    if (normalized.includes("FROM tianxing_baseline.installations")) {
      return { rows: [{
        transform_version: ONE_ROLE_TRANSFORM_VERSION,
        manifest_sha256: MANIFEST_SHA256,
        source_migration_count: ONE_ROLE_SOURCE_COUNT,
      } as unknown as Row] };
    }
    if (normalized.includes("lookup_provision_credential")) {
      return { rows: [{
        user_id: "51000000-0000-4000-8000-000000000101",
        verifier_version: null,
        password_salt: null,
        password_verifier: null,
        credential_status: null,
      } as unknown as Row] };
    }
    if (normalized.includes("SELECT identity_database_test_provision_credential")) {
      return { rows: [{ status: "created" } as unknown as Row] };
    }
    return { rows: [] };
  }
}

function dependenciesFor(
  client: ScenarioClient,
  overrides: Partial<DatabaseTestProvisionDependencies> = {},
): DatabaseTestProvisionDependencies {
  return Object.freeze({
    verifyBaseline: async () => ({ manifestJson: MANIFEST_JSON }),
    openConnection: async () => ({ client, close: async () => {} }),
    deriveVerifier: async () => Buffer.alloc(64, 0x42),
    createSalt: (size: number) => Buffer.alloc(size, 0x24),
    ...overrides,
  });
}

function stageCase(
  expected: DatabaseTestProvisionFailureStage,
  failOn: string,
): Readonly<{
  expected: DatabaseTestProvisionFailureStage;
  configure(client: ScenarioClient): DatabaseTestProvisionDependencies;
}> {
  return {
    expected,
    configure: () => dependenciesFor(new ScenarioClient({ failOn })),
  };
}

async function rejectedOperation(
  client: ScenarioClient,
  dependencies = dependenciesFor(client),
): Promise<DatabaseTestProvisionOperationError> {
  try {
    await provisionDatabaseTestIdentity({
      target: TARGET,
      normalizedEmail: "founder@env01.test.invalid",
      password: Buffer.from("synthetic-password"),
      rotate: false,
      dependencies,
    });
  } catch (error) {
    assert.ok(error instanceof DatabaseTestProvisionOperationError);
    return error;
  }
  throw new Error("Expected provisioning to fail.");
}

function pgError(code: string): Error {
  const error = new Error("raw-secret at host.internal") as Error & {
    code: string;
    severity: string;
    detail: string;
    query: string;
  };
  error.code = code;
  error.severity = "ERROR";
  error.detail = "stack-secret";
  error.query = "SELECT secret";
  return error;
}

function validEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "test",
    NODE_ENV: "production",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "txgj_env01_test",
    ONE_ROLE_BASELINE_DATABASE_URL: BASELINE_URL,
  };
}

function localEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "development",
    NODE_ENV: "development",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "tianxing",
    ONE_ROLE_BASELINE_DATABASE_URL: LOCAL_BASELINE_URL,
  };
}

async function* streamOf(chunk: Buffer): AsyncIterable<Buffer> {
  yield chunk;
}

async function runPnpm(arguments_: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", arguments_, {
      cwd,
      env: {
        HOME: cwd,
        PATH: process.env.PATH,
        CI: "1",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      if (code === 0) resolve(stdout);
      else reject(new Error("Offline pnpm argv contract failed."));
    });
  });
}
