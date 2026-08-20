import assert from "node:assert/strict";
import test from "node:test";

import {
  loadRuntimeEnvironment,
  RuntimeEnvironmentConfigurationError,
  TEST_WEB_FORBIDDEN_DATABASE_VARIABLES,
} from "../../../lib/runtime/runtime-environment.ts";

test("freezes the only three legal runtime environment combinations", () => {
  assert.deepEqual(loadRuntimeEnvironment(developmentEnvironment()), {
    appEnvironment: "development",
    nodeEnvironment: "development",
    appRuntimeMode: "local-synthetic",
    authMode: "local-synthetic",
    vercel: false,
  });
  assert.deepEqual(loadRuntimeEnvironment(testEnvironment()), {
    appEnvironment: "test",
    nodeEnvironment: "production",
    appRuntimeMode: "test-database",
    authMode: "database-test",
    vercel: { environment: "preview" },
  });
  assert.deepEqual(loadRuntimeEnvironment(productionEnvironment()), {
    appEnvironment: "production",
    nodeEnvironment: "production",
    appRuntimeMode: "production-aws",
    authMode: "cognito",
    vercel: false,
  });
});

test("rejects every cross-environment mode substitution fail closed", () => {
  const cases = [
    [developmentEnvironment(), "APP_ENV", "test", "NODE_ENV"],
    [developmentEnvironment(), "NODE_ENV", "production", "NODE_ENV"],
    [developmentEnvironment(), "APP_RUNTIME_MODE", "test-database", "APP_RUNTIME_MODE"],
    [developmentEnvironment(), "AUTH_MODE", "database-test", "AUTH_MODE"],
    [testEnvironment(), "NODE_ENV", "development", "NODE_ENV"],
    [testEnvironment(), "APP_RUNTIME_MODE", "production-aws", "APP_RUNTIME_MODE"],
    [testEnvironment(), "AUTH_MODE", "local-synthetic", "AUTH_MODE"],
    [productionEnvironment(), "APP_RUNTIME_MODE", "test-database", "APP_RUNTIME_MODE"],
    [productionEnvironment(), "AUTH_MODE", "database-test", "AUTH_MODE"],
  ] as const;
  for (const [environment, variable, value, expectedVariable] of cases) {
    assertConfigurationError(
      () => loadRuntimeEnvironment({ ...environment, [variable]: value }),
      expectedVariable,
    );
  }
});

test("treats Vercel as hosting metadata and rejects database integration variables", () => {
  assertConfigurationError(
    () => loadRuntimeEnvironment({ ...testEnvironment(), VERCEL_ENV: "development" }),
    "VERCEL_ENV",
  );
  assertConfigurationError(
    () => loadRuntimeEnvironment({ ...productionEnvironment(), VERCEL: "1" }),
    "VERCEL",
  );
  assert.deepEqual(TEST_WEB_FORBIDDEN_DATABASE_VARIABLES, [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "ONE_ROLE_BASELINE_DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "TEST_IDENTITY_DATABASE_URL",
    "TEST_APPLICATION_DATABASE_URL",
    "TEST_MIGRATION_DATABASE_URL",
    "TEST_PROVISION_DATABASE_URL",
    "NEON_AUTH_BASE_URL",
    "NEON_PROJECT_ID",
    "PGDATABASE",
    "PGHOST",
    "PGHOST_UNPOOLED",
    "PGPASSWORD",
    "PGUSER",
    "POSTGRES_DATABASE",
    "POSTGRES_HOST",
    "POSTGRES_PASSWORD",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL",
    "POSTGRES_URL_NON_POOLING",
    "POSTGRES_USER",
    "POSTGRES_URL_NO_SSL",
    "VITE_NEON_AUTH_URL",
  ]);
  for (const variable of TEST_WEB_FORBIDDEN_DATABASE_VARIABLES) {
    assertConfigurationError(
      () => loadRuntimeEnvironment({ ...testEnvironment(), [variable]: "forbidden" }),
      variable,
    );
  }
});

test("rejects every non-empty local synthetic variable in test Web runtime", () => {
  for (const variable of [
    "LOCAL_SYNTHETIC_DATABASE_URL",
    "LOCAL_SYNTHETIC_LOCALSTACK_ENDPOINT",
    "LOCAL_SYNTHETIC_UNRECOGNIZED_FUTURE_VALUE",
  ]) {
    assertConfigurationError(
      () => loadRuntimeEnvironment({ ...testEnvironment(), [variable]: "forbidden" }),
      variable,
    );
  }
});

