import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(
  new URL("../../scripts/db/apply-production-uat-migration-052.ts", import.meta.url),
  "utf8",
);

test("Production UAT migration is production-only and pins the exact target", () => {
  assert.match(script, /process\.env\.VERCEL_ENV !== "production"/);
  assert.match(script, /TEST_DATABASE_EXPECTED_NAME/);
  assert.match(script, /EXPECTED_APPLICATION_USER = "tianxing_app"/);
  assert.match(script, /202608280010_052_complete_application_task_delivery\.sql/);
});

test("Production UAT migration is locked, transactional and postflight verified", () => {
  assert.match(script, /ssl: \{ rejectUnauthorized: true \}/);
  assert.match(script, /pg_advisory_xact_lock/);
  assert.match(script, /CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public/);
  assert.match(script, /await client\.query\("BEGIN"\)/);
  assert.match(script, /await client\.query\("COMMIT"\)/);
  assert.match(script, /v2_function !== preflight\.deadline_column/);
  assert.match(script, /postflight\.v2_function/);
  assert.match(script, /postflight\.deadline_column/);
  assert.match(script, /postflight\.v2_trigger/);
  assert.match(script, /installed\.v2_owner !== installed\.v1_owner/);
  assert.match(script, /ALTER FUNCTION \$\{V2_FUNCTION\} OWNER TO/);
  assert.match(script, /postflight\.v2_executable/);
  assert.match(script, /postflight\.v2_owner !== postflight\.v1_owner/);
  assert.match(script, /GRANT SELECT, INSERT ON TABLE public\.cases_candidate_school_list_versions/);
  assert.match(script, /GRANT UPDATE \(status,submitted_at,founder_decision/);
  assert.match(script, /GRANT SELECT, INSERT ON TABLE public\.cases_candidate_school_list_items/);
  assert.match(script, /GRANT INSERT ON TABLE public\.cases_school_targets/);
});

test("Production UAT migration never logs connection material", () => {
  assert.doesNotMatch(script, /console\.(?:log|error)\([^\n]*(?:connectionString|TEST_DATABASE_URL)/);
});
