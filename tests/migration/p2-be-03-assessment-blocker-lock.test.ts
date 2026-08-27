import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("043 serializes blocker completion on Assessment without locking append-only answers", async () => {
  const sql = await readFile("db/migrations/202608260070_043_fix_assessment_blocker_append_only_lock.sql", "utf8");
  assert.match(sql, /FOR UPDATE OF assessment FOR SHARE OF manifest/);
  assert.match(sql, /cases_schema_manifest_fields[\s\S]*FOR SHARE/);
  assert.doesNotMatch(sql, /cases_assessment_answers[\s\S]*FOR UPDATE/);
  assert.doesNotMatch(sql, /GRANT UPDATE[\s\S]*cases_assessment_answers/);
  assert.match(sql, /LEFT JOIN LATERAL/);
  assert.match(sql, /ORDER BY revision\.revision_number DESC[\s\S]*LIMIT 1/);
  assert.doesNotMatch(sql, /answer\.id IS NULL/);
  assert.match(sql, /REVOKE ALL ON FUNCTION cases_lock_assessment_blockers/);
});