test("allows empty forbidden variables and approved test database and Vercel metadata", () => {
  const emptyForbidden = Object.fromEntries(
    TEST_WEB_FORBIDDEN_DATABASE_VARIABLES.map((variable) => [variable, " \t "]),
  );
  assert.deepEqual(loadRuntimeEnvironment({
    ...testEnvironment(),
    ...emptyForbidden,
    LOCAL_SYNTHETIC_EMPTY: " \n ",
    TEST_DATABASE_EXPECTED_NAME: "txgj_env01_test",
    TEST_DATABASE_URL:
      "postgresql://tianxing_app:test-secret@db.vendor.example:5432/txgj_env01_test",
    TEST_DATABASE_CONNECTION_TIMEOUT_MS: "2000",
    TEST_DATABASE_STATEMENT_TIMEOUT_MS: "5000",
    TEST_DATABASE_POOL_MAX: "1",
    VERCEL_URL: "synthetic-preview.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "synthetic.example.invalid",
    VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
    VERCEL_REGION: "iad1",
    VERCEL_TARGET_ENV: "preview",
    APP_RELEASE_SHA: "a".repeat(40),
  }), {
    appEnvironment: "test",
    nodeEnvironment: "production",
    appRuntimeMode: "test-database",
    authMode: "database-test",
    vercel: { environment: "preview" },
  });
});

test("reports the first forbidden test Web variable in fixed contract order", () => {
  const reverseOrderedConflicts = Object.fromEntries(
    [...TEST_WEB_FORBIDDEN_DATABASE_VARIABLES]
      .reverse()
      .map((variable) => [variable, "forbidden"]),
  );
  assertConfigurationError(
    () => loadRuntimeEnvironment({ ...testEnvironment(), ...reverseOrderedConflicts }),
    "DATABASE_URL",
  );
  assertConfigurationError(
    () => loadRuntimeEnvironment({
      ...testEnvironment(),
      LOCAL_SYNTHETIC_Z_DATABASE_URL: "forbidden",
      LOCAL_SYNTHETIC_A_DATABASE_URL: "forbidden",
    }),
    "LOCAL_SYNTHETIC_A_DATABASE_URL",
  );
});

test("rejects legacy split local database URLs before local runtime startup", () => {
  for (const variable of [
    "LOCAL_SYNTHETIC_IDENTITY_DATABASE_URL",
    "LOCAL_SYNTHETIC_APPLICATION_DATABASE_URL",
  ]) {
    assertConfigurationError(
      () => loadRuntimeEnvironment({ ...developmentEnvironment(), [variable]: "forbidden" }),
      variable,
    );
  }
});

test("rejects test database URLs in production with deterministic variable attribution", () => {
  const variables = [
    "TEST_DATABASE_URL",
    "TEST_IDENTITY_DATABASE_URL",
    "TEST_APPLICATION_DATABASE_URL",
    "TEST_PROVISION_DATABASE_URL",
    "TEST_MIGRATION_DATABASE_URL",
  ] as const;
  for (const variable of variables) {
    assertConfigurationError(
      () => loadRuntimeEnvironment({ ...productionEnvironment(), [variable]: "forbidden" }),
      variable,
    );
  }
  assertConfigurationError(
    () => loadRuntimeEnvironment({
      ...productionEnvironment(),
      ...Object.fromEntries(variables.map((variable) => [variable, "forbidden"])),
    }),
    "TEST_DATABASE_URL",
  );
});

function developmentEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "development",
    NODE_ENV: "development",
    APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "local-synthetic",
  };
}

function testEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "test",
    NODE_ENV: "production",
    APP_RUNTIME_MODE: "test-database",
    AUTH_MODE: "database-test",
    VERCEL: "1",
    VERCEL_ENV: "preview",
  };
}

function productionEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "production",
    NODE_ENV: "production",
    APP_RUNTIME_MODE: "production-aws",
    AUTH_MODE: "cognito",
  };
}

function assertConfigurationError(action: () => unknown, variable: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof RuntimeEnvironmentConfigurationError);
    assert.equal(error.code, "RUNTIME_CONFIGURATION_INVALID");
    assert.equal(error.variable, variable);
    return true;
  });
}
