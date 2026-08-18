import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LOCAL_RELEASE1_SCHOOLS,
  readLocalRelease1SeedTarget,
} from "../../../scripts/db/seed-local-release1.ts";
import { sha256SchoolValue } from "../../../modules/schools/public.ts";

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

test("defines exactly three deterministic synthetic schools without crawler input", () => {
  assert.equal(LOCAL_RELEASE1_SCHOOLS.length, 3);
  assert.equal(new Set(LOCAL_RELEASE1_SCHOOLS.map(({ id }) => id)).size, 3);
  assert.equal(new Set(LOCAL_RELEASE1_SCHOOLS.map(({ sourceSchoolKey }) => sourceSchoolKey)).size, 3);
  for (const school of LOCAL_RELEASE1_SCHOOLS) {
    assert.match(school.id, /^[0-9a-f-]{36}$/);
    assert.match(school.fields.official_website, /^https:\/\/synthetic-school-00[1-3]\.local\.invalid$/);
    assert.equal(school.recordSha256, sha256SchoolValue({
      sourceSchoolKey: school.sourceSchoolKey,
      fields: school.fields,
      provenance: school.provenance,
    }));
  }
});

test("seed verification compares both school and snapshot-record source keys", async () => {
  const source = await readFile("scripts/db/seed-local-release1.ts", "utf8");

  assert.match(source, /school\.source_school_key AS school_source_school_key/);
  assert.match(source, /record\.source_school_key AS record_source_school_key/);
  assert.match(source, /row\.school_source_school_key !== school\.sourceSchoolKey/);
  assert.match(source, /row\.record_source_school_key !== school\.sourceSchoolKey/);
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
