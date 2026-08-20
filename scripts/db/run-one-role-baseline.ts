import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, type ClientConfig, type QueryResult } from "pg";

import {
  ONE_ROLE_BASELINE_DIRECTORY,
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_GENERATED_DIRECTORY,
  ONE_ROLE_MARKER_SCHEMA,
  ONE_ROLE_MARKER_TABLE,
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_VERSION,
  verifyCommittedOneRoleBaseline,
  type OneRoleBaselineBuild,
  type OneRoleBaselineManifest,
} from "./generate-one-role-baseline.ts";

export const ONE_ROLE_BASELINE_TIMEOUTS = Object.freeze({
  connectionMs: 5_000,
  statementMs: 10_000,
  lockMs: 5_000,
});

const REJECTED_LEGACY_DATABASE_VARIABLES = Object.freeze([
  "MIGRATION_DATABASE_URL",
  "TEST_MIGRATION_DATABASE_URL",
  "TEST_IDENTITY_DATABASE_URL",
  "TEST_APPLICATION_DATABASE_URL",
  "TEST_PROVISION_DATABASE_URL",
  "LOCAL_SYNTHETIC_IDENTITY_DATABASE_URL",
  "LOCAL_SYNTHETIC_APPLICATION_DATABASE_URL",
] as const);
const NEON_TEST_DIRECT_HOST =
  /^ep-[a-z0-9-]+(?:\.c-[0-9]+)?\.us-east-1\.aws\.neon\.tech$/;
const AWS_PRODUCTION_RDS_HOST =
  /^[a-z0-9][a-z0-9.-]*\.ap-east-1\.rds\.amazonaws\.com$/;

type Environment = Readonly<Record<string, string | undefined>>;
export type OneRoleBaselineMode = "plan" | "dry-run" | "apply";

export type OneRoleBaselineTarget = Readonly<{
  connectionString: string;
  host: string;
  port: 5432;
  database: string;
  user: typeof ONE_ROLE_CANONICAL_ROLE;
  ssl: false | Readonly<{ rejectUnauthorized: true }>;
}>;

export type OneRoleBaselineDatabaseState = Readonly<{
  databaseName: string;
  userName: string;
  databaseOwner: string;
  login: boolean;
  superuser: boolean;
  createDatabase: boolean;
  createRole: boolean;
  inherit: boolean;
  replication: boolean;
  bypassRls: boolean;
  publicObjectCount: number;
  marker: null | Readonly<{
    baselineId: string;
    transformVersion: string;
    manifestSha256: string;
    sourceMigrationCount: number;
  }>;
  rlsNotForcedCount: number;
  unsafeSecurityDefinerCount: number;
}>;

export interface OneRoleBaselineQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows">>;
}

export class OneRoleBaselineRunError extends Error {
  readonly code = "ONE_ROLE_BASELINE_REJECTED" as const;

  constructor(message = "One-role baseline operation was rejected.") {
    super(message);
    this.name = "OneRoleBaselineRunError";
  }
}

export function readOneRoleBaselineMode(arguments_: readonly string[]): OneRoleBaselineMode {
  if (arguments_.length !== 1) throw new OneRoleBaselineRunError();
  switch (arguments_[0]) {
    case "--plan": return "plan";
    case "--dry-run": return "dry-run";
    case "--apply": return "apply";
    default: throw new OneRoleBaselineRunError();
  }
}

