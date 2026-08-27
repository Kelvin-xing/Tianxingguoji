import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MIGRATION = "db/migrations/202608260030_039_expand_crm_case_assessment.sql";

test("P2-BE-03 is append-only and freezes approved CRM schema boundaries", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  assert.match(sql, /ADD COLUMN gender text/);
  assert.match(sql, /status IN \('active', 'pending_delete', 'deleted', 'purged'\)/);
  assert.match(sql, /legacy other guardian/);
  assert.match(sql, /'non_relative_guardian','other'/);
  assert.match(sql, /'customer_referral'.*'unknown'/s);
  assert.match(sql, /crm_students_open_case_check/);
  assert.match(sql, /crm_guardians_current_relationship_check/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON TABLE crm_duplicate_candidates/);
  assert.doesNotMatch(sql, /CREATE TABLE crm_(?:duplicate|deletion_request)/);
});

test("P2-BE-03 creates PrimaryAdvisor history and append-only Assessment revisions", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  assert.match(sql, /CREATE TABLE cases_primary_advisor_assignments/);
  assert.match(sql, /current_primary_advisor_assignment_id/);
  assert.match(sql, /cases_primary_advisor_assignments_one_current_idx/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /status IN \('draft', 'background_complete'\)/);
  assert.match(sql, /revision_number bigint/);
  assert.match(sql, /cases_assessment_answers_append_only_check/);
  assert.match(sql, /REVOKE UPDATE, DELETE ON TABLE cases_assessment_answers/);
  assert.doesNotMatch(sql, /CREATE TABLE cases_(?:school_targets|tasks|applications|interviews|documents)/);
});

test("P2-BE-03 manifest owns the exact migration digest", async () => {
  const [sql, manifestText] = await Promise.all([
    readFile(MIGRATION, "utf8"), readFile("db/migrations/manifest.json", "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as { migrations: Array<{ name: string; sha256: string }> };
  const name = MIGRATION.split("/").at(-1)!;
  const entry = manifest.migrations.find((migration) => migration.name === name);
  assert.ok(entry);
  assert.equal(entry.sha256,
    createHash("sha256").update(sql).digest("hex"));
});
