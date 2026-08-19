import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { runner, type RunnerOption } from "node-pg-migrate";
import { Client } from "pg";

import { MIGRATION_CONFIG } from "../../db/migrate.config.ts";
import {
  EXPECTED_MIGRATION_COUNT,
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

const REDACTED_ENVIRONMENT_VARIABLES = Object.freeze([
  "APP_ENV",
  "NODE_ENV",
  "APP_RUNTIME_MODE",
  "AUTH_MODE",
  "TEST_DATABASE_EXPECTED_NAME",
  "TEST_MIGRATION_DATABASE_URL",
  ...REJECTED_ENVIRONMENT_VARIABLES,
] as const);

export type NeonTestMigrationMode = "dry-run" | "apply";
type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type NeonTestMigrationExecution = Readonly<{
  runMigration(): Promise<void>;
  cleanupDryRun(): Promise<void>;
  verifyRollbackAfterFailure(): Promise<void>;
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
  ledgerExists: boolean;
  appliedMigrations: readonly string[];
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

export function createNeonTestMigrationOptions(
  target: NeonTestMigrationTarget,
  mode: NeonTestMigrationMode,
  dryRunSchema = `${DRY_RUN_SCHEMA_PREFIX}contract`,
): RunnerOption {
  if (mode === "dry-run" && !isDryRunSchema(dryRunSchema)) {
    throw new NeonTestMigrationSafetyError("Dry-run migration schema name is invalid.");
  }
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
    migrationsSchema: mode === "dry-run" ? dryRunSchema : MIGRATION_CONFIG.migrationsSchema,
    migrationsTable: MIGRATION_CONFIG.migrationsTable,
    createMigrationsSchema: true,
    direction: "up",
    checkOrder: true,
    singleTransaction: true,
    noLock: false,
    advisoryLockMode: "fail",
    dryRun: mode === "dry-run",
    migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
    logger: SILENT_LOGGER,
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
    state.ledgerExists ||
    state.appliedMigrations.length !== 0 ||
    state.existingMigrationRoles.length !== 0 ||
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

export function validateNeonTestRollback(state: NeonTestDatabaseState): void {
  if (
    state.ledgerExists ||
    state.appliedMigrations.length !== 0 ||
    state.publicTableCount !== 0 ||
    state.existingMigrationRoles.length !== 0
  ) {
    throw new NeonTestMigrationSafetyError(
      "Migration rollback verification failed; stop without retry or cleanup.",
    );
  }
}

export async function executeNeonTestMigrationRun(
  mode: NeonTestMigrationMode,
  execution: NeonTestMigrationExecution,
): Promise<void> {
  let migrationFailed = false;
  let migrationFailure: unknown;

  try {
    await execution.runMigration();
  } catch (error) {
    migrationFailed = true;
    migrationFailure = error;
  }

  if (!migrationFailed) {
    if (mode === "dry-run") {
      try {
        await execution.cleanupDryRun();
      } catch (error) {
        throw new NeonTestMigrationSafetyError(
          "Dry-run cleanup failed; stop without retry.",
          { cause: error },
        );
      }
    }
    return;
  }

  let cleanupFailed = false;
  let cleanupFailure: unknown;
  if (mode === "dry-run") {
    try {
      await execution.cleanupDryRun();
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
    }
  }

  try {
    await execution.verifyRollbackAfterFailure();
  } catch (error) {
    throw new NeonTestMigrationSafetyError(
      "Migration rollback or state verification is incomplete; architecture escalation required.",
      { cause: error },
    );
  }

  if (cleanupFailed) {
    throw new NeonTestMigrationSafetyError(
      "Migration execution failed; dry-run cleanup failed and state verification passed; stop without retry.",
      { cause: cleanupFailure },
    );
  }

  throw new NeonTestMigrationSafetyError(
    "Migration execution failed and rollback verification passed; stop without retry.",
    { cause: migrationFailure },
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
             pg_get_userbyid(database.datdba) AS database_owner,
             role.rolname,
             role.rolcanlogin,
             role.rolsuper,
             role.rolcreaterole,
             role.rolcreatedb,
             role.rolinherit,
             role.rolreplication,
             role.rolbypassrls,
             pg_has_role(role.rolname, 'neon_superuser', 'member')
               AS member_of_neon_superuser
        FROM pg_database AS database
        JOIN pg_roles AS role ON role.rolname = current_user
       WHERE database.datname = current_database()
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
      SELECT role.rolname,
             role.rolcanlogin,
             role.rolsuper,
             role.rolcreaterole,
             role.rolcreatedb,
             role.rolinherit,
             role.rolreplication,
             role.rolbypassrls,
             pg_has_role(role.rolname, 'neon_superuser', 'member')
               AS member_of_neon_superuser
        FROM pg_roles AS role
       WHERE role.rolname = 'rds_iam'
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
    const roles = await client.query<RoleQueryRow>(`
      SELECT role.rolname,
             role.rolcanlogin,
             role.rolsuper,
             role.rolcreaterole,
             role.rolcreatedb,
             role.rolinherit,
             role.rolreplication,
             role.rolbypassrls,
             pg_has_role(role.rolname, 'neon_superuser', 'member')
               AS member_of_neon_superuser
        FROM pg_roles AS role
       WHERE role.rolname = ANY($1::text[])
       ORDER BY role.rolname
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
      ledgerExists,
      appliedMigrations: Object.freeze(appliedMigrations),
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

async function cleanupDryRunSchema(
  target: NeonTestMigrationTarget,
  schemaName: string,
): Promise<void> {
  if (!isDryRunSchema(schemaName)) {
    throw new NeonTestMigrationSafetyError("Dry-run cleanup target is invalid.");
  }
  const client = new Client({
    connectionString: target.connectionString,
    application_name: "tianxing-neon-test-migration-dry-run-cleanup",
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  try {
    const schema = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
      ) AS exists
    `, [schemaName]);
    if (!schema.rows[0]?.exists) return;

    const unexpectedTables = await client.query<{ table_name: string }>(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name <> 'schema_migrations'
    `, [schemaName]);
    if (unexpectedTables.rows.length !== 0) {
      throw new NeonTestMigrationSafetyError(
        "Dry-run schema contains unexpected objects; stop without cleanup.",
      );
    }
    await client.query("BEGIN");
    try {
      await client.query(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

async function runCli(
  arguments_: readonly string[],
  environment: RuntimeEnvironment,
): Promise<void> {
  const mode = readNeonTestMigrationMode(arguments_);
  const target = readNeonTestMigrationTarget(environment);
  const manifestBefore = await verifyOrderedMigrationManifest();
  assertNeonTestManifest(manifestBefore);
  const before = await inspectNeonTestDatabase(target);
  validateNeonTestPreflight(before);
  const dryRunSchema = `${DRY_RUN_SCHEMA_PREFIX}${process.pid}_${Date.now()}`;

  await executeNeonTestMigrationRun(mode, {
    runMigration: async () => {
      await runner(createNeonTestMigrationOptions(target, mode, dryRunSchema));
    },
    cleanupDryRun: async () => {
      await cleanupDryRunSchema(target, dryRunSchema);
    },
    verifyRollbackAfterFailure: async () => {
      const manifestAfterFailure = await verifyOrderedMigrationManifest();
      if (!manifestsEqual(manifestBefore, manifestAfterFailure)) {
        throw new NeonTestMigrationSafetyError(
          "Migration files changed during execution; stop without retry.",
        );
      }
      const failed = await inspectNeonTestDatabase(target);
      validateNeonTestRollback(failed);
    },
  });

  const manifestAfter = await verifyOrderedMigrationManifest();
  if (!manifestsEqual(manifestBefore, manifestAfter)) {
    throw new NeonTestMigrationSafetyError(
      "Migration files changed during execution; stop without retry.",
    );
  }
  const after = await inspectNeonTestDatabase(target);
  if (mode === "apply") {
    validateNeonTestApplyResult(after, manifestAfter);
  } else {
    validateNeonTestRollback(after);
    if (after.ledgerExists || after.staleDryRunSchemas.length !== 0) {
      throw new NeonTestMigrationSafetyError("Dry-run left database metadata behind.");
    }
  }
  process.stdout.write(
    `${JSON.stringify(createNeonTestMigrationEvidence(mode, manifestAfter, before, after), null, 2)}\n`,
  );
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function isDryRunSchema(value: string): boolean {
  return new RegExp(`^${DRY_RUN_SCHEMA_PREFIX}[a-z0-9_]+$`).test(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function redactError(error: unknown, environment: RuntimeEnvironment): string {
  let message = error instanceof Error ? error.message : "Neon migration failed.";
  const secrets = new Set<string>();
  for (const name of REDACTED_ENVIRONMENT_VARIABLES) {
    const value = environment[name];
    if (hasValue(value)) secrets.add(value!.trim());
  }
  const url = environment.TEST_MIGRATION_DATABASE_URL?.trim();
  if (url) {
    try {
      const parsed = new URL(url);
      secrets.add(parsed.hostname);
      secrets.add(decodeURIComponent(parsed.password));
    } catch {
      // The raw invalid value is already included above.
    }
  }
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.replaceAll(secret, "[redacted]");
  }
  return message;
}

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli(process.argv.slice(2), process.env).catch((error: unknown) => {
    process.stderr.write(`${redactError(error, process.env)}\n`);
    process.exitCode = 1;
  });
}
