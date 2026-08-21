import assert from "node:assert/strict";
import test from "node:test";

import { loadTestDatabaseConfiguration } from "../../../lib/runtime/test-database-config.ts";
import { RuntimeEnvironmentConfigurationError } from "../../../lib/runtime/runtime-environment.ts";

test("loads one TLS test database endpoint for the canonical application role", () => {
  const config = loadTestDatabaseConfiguration(validEnvironment());
  assert.deepEqual(config, {
    database: {
      connectionString:
        "postgresql://tianxing_app:test-secret@db.vendor.example:5432/txgj_env01_test",
      loginUser: "tianxing_app",
      databaseName: "txgj_env01_test",
      host: "db.vendor.example",
    },
    connectionTimeoutMs: 2000,
    statementTimeoutMs: 5000,
    poolMax: 1,
    ssl: { rejectUnauthorized: true },
  });
});

test("loads the local database-test endpoint only from an explicit loopback URL", () => {
  assert.deepEqual(loadTestDatabaseConfiguration(localEnvironment()), {
    database: {
      connectionString:
        "postgresql://tianxing_app:local-secret@127.0.0.1:55432/tianxing",
      loginUser: "tianxing_app",
      databaseName: "tianxing",
      host: "127.0.0.1",
    },
    connectionTimeoutMs: 2000,
    statementTimeoutMs: 2000,
    poolMax: 1,
    ssl: false,
  });
});

test("rejects remote, implicit-port, alternate-role, query, and alternate database local URLs", () => {
  for (const value of [
    "postgresql://tianxing_app:secret@db.vendor.example:5432/tianxing",
    "postgresql://tianxing_app:secret@127.0.0.1/tianxing",
    "postgresql://other_role:secret@127.0.0.1:5432/tianxing",
    "postgresql://tianxing_app:secret@127.0.0.1:5432/other",
    "postgresql://tianxing_app:secret@127.0.0.1:5432/tianxing?sslmode=require",
  ]) {
    assert.throws(
      () => loadTestDatabaseConfiguration({
        ...localEnvironment(),
        LOCAL_SYNTHETIC_DATABASE_URL: value,
      }),
      (error: unknown) => error instanceof RuntimeEnvironmentConfigurationError &&
        error.variable === "LOCAL_SYNTHETIC_DATABASE_URL",
    );
  }
});

test("rejects old multi-account variables and unsafe canonical endpoints", () => {
  for (const variable of [
    "TEST_IDENTITY_DATABASE_URL",
    "TEST_APPLICATION_DATABASE_URL",
    "TEST_PROVISION_DATABASE_URL",
    "TEST_MIGRATION_DATABASE_URL",
  ]) {
    assert.throws(
      () => loadTestDatabaseConfiguration({
        ...validEnvironment(),
        [variable]: "postgresql://legacy:secret@db.vendor.example:5432/txgj_env01_test",
      }),
      (error: unknown) => error instanceof RuntimeEnvironmentConfigurationError &&
        error.variable === variable,
    );
  }

  for (const value of [
    "postgresql://other_role:secret@db.vendor.example:5432/txgj_env01_test",
    "postgresql://tianxing_app:secret@127.0.0.1:5432/txgj_env01_test",
    "postgresql://tianxing_app:secret@db.localhost:5432/txgj_env01_test",
    "postgresql://tianxing_app:secret@db.vendor.example:5432/txgj_env01_test?sslmode=require",
  ]) {
    assert.throws(
      () => loadTestDatabaseConfiguration({ ...validEnvironment(), TEST_DATABASE_URL: value }),
      (error: unknown) => error instanceof RuntimeEnvironmentConfigurationError &&
        error.variable === "TEST_DATABASE_URL",
    );
  }
});

test("enforces the frozen Web database timeout boundaries", () => {
  for (const [connection, statement] of [["250", "1000"], ["5000", "10000"]]) {
    const config = loadTestDatabaseConfiguration({
      ...validEnvironment(),
      TEST_DATABASE_CONNECTION_TIMEOUT_MS: connection,
      TEST_DATABASE_STATEMENT_TIMEOUT_MS: statement,
    });
    assert.equal(config.connectionTimeoutMs, Number(connection));
    assert.equal(config.statementTimeoutMs, Number(statement));
  }

  for (const [variable, value] of [
    ["TEST_DATABASE_CONNECTION_TIMEOUT_MS", "249"],
    ["TEST_DATABASE_CONNECTION_TIMEOUT_MS", "5001"],
    ["TEST_DATABASE_STATEMENT_TIMEOUT_MS", "999"],
    ["TEST_DATABASE_STATEMENT_TIMEOUT_MS", "10001"],
  ] as const) {
    assert.throws(
      () => loadTestDatabaseConfiguration({ ...validEnvironment(), [variable]: value }),
      (error: unknown) => error instanceof RuntimeEnvironmentConfigurationError &&
        error.code === "RUNTIME_CONFIGURATION_INVALID" && error.variable === variable,
    );
  }
});

test("does not expose a separate password field", () => {
  const config = loadTestDatabaseConfiguration(validEnvironment());
  assert.equal(Object.hasOwn(config.database, "password"), false);
});

function validEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "test",
    NODE_ENV: "production",
    APP_RUNTIME_MODE: "test-database",
    AUTH_MODE: "database-test",
    VERCEL: "1",
    VERCEL_ENV: "preview",
    TEST_DATABASE_EXPECTED_NAME: "txgj_env01_test",
    TEST_DATABASE_URL:
      "postgresql://tianxing_app:test-secret@db.vendor.example:5432/txgj_env01_test",
    TEST_DATABASE_CONNECTION_TIMEOUT_MS: "2000",
    TEST_DATABASE_STATEMENT_TIMEOUT_MS: "5000",
    TEST_DATABASE_POOL_MAX: "1",
  };
}

function localEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "development",
    NODE_ENV: "development",
    APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "database-test",
    LOCAL_SYNTHETIC_DATABASE_URL:
      "postgresql://tianxing_app:local-secret@127.0.0.1:55432/tianxing",
    LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: "2000",
  };
}
