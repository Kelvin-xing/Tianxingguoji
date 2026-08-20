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
const LEGACY_DRY_RUN_SCHEMA_PREFIX = "migration_dry_run_env01_";
const POSTGRES_ERROR_SEVERITIES = new Set([
  "ERROR",
  "FATAL",
  "PANIC",
  "WARNING",
  "NOTICE",
  "DEBUG",
  "INFO",
  "LOG",
]);

type Environment = Readonly<Record<string, string | undefined>>;
export type OneRoleBaselineMode = "plan" | "dry-run" | "apply";
export type OneRoleBaselineFailureStage =
  | "cli"
  | "baseline_manifest"
  | "preflight_database_inspection"
  | "execution_connection"
  | "transaction_begin"
  | "transaction_execution"
  | "advisory_lock"
  | "locked_preflight"
  | "generated_manifest_before"
  | "generated_sql"
  | "generated_manifest_after"
  | "marker_write"
  | "transaction_rollback"
  | "transaction_commit"
  | "execution_connection_close"
  | "rollback_database_inspection"
  | "rollback_state_verification"
  | "postflight_database_inspection"
  | "postflight_state_verification";
export type OneRoleBaselineFailureEvidence = Readonly<{
  failure_stage: OneRoleBaselineFailureStage;
  migration_name?: string;
  postgres_code?: string;
}>;
export type OneRoleBaselineRollbackAttempt = "not_attempted" | "succeeded" | "failed";
export type OneRoleBaselineRollbackState = "clean" | "unknown" | "verification_failed";
export type OneRoleBaselinePostFailureState =
  | "clean"
  | "installed"
  | "installed_but_verification_failed"
  | "unknown"
  | "verification_failed";
export type OneRoleBaselineSuccessEvidence = Readonly<{
  status: "pass";
  baseline_id: typeof ONE_ROLE_BASELINE_ID;
  mode: Exclude<OneRoleBaselineMode, "plan">;
  target_database: string;
  canonical_login_role: typeof ONE_ROLE_CANONICAL_ROLE;
  source_migrations: number;
  generated_files: number;
  postflight_state: "clean" | "installed";
  marker: "rolled_back" | "installed";
  verification: Readonly<{
    role_contract: "verified";
    member_of_neon_superuser: false;
    granted_role_count: number;
    marker_ownership: "absent" | "verified";
    public_object_count: number;
    public_wrong_owner_count: number;
    rls_not_forced_count: number;
    unsafe_security_definer_count: number;
    migration_metadata: "absent";
    stale_dry_run_schema_count: number;
  }>;
}>;

