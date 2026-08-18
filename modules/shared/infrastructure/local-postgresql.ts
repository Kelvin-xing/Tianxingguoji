import "server-only";

import { Pool } from "pg";

import { loadLocalSyntheticConfig } from "../../../lib/runtime/local-synthetic-config.ts";
import { createTenantTransactionRunner, type DatabasePool } from "./db.ts";

const globalForLocalPostgresql = globalThis as typeof globalThis & {
  __txLocalApplicationPool?: Pool;
};

export function getLocalApplicationTenantRunner() {
  const config = loadLocalSyntheticConfig();
  if (!globalForLocalPostgresql.__txLocalApplicationPool) {
    globalForLocalPostgresql.__txLocalApplicationPool = new Pool({
      connectionString: config.database.applicationConnectionString,
      application_name: "tianxing-local-application",
      max: 5,
      connectionTimeoutMillis: config.dependencyTimeoutMs,
      statement_timeout: 5_000,
      ssl: false,
    });
  }
  return createTenantTransactionRunner(
    globalForLocalPostgresql.__txLocalApplicationPool as unknown as DatabasePool,
  );
}
