import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PATH = "db/migrations/202608230030_032_expand_case_referral_source_assignments.sql";
const CORRECTIVE_PATH = "db/migrations/202608260100_046_align_referral_source_deactivation_reason.sql";

test("CRM-06 migration freezes tenant history, one current row, RLS, and controlled close", async () => {
  const sql = await readFile(PATH, "utf8");
  assert.match(sql, /CREATE TABLE cases_case_referral_source_assignments/);
  assert.match(sql, /FOREIGN KEY \(case_id, organization_id\)[\s\S]*REFERENCES cases_service_cases/);
  assert.match(sql, /FOREIGN KEY \(referral_source_id, organization_id\)[\s\S]*REFERENCES crm_referral_sources/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /CREATE UNIQUE INDEX cases_case_referral_source_assignments_one_current_idx[\s\S]*WHERE ends_at IS NULL/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /OLD\.ends_at IS NOT NULL/);
  assert.match(sql, /NEW\.ended_by_assignment_id IS NULL/);
  assert.match(sql, /TG_OP = 'DELETE'/);
  assert.match(sql, /GRANT UPDATE \(ends_at, ended_by_assignment_id, record_version, updated_at\)/);
  assert.doesNotMatch(sql, /GRANT UPDATE ON TABLE cases_case_referral_source_assignments/);
  assert.doesNotMatch(sql, /GRANT (?:ALL|DELETE)/);
});

test("CRM-06 corrective migration freezes canonical deactivation fields", async () => {
  const sql = await readFile(CORRECTIVE_PATH, "utf8");
  assert.match(sql, /RENAME COLUMN deactivation_reason TO deactivate_reason_code/);
  assert.match(sql, /deactivated_at/);
  assert.match(sql, /deactivated_by_user_id/);
  assert.match(sql, /deactivate_reason_code/);
  assert.doesNotMatch(sql, /ADD COLUMN deactivation_reason/);
});
