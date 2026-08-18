import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = "db/migrations/202608180080_024_enable_case_stage_transition.sql";
const hardeningMigrationPath = "db/migrations/202608180090_025_harden_case_stage_transition.sql";
const evidenceBindingFixMigrationPath =
  "db/migrations/202608180100_026_fix_case_stage_transition_evidence_binding.sql";

test("keeps ServiceCase stage writes behind one tenant-bound database function", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /CREATE FUNCTION cases_apply_service_case_transition\(/);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = pg_catalog, public/s);
  assert.match(sql, /current_setting\('app\.organization_id', true\)/);
  assert.match(sql, /current_setting\('app\.actor_user_id', true\)/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /REVOKE UPDATE ON TABLE cases_service_cases FROM tianxing_app/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION cases_apply_service_case_transition\(/);
  assert.doesNotMatch(sql, /GRANT UPDATE ON TABLE cases_service_cases TO tianxing_app/);
});

test("adds append-only transition facts for only the accepted Phase 2C directions", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE cases_service_case_transition_facts/);
  assert.match(sql, /from_stage = 'signed' AND to_stage = 'background_collection'/);
  assert.match(sql, /from_stage = 'background_collection' AND to_stage = 'signed'/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON cases_service_case_transition_facts/);
  assert.match(sql, /GRANT SELECT ON TABLE cases_service_case_transition_facts TO tianxing_app/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE).*cases_service_case_transition_facts TO tianxing_app/);
});

test("rechecks primary ownership, completed assessment evidence, Founder rollback, and exact version", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /service_case\.record_version <> expected_record_version/);
  assert.match(sql, /service_case\.primary_user_id IS DISTINCT FROM actor_id/);
  assert.match(sql, /assessment\.status = 'background_complete'/);
  assert.match(sql, /manifest\.status = 'approved'/);
  assert.match(sql, /field\.blocking_stages \? 'background_complete'/);
  assert.match(sql, /actor_role <> 'founder'/);
  assert.match(sql, /transition_reason IS NULL OR btrim\(transition_reason\) = ''/);
});

test("hardens transition time, reason size, and concurrent authority reads", async () => {
  const sql = await readFile(hardeningMigrationPath, "utf8");

  assert.match(sql, /char_length\(reason\) <= 4000/);
  assert.match(sql, /transaction_timestamp\(\) - interval '5 minutes'/);
  assert.match(sql, /FOR SHARE OF role_binding, membership, organization, identity_user/g);
  assert.match(sql, /FOR SHARE OF assessment, manifest/);
  assert.match(sql, /cases_service_cases_stage_transition_guard_trg/);
  assert.match(sql, /REVOKE ALL ON FUNCTION cases_validate_service_case_stage_transition\(\) FROM PUBLIC/);
});

test("keeps assessment evidence variables distinct from SQL column names", async () => {
  const sql = await readFile(evidenceBindingFixMigrationPath, "utf8");

  assert.match(sql, /CREATE OR REPLACE FUNCTION cases_validate_service_case_stage_transition\(\)/);
  assert.match(sql, /bound_assessment_id uuid/);
  assert.match(sql, /bound_manifest_id uuid/);
  assert.match(sql, /answer\.assessment_id = bound_assessment_id/);
  assert.match(sql, /answer\.manifest_id = bound_manifest_id/);
  assert.match(sql, /field\.manifest_id = bound_manifest_id/);
  assert.doesNotMatch(sql, /\bassessment_id uuid;/);
  assert.doesNotMatch(sql, /\bmanifest_id uuid;/);
});
