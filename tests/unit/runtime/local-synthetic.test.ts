import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LocalSyntheticConfigurationError,
  loadLocalSyntheticConfig,
} from "../../../lib/runtime/local-synthetic-config.ts";
import {
  checkLocalSyntheticReadiness,
  type LocalSyntheticReadinessProbes,
} from "../../../lib/runtime/local-synthetic-readiness.ts";

test("loads an explicit loopback-only local synthetic configuration", () => {
  const config = loadLocalSyntheticConfig(validEnvironment());

  assert.deepEqual(config, {
    mode: "local-synthetic",
    database: {
      connectionString:
        "postgresql://tianxing_app:tianxing-local-app-only@127.0.0.1:5432/tianxing",
    },
    dependencyTimeoutMs: 2000,
  });
});

test("fails closed when local mode is absent or used in production", () => {
  assertConfigurationError(
    () => loadLocalSyntheticConfig({ ...validEnvironment(), APP_RUNTIME_MODE: undefined }),
    "APP_RUNTIME_MODE",
  );
  assertConfigurationError(
    () => loadLocalSyntheticConfig({ ...validEnvironment(), NODE_ENV: "production" }),
    "NODE_ENV",
  );
});

test("rejects a remote local database endpoint", () => {
  const cases = [
    {
      variable: "LOCAL_SYNTHETIC_DATABASE_URL",
      value: "postgresql://tianxing_app:secret@database.example.test:5432/tianxing",
    },
  ] as const;

  for (const candidate of cases) {
    assertConfigurationError(
      () => loadLocalSyntheticConfig({ ...validEnvironment(), [candidate.variable]: candidate.value }),
      candidate.variable,
    );
  }
});

test("derives PostgreSQL readiness identities from the shared Release 1 fixture", async () => {
  const source = await readFile("lib/runtime/local-synthetic-readiness.ts", "utf8");

  assert.match(source, /from "\.\.\/\.\.\/scripts\/db\/neon-test-synthetic-fixture\.ts"/);
  assert.match(source, /NEON_TEST_ORGANIZATION/);
  assert.match(source, /NEON_TEST_PRINCIPALS/);
  assert.match(source, /NEON_TEST_STUDENTS/);
  assert.match(source, /RELEASE1_FOUNDER\.userId/);
  assert.doesNotMatch(source, /10000000-0000-4000-8000-000000000001/);
  assert.doesNotMatch(source, /20000000-0000-4000-8000-00000000010[12]/);
  assert.doesNotMatch(source, /@local\.invalid/);
});

test("reports all dependencies ready without exposing connection values", async () => {
  const report = await checkLocalSyntheticReadiness({
    environment: validEnvironment(),
    probes: probes(),
  });

  assert.deepEqual(report, {
    mode: "local-synthetic",
    status: "ready",
    dependencies: {
      postgresql: "ready",
      postgresql_identity: "ready",
      postgresql_application: "ready",
      document_transport: "ready",
    },
  });
  assert.equal(JSON.stringify(report).includes("tianxing-local-app-only"), false);
  assert.equal(JSON.stringify(report).includes("127.0.0.1"), false);
});

test("reports each unavailable dependency without throwing raw probe errors", async () => {
  const report = await checkLocalSyntheticReadiness({
    environment: validEnvironment(),
    probes: probes({
      postgresql: async () => {
        throw new Error("postgresql://secret");
      },
      identityPostgresql: async () => {
        throw new Error("identity detail");
      },
      applicationPostgresql: async () => {
        throw new Error("application detail");
      },
      documentTransport: async () => {
        throw new Error("scanner detail");
      },
    }),
  });

  assert.deepEqual(report, {
    mode: "local-synthetic",
    status: "not_ready",
    dependencies: {
      postgresql: "unavailable",
      postgresql_identity: "unavailable",
      postgresql_application: "unavailable",
      document_transport: "unavailable",
    },
  });
  assert.equal(JSON.stringify(report).includes("secret"), false);
  assert.equal(JSON.stringify(report).includes("scanner detail"), false);
});

function validEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "development",
    APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "database-test",
    NODE_ENV: "development",
    LOCAL_SYNTHETIC_DATABASE_URL:
      "postgresql://tianxing_app:tianxing-local-app-only@127.0.0.1:5432/tianxing",
    LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: "2000",
    DOCUMENT_TRANSPORT_MODE: "deterministic-fake",
    DOCUMENT_FAKE_REGION: "ap-east-1",
    DOCUMENT_FAKE_BUCKET: "tianxing-local-documents",
    DOCUMENT_FAKE_ORIGIN: "http://localhost:3000",
    DOCUMENT_FAKE_SIGNING_SECRET: "local-only-test-secret-at-least-32-characters",
    DOCUMENT_FAKE_ORGANIZATION_ID: "51000000-0000-4000-8000-000000000001",
    DOCUMENT_FAKE_WORKER_CONTEXT_ID: "10000000-0000-4000-8000-000000000901",
  };
}

function probes(
  overrides: Partial<LocalSyntheticReadinessProbes> = {},
): LocalSyntheticReadinessProbes {
  return {
    postgresql: async () => undefined,
    identityPostgresql: async () => undefined,
    applicationPostgresql: async () => undefined,
    documentTransport: async () => undefined,
    ...overrides,
  };
}

function assertConfigurationError(action: () => unknown, variable: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LocalSyntheticConfigurationError);
    assert.equal(error.variable, variable);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
}