export type OneRoleBaselineTarget = Readonly<{
  connectionString: string;
  host: string;
  port: number;
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
  memberOfNeonSuperuser: boolean;
  grantedRoleCount: number;
  publicObjectCount: number;
  publicWrongOwnerCount: number;
  markerSchemaOwner: string | null;
  markerTableOwner: string | null;
  markerRowCount: number;
  marker: null | Readonly<{
    baselineId: string;
    transformVersion: string;
    manifestSha256: string;
    sourceMigrationCount: number;
  }>;
  rlsNotForcedCount: number;
  unsafeSecurityDefinerCount: number;
  migrationSchemaPresent: boolean;
  migrationLedgerPresent: boolean;
  staleDryRunSchemaCount: number;
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

export class OneRoleBaselineAttemptError extends OneRoleBaselineRunError {
  readonly originalFailure: OneRoleBaselineFailureEvidence;
  readonly transactionStarted: boolean;
  readonly rollbackAttempt: OneRoleBaselineRollbackAttempt;
  readonly transactionRollbackFailure?: OneRoleBaselineFailureEvidence;
  readonly commitResultUncertain: boolean;

  constructor(input: Readonly<{
    originalFailure: OneRoleBaselineFailureEvidence;
    transactionStarted: boolean;
    rollbackAttempt: OneRoleBaselineRollbackAttempt;
    transactionRollbackFailure?: OneRoleBaselineFailureEvidence;
    commitResultUncertain?: boolean;
  }>) {
    super();
    this.name = "OneRoleBaselineAttemptError";
    this.originalFailure = input.originalFailure;
    this.transactionStarted = input.transactionStarted;
    this.rollbackAttempt = input.rollbackAttempt;
    this.transactionRollbackFailure = input.transactionRollbackFailure;
    this.commitResultUncertain = input.commitResultUncertain === true;
  }
}

export class OneRoleBaselineOperationError extends OneRoleBaselineRunError {
  readonly mode?: Exclude<OneRoleBaselineMode, "plan">;
  readonly originalFailure: OneRoleBaselineFailureEvidence;
  readonly transactionStarted: boolean;
  readonly rollbackAttempt: OneRoleBaselineRollbackAttempt;
  readonly transactionRollbackFailure?: OneRoleBaselineFailureEvidence;
  readonly rollbackState?: OneRoleBaselineRollbackState;
  readonly rollbackVerificationFailure?: OneRoleBaselineFailureEvidence;
  readonly executionConnectionCloseFailure?: OneRoleBaselineFailureEvidence;
  readonly postFailureState?: OneRoleBaselinePostFailureState;
  readonly postFailureVerificationFailure?: OneRoleBaselineFailureEvidence;
  readonly commitResultUncertain: boolean;
  readonly applyCommitted: boolean;

  constructor(input: Readonly<{
    mode?: Exclude<OneRoleBaselineMode, "plan">;
    originalFailure: OneRoleBaselineFailureEvidence;
    transactionStarted?: boolean;
    rollbackAttempt?: OneRoleBaselineRollbackAttempt;
    transactionRollbackFailure?: OneRoleBaselineFailureEvidence;
    rollbackState?: OneRoleBaselineRollbackState;
    rollbackVerificationFailure?: OneRoleBaselineFailureEvidence;
    executionConnectionCloseFailure?: OneRoleBaselineFailureEvidence;
    postFailureState?: OneRoleBaselinePostFailureState;
    postFailureVerificationFailure?: OneRoleBaselineFailureEvidence;
    commitResultUncertain?: boolean;
    applyCommitted?: boolean;
  }>) {
    super();
    this.name = "OneRoleBaselineOperationError";
    this.mode = input.mode;
    this.originalFailure = input.originalFailure;
    this.transactionStarted = input.transactionStarted === true;
    this.rollbackAttempt = input.rollbackAttempt ?? "not_attempted";
    this.transactionRollbackFailure = input.transactionRollbackFailure;
    this.rollbackState = input.rollbackState;
    this.rollbackVerificationFailure = input.rollbackVerificationFailure;
    this.executionConnectionCloseFailure = input.executionConnectionCloseFailure;
    this.postFailureState = input.postFailureState;
    this.postFailureVerificationFailure = input.postFailureVerificationFailure;
    this.commitResultUncertain = input.commitResultUncertain === true;
    this.applyCommitted = input.applyCommitted === true;
  }
}

export type OneRoleBaselineExecutionConnection = Readonly<{
  client: OneRoleBaselineQueryClient;
  close(): Promise<void>;
}>;

export type OneRoleBaselineRunDependencies = Readonly<{
  inspect(): Promise<OneRoleBaselineDatabaseState>;
  openExecutionConnection(): Promise<OneRoleBaselineExecutionConnection>;
  readGeneratedFile?: (name: string) => Promise<string>;
  inspectLockedPreflight?: (
    client: OneRoleBaselineQueryClient,
  ) => Promise<OneRoleBaselineDatabaseState>;
}>;

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
    port: Number(url.port),
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

  try {
    await input.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  } catch (error) {
    throw new OneRoleBaselineAttemptError({
      originalFailure: failureEvidence("transaction_begin", undefined, error),
      transactionStarted: false,
      rollbackAttempt: "not_attempted",
    });
  }

  let originalFailure: OneRoleBaselineFailureEvidence | undefined;
  try {
    let lock: Pick<QueryResult<{ acquired: boolean }>, "rows">;
    try {
      lock = await input.client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [ONE_ROLE_BASELINE_ID],
      );
    } catch (error) {
      throw attemptFailure("advisory_lock", error);
    }
    if (lock.rows[0]?.acquired !== true) throw attemptFailure("advisory_lock");

    try {
      const lockedState = await (input.inspectPreflight ?? inspectOneRoleBaselineDatabase)(
        input.client,
      );
      assertOneRoleBaselinePreflight(lockedState, input.target);
    } catch (error) {
      throw attemptFailure("locked_preflight", error);
    }

    for (const file of input.build.manifest.generated_files) {
      const before = await readVerifiedGeneratedFile(
        readGeneratedFile,
        file,
        "generated_manifest_before",
      );
      try {
        await input.client.query(before);
      } catch (error) {
        throw attemptFailure("generated_sql", error, file.name);
      }
      await readVerifiedGeneratedFile(
        readGeneratedFile,
        file,
        "generated_manifest_after",
      );
    }

    try {
      await createBaselineMarker(input.client, manifestSha256);
    } catch (error) {
      throw attemptFailure("marker_write", error);
    }
  } catch (error) {
    originalFailure = normalizeAttemptFailure(error, "transaction_execution").originalFailure;
  }

  if (originalFailure) {
    let rollbackAttempt: OneRoleBaselineRollbackAttempt = "succeeded";
    let transactionRollbackFailure: OneRoleBaselineFailureEvidence | undefined;
    try {
      await input.client.query("ROLLBACK");
    } catch (error) {
      rollbackAttempt = "failed";
      transactionRollbackFailure = failureEvidence("transaction_rollback", undefined, error);
    }
    throw new OneRoleBaselineAttemptError({
      originalFailure,
      transactionStarted: true,
      rollbackAttempt,
      transactionRollbackFailure,
    });
  }

  if (input.mode === "dry-run") {
    try {
      await input.client.query("ROLLBACK");
      return;
    } catch (error) {
      throw new OneRoleBaselineAttemptError({
        originalFailure: failureEvidence("transaction_rollback", undefined, error),
        transactionStarted: true,
        rollbackAttempt: "failed",
      });
    }
  }

  try {
    await input.client.query("COMMIT");
  } catch (error) {
    let rollbackAttempt: OneRoleBaselineRollbackAttempt = "succeeded";
    let transactionRollbackFailure: OneRoleBaselineFailureEvidence | undefined;
    try {
      await input.client.query("ROLLBACK");
    } catch (rollbackError) {
      rollbackAttempt = "failed";
      transactionRollbackFailure = failureEvidence(
        "transaction_rollback",
        undefined,
        rollbackError,
      );
    }
    throw new OneRoleBaselineAttemptError({
      originalFailure: failureEvidence("transaction_commit", undefined, error),
      transactionStarted: true,
      rollbackAttempt,
      transactionRollbackFailure,
      commitResultUncertain: true,
    });
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
    member_of_neon_superuser: boolean;
    granted_role_count: string;
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
           role_row.rolbypassrls,
           EXISTS (
             SELECT 1
               FROM pg_roles AS neon_role
              WHERE neon_role.rolname = 'neon_superuser'
                AND pg_has_role(role_row.oid, neon_role.oid, 'MEMBER')
           ) AS member_of_neon_superuser,
           (SELECT count(*)::text
              FROM pg_auth_members AS membership
             WHERE membership.member = role_row.oid) AS granted_role_count
      FROM pg_database AS database_row
      JOIN pg_roles AS role_row ON role_row.rolname = current_user
     WHERE database_row.datname = current_database()
  `);
  const objects = await client.query<{ count: string; wrong_owner_count: string }>(`
    WITH recognized_public_object_owners AS (
      SELECT class_row.relowner AS owner_oid
        FROM pg_class AS class_row
        JOIN pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
       WHERE namespace_row.nspname = 'public'
         AND class_row.relkind IN ('r', 'p', 'i', 'I', 'v', 'm', 'S', 'c', 'f')
      UNION ALL
      SELECT procedure_row.proowner AS owner_oid
        FROM pg_proc AS procedure_row
        JOIN pg_namespace AS namespace_row ON namespace_row.oid = procedure_row.pronamespace
       WHERE namespace_row.nspname = 'public'
      UNION ALL
      SELECT type_row.typowner AS owner_oid
        FROM pg_type AS type_row
        JOIN pg_namespace AS namespace_row ON namespace_row.oid = type_row.typnamespace
       WHERE namespace_row.nspname = 'public'
         AND type_row.typisdefined
         AND type_row.typtype <> 'p'
    )
    SELECT count(*)::text AS count,
           count(*) FILTER (
             WHERE owner_oid <> (SELECT oid FROM pg_roles WHERE rolname = $1)
           )::text AS wrong_owner_count
      FROM recognized_public_object_owners
  `, [ONE_ROLE_CANONICAL_ROLE]);
  const markerOwnership = await client.query<{
    schema_owner: string | null;
    table_owner: string | null;
  }>(`
    SELECT (
             SELECT pg_get_userbyid(namespace_row.nspowner)
               FROM pg_namespace AS namespace_row
              WHERE namespace_row.nspname = $1
           ) AS schema_owner,
           (
             SELECT pg_get_userbyid(class_row.relowner)
               FROM pg_class AS class_row
               JOIN pg_namespace AS namespace_row
                 ON namespace_row.oid = class_row.relnamespace
              WHERE namespace_row.nspname = $1
                AND class_row.relname = $2
                AND class_row.relkind IN ('r', 'p')
           ) AS table_owner
  `, [ONE_ROLE_MARKER_SCHEMA, ONE_ROLE_MARKER_TABLE]);
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
     ORDER BY baseline_id COLLATE "C"
  `);
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
  const residue = await client.query<{
    migration_schema_present: boolean;
    migration_ledger_present: boolean;
    stale_dry_run_schema_count: string;
  }>(`
    SELECT EXISTS (
             SELECT 1
               FROM pg_namespace AS namespace_row
              WHERE namespace_row.nspname = 'migration'
           ) AS migration_schema_present,
           to_regclass('migration.schema_migrations') IS NOT NULL
             AS migration_ledger_present,
           (SELECT count(*)::text
              FROM pg_namespace AS namespace_row
             WHERE left(namespace_row.nspname, $2) = $1) AS stale_dry_run_schema_count
  `, [LEGACY_DRY_RUN_SCHEMA_PREFIX, LEGACY_DRY_RUN_SCHEMA_PREFIX.length]);
  const current = identity.rows[0];
  if (!current) throw new OneRoleBaselineRunError();
  const markerOwners = markerOwnership.rows[0];
  const markerRow = marker.rows[0];
  const residueRow = residue.rows[0];
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
    memberOfNeonSuperuser: current.member_of_neon_superuser,
    grantedRoleCount: Number(current.granted_role_count),
    publicObjectCount: Number(objects.rows[0]?.count ?? "0"),
    publicWrongOwnerCount: Number(objects.rows[0]?.wrong_owner_count ?? "0"),
    markerSchemaOwner: markerOwners?.schema_owner ?? null,
    markerTableOwner: markerOwners?.table_owner ?? null,
    markerRowCount: marker.rows.length,
    marker: markerRow ? Object.freeze({
      baselineId: markerRow.baseline_id,
      transformVersion: markerRow.transform_version,
      manifestSha256: markerRow.manifest_sha256,
      sourceMigrationCount: markerRow.source_migration_count,
    }) : null,
    rlsNotForcedCount: Number(rls.rows[0]?.count ?? "0"),
    unsafeSecurityDefinerCount: Number(functions.rows[0]?.count ?? "0"),
    migrationSchemaPresent: residueRow?.migration_schema_present === true,
    migrationLedgerPresent: residueRow?.migration_ledger_present === true,
    staleDryRunSchemaCount: Number(residueRow?.stale_dry_run_schema_count ?? "0"),
  });
}