export function readOneRoleBaselineTarget(
  environment: Environment = process.env,
  mode: Exclude<OneRoleBaselineMode, "plan"> = "dry-run",
): OneRoleBaselineTarget {
  for (const variable of REJECTED_LEGACY_DATABASE_VARIABLES) {
    if (environment[variable]?.trim()) throw new OneRoleBaselineRunError();
  }
  const appEnvironment = required(environment, "APP_ENV");
  const nodeEnvironment = required(environment, "NODE_ENV");
  if (
    !["development", "test", "production"].includes(appEnvironment) ||
    (appEnvironment === "development" && nodeEnvironment !== "development") ||
    (appEnvironment !== "development" && nodeEnvironment !== "production")
  ) {
    throw new OneRoleBaselineRunError();
  }
  const expectedDatabase = required(environment, "ONE_ROLE_BASELINE_EXPECTED_DATABASE");
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(expectedDatabase) ||
    new Set(["postgres", "template0", "template1"]).has(expectedDatabase)
  ) {
    throw new OneRoleBaselineRunError();
  }
  let url: URL;
  try {
    url = new URL(required(environment, "ONE_ROLE_BASELINE_DATABASE_URL"));
  } catch {
    throw new OneRoleBaselineRunError();
  }
  let user: string;
  let database: string;
  try {
    user = decodeURIComponent(url.username);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new OneRoleBaselineRunError();
  }
  const host = url.hostname.toLowerCase();
  const loopback = isLoopback(host);
  if (
    url.protocol !== "postgresql:" ||
    user !== ONE_ROLE_CANONICAL_ROLE ||
    url.password.length === 0 ||
    url.port !== "5432" ||
    url.pathname.split("/").length !== 2 ||
    database !== expectedDatabase ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    host.length === 0 ||
    host.includes("..") ||
    host.includes("-pooler.") ||
    (!loopback && (isIP(stripIpv6Brackets(host)) !== 0 || !host.includes(".")))
  ) {
    throw new OneRoleBaselineRunError();
  }
  if (
    (appEnvironment === "development" && (!loopback || database !== "tianxing")) ||
    (appEnvironment === "test" && !NEON_TEST_DIRECT_HOST.test(host)) ||
    (appEnvironment === "production" &&
      (!AWS_PRODUCTION_RDS_HOST.test(host) || database !== "tianxing"))
  ) {
    throw new OneRoleBaselineRunError();
  }
  if (
    mode === "apply" &&
    environment.ONE_ROLE_BASELINE_APPLY_CONFIRM?.trim() !== ONE_ROLE_BASELINE_ID
  ) {
    throw new OneRoleBaselineRunError();
  }
  return Object.freeze({
    connectionString: url.toString(),
    host,
    port: 5432 as const,
    database,
    user: ONE_ROLE_CANONICAL_ROLE,
    ssl: loopback ? false : Object.freeze({ rejectUnauthorized: true as const }),
  });
}

export function createOneRoleBaselineClientConfig(target: OneRoleBaselineTarget): ClientConfig {
  return {
    connectionString: target.connectionString,
    application_name: "tianxing-one-role-baseline",
    connectionTimeoutMillis: ONE_ROLE_BASELINE_TIMEOUTS.connectionMs,
    statement_timeout: ONE_ROLE_BASELINE_TIMEOUTS.statementMs,
    lock_timeout: ONE_ROLE_BASELINE_TIMEOUTS.lockMs,
    ssl: target.ssl,
  };
}

export async function executeOneRoleBaselineTransaction(input: Readonly<{
  client: OneRoleBaselineQueryClient;
  target: OneRoleBaselineTarget;
  mode: Exclude<OneRoleBaselineMode, "plan">;
  build: OneRoleBaselineBuild;
  readGeneratedFile?: (name: string) => Promise<string>;
  inspectPreflight?: (
    client: OneRoleBaselineQueryClient,
  ) => Promise<OneRoleBaselineDatabaseState>;
}>): Promise<void> {
  const readGeneratedFile = input.readGeneratedFile ?? ((name: string) =>
    readFile(resolve(ONE_ROLE_GENERATED_DIRECTORY, name), "utf8"));
  const manifestSha256 = sha256(input.build.manifestJson);
  let transactionOpen = false;
  try {
    await input.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionOpen = true;
    const lock = await input.client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
      [ONE_ROLE_BASELINE_ID],
    );
    if (lock.rows[0]?.acquired !== true) throw new OneRoleBaselineRunError();
    const lockedState = await (input.inspectPreflight ?? inspectOneRoleBaselineDatabase)(input.client);
    assertOneRoleBaselinePreflight(lockedState, input.target);

    for (const file of input.build.manifest.generated_files) {
      const before = await readGeneratedFile(file.name);
      assertFileHash(file, before);
      await input.client.query(before);
      const after = await readGeneratedFile(file.name);
      assertFileHash(file, after);
    }
    await createBaselineMarker(input.client, manifestSha256);
    if (input.mode === "dry-run") {
      await input.client.query("ROLLBACK");
    } else {
      await input.client.query("COMMIT");
    }
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        await input.client.query("ROLLBACK");
      } catch {
        // The caller receives only the fixed safety error.
      }
    }
    throw error instanceof OneRoleBaselineRunError ? error : new OneRoleBaselineRunError();
  }
}

