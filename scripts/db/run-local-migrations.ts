import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { runner, type RunnerOption } from "node-pg-migrate";
import { Client } from "pg";

import {
  createMigrationApplyOptions,
  createMigrationRunnerOptions,
} from "../../db/migrate.config.ts";
import {
  MigrationManifestSafetyError,
  verifyOrderedMigrationManifest,
  type MigrationManifest as SharedMigrationManifest,
} from "./migration-manifest.ts";

const LOCAL_MODE = "local-synthetic";
const LOCAL_DATABASE = "tianxing";
const LOCAL_MIGRATION_USER = "tianxing_migration";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type LocalMigrationMode = "dry-run" | "apply";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type MigrationManifest = SharedMigrationManifest;

export type LocalMigrationTarget = Readonly<{
  connectionString: string;
  host: string;
  port: number;
  database: typeof LOCAL_DATABASE;
  user: typeof LOCAL_MIGRATION_USER;
}>;

type DatabaseState = Readonly<{
  publicTableCount: number;
  appliedMigrations: readonly string[];
}>;

export class LocalMigrationSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalMigrationSafetyError";
  }
}

export function readLocalMigrationMode(arguments_: readonly string[]): LocalMigrationMode {
  if (arguments_.length !== 1 || !["--dry-run", "--apply"].includes(arguments_[0] ?? "")) {
    throw new LocalMigrationSafetyError("Specify exactly one migration mode: --dry-run or --apply.");
  }
  return arguments_[0] === "--apply" ? "apply" : "dry-run";
}

export function readLocalMigrationTarget(
  environment: RuntimeEnvironment = process.env,
): LocalMigrationTarget {
  if (environment.APP_RUNTIME_MODE !== LOCAL_MODE || environment.NODE_ENV === "production") {
    throw new LocalMigrationSafetyError("Local migrations require non-production local-synthetic mode.");
  }

  const connectionString = environment.MIGRATION_DATABASE_URL?.trim();
  if (!connectionString || /[\r\n]/.test(connectionString)) {
    throw new LocalMigrationSafetyError("MIGRATION_DATABASE_URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new LocalMigrationSafetyError("MIGRATION_DATABASE_URL must be a valid PostgreSQL URL.");
  }

  const database = decodeURIComponent(parsed.pathname.slice(1));
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username !== LOCAL_MIGRATION_USER ||
    parsed.password.length === 0 ||
    database !== LOCAL_DATABASE ||
    port !== 5432 ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new LocalMigrationSafetyError(
      "Migration target must be the loopback tianxing database and tianxing_migration user.",
    );
  }

  return Object.freeze({
    connectionString,
    host: parsed.hostname,
    port,
    database: LOCAL_DATABASE,
    user: LOCAL_MIGRATION_USER,
  });
}

export function createLocalMigrationOptions(
  target: LocalMigrationTarget,
  mode: LocalMigrationMode,
): RunnerOption {
  return mode === "apply"
    ? createMigrationApplyOptions(target.connectionString)
    : createMigrationRunnerOptions(target.connectionString);
}

export async function verifyMigrationManifest(
  migrationDirectory = "db/migrations",
  manifestPath = "db/migrations/manifest.json",
): Promise<MigrationManifest> {
  try {
    return await verifyOrderedMigrationManifest(migrationDirectory, manifestPath);
  } catch (error) {
    if (error instanceof MigrationManifestSafetyError) {
      throw new LocalMigrationSafetyError(error.message);
    }
    throw error;
  }
}

async function inspectDatabase(
  target: LocalMigrationTarget,
  expectedLedger: readonly string[],
): Promise<DatabaseState> {
  const client = new Client({
    connectionString: target.connectionString,
    application_name: "tianxing-local-migration-preflight",
    statement_timeout: 5_000,
    lock_timeout: 5_000,
  });
  await client.connect();
  try {
    const identity = await client.query<{
      database_name: string;
      user_name: string;
      rolsuper: boolean;
      rolcreaterole: boolean;
    }>(`
      SELECT current_database() AS database_name,
             current_user AS user_name,
             role.rolsuper,
             role.rolcreaterole
        FROM pg_roles role
       WHERE role.rolname = current_user
    `);
    const current = identity.rows[0];
    if (
      !current ||
      current.database_name !== target.database ||
      current.user_name !== target.user ||
      !current.rolsuper ||
      !current.rolcreaterole
    ) {
      throw new LocalMigrationSafetyError("Connected database identity is not the approved local owner.");
    }

    const publicTables = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
        FROM pg_tables
       WHERE schemaname = 'public'
    `);
    const ledger = await client.query<{ ledger: string | null }>(
      "SELECT to_regclass('migration.schema_migrations')::text AS ledger",
    );
    const appliedMigrations = ledger.rows[0]?.ledger
      ? (
          await client.query<{ name: string }>(
            'SELECT name FROM migration.schema_migrations ORDER BY run_on, id',
          )
        ).rows.map(({ name }) => name)
      : [];

    if (
      appliedMigrations.length > expectedLedger.length ||
      appliedMigrations.some((name, index) => name !== expectedLedger[index])
    ) {
      throw new LocalMigrationSafetyError("Database migration ledger is not an ordered manifest prefix.");
    }

    const publicTableCount = Number(publicTables.rows[0]?.count ?? "0");
    if (appliedMigrations.length === 0 && publicTableCount !== 0) {
      throw new LocalMigrationSafetyError("An empty migration ledger requires an empty public schema.");
    }

    return Object.freeze({
      publicTableCount,
      appliedMigrations: Object.freeze(appliedMigrations),
    });
  } finally {
    await client.end();
  }
}

async function runCli(arguments_: readonly string[], environment: RuntimeEnvironment): Promise<void> {
  const mode = readLocalMigrationMode(arguments_);
  const target = readLocalMigrationTarget(environment);
  const manifest = await verifyMigrationManifest();
  const expectedLedger = manifest.migrations.map(({ name }) => name.replace(/\.sql$/, ""));
  const before = await inspectDatabase(target, expectedLedger);
  const migrated = await runner(createLocalMigrationOptions(target, mode));
  const after = await inspectDatabase(target, expectedLedger);

  if (mode === "dry-run" && after.appliedMigrations.length !== before.appliedMigrations.length) {
    throw new LocalMigrationSafetyError("Dry-run changed the migration ledger.");
  }
  if (mode === "apply" && after.appliedMigrations.length !== expectedLedger.length) {
    throw new LocalMigrationSafetyError("Migration apply did not reach the complete manifest.");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        mode,
        target: {
          host: target.host,
          port: target.port,
          database: target.database,
          user: target.user,
        },
        manifest_migrations: manifest.migrations.length,
        ledger_before: before.appliedMigrations.length,
        runner_selected: migrated.length,
        ledger_after: after.appliedMigrations.length,
        public_tables_after: after.publicTableCount,
        status: "pass",
      },
      null,
      2,
    )}\n`,
  );
}

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli(process.argv.slice(2), process.env).catch((error: unknown) => {
    const unsafeMessage = error instanceof Error ? error.message : "Unknown migration failure.";
    const secret = process.env.MIGRATION_DATABASE_URL ?? "";
    const safeMessage = secret === "" ? unsafeMessage : unsafeMessage.replaceAll(secret, "[redacted]");
    process.stderr.write(`${safeMessage}\n`);
    process.exitCode = 1;
  });
}
