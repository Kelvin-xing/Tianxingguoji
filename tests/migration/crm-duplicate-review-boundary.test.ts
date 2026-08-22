import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = "db/migrations/202608230020_030_expand_crm_duplicate_review.sql";

test("creates the five tenant-scoped CRM duplicate review tables with FORCE RLS", async () => {
  const sql = await readFile(migrationPath, "utf8");
  for (const table of ["crm_duplicate_candidates", "crm_duplicate_merges",
    "crm_duplicate_alias_revisions", "crm_duplicate_field_provenance_revisions",
    "crm_duplicate_merge_corrections"]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`organization_id = nullif\\(current_setting\\('app\\.organization_id', true\\)`));
  }
});

test("stores only canonical signal names and preserves every revision and decision row", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /matching_signals text\[\] NOT NULL/);
  assert.match(sql, /matching_signals <@ ARRAY\['display_name','date_of_birth','email','phone'\]/);
  for (const trigger of ["crm_duplicate_candidates_delete_trg", "crm_duplicate_merges_delete_trg",
    "crm_duplicate_alias_append_only_trg", "crm_duplicate_provenance_append_only_trg",
    "crm_duplicate_corrections_append_only_trg"]) assert.match(sql, new RegExp(trigger));
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE[^;]*crm_duplicate_/i);
});

test("keeps merge and correction transitions constrained and function execution non-public", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /reason_code = 'duplicate\.confirmed'/);
  assert.match(sql, /reason_code = 'duplicate\.merge\.corrected'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION crm_validate_duplicate_candidate_write\(\) FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON FUNCTION crm_validate_duplicate_merge_write\(\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION crm_reject_duplicate_revision_change\(\) TO tianxing_app/);
});
