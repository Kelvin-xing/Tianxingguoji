import assert from "node:assert/strict";
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
        "postgresql://tianxing_health:tianxing-local-health-only@127.0.0.1:5432/tianxing",
      identityConnectionString:
        "postgresql://tianxing_local_identity:tianxing-local-identity-only@127.0.0.1:5432/tianxing",
    },
    localstack: {
      endpoint: "http://127.0.0.1:4566",
      region: "ap-east-1",
      bucket: "tianxing-local-documents",
      queue: "tianxing-local-document-scan",
      deadLetterQueue: "tianxing-local-document-scan-dlq",
    },
    clamav: { host: "127.0.0.1", port: 3310 },
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

test("rejects remote database, LocalStack, and ClamAV endpoints", () => {
  const cases = [
    {
      variable: "LOCAL_SYNTHETIC_DATABASE_URL",
      value: "postgresql://tianxing_health:secret@database.example.test:5432/tianxing",
    },
    {
      variable: "LOCAL_SYNTHETIC_IDENTITY_DATABASE_URL",
      value: "postgresql://tianxing_local_identity:secret@database.example.test:5432/tianxing",
    },
    {
      variable: "LOCAL_SYNTHETIC_LOCALSTACK_ENDPOINT",
      value: "https://localstack.example.test:4566",
    },
    {
      variable: "LOCAL_SYNTHETIC_CLAMAV_HOST",
      value: "scanner.example.test",
    },
  ] as const;

  for (const candidate of cases) {
    assertConfigurationError(
      () => loadLocalSyntheticConfig({ ...validEnvironment(), [candidate.variable]: candidate.value }),
      candidate.variable,
    );
  }
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
      localstack_s3: "ready",
      localstack_sqs: "ready",
      clamav: "ready",
    },
  });
  assert.equal(JSON.stringify(report).includes("tianxing-local-health-only"), false);
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
      localstack: async () => ({ s3: true, sqs: false }),
      clamav: async () => {
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
      localstack_s3: "ready",
      localstack_sqs: "unavailable",
      clamav: "unavailable",
    },
  });
  assert.equal(JSON.stringify(report).includes("secret"), false);
  assert.equal(JSON.stringify(report).includes("scanner detail"), false);
});

function validEnvironment(): Record<string, string | undefined> {
  return {
    APP_RUNTIME_MODE: "local-synthetic",
    NODE_ENV: "development",
    LOCAL_SYNTHETIC_DATABASE_URL:
      "postgresql://tianxing_health:tianxing-local-health-only@127.0.0.1:5432/tianxing",
    LOCAL_SYNTHETIC_IDENTITY_DATABASE_URL:
      "postgresql://tianxing_local_identity:tianxing-local-identity-only@127.0.0.1:5432/tianxing",
    LOCAL_SYNTHETIC_LOCALSTACK_ENDPOINT: "http://127.0.0.1:4566",
    LOCAL_SYNTHETIC_AWS_REGION: "ap-east-1",
    LOCAL_SYNTHETIC_S3_BUCKET: "tianxing-local-documents",
    LOCAL_SYNTHETIC_SQS_QUEUE: "tianxing-local-document-scan",
    LOCAL_SYNTHETIC_SQS_DLQ: "tianxing-local-document-scan-dlq",
    LOCAL_SYNTHETIC_CLAMAV_HOST: "127.0.0.1",
    LOCAL_SYNTHETIC_CLAMAV_PORT: "3310",
    LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: "2000",
  };
}

function probes(
  overrides: Partial<LocalSyntheticReadinessProbes> = {},
): LocalSyntheticReadinessProbes {
  return {
    postgresql: async () => undefined,
    identityPostgresql: async () => undefined,
    localstack: async () => ({ s3: true, sqs: true }),
    clamav: async () => undefined,
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
