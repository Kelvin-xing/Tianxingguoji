import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { PG_MIGRATE_LOCK_ID, runner, type RunnerOption } from "node-pg-migrate";
import { Client, type ClientConfig } from "pg";

import { MIGRATION_CONFIG } from "../../db/migrate.config.ts";
import {
  EXPECTED_MIGRATION_COUNT,
  MIGRATION_DIRECTORY,
  NEON_TEST_DATABASE,
  NEON_TEST_MIGRATION_LOGIN,
  assertNeonTestManifest,
  manifestsEqual,
  verifyOrderedMigrationManifest,
  type MigrationManifest,
} from "./migration-manifest.ts";

const NEON_DIRECT_HOST =
  /^ep-[a-z0-9-]+(?:\.c-[0-9]+)?\.us-east-1\.aws\.neon\.tech$/;
const DRY_RUN_SCHEMA_PREFIX = "migration_dry_run_env01_";
const EXPECTED_PUBLIC_TABLES = 63;
const SILENT_LOGGER = Object.freeze({
  debug: (_message?: unknown) => undefined,
  info: (_message?: unknown) => undefined,
  warn: (_message?: unknown) => undefined,
  error: (_message?: unknown) => undefined,
});
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

export const MIGRATION_CREATED_ROLES = Object.freeze([
  "tianxing_app",
  "portal_auth",
  "platform_billing",
  "platform_billing_reader",
  "tianxing_test_application",
  "tianxing_test_identity",
  "tianxing_test_provisioner",
] as const);

const LOGIN_MIGRATION_ROLES = new Set([
  "tianxing_app",
  "portal_auth",
  "platform_billing",
  "platform_billing_reader",
]);
const INHERITING_MIGRATION_ROLES = new Set([
  "tianxing_test_application",
  "tianxing_test_identity",
  "tianxing_test_provisioner",
]);

const REJECTED_ENVIRONMENT_VARIABLES = Object.freeze([
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "TEST_IDENTITY_DATABASE_URL",
  "TEST_APPLICATION_DATABASE_URL",
  "TEST_PROVISION_DATABASE_URL",
  "VERCEL",
  "VERCEL_ENV",
] as const);

export type NeonTestMigrationMode = "dry-run" | "apply";
type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type NeonTestMigrationExecution = Readonly<{
  runMigration(): Promise<void>;
  verifyRollbackAfterFailure(): Promise<NeonTestRollbackVerification>;
}>;

export type NeonTestMigrationFailureStage =
  | "cli"
  | "preflight_manifest"
  | "preflight_database_inspection"
  | "transaction_begin"
  | "advisory_lock"
  | "migration_manifest_before"
  | "migration_sql"
  | "migration_manifest_after"
  | "transaction_rollback"
  | "dry_run_execution"
  | "apply_runner"
  | "rollback_manifest"
  | "rollback_database_inspection"
  | "postflight_manifest"
  | "postflight_database_inspection"
  | "rollback_state_verification";

export type NeonTestMigrationFailureEvidence = Readonly<{
  failure_stage: NeonTestMigrationFailureStage;
  migration_name?: string;
  postgres_code?: string;
}>;

export type NeonTestRollbackVerification = Readonly<{
  state: "clean" | "metadata_cleanup_required";
}>;

export type NeonTestTransactionalDryRunExecution = Readonly<{
  query(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
  readMigration(name: string): Promise<Uint8Array>;
}>;

export type NeonTestMigrationTarget = Readonly<{
  connectionString: string;
  host: string;
  port: 5432;
  database: typeof NEON_TEST_DATABASE;
  user: typeof NEON_TEST_MIGRATION_LOGIN;
}>;

type RoleState = Readonly<{
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  memberOfNeonSuperuser: boolean;
}>;

export type NeonTestDatabaseState = Readonly<{
  databaseName: string;
  userName: string;
  databaseOwner: string;
  migrationRole: RoleState;
  rdsIamRole: RoleState | null;
  hasRdsIamAdminOption: boolean;
  publicTableCount: number;
  migrationSchemaExists: boolean;
  migrationSchemaOwner: string | null;
  ledgerExists: boolean;
  appliedMigrations: readonly string[];
  migrationMetadataObjects: readonly string[];
  migrationClassObjectOwners: readonly string[];
  migrationExternalUserDependencyCount: number;
  existingMigrationRoles: readonly string[];
  migrationRoles: readonly RoleState[];
  staleDryRunSchemas: readonly string[];
}>;

export class NeonTestMigrationSafetyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NeonTestMigrationSafetyError";
  }
}

class NeonTestMigrationAttemptError extends NeonTestMigrationSafetyError {
  readonly originalFailure: NeonTestMigrationFailureEvidence;
  readonly transactionRollbackFailure?: NeonTestMigrationFailureEvidence;

  constructor(
    originalFailure: NeonTestMigrationFailureEvidence,
    transactionRollbackFailure?: NeonTestMigrationFailureEvidence,
  ) {
    super("Migration attempt failed.");
    this.name = "NeonTestMigrationAttemptError";
    this.originalFailure = originalFailure;
    this.transactionRollbackFailure = transactionRollbackFailure;
  }
}

