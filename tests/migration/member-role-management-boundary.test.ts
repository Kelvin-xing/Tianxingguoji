import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("053 hardens profile eligibility, role history and the final Founder", async () => {
  const sql = await readFile(
    "db/migrations/202608280020_053_harden_member_role_management.sql",
    "utf8",
  );
  assert.match(sql, /access_employee_profiles_employment_type_roles_check/);
  assert.match(sql, /access_role_bindings_identity_immutable_check/);
  assert.match(sql, /access_role_bindings_status_transition_check/);
  assert.match(sql, /access_role_bindings_version_check/);
  assert.match(sql, /access_role_bindings_last_founder_check/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /BEFORE INSERT OR UPDATE ON access_employee_profiles/);
  assert.match(sql, /BEFORE INSERT OR UPDATE ON access_role_bindings/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM access_/i);
});

test("054 keeps database-test Identity compatible with active role unions", async () => {
  const sql = await readFile(
    "db/migrations/202608290010_054_support_multi_role_identity_sessions.sql",
    "utf8",
  );
  assert.match(sql, /CREATE OR REPLACE FUNCTION identity_database_test_complete_login/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION identity_database_test_resolve_session/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION identity_database_test_provision_credential/);
  assert.match(sql, /IF v_role_count < 1 THEN/);
  assert.match(sql, /WHEN 'founder' THEN 1[\s\S]*WHEN 'contractor' THEN 4/);
  assert.doesNotMatch(sql, /v_role_count <> 1/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM access_/i);
});
