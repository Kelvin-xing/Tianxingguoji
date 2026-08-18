import assert from "node:assert/strict";
import test from "node:test";

import {
  loadTestDatabaseConfiguration,
  TEST_APPLICATION_GROUP_ROLE,
} from "../../../lib/runtime/test-database-config.ts";
import { RuntimeEnvironmentConfigurationError } from "../../../lib/runtime/runtime-environment.ts";

test("loads two separated TLS test database login endpoints", () => {
  assert.equal(TEST_APPLICATION_GROUP_ROLE, "tianxing_test_application");
  const config = loadTestDatabaseConfiguration(validEnvironment());
  assert.deepEqual(config, {
    identity: {
      connectionString: "postgresql://env01_identity_login:identity-secret@db.vendor.example:5432/txgj_env01_test",
      loginUser: "env01_identity_login",
      databaseName: "txgj_env01_test",
      host: "db.vendor.example",
    },
    application: {
      connectionString: "postgresql://env01_application_login:application-secret@db.vendor.example:5432/txgj_env01_test",
      loginUser: "env01_application_login",
      databaseName: "txgj_env01_test",
      host: "db.vendor.example",
    },
    connectionTimeoutMs: 2000,
    statementTimeoutMs: 5000,
    poolMax: 1,
    ssl: { rejectUnauthorized: true },
  });
});

test("rejects unsafe database names, hosts, roles, query parameters, and shared logins", () => {
  const cases: readonly [string, string, string][] = [
    ["TEST_DATABASE_EXPECTED_NAME", "tianxing", "TEST_DATABASE_EXPECTED_NAME"],
    ["TEST_IDENTITY_DATABASE_URL", "postgresql://identity:secret@127.0.0.1:5432/txgj_env01_test", "TEST_IDENTITY_DATABASE_URL"],
    ["TEST_IDENTITY_DATABASE_URL", "postgresql://identity:secret@[::1]:5432/txgj_env01_test", "TEST_IDENTITY_DATABASE_URL"],
    ["TEST_IDENTITY_DATABASE_URL", "postgresql://identity:secret@db.localhost:5432/txgj_env01_test", "TEST_IDENTITY_DATABASE_URL"],
    ["TEST_IDENTITY_DATABASE_URL", "postgresql://tianxing_test_identity:secret@db.vendor.example:5432/txgj_env01_test", "TEST_IDENTITY_DATABASE_URL"],
    ["TEST_IDENTITY_DATABASE_URL", "postgresql://env01_migration_login:secret@db.vendor.example:5432/txgj_env01_test", "TEST_IDENTITY_DATABASE_URL"],
    ["TEST_IDENTITY_DATABASE_URL", "postgresql://identity:secret@db.vendor.example:5432/txgj_env01_test?sslmode=require", "TEST_IDENTITY_DATABASE_URL"],
    ["TEST_APPLICATION_DATABASE_URL", "postgresql://env01_application_login:secret@other.vendor.example:5432/txgj_env01_test", "TEST_APPLICATION_DATABASE_URL"],
    ["TEST_APPLICATION_DATABASE_URL", "postgresql://env01_identity_login:secret@db.vendor.example:5432/txgj_env01_test", "TEST_APPLICATION_DATABASE_URL"],
    ["TEST_APPLICATION_DATABASE_URL", "postgresql://tianxing_test_application:secret@db.vendor.example:5432/txgj_env01_test", "TEST_APPLICATION_DATABASE_URL"],
    ["TEST_DATABASE_POOL_MAX", "2", "TEST_DATABASE_POOL_MAX"],
  ];
  for (const [variable, value, expectedVariable] of cases) {
    assert.throws(
      () => loadTestDatabaseConfiguration({ ...validEnvironment(), [variable]: value }),
      (error: unknown) => error instanceof RuntimeEnvironmentConfigurationError &&
        error.variable === expectedVariable,
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

test("rejects equal decoded identity and application passwords without exposing a password field", () => {
  for (const [identityPassword, applicationPassword] of [
    ["shared-secret", "shared-secret"],
    ["shared%2Dsecret", "shared-secret"],
  ]) {
    const environment = validEnvironment();
    environment.TEST_IDENTITY_DATABASE_URL =
      `postgresql://env01_identity_login:${identityPassword}@db.vendor.example:5432/txgj_env01_test`;
    environment.TEST_APPLICATION_DATABASE_URL =
      `postgresql://env01_application_login:${applicationPassword}@db.vendor.example:5432/txgj_env01_test`;
    assert.throws(
      () => loadTestDatabaseConfiguration(environment),
      (error: unknown) => error instanceof RuntimeEnvironmentConfigurationError &&
        error.variable === "TEST_APPLICATION_DATABASE_URL" &&
        !Object.hasOwn(error, "password"),
    );
  }

  const config = loadTestDatabaseConfiguration(validEnvironment());
  assert.equal(Object.hasOwn(config.identity, "password"), false);
  assert.equal(Object.hasOwn(config.application, "password"), false);
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
    TEST_IDENTITY_DATABASE_URL:
      "postgresql://env01_identity_login:identity-secret@db.vendor.example:5432/txgj_env01_test",
    TEST_APPLICATION_DATABASE_URL:
      "postgresql://env01_application_login:application-secret@db.vendor.example:5432/txgj_env01_test",
    TEST_DATABASE_CONNECTION_TIMEOUT_MS: "2000",
    TEST_DATABASE_STATEMENT_TIMEOUT_MS: "5000",
    TEST_DATABASE_POOL_MAX: "1",
  };
}