export class NeonTestMigrationRunError extends NeonTestMigrationSafetyError {
  readonly originalFailure: NeonTestMigrationFailureEvidence;
  readonly rollbackState?: NeonTestRollbackVerification["state"];
  readonly transactionRollbackFailure?: NeonTestMigrationFailureEvidence;
  readonly rollbackVerificationFailure?: NeonTestMigrationFailureEvidence;

  constructor(
    originalFailure: NeonTestMigrationFailureEvidence,
    rollbackState?: NeonTestRollbackVerification["state"],
    transactionRollbackFailure?: NeonTestMigrationFailureEvidence,
    rollbackVerificationFailure?: NeonTestMigrationFailureEvidence,
  ) {
    super(
      rollbackVerificationFailure
        ? "Migration rollback verification is incomplete; architecture escalation required."
        : rollbackState === "metadata_cleanup_required"
          ? "Migration execution failed; business rollback passed and metadata cleanup is required."
          : rollbackState === "clean"
            ? "Migration execution failed and business rollback verification passed; stop without retry."
            : "Migration safety gate failed; stop without retry.",
    );
    this.name = "NeonTestMigrationRunError";
    this.originalFailure = originalFailure;
    this.rollbackState = rollbackState;
    this.transactionRollbackFailure = transactionRollbackFailure;
    this.rollbackVerificationFailure = rollbackVerificationFailure;
  }
}

export const EXPECTED_EMPTY_MIGRATION_METADATA_OBJECTS = Object.freeze([
  "class:S:schema_migrations_id_seq",
  "class:i:schema_migrations_pkey",
  "class:r:schema_migrations",
  "constraint:p:schema_migrations_pkey",
] as const);

export const MIGRATION_METADATA_INVENTORY_SQL = `
      SELECT object_key, object_owner
        FROM (
          SELECT 'class:' || class_row.relkind::text || ':' || class_row.relname AS object_key,
                 pg_get_userbyid(class_row.relowner) AS object_owner
            FROM pg_class AS class_row
            JOIN pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
           WHERE namespace_row.nspname = 'migration'
          UNION ALL
          SELECT 'constraint:' || constraint_row.contype::text || ':' || constraint_row.conname
                   AS object_key,
                 NULL::text AS object_owner
            FROM pg_constraint AS constraint_row
            JOIN pg_namespace AS namespace_row ON namespace_row.oid = constraint_row.connamespace
           WHERE namespace_row.nspname = 'migration'
        ) AS metadata_rows
       ORDER BY object_key COLLATE "C"
    `;

export const MIGRATION_EXTERNAL_DEPENDENCY_SQL = `
      WITH migration_references AS (
        SELECT 'pg_namespace'::regclass::oid AS refclassid,
               namespace_row.oid AS refobjid
          FROM pg_namespace AS namespace_row
         WHERE namespace_row.nspname = 'migration'
        UNION ALL
        SELECT 'pg_class'::regclass::oid,
               class_row.oid
          FROM pg_class AS class_row
          JOIN pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
         WHERE namespace_row.nspname = 'migration'
        UNION ALL
        SELECT 'pg_constraint'::regclass::oid,
               constraint_row.oid
          FROM pg_constraint AS constraint_row
          JOIN pg_namespace AS namespace_row ON namespace_row.oid = constraint_row.connamespace
         WHERE namespace_row.nspname = 'migration'
      ), normal_dependencies AS (
        SELECT DISTINCT dependency_row.classid,
                        dependency_row.objid,
                        dependency_row.objsubid
          FROM pg_depend AS dependency_row
          JOIN migration_references AS reference_row
            ON reference_row.refclassid = dependency_row.refclassid
           AND reference_row.refobjid = dependency_row.refobjid
         WHERE dependency_row.deptype = 'n'
      ), resolved_dependencies AS (
        SELECT dependency_row.classid,
               dependency_row.objid,
               dependency_row.objsubid,
               COALESCE(
                 class_namespace.nspname,
                 procedure_namespace.nspname,
                 type_namespace.nspname,
                 constraint_namespace.nspname,
                 rewrite_namespace.nspname,
                 default_namespace.nspname
               ) AS dependent_schema
          FROM normal_dependencies AS dependency_row
          LEFT JOIN pg_class AS dependent_class
            ON dependency_row.classid = 'pg_class'::regclass
           AND dependent_class.oid = dependency_row.objid
          LEFT JOIN pg_namespace AS class_namespace
            ON class_namespace.oid = dependent_class.relnamespace
          LEFT JOIN pg_proc AS dependent_procedure
            ON dependency_row.classid = 'pg_proc'::regclass
           AND dependent_procedure.oid = dependency_row.objid
          LEFT JOIN pg_namespace AS procedure_namespace
            ON procedure_namespace.oid = dependent_procedure.pronamespace
          LEFT JOIN pg_type AS dependent_type
            ON dependency_row.classid = 'pg_type'::regclass
           AND dependent_type.oid = dependency_row.objid
          LEFT JOIN pg_namespace AS type_namespace
            ON type_namespace.oid = dependent_type.typnamespace
          LEFT JOIN pg_constraint AS dependent_constraint
            ON dependency_row.classid = 'pg_constraint'::regclass
           AND dependent_constraint.oid = dependency_row.objid
          LEFT JOIN pg_namespace AS constraint_namespace
            ON constraint_namespace.oid = dependent_constraint.connamespace
          LEFT JOIN pg_rewrite AS dependent_rewrite
            ON dependency_row.classid = 'pg_rewrite'::regclass
           AND dependent_rewrite.oid = dependency_row.objid
          LEFT JOIN pg_class AS rewrite_class
            ON rewrite_class.oid = dependent_rewrite.ev_class
          LEFT JOIN pg_namespace AS rewrite_namespace
            ON rewrite_namespace.oid = rewrite_class.relnamespace
          LEFT JOIN pg_attrdef AS dependent_default
            ON dependency_row.classid = 'pg_attrdef'::regclass
           AND dependent_default.oid = dependency_row.objid
          LEFT JOIN pg_class AS default_class
            ON default_class.oid = dependent_default.adrelid
          LEFT JOIN pg_namespace AS default_namespace
            ON default_namespace.oid = default_class.relnamespace
      )
      SELECT count(*)::text AS count
        FROM resolved_dependencies
       WHERE dependent_schema IS NULL
          OR (
            dependent_schema <> 'migration'
            AND dependent_schema <> 'pg_catalog'
            AND dependent_schema <> 'information_schema'
            AND dependent_schema NOT LIKE 'pg_toast%'
          )
    `;