export async function inspectOneRoleBaselineDatabase(
  client: OneRoleBaselineQueryClient,
): Promise<OneRoleBaselineDatabaseState> {
  const identity = await client.query<{
    database_name: string;
    user_name: string;
    database_owner: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(`
    SELECT current_database() AS database_name,
           current_user AS user_name,
           pg_get_userbyid(database_row.datdba) AS database_owner,
           role_row.rolcanlogin,
           role_row.rolsuper,
           role_row.rolcreatedb,
           role_row.rolcreaterole,
           role_row.rolinherit,
           role_row.rolreplication,
           role_row.rolbypassrls
      FROM pg_database AS database_row
      JOIN pg_roles AS role_row ON role_row.rolname = current_user
     WHERE database_row.datname = current_database()
  `);
  const objects = await client.query<{ count: string }>(`
    SELECT (
      (SELECT count(*) FROM pg_class AS class_row
        JOIN pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
       WHERE namespace_row.nspname = 'public'
         AND class_row.relkind IN ('r', 'p', 'v', 'm', 'S', 'f'))
      +
      (SELECT count(*) FROM pg_proc AS procedure_row
        JOIN pg_namespace AS namespace_row ON namespace_row.oid = procedure_row.pronamespace
       WHERE namespace_row.nspname = 'public')
    )::text AS count
  `);
  const markerExists = await client.query<{ marker_name: string | null }>(
    "SELECT to_regclass($1)::text AS marker_name",
    [`${ONE_ROLE_MARKER_SCHEMA}.${ONE_ROLE_MARKER_TABLE}`],
  );
  const marker = markerExists.rows[0]?.marker_name === null
    ? { rows: [] as {
      baseline_id: string;
      transform_version: string;
      manifest_sha256: string;
      source_migration_count: number;
    }[] }
    : await client.query<{
    baseline_id: string;
    transform_version: string;
    manifest_sha256: string;
    source_migration_count: number;
  }>(`
    SELECT baseline_id, transform_version, manifest_sha256, source_migration_count
     FROM ${ONE_ROLE_MARKER_SCHEMA}.${ONE_ROLE_MARKER_TABLE}
     WHERE baseline_id = $1
  `, [ONE_ROLE_BASELINE_ID]);
  const rls = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
      FROM pg_class AS class_row
      JOIN pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
     WHERE namespace_row.nspname = 'public'
       AND class_row.relkind IN ('r', 'p')
       AND class_row.relrowsecurity
       AND NOT class_row.relforcerowsecurity
  `);
  const functions = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
      FROM pg_proc AS procedure_row
      JOIN pg_namespace AS namespace_row ON namespace_row.oid = procedure_row.pronamespace
     WHERE namespace_row.nspname = 'public'
       AND procedure_row.prosecdef
       AND (
         NOT COALESCE(procedure_row.proconfig, ARRAY[]::text[])
           @> ARRAY['search_path=pg_catalog, public']::text[]
         OR EXISTS (
           SELECT 1
             FROM aclexplode(COALESCE(
               procedure_row.proacl,
               acldefault('f', procedure_row.proowner)
             )) AS acl_row
            WHERE acl_row.grantee = 0
              AND acl_row.privilege_type = 'EXECUTE'
         )
       )
  `);
  const current = identity.rows[0];
  if (!current) throw new OneRoleBaselineRunError();
  const markerRow = marker.rows[0];
  return Object.freeze({
    databaseName: current.database_name,
    userName: current.user_name,
    databaseOwner: current.database_owner,
    login: current.rolcanlogin,
    superuser: current.rolsuper,
    createDatabase: current.rolcreatedb,
    createRole: current.rolcreaterole,
    inherit: current.rolinherit,
    replication: current.rolreplication,
    bypassRls: current.rolbypassrls,
    publicObjectCount: Number(objects.rows[0]?.count ?? "0"),
    marker: markerRow ? Object.freeze({
      baselineId: markerRow.baseline_id,
      transformVersion: markerRow.transform_version,
      manifestSha256: markerRow.manifest_sha256,
      sourceMigrationCount: markerRow.source_migration_count,
    }) : null,
    rlsNotForcedCount: Number(rls.rows[0]?.count ?? "0"),
    unsafeSecurityDefinerCount: Number(functions.rows[0]?.count ?? "0"),
  });
}

