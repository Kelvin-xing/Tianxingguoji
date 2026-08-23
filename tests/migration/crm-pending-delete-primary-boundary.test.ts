import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath =
  "db/migrations/202608230030_031_allow_pending_primary_guardian.sql";

test("replaces only the primary-contact predicate with readable Guardian lifecycle states", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
  assert.match(sql, /CREATE OR REPLACE FUNCTION crm_assert_student_primary_contact\(target_student_id uuid\)/);
  assert.match(sql, /guardian\.status IN \('active', 'pending_delete'\)/);
  assert.match(sql, /current_primary_count <> 1/);
  assert.match(sql, /CONSTRAINT = 'crm_students_current_primary_contact_check'/);
  assert.doesNotMatch(sql, /guardian\.status\s*=\s*'purged'/);
  assert.doesNotMatch(sql, /CREATE (?:CONSTRAINT )?TRIGGER|ALTER TABLE|CREATE POLICY|GRANT|REVOKE/);
});