const EXPECTED_MIGRATION_CLASS_OBJECT_COUNT =
  EXPECTED_EMPTY_MIGRATION_METADATA_OBJECTS.filter((object) =>
    object.startsWith("class:"),
  ).length;

export function readNeonTestMigrationMode(
  arguments_: readonly string[],
): NeonTestMigrationMode {
  if (arguments_.length !== 1 || !["--dry-run", "--apply"].includes(arguments_[0] ?? "")) {
    throw new NeonTestMigrationSafetyError(
      "Specify exactly one Neon migration mode: --dry-run or --apply.",
    );
  }
  return arguments_[0] === "--apply" ? "apply" : "dry-run";
}

export function readNeonTestMigrationTarget(
  environment: RuntimeEnvironment = process.env,
): NeonTestMigrationTarget {
  if (
    environment.APP_ENV !== "test" ||
    environment.NODE_ENV !== "production" ||
    environment.APP_RUNTIME_MODE !== "test-database" ||
    environment.AUTH_MODE !== "database-test" ||
    environment.TEST_DATABASE_EXPECTED_NAME !== NEON_TEST_DATABASE
  ) {
    throw new NeonTestMigrationSafetyError("Neon migration environment contract is invalid.");
  }
  if (REJECTED_ENVIRONMENT_VARIABLES.some((name) => hasValue(environment[name]))) {
    throw new NeonTestMigrationSafetyError(
      "Neon migration environment contains a rejected database or Vercel variable.",
    );
  }

  const connectionString = environment.TEST_MIGRATION_DATABASE_URL?.trim();
  if (!connectionString || /[\r\n]/.test(connectionString)) {
    throw new NeonTestMigrationSafetyError("TEST_MIGRATION_DATABASE_URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new NeonTestMigrationSafetyError(
      "TEST_MIGRATION_DATABASE_URL must be a valid PostgreSQL URL.",
    );
  }

  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new NeonTestMigrationSafetyError("Neon migration URL encoding is invalid.");
  }

  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "postgresql:" ||
    parsed.port !== "5432" ||
    user !== NEON_TEST_MIGRATION_LOGIN ||
    password.length === 0 ||
    database !== NEON_TEST_DATABASE ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    host.includes("-pooler") ||
    isIP(host) !== 0 ||
    host === "localhost" ||
    !NEON_DIRECT_HOST.test(host)
  ) {
    throw new NeonTestMigrationSafetyError(
      "Migration target is not the approved Neon us-east-1 direct endpoint.",
    );
  }

  return Object.freeze({
    connectionString,
    host,
    port: 5432 as const,
    database: NEON_TEST_DATABASE,
    user: NEON_TEST_MIGRATION_LOGIN,
  });
}

