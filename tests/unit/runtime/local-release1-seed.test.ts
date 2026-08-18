import assert from "node:assert/strict";
import test from "node:test";

import {
  readLocalRelease1SeedTarget,
} from "../../../scripts/db/seed-local-release1.ts";

const ownerUrl = "postgresql://tianxing_migration:owner@127.0.0.1:5432/tianxing";
const applicationUrl = "postgresql://tianxing_app:tianxing-local-app-only@127.0.0.1:5432/tianxing";

test("accepts only the fixed local Release 1 application role", () => {
  assert.deepEqual(readLocalRelease1SeedTarget(environment()), {
    ownerConnectionString: ownerUrl,
    runtimeConnectionString: applicationUrl,
  });

  for (const invalid of [
    applicationUrl.replace("127.0.0.1", "database.example.test"),
    applicationUrl.replace("tianxing_app", "postgres"),
    applicationUrl.replace("tianxing-local-app-only", "other"),
  ]) {
    assert.throws(
      () => readLocalRelease1SeedTarget({
        ...environment(),
        LOCAL_SYNTHETIC_APPLICATION_DATABASE_URL: invalid,
      }),
      Error,
    );
  }
});

function environment(): Record<string, string> {
  return {
    APP_RUNTIME_MODE: "local-synthetic",
    NODE_ENV: "development",
    MIGRATION_DATABASE_URL: ownerUrl,
    LOCAL_SYNTHETIC_DATABASE_URL:
      "postgresql://tianxing_health:health@127.0.0.1:5432/tianxing",
    LOCAL_SYNTHETIC_IDENTITY_DATABASE_URL:
      "postgresql://tianxing_local_identity:identity@127.0.0.1:5432/tianxing",
    LOCAL_SYNTHETIC_APPLICATION_DATABASE_URL: applicationUrl,
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
