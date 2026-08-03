import type { RunnerOption } from "node-pg-migrate";

export const MIGRATION_CONFIG = Object.freeze({
  tool: Object.freeze({
    name: "node-pg-migrate",
    version: "9.0.0",
    license: "MIT",
  }),
  packageManager: "pnpm@10.34.4",
  migrationsDirectory: "db/migrations",
  schema: "public",
  migrationsSchema: "migration",
  migrationsTable: "schema_migrations",
  createMigrationsSchema: true,
  databaseUrlEnvironmentVariable: "MIGRATION_DATABASE_URL",
  migrationLoader: "sql",
  checkOrder: true,
  singleTransaction: true,
  advisoryLockMode: "fail",
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 5_000,
  dryRunByDefault: true,
  telemetry: "disabled",
} as const);

export function createMigrationRunnerOptions(migrationDatabaseUrl: string): RunnerOption {
  if (migrationDatabaseUrl.length === 0) {
    throw new Error("MIGRATION_DATABASE_URL is required.");
  }

  return {
    databaseUrl: {
      connectionString: migrationDatabaseUrl,
      application_name: "tianxing-schema-migration",
      statement_timeout: MIGRATION_CONFIG.statementTimeoutMs,
      lock_timeout: MIGRATION_CONFIG.lockTimeoutMs,
    },
    dir: MIGRATION_CONFIG.migrationsDirectory,
    schema: MIGRATION_CONFIG.schema,
    migrationsSchema: MIGRATION_CONFIG.migrationsSchema,
    migrationsTable: MIGRATION_CONFIG.migrationsTable,
    createMigrationsSchema: MIGRATION_CONFIG.createMigrationsSchema,
    direction: "up" as const,
    checkOrder: MIGRATION_CONFIG.checkOrder,
    singleTransaction: MIGRATION_CONFIG.singleTransaction,
    noLock: false,
    advisoryLockMode: MIGRATION_CONFIG.advisoryLockMode,
    dryRun: MIGRATION_CONFIG.dryRunByDefault,
    migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" as const }],
  };
}