export function createNeonTestMigrationApplyOptions(
  target: NeonTestMigrationTarget,
): RunnerOption {
  return {
    databaseUrl: {
      connectionString: target.connectionString,
      application_name: "tianxing-neon-test-migration",
      statement_timeout: MIGRATION_CONFIG.statementTimeoutMs,
      lock_timeout: MIGRATION_CONFIG.lockTimeoutMs,
      ssl: { rejectUnauthorized: true },
    },
    dir: MIGRATION_CONFIG.migrationsGlob,
    useGlob: true,
    schema: MIGRATION_CONFIG.schema,
    migrationsSchema: MIGRATION_CONFIG.migrationsSchema,
    migrationsTable: MIGRATION_CONFIG.migrationsTable,
    createMigrationsSchema: true,
    direction: "up",
    checkOrder: true,
    singleTransaction: true,
    noLock: false,
    advisoryLockMode: "fail",
    dryRun: false,
    migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
    logger: SILENT_LOGGER,
  };
}

export function createNeonTestDryRunClientOptions(
  target: NeonTestMigrationTarget,
): ClientConfig {
  return {
    connectionString: target.connectionString,
    application_name: "tianxing-neon-test-migration-dry-run",
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: MIGRATION_CONFIG.statementTimeoutMs,
    lock_timeout: MIGRATION_CONFIG.lockTimeoutMs,
    ssl: { rejectUnauthorized: true },
  };
}

export function validateNeonTestPreflight(state: NeonTestDatabaseState): void {
  const role = state.migrationRole;
  const rdsIam = state.rdsIamRole;
  if (
    state.databaseName !== NEON_TEST_DATABASE ||
    state.userName !== NEON_TEST_MIGRATION_LOGIN ||
    state.databaseOwner !== NEON_TEST_MIGRATION_LOGIN ||
    role.rolname !== NEON_TEST_MIGRATION_LOGIN ||
    !role.rolcanlogin ||
    role.rolsuper ||
    !role.rolcreaterole ||
    role.rolcreatedb ||
    role.rolinherit ||
    role.rolreplication ||
    role.rolbypassrls ||
    role.memberOfNeonSuperuser ||
    !state.hasRdsIamAdminOption
  ) {
    throw new NeonTestMigrationSafetyError(
      "Connected migration identity is not the approved Neon database owner.",
    );
  }
  if (
    !rdsIam ||
    rdsIam.rolcanlogin ||
    rdsIam.rolsuper ||
    rdsIam.rolcreaterole ||
    rdsIam.rolcreatedb ||
    rdsIam.rolinherit ||
    rdsIam.rolreplication ||
    rdsIam.rolbypassrls ||
    rdsIam.memberOfNeonSuperuser
  ) {
    throw new NeonTestMigrationSafetyError("rds_iam is not the approved compatibility role.");
  }
  if (
    state.publicTableCount !== 0 ||
    state.migrationSchemaExists ||
    state.migrationSchemaOwner !== null ||
    state.ledgerExists ||
    state.appliedMigrations.length !== 0 ||
    state.migrationMetadataObjects.length !== 0 ||
    state.migrationClassObjectOwners.length !== 0 ||
    state.migrationExternalUserDependencyCount !== 0 ||
    state.existingMigrationRoles.length !== 0 ||
    state.migrationRoles.length !== 0 ||
    state.staleDryRunSchemas.length !== 0
  ) {
    throw new NeonTestMigrationSafetyError("Neon migration target is not an empty bootstrap database.");
  }
}

export function validateNeonTestApplyResult(
  state: NeonTestDatabaseState,
  manifest: MigrationManifest,
): void {
  assertNeonTestManifest(manifest);
  const expectedLedger = manifest.migrations.map(({ name }) => name.replace(/\.sql$/, ""));
  if (
    !state.ledgerExists ||
    !state.migrationSchemaExists ||
    !hasExpectedMigrationMetadataAuthority(state) ||
    !arraysEqual(
      state.migrationMetadataObjects,
      EXPECTED_EMPTY_MIGRATION_METADATA_OBJECTS,
    ) ||
    state.publicTableCount !== EXPECTED_PUBLIC_TABLES ||
    state.appliedMigrations.length !== EXPECTED_MIGRATION_COUNT ||
    state.appliedMigrations.some((name, index) => name !== expectedLedger[index]) ||
    state.existingMigrationRoles.length !== MIGRATION_CREATED_ROLES.length ||
    state.migrationRoles.length !== MIGRATION_CREATED_ROLES.length ||
    state.existingMigrationRoles.some(
      (name) => !(MIGRATION_CREATED_ROLES as readonly string[]).includes(name),
    )
  ) {
    throw new NeonTestMigrationSafetyError("Neon migration apply result is incomplete.");
  }
  for (const role of state.migrationRoles) {
    if (
      role.rolcanlogin !== LOGIN_MIGRATION_ROLES.has(role.rolname) ||
      role.rolinherit !== INHERITING_MIGRATION_ROLES.has(role.rolname) ||
      !(MIGRATION_CREATED_ROLES as readonly string[]).includes(role.rolname) ||
      role.rolsuper ||
      role.rolcreaterole ||
      role.rolcreatedb ||
      role.rolreplication ||
      role.rolbypassrls ||
      role.memberOfNeonSuperuser
    ) {
      throw new NeonTestMigrationSafetyError("A migration-created role has unsafe attributes.");
    }
  }
}

