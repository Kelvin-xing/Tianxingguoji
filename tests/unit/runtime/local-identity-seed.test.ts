import assert from "node:assert/strict";
import test from "node:test";

import {
  readLocalIdentitySeedTarget,
} from "../../../scripts/db/seed-local-identity.ts";

test("uses the same canonical one-role URL for owner and runtime seed work", () => {
  assert.deepEqual(readLocalIdentitySeedTarget(environment()), {
    ownerConnectionString: LOCAL_URL,
    runtimeConnectionString: LOCAL_URL,
  });
});

test("local identity seed requires the baseline marker and creates no database role", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile("scripts/db/seed-local-identity.ts", "utf8"));
  assert.match(source, /ONE_ROLE_MARKER_SCHEMA/);
  assert.doesNotMatch(source, /CREATE\s+ROLE|ALTER\s+ROLE|pg_has_role/i);
});

const LOCAL_URL =
  "postgresql://tianxing_app:tianxing-local-app-only@127.0.0.1:5432/tianxing";

function environment(): Record<string, string> {
  return {
    APP_ENV: "development",
    NODE_ENV: "development",
    APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "local-synthetic",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "tianxing",
    ONE_ROLE_BASELINE_DATABASE_URL: LOCAL_URL,
    LOCAL_SYNTHETIC_DATABASE_URL: LOCAL_URL,
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
