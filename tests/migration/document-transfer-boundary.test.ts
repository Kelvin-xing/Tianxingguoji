import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE = "db/migrations/202608240010_035_harden_document_upload_scan_download.sql";
const GENERATED =
  "db/baselines/one-role/generated/034_202608240010_035_harden_document_upload_scan_download.sql";

test("migration 035 freezes upload generation, exact scan facts, and bounded attempts", async () => {
  const sql = await readFile(SOURCE, "utf8");

  for (const constraint of [
    "documents_documents_doc02_active_pointer_preflight",
    "documents_document_versions_doc02_size_preflight",
    "documents_document_versions_doc02_content_type_preflight",
    "documents_document_versions_doc02_provider_version_preflight",
    "documents_scan_results_doc02_object_preflight",
    "documents_scan_results_doc02_attempt_preflight",
    "documents_scan_results_doc02_semantics_preflight",
    "documents_document_versions_doc02_scan_preflight",
    "documents_document_versions_doc02_inflight_preflight",
    "documents_scan_results_doc02_backfill_preflight",
  ]) {
    assert.match(sql, new RegExp(constraint, "u"));
  }

  assert.match(sql, /ADD COLUMN upload_generation bigint/);
  assert.match(sql, /row_number\(\) OVER \([\s\S]*PARTITION BY organization_id,document_id/);
  assert.match(sql, /GREATEST\(version\.updated_at,transaction_timestamp\(\)\)/);
  assert.match(sql, /GREATEST\(scan\.updated_at,transaction_timestamp\(\)\)/);
  assert.match(sql, /documents_document_versions_generation_key UNIQUE/);
  assert.match(sql, /documents_document_versions_one_in_flight_idx/);
  assert.match(sql, /'abandoned'/);
  assert.match(sql, /state = 'abandoned' AND object_version_id IS NULL/);
  assert.match(sql, /OLD\.state = 'pending_upload' AND NEW\.state = 'abandoned'/);
  assert.match(sql, /documents_document_versions_abandoned_immutable_check/);
  assert.match(sql, /documents_document_versions_abandoned_unbound_check/);
  assert.match(sql, /upload_generation IS DISTINCT FROM expected_upload_generation/);
  assert.match(sql, /documents_document_versions_initial_state_check/);
  assert.match(sql, /NEW\.record_version <> 1/);
  assert.match(sql, /NEW\.revoked_at IS NOT NULL/);
  assert.match(sql, /NEW\.created_at IS DISTINCT FROM transaction_timestamp\(\)/);

  assert.match(sql, /length\(object_version_id\) BETWEEN 1 AND 1024/);
  assert.match(sql, /scan\.scan_policy_version='clamav-release1-v1'/);
  assert.match(sql, /scan\.object_bucket=NEW\.object_bucket/);
  assert.match(sql, /scan\.object_key=NEW\.object_key/);
  assert.match(sql, /scan\.object_version_id=NEW\.object_version_id/);
  assert.match(sql, /attempt_count BETWEEN 0 AND 3/);
  assert.match(sql, /OLD\.attempt_count >= 3/);
  assert.match(sql, /NEW\.attempt_count <> OLD\.attempt_count \+ 1/);
  assert.match(sql, /NEW\.engine IS DISTINCT FROM 'clamav-release1'/);
  assert.match(sql, /documents_scan_results_same_state_semantics_check/);
  assert.match(sql, /documents_document_versions_stale_retry_check/);
  assert.match(sql, /documents_document_versions_stale_activation_check/);
});

test("migration 035 closes scan and active-pointer state at commit", async () => {
  const sql = await readFile(SOURCE, "utf8");

  assert.match(sql, /CREATE FUNCTION documents_validate_scan_lifecycle_commit\(\)/);
  assert.match(sql, /documents_document_versions_scan_lifecycle_commit_check/);
  assert.match(sql, /documents_scan_results_version_lifecycle_commit_check/);
  assert.match(sql, /documents_document_versions_stale_generation_commit_check/);
  assert.match(sql, /CREATE FUNCTION documents_validate_active_pointer_commit\(\)/);
  assert.match(sql, /documents_documents_active_version_commit_check/);
  assert.match(sql, /documents_document_versions_active_pointer_commit_check/);
  assert.equal((sql.match(/DEFERRABLE INITIALLY DEFERRED/gu) ?? []).length, 4);
  assert.match(sql, /FOR UPDATE/);
});

test("migration 035 fixes function search paths and grants only explicit document access", async () => {
  const sql = await readFile(SOURCE, "utf8");

  assert.equal((sql.match(/SET search_path = pg_catalog, public/gu) ?? []).length >= 7, true);
  for (const name of [
    "documents_validate_version_write",
    "documents_validate_scan_result_write",
    "documents_validate_active_pointer_commit",
    "documents_validate_scan_lifecycle_commit",
    "documents_assert_active_founder",
    "documents_reject_immutable_delete",
    "documents_validate_document_write",
  ]) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${name}\\(`, "u"));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION ${name}\\(`, "u"));
  }
  for (const table of [
    "documents_documents",
    "documents_document_versions",
    "documents_scan_results",
  ]) {
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`, "u"));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, "u"));
  }
  assert.doesNotMatch(sql, /DISABLE ROW LEVEL SECURITY|ALTER ROLE|GRANT ALL/i);
});

test("generated baseline carries the exact migration 035 hardening contract", async () => {
  const sql = await readFile(GENERATED, "utf8");
  assert.match(sql, /documents_document_versions_doc02_size_preflight/);
  assert.match(sql, /documents_document_versions_generation_key/);
  assert.match(sql, /documents_scan_results_exact_object_check/);
  assert.match(sql, /documents_document_versions_scan_lifecycle_commit_check/);
  assert.match(sql, /documents_documents_active_version_commit_check/);
});