export function validateNeonTestRollback(
  state: NeonTestDatabaseState,
): NeonTestRollbackVerification {
  if (
    state.appliedMigrations.length !== 0 ||
    state.publicTableCount !== 0 ||
    state.existingMigrationRoles.length !== 0 ||
    state.migrationRoles.length !== 0 ||
    state.staleDryRunSchemas.length !== 0
  ) {
    throw new NeonTestMigrationAttemptError(
      migrationFailureEvidence("rollback_state_verification"),
    );
  }

  if (
    !state.migrationSchemaExists &&
    state.migrationSchemaOwner === null &&
    !state.ledgerExists &&
    state.migrationMetadataObjects.length === 0 &&
    state.migrationClassObjectOwners.length === 0 &&
    state.migrationExternalUserDependencyCount === 0
  ) {
    return Object.freeze({ state: "clean" });
  }

  if (
    state.migrationSchemaExists &&
    state.ledgerExists &&
    hasExpectedMigrationMetadataAuthority(state) &&
    arraysEqual(
      state.migrationMetadataObjects,
      EXPECTED_EMPTY_MIGRATION_METADATA_OBJECTS,
    )
  ) {
    return Object.freeze({ state: "metadata_cleanup_required" });
  }

  throw new NeonTestMigrationAttemptError(
    migrationFailureEvidence("rollback_state_verification"),
  );
}

export async function executeNeonTestTransactionalDryRun(
  manifest: MigrationManifest,
  execution: NeonTestTransactionalDryRunExecution,
): Promise<void> {
  assertNeonTestManifest(manifest);

  try {
    await execution.query("BEGIN");
  } catch (error) {
    throw new NeonTestMigrationAttemptError(
      migrationFailureEvidence("transaction_begin", undefined, error),
    );
  }

  let originalFailure: NeonTestMigrationFailureEvidence | undefined;
  let transactionRollbackFailure: NeonTestMigrationFailureEvidence | undefined;
  try {
    let lock: Readonly<{ rows: readonly Record<string, unknown>[] }>;
    try {
      lock = await execution.query(
        "SELECT pg_try_advisory_xact_lock($1::bigint) AS lock_obtained",
        [String(PG_MIGRATE_LOCK_ID)],
      );
    } catch (error) {
      throw new NeonTestMigrationAttemptError(
        migrationFailureEvidence("advisory_lock", undefined, error),
      );
    }
    if (lock.rows[0]?.lock_obtained !== true) {
      throw new NeonTestMigrationAttemptError(
        migrationFailureEvidence("advisory_lock"),
      );
    }

    for (const entry of manifest.migrations) {
      const before = await readVerifiedMigration(
        execution,
        entry.name,
        entry.sha256,
        "migration_manifest_before",
      );
      try {
        await execution.query(Buffer.from(before).toString("utf8"));
      } catch (error) {
        throw new NeonTestMigrationAttemptError(
          migrationFailureEvidence("migration_sql", entry.name, error),
        );
      }
      await readVerifiedMigration(
        execution,
        entry.name,
        entry.sha256,
        "migration_manifest_after",
      );
    }
  } catch (error) {
    const attempt = normalizeMigrationAttemptFailure(error, "dry_run_execution");
    originalFailure = attempt.originalFailure;
    transactionRollbackFailure = attempt.transactionRollbackFailure;
  }

  try {
    await execution.query("ROLLBACK");
  } catch (error) {
    const rollbackFailure = migrationFailureEvidence(
      "transaction_rollback",
      undefined,
      error,
    );
    if (!originalFailure) {
      originalFailure = rollbackFailure;
    } else {
      transactionRollbackFailure = rollbackFailure;
    }
  }

  if (originalFailure) {
    throw new NeonTestMigrationAttemptError(
      originalFailure,
      transactionRollbackFailure,
    );
  }
}

export async function executeNeonTestMigrationRun(
  mode: NeonTestMigrationMode,
  execution: NeonTestMigrationExecution,
): Promise<void> {
  let migrationFailure: NeonTestMigrationAttemptError | undefined;

  try {
    await execution.runMigration();
  } catch (error) {
    migrationFailure = normalizeMigrationAttemptFailure(
      error,
      mode === "dry-run" ? "dry_run_execution" : "apply_runner",
    );
  }

  if (!migrationFailure) return;

  let rollbackState: NeonTestRollbackVerification;
  try {
    rollbackState = await execution.verifyRollbackAfterFailure();
  } catch (error) {
    const verificationFailure = normalizeMigrationAttemptFailure(
      error,
      "rollback_state_verification",
    );
    throw new NeonTestMigrationRunError(
      migrationFailure.originalFailure,
      undefined,
      migrationFailure.transactionRollbackFailure,
      verificationFailure.originalFailure,
    );
  }

  throw new NeonTestMigrationRunError(
    migrationFailure.originalFailure,
    rollbackState.state,
    migrationFailure.transactionRollbackFailure,
  );
}

