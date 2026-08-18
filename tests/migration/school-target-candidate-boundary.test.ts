import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = "db/migrations/202608180110_027_enable_candidate_school_target.sql";

test("puts candidate SchoolTarget creation behind one tenant-bound function", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /CREATE FUNCTION cases_create_candidate_school_target\(/);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = pg_catalog, public/s);
  assert.match(sql, /current_setting\('app\.organization_id', true\)/);
  assert.match(sql, /current_setting\('app\.actor_user_id', true\)/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /FOR SHARE OF role_binding, membership, organization, identity_user/);
  assert.match(sql, /role_binding\.role = 'advisor'/);
  assert.match(sql, /service_case\.primary_user_id = actor_id/);
  assert.match(sql, /service_case\.stage <> 'background_collection'/);
});

test("copies intake and admission from ServiceCase and fixes candidate state", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /service_case\.intake_year/);
  assert.match(sql, /service_case\.admission_type/);
  assert.match(sql, /'candidate', p_resolved_revision_id/);
  assert.doesNotMatch(sql, /p_intake_year|p_admission_type/);
  assert.doesNotMatch(sql, /CREATE TABLE/i);
});

test("revokes direct target insertion and grants only the protected function", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /REVOKE INSERT ON TABLE cases_school_targets FROM tianxing_app/);
  assert.match(sql, /REVOKE ALL ON FUNCTION cases_create_candidate_school_target\([\s\S]*FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION cases_create_candidate_school_target\([\s\S]*TO tianxing_app/);
  assert.doesNotMatch(sql, /GRANT INSERT ON TABLE cases_school_targets TO tianxing_app/);
});
