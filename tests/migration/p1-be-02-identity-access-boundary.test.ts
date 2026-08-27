import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MIGRATION = "db/migrations/202608260020_038_expand_identity_access_boundaries.sql";

test("P1-BE-02 adds EmployeeProfile and lifecycle receipts without changing historical migrations", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  assert.match(sql, /CREATE TABLE access_employee_profiles/);
  assert.match(sql, /membership_id uuid PRIMARY KEY/);
  assert.match(sql, /employment_type IN \('FULL_TIME', 'PART_TIME'\)/);
  assert.match(sql, /identity\/access history is append-only/i);
  assert.match(sql, /ADD COLUMN activated_at timestamptz/);
  assert.match(sql, /ADD COLUMN disabled_at timestamptz/);
  assert.match(sql, /ADD COLUMN credential_version text NOT NULL DEFAULT 'v1'/);
  assert.match(sql, /expires_at <= created_at \+ interval '72 hours'/);
});

test("P1-BE-02 freezes four active roles and Contractor compatibility", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  assert.match(sql, /UPDATE access_role_bindings[\s\S]*role = 'data_reviewer'[\s\S]*status = 'revoked'/);
  assert.match(sql, /status <> 'active' OR role IN \('founder', 'admin', 'advisor', 'contractor'\)/);
  assert.match(sql, /access_role_bindings_contractor_exclusive_check/);
  assert.match(sql, /access_role_bindings_employment_type_check/);
  assert.match(sql, /access_role_bindings_last_founder_check/);
  assert.match(sql, /remaining_role\.organization_id = OLD\.organization_id/);
  assert.match(sql, /remaining_membership\.status = 'active'/);
  assert.doesNotMatch(sql, /CREATE TABLE (?:data_reviewer|contractor)_/i);
});

test("P1-BE-02 separates canonical Identity session resolution from Access", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  const principalFunction = functionSource(sql, "identity_resolve_session_principal");
  const accessFunction = functionSource(sql, "access_resolve_workspace_context");
  assert.match(principalFunction, /identity_sessions AS session/);
  assert.match(principalFunction, /identity_users AS identity_user/);
  assert.doesNotMatch(principalFunction, /role_binding|membership|access_organization/);
  assert.match(accessFunction, /role_binding\.role IN \('founder', 'admin', 'advisor', 'contractor'\)/);
  assert.match(accessFunction, /ORDER BY role_binding\.id/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION identity_resolve_session_principal/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION access_resolve_workspace_context/);
});

test("P1-BE-02 enforces session, grant, RLS and immutable history boundaries", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  assert.match(sql, /ALTER COLUMN organization_id DROP NOT NULL/);
  assert.match(sql, /ALTER COLUMN membership_id DROP NOT NULL/);
  assert.match(sql, /identity_sessions_p1_time_window_check/);
  assert.match(sql, /interval '8 hours'/);
  assert.match(sql, /interval '24 hours'/);
  assert.match(sql, /access_scope_grants_one_current_scope_idx/);
  assert.match(sql, /access_scope_grants_collaborator_window_check/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /tianxing_employee_profile_tenant_boundary/);
  assert.match(sql, /access_reject_physical_delete/);
  assert.match(sql, /REVOKE DELETE ON TABLE access_employee_profiles/);
});

test("P1-BE-02 migration is pinned in the source manifest", async () => {
  const [sql, manifestText] = await Promise.all([
    readFile(MIGRATION, "utf8"),
    readFile("db/migrations/manifest.json", "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as {
    migrations: Array<{ name: string; sha256: string }>;
  };
  const migrationName = MIGRATION.split("/").at(-1);
  const matchingEntries = manifest.migrations.filter(({ name }) => name === migrationName);
  assert.equal(matchingEntries.length, 1);
  const entry = matchingEntries[0];
  assert.equal(entry?.sha256, createHash("sha256").update(sql).digest("hex"));
});

function functionSource(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  assert.ok(start >= 0);
  const end = sql.indexOf("$$;", start);
  assert.ok(end > start);
  return sql.slice(start, end);
}