export function assertOneRoleBaselinePreflight(
  state: OneRoleBaselineDatabaseState,
  target: OneRoleBaselineTarget,
): void {
  if (
    state.databaseName !== target.database ||
    state.userName !== ONE_ROLE_CANONICAL_ROLE ||
    state.databaseOwner !== ONE_ROLE_CANONICAL_ROLE ||
    !state.login ||
    state.superuser ||
    state.createDatabase ||
    state.createRole ||
    state.inherit ||
    state.replication ||
    state.bypassRls ||
    state.publicObjectCount !== 0 ||
    state.marker !== null ||
    state.rlsNotForcedCount !== 0 ||
    state.unsafeSecurityDefinerCount !== 0
  ) {
    throw new OneRoleBaselineRunError();
  }
}

export function assertOneRoleBaselinePostflight(input: Readonly<{
  state: OneRoleBaselineDatabaseState;
  target: OneRoleBaselineTarget;
  mode: Exclude<OneRoleBaselineMode, "plan">;
  manifestSha256: string;
}>): void {
  const { state, target, mode } = input;
  if (
    state.databaseName !== target.database ||
    state.userName !== ONE_ROLE_CANONICAL_ROLE ||
    state.databaseOwner !== ONE_ROLE_CANONICAL_ROLE ||
    state.rlsNotForcedCount !== 0 ||
    state.unsafeSecurityDefinerCount !== 0
  ) {
    throw new OneRoleBaselineRunError();
  }
  if (mode === "dry-run") {
    if (state.publicObjectCount !== 0 || state.marker !== null) throw new OneRoleBaselineRunError();
    return;
  }
  if (
    state.publicObjectCount === 0 ||
    state.marker?.baselineId !== ONE_ROLE_BASELINE_ID ||
    state.marker.transformVersion !== ONE_ROLE_TRANSFORM_VERSION ||
    state.marker.manifestSha256 !== input.manifestSha256 ||
    state.marker.sourceMigrationCount !== ONE_ROLE_SOURCE_COUNT
  ) {
    throw new OneRoleBaselineRunError();
  }
}

