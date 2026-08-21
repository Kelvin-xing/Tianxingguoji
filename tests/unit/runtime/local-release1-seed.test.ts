import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LOCAL_RELEASE1_SCHOOLS,
  readLocalRelease1SeedTarget,
} from "../../../scripts/db/seed-local-release1.ts";
import { sha256SchoolValue } from "../../../modules/schools/public.ts";

const ownerUrl = "postgresql://tianxing_app:tianxing-local-app-only@127.0.0.1:5432/tianxing";
const applicationUrl = "postgresql://tianxing_app:tianxing-local-app-only@127.0.0.1:5432/tianxing";

test("uses the same canonical one-role URL for baseline owner and runtime", () => {
  assert.deepEqual(readLocalRelease1SeedTarget(environment()), {
    ownerConnectionString: ownerUrl,
    runtimeConnectionString: applicationUrl,
  });
});

test("requires the one-role baseline marker and never alters a database role", async () => {
  const source = await readFile("scripts/db/seed-local-release1.ts", "utf8");
  assert.match(source, /ONE_ROLE_MARKER_SCHEMA/);
  assert.doesNotMatch(source, /CREATE\s+ROLE|ALTER\s+ROLE|pg_has_role/i);
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
    APP_ENV: "development",
    APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "database-test",
    NODE_ENV: "development",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "tianxing",
    ONE_ROLE_BASELINE_DATABASE_URL: ownerUrl,
    LOCAL_SYNTHETIC_DATABASE_URL:
      applicationUrl,
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
