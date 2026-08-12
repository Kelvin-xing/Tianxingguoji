import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../db/migrations/202608120030_015_expand_case_reconstruction.sql", import.meta.url);

test("reconstruction migration keeps aggregate/version, tenant, ordering, review and append-only invariants", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  for (const table of [
    "cases_reconstructions",
    "cases_reconstruction_versions",
    "cases_reconstruction_events",
    "cases_reconstruction_gaps",
    "cases_reconstruction_activations",
    "cases_reconstruction_idempotency",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`));
  }
  assert.match(sql, /service_case_id uuid,\s+pilot_reference/);
  assert.match(sql, /state <> 'activated' OR service_case_id IS NOT NULL/);
  assert.match(sql, /UNIQUE \(organization_id, pilot_reference\)/);
  assert.match(sql, /UNIQUE \(organization_id, reconstruction_id, version_no\)/);
  assert.match(sql, /occurred_at <= recorded_at/);
  assert.match(sql, /UNIQUE \(organization_id, reconstruction_version_id, occurred_at, sequence_no\)/);
  assert.match(sql, /reviewer_user_id IS NULL OR reviewer_user_id <> recorder_user_id/);
  assert.match(sql, /FOREIGN KEY \(correction_of_event_id, organization_id\)/);
  assert.match(sql, /REFERENCES cases_reconstruction_events \(id, organization_id\)/);
  assert.match(sql, /REFERENCES cases_service_cases \(id, organization_id\)/);
  assert.match(sql, /REFERENCES audit_events \(id, organization_id\)/);
  assert.match(sql, /REFERENCES audit_outbox \(id, organization_id\)/);
  assert.match(sql, /cases_reconstruction_no_correction_chain/);
});

test("idempotency schema represents scoped receipt states without replacing P3-19 authority", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /organization_id, actor_user_id, command_type, aggregate_id, pilot_reference/);
  assert.match(sql, /expected_record_version, idempotency_key/);
  assert.match(
    sql,
    /CONSTRAINT cases_reconstruction_idempotency_scope_key UNIQUE NULLS NOT DISTINCT \(\s*organization_id,\s*actor_user_id,\s*command_type,\s*aggregate_id,\s*pilot_reference,\s*expected_record_version,\s*idempotency_key\s*\)/s,
  );
  assert.match(sql, /state IN \('in_progress', 'completed', 'failed_reconcilable'\)/);
  assert.match(sql, /request_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.doesNotMatch(sql, /CREATE TABLE .*pilot_approval/i);
  assert.doesNotMatch(sql, /INSERT INTO/i);
  assert.doesNotMatch(sql, /evidence_(?:body|content|text)/i);
  assert.doesNotMatch(sql, /GRANT /i);
  assert.match(sql, /P3-19 remains the approval authority/);
});

test("correction trigger rejects targets outside the aggregate activated version", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /SELECT reconstruction_version_id, correction_of_event_id\s+INTO target_version_id, target_correction_id/);
  assert.match(sql, /SELECT reconstruction\.activated_version_id\s+INTO parent_activated_version_id/);
  assert.match(sql, /target_version_id IS DISTINCT FROM parent_activated_version_id/);
  assert.match(sql, /cases_reconstruction_correction_target_activated_version/);
});