async function createBaselineMarker(
  client: OneRoleBaselineQueryClient,
  manifestSha256: string,
): Promise<void> {
  await client.query(`CREATE SCHEMA ${ONE_ROLE_MARKER_SCHEMA}`);
  await client.query(`
    CREATE TABLE ${ONE_ROLE_MARKER_SCHEMA}.${ONE_ROLE_MARKER_TABLE} (
      baseline_id text PRIMARY KEY,
      transform_version text NOT NULL,
      manifest_sha256 char(64) NOT NULL,
      source_migration_count integer NOT NULL,
      installed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT tianxing_baseline_manifest_sha256_check
        CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT tianxing_baseline_source_count_check
        CHECK (source_migration_count = ${ONE_ROLE_SOURCE_COUNT})
    )
  `);
  await client.query(`
    INSERT INTO ${ONE_ROLE_MARKER_SCHEMA}.${ONE_ROLE_MARKER_TABLE}
      (baseline_id, transform_version, manifest_sha256, source_migration_count)
    VALUES ($1, $2, $3, $4)
  `, [ONE_ROLE_BASELINE_ID, ONE_ROLE_TRANSFORM_VERSION, manifestSha256, ONE_ROLE_SOURCE_COUNT]);
}

function assertFileHash(
  file: OneRoleBaselineManifest["generated_files"][number],
  contents: string,
): void {
  if (sha256(contents) !== file.sha256) throw new OneRoleBaselineRunError();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required(environment: Environment, variable: string): string {
  const value = environment[variable]?.trim();
  if (!value || /[\r\n]/.test(value)) throw new OneRoleBaselineRunError();
  return value;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isLoopback(host: string): boolean {
  const address = stripIpv6Brackets(host);
  return host === "localhost" || host.endsWith(".localhost") ||
    address === "127.0.0.1" || address === "::1";
}

async function inspectWithNewClient(target: OneRoleBaselineTarget): Promise<OneRoleBaselineDatabaseState> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  await client.connect();
  try {
    return await inspectOneRoleBaselineDatabase(client);
  } finally {
    await client.end();
  }
}

async function runDatabaseMode(
  mode: Exclude<OneRoleBaselineMode, "plan">,
  environment: Environment,
  build: OneRoleBaselineBuild,
): Promise<void> {
  const target = readOneRoleBaselineTarget(environment, mode);
  const before = await inspectWithNewClient(target);
  assertOneRoleBaselinePreflight(before, target);
  const client = new Client(createOneRoleBaselineClientConfig(target));
  await client.connect();
  try {
    await executeOneRoleBaselineTransaction({ client, target, mode, build });
  } finally {
    await client.end();
  }
  const manifestSha256 = sha256(build.manifestJson);
  const after = await inspectWithNewClient(target);
  assertOneRoleBaselinePostflight({ state: after, target, mode, manifestSha256 });
  process.stdout.write(`${JSON.stringify({
    baseline_id: ONE_ROLE_BASELINE_ID,
    mode,
    target_database: target.database,
    canonical_login_role: ONE_ROLE_CANONICAL_ROLE,
    source_migrations: build.manifest.source_migrations.length,
    generated_files: build.manifest.generated_files.length,
    marker: mode === "apply" ? "installed" : "rolled_back",
    status: "pass",
  })}\n`);
}

async function runCli(arguments_: readonly string[], environment: Environment): Promise<void> {
  const mode = readOneRoleBaselineMode(arguments_);
  const build = await verifyCommittedOneRoleBaseline();
  if (mode === "plan") {
    process.stdout.write(`${JSON.stringify({
      baseline_id: ONE_ROLE_BASELINE_ID,
      mode,
      source_migrations: build.manifest.source_migrations.length,
      generated_files: build.manifest.generated_files.length,
      manifest_sha256: sha256(build.manifestJson),
      transaction_contract: build.manifest.transaction_contract,
      marker: `${ONE_ROLE_MARKER_SCHEMA}.${ONE_ROLE_MARKER_TABLE}`,
      status: "pass",
    }, null, 2)}\n`);
    return;
  }
  await runDatabaseMode(mode, environment, build);
}

const isMainModule = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli(process.argv.slice(2), process.env).catch(() => {
    process.stderr.write("One-role baseline operation failed safely.\n");
    process.exitCode = 1;
  });
}

export const ONE_ROLE_BASELINE_ASSET_ROOT = ONE_ROLE_BASELINE_DIRECTORY;