export function formatNeonTestMigrationFailure(error: unknown): string | undefined {
  if (!(error instanceof NeonTestMigrationRunError)) return undefined;
  return JSON.stringify({
    original_failure: error.originalFailure,
    ...(error.transactionRollbackFailure
      ? { transaction_rollback_failure: error.transactionRollbackFailure }
      : {}),
    ...(error.rollbackVerificationFailure
      ? { rollback_verification_failure: error.rollbackVerificationFailure }
      : {}),
    ...(error.rollbackState ? { rollback_state: error.rollbackState } : {}),
  });
}

async function readVerifiedMigration(
  execution: NeonTestTransactionalDryRunExecution,
  migrationName: string,
  expectedSha256: string,
  stage: "migration_manifest_before" | "migration_manifest_after",
): Promise<Uint8Array> {
  let contents: Uint8Array;
  try {
    contents = await execution.readMigration(migrationName);
  } catch (error) {
    throw new NeonTestMigrationAttemptError(
      migrationFailureEvidence(stage, migrationName, error),
    );
  }
  const actualSha256 = createHash("sha256").update(contents).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new NeonTestMigrationAttemptError(
      migrationFailureEvidence(stage, migrationName),
    );
  }
  return contents;
}

function normalizeMigrationAttemptFailure(
  error: unknown,
  fallbackStage: NeonTestMigrationFailureStage,
): NeonTestMigrationAttemptError {
  if (error instanceof NeonTestMigrationAttemptError) return error;
  if (error instanceof NeonTestMigrationRunError) {
    return new NeonTestMigrationAttemptError(
      error.originalFailure,
      error.transactionRollbackFailure,
    );
  }
  return new NeonTestMigrationAttemptError(
    migrationFailureEvidence(fallbackStage, undefined, error),
  );
}

export function createNeonTestMigrationRunError(
  stage: NeonTestMigrationFailureStage,
  error?: unknown,
): NeonTestMigrationRunError {
  return new NeonTestMigrationRunError(
    migrationFailureEvidence(stage, undefined, error),
  );
}