export function assertOneRoleBaselinePreflight(
  state: OneRoleBaselineDatabaseState,
  target: OneRoleBaselineTarget,
): void {
  if (
    !hasCanonicalOneRoleAuthority(state, target) ||
    state.publicObjectCount !== 0 ||
    state.publicWrongOwnerCount !== 0 ||
    state.markerSchemaOwner !== null ||
    state.markerTableOwner !== null ||
    state.markerRowCount !== 0 ||
    state.marker !== null ||
    state.migrationSchemaPresent ||
    state.migrationLedgerPresent ||
    state.staleDryRunSchemaCount !== 0
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
  if (mode === "dry-run") {
    assertOneRoleBaselinePreflight(state, target);
    return;
  }
  if (
    !hasCanonicalOneRoleAuthority(state, target) ||
    state.publicObjectCount === 0 ||
    state.publicWrongOwnerCount !== 0 ||
    state.markerSchemaOwner !== ONE_ROLE_CANONICAL_ROLE ||
    state.markerTableOwner !== ONE_ROLE_CANONICAL_ROLE ||
    state.markerRowCount !== 1 ||
    state.marker?.baselineId !== ONE_ROLE_BASELINE_ID ||
    state.marker.transformVersion !== ONE_ROLE_TRANSFORM_VERSION ||
    state.marker.manifestSha256 !== input.manifestSha256 ||
    state.marker.sourceMigrationCount !== ONE_ROLE_SOURCE_COUNT ||
    state.migrationSchemaPresent ||
    state.migrationLedgerPresent ||
    state.staleDryRunSchemaCount !== 0
  ) {
    throw new OneRoleBaselineRunError();
  }
}

function hasCanonicalOneRoleAuthority(
  state: OneRoleBaselineDatabaseState,
  target: OneRoleBaselineTarget,
): boolean {
  return state.databaseName === target.database &&
    state.userName === ONE_ROLE_CANONICAL_ROLE &&
    state.databaseOwner === ONE_ROLE_CANONICAL_ROLE &&
    state.login &&
    !state.superuser &&
    !state.createDatabase &&
    !state.createRole &&
    !state.inherit &&
    !state.replication &&
    !state.bypassRls &&
    !state.memberOfNeonSuperuser &&
    state.grantedRoleCount === 0 &&
    state.rlsNotForcedCount === 0 &&
    state.unsafeSecurityDefinerCount === 0;
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

async function readVerifiedGeneratedFile(
  readGeneratedFile: (name: string) => Promise<string>,
  file: OneRoleBaselineManifest["generated_files"][number],
  stage: "generated_manifest_before" | "generated_manifest_after",
): Promise<string> {
  try {
    const contents = await readGeneratedFile(file.name);
    assertFileHash(file, contents);
    return contents;
  } catch (error) {
    throw attemptFailure(stage, error, file.name);
  }
}

function attemptFailure(
  stage: OneRoleBaselineFailureStage,
  error?: unknown,
  migrationName?: string,
): OneRoleBaselineAttemptError {
  return new OneRoleBaselineAttemptError({
    originalFailure: failureEvidence(stage, migrationName, error),
    transactionStarted: true,
    rollbackAttempt: "not_attempted",
  });
}

function normalizeAttemptFailure(
  error: unknown,
  fallbackStage: OneRoleBaselineFailureStage,
): OneRoleBaselineAttemptError {
  if (error instanceof OneRoleBaselineAttemptError) return error;
  return attemptFailure(fallbackStage, error);
}

function failureEvidence(
  stage: OneRoleBaselineFailureStage,
  migrationName?: string,
  error?: unknown,
): OneRoleBaselineFailureEvidence {
  const postgresCode = readPostgresCode(error);
  return Object.freeze({
    failure_stage: stage,
    ...(migrationName ? { migration_name: migrationName } : {}),
    ...(postgresCode ? { postgres_code: postgresCode } : {}),
  });
}

function readPostgresCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const databaseError = current as Error & { code?: unknown; severity?: unknown };
    const code = databaseError.code;
    if (
      POSTGRES_ERROR_SEVERITIES.has(String(databaseError.severity)) &&
      typeof code === "string" &&
      /^[0-9A-Z]{5}$/.test(code)
    ) {
      return code;
    }
    current = current.cause;
  }
  return undefined;
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

export async function executeOneRoleBaselineRun(input: Readonly<{
  mode: Exclude<OneRoleBaselineMode, "plan">;
  target: OneRoleBaselineTarget;
  build: OneRoleBaselineBuild;
  dependencies: OneRoleBaselineRunDependencies;
}>): Promise<OneRoleBaselineSuccessEvidence> {
  const { mode, target, build, dependencies } = input;
  const manifestSha256 = sha256(build.manifestJson);

  try {
    const before = await dependencies.inspect();
    assertOneRoleBaselinePreflight(before, target);
  } catch (error) {
    throw new OneRoleBaselineOperationError({
      mode,
      originalFailure: failureEvidence("preflight_database_inspection", undefined, error),
    });
  }

  let connection: OneRoleBaselineExecutionConnection;
  try {
    connection = await dependencies.openExecutionConnection();
  } catch (error) {
    throw new OneRoleBaselineOperationError({
      mode,
      originalFailure: failureEvidence("execution_connection", undefined, error),
    });
  }

  let attemptFailureResult: OneRoleBaselineAttemptError | undefined;
  try {
    await executeOneRoleBaselineTransaction({
      client: connection.client,
      target,
      mode,
      build,
      readGeneratedFile: dependencies.readGeneratedFile,
      inspectPreflight: dependencies.inspectLockedPreflight,
    });
  } catch (error) {
    attemptFailureResult = normalizeAttemptFailure(error, "transaction_execution");
  }

  let closeFailure: OneRoleBaselineFailureEvidence | undefined;
  try {
    await connection.close();
  } catch (error) {
    closeFailure = failureEvidence("execution_connection_close", undefined, error);
  }

  if (attemptFailureResult || closeFailure) {
    const transactionStarted = attemptFailureResult?.transactionStarted ?? true;
    const operation = Object.freeze({
      mode,
      originalFailure: attemptFailureResult?.originalFailure ?? closeFailure!,
      transactionStarted,
      rollbackAttempt: attemptFailureResult?.rollbackAttempt ?? (
        mode === "dry-run" ? "succeeded" as const : "not_attempted" as const
      ),
      transactionRollbackFailure: attemptFailureResult?.transactionRollbackFailure,
      executionConnectionCloseFailure:
        attemptFailureResult && closeFailure ? closeFailure : undefined,
      commitResultUncertain: attemptFailureResult?.commitResultUncertain === true,
      applyCommitted: mode === "apply" && attemptFailureResult === undefined,
    });
    if (!transactionStarted) throw new OneRoleBaselineOperationError(operation);
    await throwAfterIndependentStateVerification(
      operation,
      target,
      manifestSha256,
      dependencies.inspect,
    );
  }

  let after: OneRoleBaselineDatabaseState;
  try {
    after = await dependencies.inspect();
  } catch (error) {
    throw new OneRoleBaselineOperationError({
      mode,
      originalFailure: failureEvidence("postflight_database_inspection", undefined, error),
      transactionStarted: true,
      rollbackAttempt: mode === "dry-run" ? "succeeded" : "not_attempted",
      rollbackState: mode === "dry-run" ? "unknown" : undefined,
      rollbackVerificationFailure: mode === "dry-run"
        ? failureEvidence("rollback_database_inspection", undefined, error)
        : undefined,
      postFailureState: mode === "apply"
        ? "installed_but_verification_failed"
        : undefined,
      postFailureVerificationFailure: mode === "apply"
        ? failureEvidence("postflight_database_inspection", undefined, error)
        : undefined,
      applyCommitted: mode === "apply",
    });
  }

  try {
    if (mode === "dry-run") {
      assertOneRoleBaselinePreflight(after, target);
    } else {
      assertOneRoleBaselinePostflight({ state: after, target, mode, manifestSha256 });
    }
  } catch (error) {
    throw new OneRoleBaselineOperationError({
      mode,
      originalFailure: failureEvidence("postflight_state_verification", undefined, error),
      transactionStarted: true,
      rollbackAttempt: mode === "dry-run" ? "succeeded" : "not_attempted",
      rollbackState: mode === "dry-run" ? "verification_failed" : undefined,
      rollbackVerificationFailure: mode === "dry-run"
        ? failureEvidence("rollback_state_verification", undefined, error)
        : undefined,
      postFailureState: mode === "apply"
        ? "installed_but_verification_failed"
        : undefined,
      postFailureVerificationFailure: mode === "apply"
        ? failureEvidence("postflight_state_verification", undefined, error)
        : undefined,
      applyCommitted: mode === "apply",
    });
  }

  return createOneRoleBaselineSuccessEvidence(mode, target, build, after);
}

async function throwAfterIndependentStateVerification(
  operation: Readonly<{
    mode: Exclude<OneRoleBaselineMode, "plan">;
    originalFailure: OneRoleBaselineFailureEvidence;
    transactionStarted: boolean;
    rollbackAttempt: OneRoleBaselineRollbackAttempt;
    transactionRollbackFailure?: OneRoleBaselineFailureEvidence;
    executionConnectionCloseFailure?: OneRoleBaselineFailureEvidence;
    commitResultUncertain: boolean;
    applyCommitted: boolean;
  }>,
  target: OneRoleBaselineTarget,
  manifestSha256: string,
  inspect: () => Promise<OneRoleBaselineDatabaseState>,
): Promise<never> {
  let state: OneRoleBaselineDatabaseState;
  try {
    state = await inspect();
  } catch (error) {
    throw new OneRoleBaselineOperationError({
      ...operation,
      rollbackState: operation.mode === "dry-run" ? "unknown" : undefined,
      rollbackVerificationFailure: operation.mode === "dry-run"
        ? failureEvidence("rollback_database_inspection", undefined, error)
        : undefined,
      postFailureState: operation.mode === "apply"
        ? operation.applyCommitted
          ? "installed_but_verification_failed"
          : "unknown"
        : undefined,
      postFailureVerificationFailure: operation.mode === "apply"
        ? failureEvidence("postflight_database_inspection", undefined, error)
        : undefined,
    });
  }

  if (operation.mode === "dry-run") {
    try {
      assertOneRoleBaselinePreflight(state, target);
    } catch (error) {
      throw new OneRoleBaselineOperationError({
        ...operation,
        rollbackState: "verification_failed",
        rollbackVerificationFailure: failureEvidence(
          "rollback_state_verification",
          undefined,
          error,
        ),
      });
    }
    throw new OneRoleBaselineOperationError({ ...operation, rollbackState: "clean" });
  }

  let clean = false;
  try {
    assertOneRoleBaselinePreflight(state, target);
    clean = true;
  } catch {}
  if (clean) {
    throw new OneRoleBaselineOperationError({ ...operation, postFailureState: "clean" });
  }
  try {
    assertOneRoleBaselinePostflight({
      state,
      target,
      mode: "apply",
      manifestSha256,
    });
  } catch (error) {
    throw new OneRoleBaselineOperationError({
      ...operation,
      postFailureState: operation.applyCommitted
        ? "installed_but_verification_failed"
        : "verification_failed",
      postFailureVerificationFailure: failureEvidence(
        "postflight_state_verification",
        undefined,
        error,
      ),
    });
  }
  throw new OneRoleBaselineOperationError({ ...operation, postFailureState: "installed" });
}

function createOneRoleBaselineSuccessEvidence(
  mode: Exclude<OneRoleBaselineMode, "plan">,
  target: OneRoleBaselineTarget,
  build: OneRoleBaselineBuild,
  state: OneRoleBaselineDatabaseState,
): OneRoleBaselineSuccessEvidence {
  return Object.freeze({
    status: "pass",
    baseline_id: ONE_ROLE_BASELINE_ID,
    mode,
    target_database: target.database,
    canonical_login_role: ONE_ROLE_CANONICAL_ROLE,
    source_migrations: build.manifest.source_migrations.length,
    generated_files: build.manifest.generated_files.length,
    postflight_state: mode === "apply" ? "installed" : "clean",
    marker: mode === "apply" ? "installed" : "rolled_back",
    verification: Object.freeze({
      role_contract: "verified" as const,
      member_of_neon_superuser: false as const,
      granted_role_count: state.grantedRoleCount,
      marker_ownership: mode === "apply" ? "verified" as const : "absent" as const,
      public_object_count: state.publicObjectCount,
      public_wrong_owner_count: state.publicWrongOwnerCount,
      rls_not_forced_count: state.rlsNotForcedCount,
      unsafe_security_definer_count: state.unsafeSecurityDefinerCount,
      migration_metadata: "absent" as const,
      stale_dry_run_schema_count: state.staleDryRunSchemaCount,
    }),
  });
}

export function formatOneRoleBaselineFailure(
  error: unknown,
  mode?: OneRoleBaselineMode,
): string {
  const operation = error instanceof OneRoleBaselineOperationError
    ? error
    : new OneRoleBaselineOperationError({
      mode: mode === "plan" ? undefined : mode,
      originalFailure: failureEvidence("cli"),
    });
  return JSON.stringify({
    status: "failed",
    baseline_id: ONE_ROLE_BASELINE_ID,
    ...(operation.mode ? { mode: operation.mode } : mode ? { mode } : {}),
    original_failure: operation.originalFailure,
    transaction_started: operation.transactionStarted,
    rollback_attempt: operation.rollbackAttempt,
    ...(operation.transactionRollbackFailure
      ? { transaction_rollback_failure: operation.transactionRollbackFailure }
      : {}),
    ...(operation.executionConnectionCloseFailure
      ? { execution_connection_close_failure: operation.executionConnectionCloseFailure }
      : {}),
    ...(operation.rollbackState ? { rollback_state: operation.rollbackState } : {}),
    ...(operation.rollbackVerificationFailure
      ? { rollback_verification_failure: operation.rollbackVerificationFailure }
      : {}),
    ...(operation.postFailureState ? { post_failure_state: operation.postFailureState } : {}),
    ...(operation.postFailureVerificationFailure
      ? { post_failure_verification_failure: operation.postFailureVerificationFailure }
      : {}),
    ...(operation.applyCommitted
      ? { commit_result: "succeeded" }
      : operation.commitResultUncertain
        ? { commit_result: "uncertain" }
        : {}),
    ...(operation.postFailureState === "installed_but_verification_failed"
      ? {
          retry: "forbidden",
          operator_action: "freeze_and_escalate",
        }
      : {}),
  });
}

async function runDatabaseMode(
  mode: Exclude<OneRoleBaselineMode, "plan">,
  environment: Environment,
  build: OneRoleBaselineBuild,
): Promise<OneRoleBaselineSuccessEvidence> {
  const target = readOneRoleBaselineTarget(environment, mode);
  return executeOneRoleBaselineRun({
    mode,
    target,
    build,
    dependencies: {
      inspect: () => inspectWithNewClient(target),
      openExecutionConnection: async () => {
        const client = new Client(createOneRoleBaselineClientConfig(target));
        await client.connect();
        return Object.freeze({ client, close: () => client.end() });
      },
    },
  });
}

export async function runOneRoleBaselineCli(
  arguments_: readonly string[],
  environment: Environment,
): Promise<void> {
  const mode = readOneRoleBaselineMode(arguments_);
  let build: OneRoleBaselineBuild;
  try {
    build = await verifyCommittedOneRoleBaseline();
  } catch (error) {
    throw new OneRoleBaselineOperationError({
      originalFailure: failureEvidence("baseline_manifest", undefined, error),
    });
  }
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
  const evidence = await runDatabaseMode(mode, environment, build);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

const isMainModule = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const arguments_ = process.argv.slice(2);
  let mode: OneRoleBaselineMode | undefined;
  try {
    mode = readOneRoleBaselineMode(arguments_);
  } catch {}
  runOneRoleBaselineCli(arguments_, process.env).catch((error: unknown) => {
    process.stderr.write(`${formatOneRoleBaselineFailure(error, mode)}\n`);
    process.exitCode = 1;
  });
}

export const ONE_ROLE_BASELINE_ASSET_ROOT = ONE_ROLE_BASELINE_DIRECTORY;
