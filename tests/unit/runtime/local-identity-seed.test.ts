import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalIdentitySeedSafetyError,
  readLocalIdentitySeedTarget,
} from "../../../scripts/db/seed-local-identity.ts";

const OWNER_URL =
  "postgresql://tianxing_migration:tianxing-local-migration-only@127.0.0.1:5432/tianxing";
const IDENTITY_URL =
  "postgresql://tianxing_local_identity:tianxing-local-identity-only@127.0.0.1:5432/tianxing";

test("accepts only matching fixed local owner and identity targets", () => {
  assert.deepEqual(readLocalIdentitySeedTarget(environment()), {
    ownerConnectionString: OWNER_URL,
    runtimeConnectionString: IDENTITY_URL,
  });

  for (const identityUrl of [
    IDENTITY_URL.replace("127.0.0.1", "database.example.test"),
    IDENTITY_URL.replace("tianxing_local_identity", "tianxing_app"),
    IDENTITY_URL.replace("tianxing-local-identity-only", "different-password"),
    IDENTITY_URL.replace("/tianxing", "/postgres"),
  ]) {
    assert.throws(
      () => readLocalIdentitySeedTarget(environment({
        LOCAL_SYNTHETIC_IDENTITY_DATABASE_URL: identityUrl,
      })),
      (error: unknown) => error instanceof Error &&
        (error.name === "LocalSyntheticConfigurationError" ||
          error instanceof LocalIdentitySeedSafetyError) &&
        !error.message.includes("different-password"),
    );
  }
});

function environment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    APP_ENV: "development",
    APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "local-synthetic",
    NODE_ENV: "development",
    MIGRATION_DATABASE_URL: OWNER_URL,
    LOCAL_SYNTHETIC_DATABASE_URL:
      "postgresql://tianxing_health:tianxing-local-health-only@127.0.0.1:5432/tianxing",
    LOCAL_SYNTHETIC_IDENTITY_DATABASE_URL: IDENTITY_URL,
    LOCAL_SYNTHETIC_APPLICATION_DATABASE_URL:
      "postgresql://tianxing_app:tianxing-local-app-only@127.0.0.1:5432/tianxing",
    LOCAL_SYNTHETIC_LOCALSTACK_ENDPOINT: "http://127.0.0.1:4566",
    LOCAL_SYNTHETIC_AWS_REGION: "ap-east-1",
    LOCAL_SYNTHETIC_S3_BUCKET: "tianxing-local-documents",
    LOCAL_SYNTHETIC_SQS_QUEUE: "tianxing-local-document-scan",
    LOCAL_SYNTHETIC_SQS_DLQ: "tianxing-local-document-scan-dlq",
    LOCAL_SYNTHETIC_CLAMAV_HOST: "127.0.0.1",
    LOCAL_SYNTHETIC_CLAMAV_PORT: "3310",
    LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: "2000",
    ...overrides,
  };
}