function migrationFailureEvidence(
  stage: NeonTestMigrationFailureStage,
  migrationName?: string,
  error?: unknown,
): NeonTestMigrationFailureEvidence {
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
    const databaseError = current as Error & {
      code?: unknown;
      severity?: unknown;
    };
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

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function hasExpectedMigrationMetadataAuthority(
  state: NeonTestDatabaseState,
): boolean {
  return (
    state.migrationSchemaOwner === NEON_TEST_MIGRATION_LOGIN &&
    state.migrationClassObjectOwners.length === EXPECTED_MIGRATION_CLASS_OBJECT_COUNT &&
    state.migrationClassObjectOwners.every(
      (owner) => owner === NEON_TEST_MIGRATION_LOGIN,
    ) &&
    state.migrationExternalUserDependencyCount === 0
  );
}

export function createNeonTestMigrationEvidence(
  mode: NeonTestMigrationMode,
  manifest: MigrationManifest,
  before: NeonTestDatabaseState,
  after: NeonTestDatabaseState,
) {
  return Object.freeze({
    mode,
    endpoint_kind: "neon-direct",
    target_database: NEON_TEST_DATABASE,
    migration_login: NEON_TEST_MIGRATION_LOGIN,
    tls: Object.freeze({ verified: true, reject_unauthorized: true }),
    manifest: Object.freeze({
      version: manifest.manifestVersion,
      count: manifest.migrations.length,
      sha256: manifest.manifestSha256,
      migrations: manifest.migrations,
    }),
    ledger: Object.freeze({
      before: before.appliedMigrations.length,
      after: after.appliedMigrations.length,
    }),
    public_table_count: Object.freeze({
      before: before.publicTableCount,
      after: after.publicTableCount,
    }),
    transaction_policy: Object.freeze({
      tool: MIGRATION_CONFIG.tool.name,
      version: MIGRATION_CONFIG.tool.version,
      check_order: true,
      single_transaction: true,
      advisory_lock_mode: "fail",
      no_lock: false,
    }),
    status: "pass",
  });
}

async function inspectNeonTestDatabase(
  target: NeonTestMigrationTarget,
): Promise<NeonTestDatabaseState> {
  const client = new Client({
    connectionString: target.connectionString,
    application_name: "tianxing-neon-test-migration-preflight",
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  try {
    const identity = await client.query<{
      database_name: string;
      user_name: string;
      database_owner: string;
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      member_of_neon_superuser: boolean;
    }>(`
      SELECT current_database() AS database_name,
             current_user AS user_name,
             pg_get_userbyid(database_row.datdba) AS database_owner,
             role_row.rolname,
             role_row.rolcanlogin,
             role_row.rolsuper,
             role_row.rolcreaterole,
             role_row.rolcreatedb,
             role_row.rolinherit,
             role_row.rolreplication,
             role_row.rolbypassrls,
             pg_has_role(role_row.rolname, 'neon_superuser', 'member')
               AS member_of_neon_superuser
        FROM pg_database AS database_row
        JOIN pg_roles AS role_row ON role_row.rolname = current_user
       WHERE database_row.datname = current_database()
    `);
    const current = identity.rows[0];
    if (!current) {
      throw new NeonTestMigrationSafetyError("Connected migration identity could not be inspected.");
    }

    const rdsIam = await client.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      member_of_neon_superuser: boolean;
    }>(`
      SELECT role_row.rolname,
             role_row.rolcanlogin,
             role_row.rolsuper,
             role_row.rolcreaterole,
             role_row.rolcreatedb,
             role_row.rolinherit,
             role_row.rolreplication,
             role_row.rolbypassrls,
             pg_has_role(role_row.rolname, 'neon_superuser', 'member')
               AS member_of_neon_superuser
        FROM pg_roles AS role_row
       WHERE role_row.rolname = 'rds_iam'
    `);
    const adminOption = await client.query<{ has_admin_option: boolean }>(`
      SELECT EXISTS (
        SELECT 1
          FROM pg_auth_members AS membership
          JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
          JOIN pg_roles AS member_role ON member_role.oid = membership.member
         WHERE granted_role.rolname = 'rds_iam'
           AND member_role.rolname = current_user
           AND membership.admin_option
      ) AS has_admin_option
    `);
    const publicTables = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'
    `);
    const migrationSchema = await client.query<{ schema_owner: string }>(`
      SELECT pg_get_userbyid(namespace_row.nspowner) AS schema_owner
        FROM pg_namespace AS namespace_row
       WHERE namespace_row.nspname = 'migration'
    `);
    const ledger = await client.query<{ ledger: string | null }>(
      "SELECT to_regclass('migration.schema_migrations')::text AS ledger",
    );
    const ledgerExists = ledger.rows[0]?.ledger !== null;
    const appliedMigrations = ledgerExists
      ? (
          await client.query<{ name: string }>(
            "SELECT name FROM migration.schema_migrations ORDER BY run_on, id",
          )
        ).rows.map(({ name }) => name)
      : [];
    const metadataObjects = await client.query<{
      object_key: string;
      object_owner: string | null;
    }>(MIGRATION_METADATA_INVENTORY_SQL);
    const externalDependencies = await client.query<{ count: string }>(
      MIGRATION_EXTERNAL_DEPENDENCY_SQL,
    );
    const roles = await client.query<RoleQueryRow>(`
      SELECT role_row.rolname,
             role_row.rolcanlogin,
             role_row.rolsuper,
             role_row.rolcreaterole,
             role_row.rolcreatedb,
             role_row.rolinherit,
             role_row.rolreplication,
             role_row.rolbypassrls,
             pg_has_role(role_row.rolname, 'neon_superuser', 'member')
               AS member_of_neon_superuser
        FROM pg_roles AS role_row
       WHERE role_row.rolname = ANY($1::text[])
       ORDER BY role_row.rolname
    `, [MIGRATION_CREATED_ROLES]);
    const staleSchemas = await client.query<{ schema_name: string }>(`
      SELECT schema_name
        FROM information_schema.schemata
       WHERE left(schema_name, $2) = $1
       ORDER BY schema_name
    `, [DRY_RUN_SCHEMA_PREFIX, DRY_RUN_SCHEMA_PREFIX.length]);

    const migrationRole = toRoleState(current);
    const migrationRoles = roles.rows.map(toRoleState);
    return Object.freeze({
      databaseName: current.database_name,
      userName: current.user_name,
      databaseOwner: current.database_owner,
      migrationRole,
      rdsIamRole: rdsIam.rows[0] ? toRoleState(rdsIam.rows[0]) : null,
      hasRdsIamAdminOption: adminOption.rows[0]?.has_admin_option === true,
      publicTableCount: Number(publicTables.rows[0]?.count ?? "0"),
      migrationSchemaExists: migrationSchema.rows.length === 1,
      migrationSchemaOwner: migrationSchema.rows[0]?.schema_owner ?? null,
      ledgerExists,
      appliedMigrations: Object.freeze(appliedMigrations),
      migrationMetadataObjects: Object.freeze(
        metadataObjects.rows.map(({ object_key }) => object_key),
      ),
      migrationClassObjectOwners: Object.freeze(
        metadataObjects.rows
          .filter(({ object_key }) => object_key.startsWith("class:"))
          .map(({ object_owner }) => object_owner ?? ""),
      ),
      migrationExternalUserDependencyCount: Number(
        externalDependencies.rows[0]?.count ?? "0",
      ),
      existingMigrationRoles: Object.freeze(migrationRoles.map(({ rolname }) => rolname)),
      migrationRoles: Object.freeze(migrationRoles),
      staleDryRunSchemas: Object.freeze(staleSchemas.rows.map(({ schema_name }) => schema_name)),
    });
  } finally {
    await client.end();
  }
}

type RoleQueryRow = Readonly<{
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  member_of_neon_superuser: boolean;
}>;

function toRoleState(row: RoleQueryRow): RoleState {
  return Object.freeze({
    rolname: row.rolname,
    rolcanlogin: row.rolcanlogin,
    rolsuper: row.rolsuper,
    rolcreaterole: row.rolcreaterole,
    rolcreatedb: row.rolcreatedb,
    rolinherit: row.rolinherit,
    rolreplication: row.rolreplication,
    rolbypassrls: row.rolbypassrls,
    memberOfNeonSuperuser: row.member_of_neon_superuser,
  });
}

async function runNeonTestTransactionalDryRun(
  target: NeonTestMigrationTarget,
  manifest: MigrationManifest,
): Promise<void> {
  const client = new Client(createNeonTestDryRunClientOptions(target));
  await client.connect();
  try {
    await executeNeonTestTransactionalDryRun(manifest, {
      query: async (sql, parameters) => {
        const result = parameters
          ? await client.query(sql, [...parameters])
          : await client.query(sql);
        return { rows: result.rows as readonly Record<string, unknown>[] };
      },
      readMigration: async (name) =>
        readFile(resolve(MIGRATION_DIRECTORY, name)),
    });
  } finally {
    await client.end();
  }
}

async function readMigrationManifestForStage(
  stage:
  | "preflight_manifest"
  | "rollback_manifest"
  | "postflight_manifest",
): Promise<MigrationManifest> {
  try {
    const manifest = await verifyOrderedMigrationManifest();
    assertNeonTestManifest(manifest);
    return manifest;
  } catch (error) {
    throw createNeonTestMigrationRunError(stage, error);
  }
}

async function inspectNeonTestDatabaseForStage(
  target: NeonTestMigrationTarget,
  stage:
  | "preflight_database_inspection"
  | "rollback_database_inspection"
  | "postflight_database_inspection",
): Promise<NeonTestDatabaseState> {
  try {
    return await inspectNeonTestDatabase(target);
  } catch (error) {
    throw createNeonTestMigrationRunError(stage, error);
  }
}

function assertManifestUnchangedForStage(
  expected: MigrationManifest,
  actual: MigrationManifest,
  stage: "rollback_manifest" | "postflight_manifest",
): void {
  if (!manifestsEqual(expected, actual)) {
    throw createNeonTestMigrationRunError(stage);
  }
}

async function runCli(
  arguments_: readonly string[],
  environment: RuntimeEnvironment,
): Promise<void> {
  const mode = readNeonTestMigrationMode(arguments_);
  const target = readNeonTestMigrationTarget(environment);
  const manifestBefore = await readMigrationManifestForStage("preflight_manifest");
  const before = await inspectNeonTestDatabaseForStage(
    target,
    "preflight_database_inspection",
  );
  try {
    validateNeonTestPreflight(before);
  } catch (error) {
    throw createNeonTestMigrationRunError("preflight_database_inspection", error);
  }

  await executeNeonTestMigrationRun(mode, {
    runMigration: async () => {
      if (mode === "dry-run") {
        await runNeonTestTransactionalDryRun(target, manifestBefore);
      } else {
        await runner(createNeonTestMigrationApplyOptions(target));
      }
    },
    verifyRollbackAfterFailure: async () => {
      const manifestAfterFailure = await readMigrationManifestForStage("rollback_manifest");
      assertManifestUnchangedForStage(
        manifestBefore,
        manifestAfterFailure,
        "rollback_manifest",
      );
      const failed = await inspectNeonTestDatabaseForStage(
        target,
        "rollback_database_inspection",
      );
      const rollback = validateNeonTestRollback(failed);
      if (mode === "dry-run" && rollback.state !== "clean") {
        throw new NeonTestMigrationAttemptError(
          migrationFailureEvidence("rollback_state_verification"),
        );
      }
      return rollback;
    },
  });

  const manifestAfter = await readMigrationManifestForStage("postflight_manifest");
  assertManifestUnchangedForStage(
    manifestBefore,
    manifestAfter,
    "postflight_manifest",
  );
  const after = await inspectNeonTestDatabaseForStage(
    target,
    "postflight_database_inspection",
  );
  try {
    if (mode === "apply") {
      validateNeonTestApplyResult(after, manifestAfter);
    } else {
      const rollback = validateNeonTestRollback(after);
      if (rollback.state !== "clean") {
        throw new NeonTestMigrationSafetyError(
          "Dry-run left database metadata behind.",
        );
      }
    }
  } catch (error) {
    throw createNeonTestMigrationRunError("postflight_database_inspection", error);
  }
  process.stdout.write(
    `${JSON.stringify(createNeonTestMigrationEvidence(mode, manifestAfter, before, after), null, 2)}\n`,
  );
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function redactError(error: unknown): string {
  const migrationFailure = formatNeonTestMigrationFailure(error);
  if (migrationFailure) return migrationFailure;
  return JSON.stringify({
    original_failure: { failure_stage: "cli" },
  });
}

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli(process.argv.slice(2), process.env).catch((error: unknown) => {
    process.stderr.write(`${redactError(error)}\n`);
    process.exitCode = 1;
  });
}
