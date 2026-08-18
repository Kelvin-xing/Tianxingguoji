import "server-only";

import { Pool } from "pg";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import {
  loadTestDatabaseConfiguration,
  TEST_APPLICATION_GROUP_ROLE,
} from "../../../lib/runtime/test-database-config.ts";
import { createTenantTransactionRunner, type DatabasePool } from "./db.ts";
import { getLocalApplicationTenantRunner } from "./local-postgresql.ts";

const globalForApplicationPostgresql = globalThis as typeof globalThis & {
  __txTestApplicationPool?: Pool;
};

export class ApplicationTenantRuntimeUnavailable extends Error {
  constructor() {
    super("Application tenant runtime is not configured.");
    this.name = "ApplicationTenantRuntimeUnavailable";
  }
}

export function getApplicationTenantRunner() {
  const runtime = loadRuntimeEnvironment();
  if (runtime.appRuntimeMode === "local-synthetic") {
    return getLocalApplicationTenantRunner();
  }
  if (runtime.appRuntimeMode !== "test-database") {
    throw new ApplicationTenantRuntimeUnavailable();
  }

  const config = loadTestDatabaseConfiguration();
  if (!globalForApplicationPostgresql.__txTestApplicationPool) {
    globalForApplicationPostgresql.__txTestApplicationPool = new Pool({
      connectionString: config.application.connectionString,
      application_name: "tianxing-test-application",
      max: config.poolMax,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      statement_timeout: config.statementTimeoutMs,
      ssl: config.ssl,
    });
  }
  return createTenantTransactionRunner(
    globalForApplicationPostgresql.__txTestApplicationPool as unknown as DatabasePool,
    {
      expectedLoginUser: config.application.loginUser,
      requiredGroupRole: TEST_APPLICATION_GROUP_ROLE,
    },
  );
}
