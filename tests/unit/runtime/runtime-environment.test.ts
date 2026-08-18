import assert from "node:assert/strict";
import test from "node:test";

import {
  loadRuntimeEnvironment,
  RuntimeEnvironmentConfigurationError,
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

test("treats Vercel as hosting metadata and rejects privileged URLs in test Web runtime", () => {
  assertConfigurationError(
    () => loadRuntimeEnvironment({ ...testEnvironment(), VERCEL_ENV: "development" }),
    "VERCEL_ENV",
  );
  assertConfigurationError(
    () => loadRuntimeEnvironment({ ...productionEnvironment(), VERCEL: "1" }),
    "VERCEL",
  );
  for (const variable of [
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "TEST_MIGRATION_DATABASE_URL",
    "TEST_PROVISION_DATABASE_URL",
    "LOCAL_SYNTHETIC_DATABASE_URL",
  ]) {
    assertConfigurationError(
      () => loadRuntimeEnvironment({ ...testEnvironment(), [variable]: "forbidden" }),
      variable,
    );
  }
});

test("rejects test database URLs in production with deterministic variable attribution", () => {
  const variables = [
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
    "TEST_IDENTITY_DATABASE_URL",
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
