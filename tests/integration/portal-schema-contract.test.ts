import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../db/migrations/202608130010_011_expand_external_portal_access.sql",
  import.meta.url,
);

test("portal schema binds every viewer, grant, and session to one tenant and case", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  for (const table of [
    "portal_viewers",
    "portal_access_grants",
    "portal_sessions",
    "portal_security_events",
    "portal_idempotency_records",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`));
  }

  assert.match(sql, /REFERENCES cases_service_cases \(id, organization_id\)/);
  assert.match(sql, /REFERENCES crm_student_guardian_relationships \(id, organization_id\)/);
  assert.match(sql, /UNIQUE \(id, organization_id, service_case_id\)/);
  assert.match(sql, /REFERENCES portal_viewers \(id, organization_id, service_case_id\)/);
  assert.match(sql, /REFERENCES portal_access_grants \(id, organization_id, service_case_id\)/);
  assert.match(sql, /current_setting\('app\.organization_id', true\)/);
});

test("portal schema stores only globally unique keyed digests and bounded lifetimes", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /keyed_secret_hash bytea/);
  assert.match(sql, /secret_fingerprint char\(64\)/);
  assert.match(sql, /octet_length\(keyed_secret_hash\) = 32/);
  assert.match(sql, /UNIQUE \(keyed_secret_hash\)/);
  assert.match(sql, /UNIQUE \(secret_fingerprint\)/);
  assert.match(sql, /expires_at > issued_at/);
  assert.match(sql, /expires_at <= issued_at \+ interval '7 days'/);
  assert.match(sql, /idle_expires_at <= last_seen_at \+ interval '15 minutes'/);
  assert.match(sql, /absolute_expires_at <= created_at \+ interval '8 hours'/);
  assert.match(sql, /absolute_expires_at <= grant_expires_at/);
  assert.match(sql, /portal_access_grants_one_active_lifecycle_idx/);
  assert.match(sql, /portal_sessions_active_slot_idx/);
  assert.doesNotMatch(sql, /raw_secret|plaintext|secret_value/i);
});

test("grant transitions invalidate sessions and security evidence is append-only", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /CREATE FUNCTION portal_validate_grant_write\(\)/);
  assert.match(sql, /OLD\.status = 'active'\s+AND NEW\.status IN \('revoked', 'expired'\)/s);
  assert.match(sql, /CREATE FUNCTION portal_invalidate_grant_sessions\(\)/);
  assert.match(sql, /UPDATE portal_sessions\s+SET status = 'revoked'/s);
  assert.match(sql, /CREATE TRIGGER portal_access_grants_invalidate_sessions/);
  assert.match(sql, /CREATE FUNCTION portal_reject_security_event_mutation\(\)/);
  assert.match(sql, /CREATE FUNCTION portal_validate_security_event\(\)/);
  assert.match(sql, /portal_security_events_audit_context_check/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON portal_security_events/);
  assert.match(sql, /REFERENCES audit_events \(id, organization_id\)/);
  assert.match(sql, /REFERENCES audit_outbox \(id, organization_id\)/);
  assert.match(sql, /operation IN \('issue', 'revoke', 'rotate', 'redeem'\)/);
  assert.match(sql, /operation = 'redeem' AND actor_user_id IS NULL/);
});

test("session allocation serializes with grant revoke and retention has no undefined delete", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  const sessionValidator = sql.match(
    /CREATE FUNCTION portal_validate_session_write\(\)[\s\S]+?AS \$\$([\s\S]+?)\$\$;/,
  )?.[1];
  assert.ok(sessionValidator);
  assert.match(
    sessionValidator,
    /FROM portal_access_grants\s+WHERE id = NEW\.grant_id\s+AND organization_id = NEW\.organization_id\s+AND service_case_id = NEW\.service_case_id\s+FOR UPDATE;/s,
  );
  assert.match(sql, /CREATE TRIGGER portal_sessions_validate_write\s+BEFORE INSERT OR UPDATE ON portal_sessions/s);
  assert.match(sql, /CREATE TRIGGER portal_access_grants_invalidate_sessions\s+AFTER UPDATE OF status ON portal_access_grants/s);
  assert.doesNotMatch(
    sql,
    /GRANT[^;]*DELETE[^;]*ON TABLE portal_viewers[^;]*TO tianxing_app/is,
  );
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE[^;]*portal_(?:viewers|access_grants|sessions|security_events|idempotency_records)[^;]*TO tianxing_app/is);
});

test("DEC-065 grants portal_auth only one fixed, minimal discovery function", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /CREATE ROLE portal_auth LOGIN[^;]*NOBYPASSRLS/);
  assert.match(sql, /GRANT rds_iam TO portal_auth/);
  assert.match(sql, /GRANT CONNECT ON DATABASE %I TO portal_auth/);
  assert.match(sql, /CREATE FUNCTION portal_discover_grant_by_keyed_hash\(candidate_hash bytea\)/);
  assert.match(sql, /RETURNS TABLE \(\s*organization_id uuid,\s*grant_id uuid,\s*service_case_id uuid\s*\)/s);
  assert.match(sql, /LANGUAGE sql\s+SECURITY DEFINER\s+STABLE\s+SET search_path = pg_catalog, public/s);
  assert.match(sql, /grant_row\.keyed_secret_hash = candidate_hash/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM portal_auth/);
  assert.match(sql, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/);
  assert.match(sql, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM portal_auth/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION portal_discover_grant_by_keyed_hash\(bytea\) TO portal_auth/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]* TO portal_auth/i);
  const discoveryBody = sql.match(
    /CREATE FUNCTION portal_discover_grant_by_keyed_hash[\s\S]+?AS \$\$([\s\S]+?)\$\$;/,
  )?.[1];
  assert.ok(discoveryBody);
  assert.doesNotMatch(discoveryBody, /EXECUTE|format\(/i);
});
