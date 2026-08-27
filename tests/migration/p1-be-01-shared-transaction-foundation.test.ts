import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath =
  "db/migrations/202608260010_037_expand_shared_actor_scope.sql";

test("migration 037 backfills legacy User receipts without rewriting migration 007", async () => {
  const [sql, original] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile("db/migrations/202608022530_007_expand_audit_outbox.sql", "utf8"),
  ]);

  assert.match(sql, /ADD COLUMN actor_kind text/);
  assert.match(sql, /ADD COLUMN actor_opaque_id text/);
  assert.match(sql, /SET actor_kind = 'user',[\s\S]*actor_opaque_id = actor_user_id::text/);
  assert.match(sql, /ALTER COLUMN actor_user_id DROP NOT NULL/);
  assert.match(original, /actor_user_id uuid NOT NULL/);
  assert.doesNotMatch(original, /actor_opaque_id/);
});

test("migration 037 scopes actors by kind and opaque identifier", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /actor_kind IN \('user', 'portal', 'worker', 'system'\)/);
  assert.match(sql, /UNIQUE \(\s*organization_id,\s*actor_kind,\s*actor_opaque_id,\s*operation,\s*idempotency_key\s*\)/);
  assert.match(sql, /shared_idempotency_records_legacy_user_scope_key UNIQUE \(\s*organization_id,\s*actor_user_id,\s*operation,\s*idempotency_key/);
  assert.match(sql, /actor_kind = 'user' AND actor_user_id IS NOT NULL[\s\S]*actor_opaque_id = actor_user_id::text/);
  assert.match(sql, /actor_kind IN \('portal', 'worker', 'system'\) AND actor_user_id IS NULL/);
  assert.match(sql, /legacy_user_scope_key UNIQUE/);
  assert.match(sql, /NEW\.actor_kind := 'user'/);
  assert.match(sql, /NEW\.actor_opaque_id := NEW\.actor_user_id::text/);
});

test("migration 037 freezes scope and terminal records and denies deletion", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const field of ["actor_user_id", "actor_kind", "actor_opaque_id", "operation",
    "idempotency_key", "request_hash", "created_at"]) {
    assert.match(sql, new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`));
  }
  assert.match(sql, /OLD\.state <> 'in_progress' OR NEW\.state NOT IN \('completed', 'failed'\)/);
  assert.match(sql, /BEFORE DELETE ON shared_idempotency_records/);
  assert.match(sql, /BEFORE TRUNCATE ON shared_idempotency_records/);
  assert.match(sql, /CONSTRAINT = 'shared_idempotency_records_append_only'/);
  assert.match(sql, /REVOKE ALL ON TABLE shared_idempotency_records FROM tianxing_app/);
});

test("migration 037 reasserts FORCE RLS and the canonical tenant policy", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /ALTER TABLE shared_idempotency_records FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE shared_idempotency_records TO tianxing_app/);
  assert.match(sql, /CREATE POLICY tianxing_tenant_boundary ON shared_idempotency_records[\s\S]*FOR ALL TO tianxing_app/);
  assert.match(sql, /USING \(organization_id::text = current_setting\('app\.organization_id', true\)\)/);
  assert.match(sql, /WITH CHECK \(organization_id::text = current_setting\('app\.organization_id', true\)\)/);
});
