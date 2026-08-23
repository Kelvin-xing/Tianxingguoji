import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE = "db/migrations/202608230050_034_complete_case_document_registration.sql";

test("migration 034 fails closed for legacy documents and freezes registration metadata", async () => {
  const sql = await readFile(SOURCE, "utf8");
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM public\.documents_documents\)/);
  assert.match(sql, /documents_documents_registration_metadata_migration_required/);
  assert.match(sql, /ADD COLUMN display_name text NOT NULL/);
  assert.match(sql, /char_length\(display_name\) BETWEEN 1 AND 200/);
  assert.match(sql, /owner_kind <> 'case'/);
  assert.match(sql, /identity_and_case_evidence/);
  assert.match(sql, /operational_attachment/);
  assert.match(sql, /documents_registration_metadata_immutable_trg/);
  assert.match(sql, /NEW\.display_name IS DISTINCT FROM OLD\.display_name/);
  assert.match(sql, /NEW\.classification IS DISTINCT FROM OLD\.classification/);
  assert.match(sql, /SET search_path = pg_catalog, public/);
  assert.doesNotMatch(sql, /INSERT INTO documents_document_versions|INSERT INTO documents_scan_results/i);
  assert.doesNotMatch(sql, /ALTER ROLE|DISABLE ROW LEVEL SECURITY|DROP TABLE/i);
});

test("generated baseline contains migration 034 without changing its safety contract", async () => {
  const sql = await readFile(
    "db/baselines/one-role/generated/033_202608230050_034_complete_case_document_registration.sql",
    "utf8",
  );
  assert.match(sql, /documents_documents_registration_metadata_migration_required/);
  assert.match(sql, /documents_registration_metadata_immutable_trg/);
});
