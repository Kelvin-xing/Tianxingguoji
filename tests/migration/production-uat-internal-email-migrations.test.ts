import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL(
  "../../scripts/db/apply-production-uat-internal-email-migrations.ts",
  import.meta.url,
);

test("Production UAT applies internal-email prerequisites and migrations transactionally", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.match(script, /process\.env\.VERCEL_ENV !== "production"/);
  assert.match(script, /process\.argv\[2\] === "--dry-run"/);
  assert.match(script, /TEST_DATABASE_URL/);
  assert.match(script, /TEST_DATABASE_EXPECTED_NAME/);
  assert.match(script, /ONE_ROLE_BASELINE_DATABASE_URL/);
  assert.match(script, /ONE_ROLE_BASELINE_EXPECTED_DATABASE/);
  assert.match(script, /EXPECTED_APPLICATION_USER = "tianxing_app"/);
  assert.match(script, /202608260020_038_expand_identity_access_boundaries\.sql/);
  assert.match(script, /202608280020_053_harden_member_role_management\.sql/);
  assert.match(script, /202608290010_054_support_multi_role_identity_sessions\.sql/);
  assert.match(script, /202609070010_055_internal_email_identity\.sql/);
  assert.match(script, /202609080010_056_email_provider_settings\.sql/);
  assert.match(script, /202609080020_057_email_invitation_template\.sql/);
  assert.match(script, /await client\.query\("BEGIN"\)/);
  assert.match(script, /pg_advisory_xact_lock/);
  assert.match(script, /await client\.query\(dryRun \? "ROLLBACK" : "COMMIT"\)/);
  assert.match(script, /await client\.query\("ROLLBACK"\)/);
  assert.match(script, /assertNoPartialFeatures/);
  assert.match(script, /serializeFeatureState/);
  assert.match(script, /backfillEmployeeProfiles/);
  assert.match(script, /relaxIdentityAccessRlsForMigration/);
  assert.match(script, /restoreIdentityAccessRlsAfterMigration/);
  assert.match(script, /status=\$\{dryRun \? "verified" : "ready"\} applied=/);
  assert.doesNotMatch(script, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(script, /LOCAL_SYNTHETIC_DATABASE_URL/);
});
