import { readFile } from "node:fs/promises";

import { Client } from "pg";

const MIGRATION_NAME = "202608280010_052_complete_application_task_delivery.sql";
const EXPECTED_APPLICATION_USER = "tianxing_app";
const MIGRATION_LOCK_ID = 520_828_001;

if (process.env.VERCEL_ENV !== "production") {
  console.log(`production_uat_migration=${MIGRATION_NAME} status=skipped_non_production`);
  process.exit(0);
}

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const expectedDatabase = process.env.TEST_DATABASE_EXPECTED_NAME?.trim();

if (!connectionString || !expectedDatabase) {
  throw new Error("Production UAT migration requires the configured test database.");
}

const client = new Client({
  connectionString,
  application_name: "tianxing-production-uat-migration-052",
  ssl: { rejectUnauthorized: true },
});

try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '60s'");
  await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);

  const preflight = await readPreflight();
  if (
    preflight.database_name !== expectedDatabase ||
    preflight.user_name !== EXPECTED_APPLICATION_USER
  ) {
    throw new Error("Production UAT migration target identity was rejected.");
  }
  if (!preflight.v1_function || !preflight.promotion_function) {
    throw new Error("Production UAT migration prerequisite schema is missing.");
  }
  if (preflight.v2_function !== preflight.deadline_column) {
    throw new Error("Production UAT migration found a partial migration state.");
  }

  if (!preflight.v2_function) {
    const migrationSql = await readFile(
      new URL(`../../db/migrations/${MIGRATION_NAME}`, import.meta.url),
      "utf8",
    );
    await client.query(migrationSql);
  }

  const postflight = await readPreflight();
  if (!postflight.v2_function || !postflight.deadline_column || !postflight.v2_trigger) {
    throw new Error("Production UAT migration postflight verification failed.");
  }

  await client.query("COMMIT");
  console.log(`production_uat_migration=${MIGRATION_NAME} status=ready`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  const postgresCode = readPostgresCode(error);
  console.error(
    `production_uat_migration=${MIGRATION_NAME} status=failed postgres_code=${postgresCode}`,
  );
  throw new Error("Production UAT migration failed.", { cause: error });
} finally {
  await client.end().catch(() => undefined);
}

async function readPreflight(): Promise<Readonly<{
  database_name: string;
  user_name: string;
  v1_function: boolean;
  v2_function: boolean;
  promotion_function: boolean;
  deadline_column: boolean;
  v2_trigger: boolean;
}>> {
  const result = await client.query({
    text: `SELECT current_database() AS database_name,
                  current_user AS user_name,
                  to_regprocedure('public.cases_create_candidate_list_version(uuid,uuid,uuid,bigint,text,text,jsonb,timestamptz)') IS NOT NULL AS v1_function,
                  to_regprocedure('public.cases_create_candidate_list_version_v2(uuid,uuid,uuid,bigint,text,text,jsonb,timestamptz)') IS NOT NULL AS v2_function,
                  to_regprocedure('public.cases_promote_confirmed_targets_to_preparing()') IS NOT NULL AS promotion_function,
                  EXISTS (
                    SELECT 1 FROM information_schema.columns
                     WHERE table_schema='public'
                       AND table_name='cases_candidate_school_list_items'
                       AND column_name='application_deadline'
                  ) AS deadline_column,
                  EXISTS (
                    SELECT 1 FROM pg_trigger AS trigger_row
                    JOIN pg_class AS table_row ON table_row.oid=trigger_row.tgrelid
                    JOIN pg_namespace AS schema_row ON schema_row.oid=table_row.relnamespace
                     WHERE schema_row.nspname='public'
                       AND table_row.relname='cases_candidate_school_list_versions'
                       AND trigger_row.tgname='cases_candidate_confirmed_preparing_trg'
                       AND NOT trigger_row.tgisinternal
                  ) AS v2_trigger`,
  });
  const row = result.rows[0];
  if (!row) throw new Error("Production UAT migration preflight returned no row.");
  return row;
}

function readPostgresCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown";
}
