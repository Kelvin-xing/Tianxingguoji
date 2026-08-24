import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath =
  "db/migrations/202608240020_036_complete_case_workflow_foundation.sql";
const applicationRoleMigrationPath =
  "db/migrations/202608030030_008_expand_application_database_role.sql";
const stageTransitionMigrationPath =
  "db/migrations/202608180080_024_enable_case_stage_transition.sql";

test("migration 036 preserves the existing tenant policy and forces RLS only after empty preflight", async () => {
  const [sql, applicationRoleSql] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(applicationRoleMigrationPath, "utf8"),
  ]);
  const noForce = sql.indexOf("ALTER TABLE cases_service_cases NO FORCE ROW LEVEL SECURITY");
  const populated = sql.indexOf("IF EXISTS (SELECT 1 FROM cases_service_cases)");
  const force = sql.indexOf("ALTER TABLE cases_service_cases FORCE ROW LEVEL SECURITY");

  assert.ok(noForce >= 0 && populated > noForce && force > populated);
  assert.match(sql, /CONSTRAINT = 'cases_service_cases_existing_data_unmapped_check'/);
  assert.match(sql, /ERRCODE = '23514'/);
  assert.doesNotMatch(sql, /CREATE POLICY tianxing_tenant_boundary ON cases_service_cases/);
  assert.doesNotMatch(sql, /cases_service_cases ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /UPDATE cases_service_cases[\s\S]*SET workflow_status/);
  assert.match(
    applicationRoleSql,
    /CREATE POLICY tianxing_tenant_boundary ON public\.%I[\s\S]*FOR ALL TO tianxing_app[\s\S]*USING \(organization_id::text = current_setting\('app\.organization_id', true\)\)[\s\S]*WITH CHECK \(organization_id::text = current_setting\('app\.organization_id', true\)\)/,
  );
});

test("migration 036 enforces Advisor-only signed/active/v1 creation and same-transaction advance", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /primary_role = 'advisor'/);
  assert.match(sql, /NEW\.stage IS DISTINCT FROM 'signed'/);
  assert.match(sql, /NEW\.workflow_status IS DISTINCT FROM 'active'/);
  assert.match(sql, /NEW\.record_version <> 1/);
  assert.match(sql, /CONSTRAINT = 'cases_service_cases_initial_state_check'/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER cases_service_cases_signed_commit_trg[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /CONSTRAINT = 'cases_service_cases_signed_commit_check'/);
  assert.match(sql, /actor_role = 'founder'[\s\S]*service_case\.primary_user_id = actor_id[\s\S]*service_case\.primary_role_binding_id = role_binding\.id/);
  assert.equal(
    (sql.match(/FOR SHARE OF role_binding, membership, organization, identity_user/g) ?? []).length >= 3,
    true,
  );
  assert.doesNotMatch(sql, /SELECT EXISTS \([\s\S]*actor_role IN \('founder', 'advisor'\)/);
  assert.match(sql, /from_stage = 'signed'[\s\S]*to_stage = 'background_collection'[\s\S]*reason IS NULL/);
  assert.doesNotMatch(
    sql.match(/ADD CONSTRAINT cases_service_case_transition_facts_direction_check CHECK \([\s\S]*?\n  \);/)?.[0] ?? "",
    /background_collection[^\n]*signed/,
  );
});

test("migration 036 freezes pause/resume facts and fail-closed assessment semantics", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /action = 'pause'[\s\S]*reason IS NOT NULL[\s\S]*char_length\(reason\) <= 1000/);
  assert.match(sql, /action = 'resume' AND reason IS NULL/);
  assert.match(sql, /target\.state IN \([\s\S]*'submitted'[\s\S]*'offer_declined'[\s\S]*'rejected'[\s\S]*\)/);
  const targetGuard = sql.match(/target\.state IN \([\s\S]*?\n\s*\)/)?.[0] ?? "";
  assert.doesNotMatch(targetGuard, /'withdrawn'/);
  assert.match(sql, /answer\.id IS NULL[\s\S]*answer\.semantic_state <> 'provided'/);
  assert.match(sql, /cases_assert_case_flow_v1_manifest/);
  assert.match(sql, /student_profile\.date_of_birth[\s\S]*family_context\.fee_preference/);
  assert.match(sql, /cases_manifest_blocker_contract_check/);
  assert.match(sql, /blocking_stages IS DISTINCT FROM expected\.blocking_stages/);
  assert.match(sql, /cases_lock_assessment_blockers\([\s\S]*NEW\.id,[\s\S]*NEW\.manifest_id,[\s\S]*'selection_ready'/);
  assert.match(sql, /cases_assert_assessment_writeable\([\s\S]*student\.status[\s\S]*service_case\.workflow_status/);
  assert.match(sql, /completion_only AND case_stage <> 'background_collection'/);
  assert.match(sql, /cases_assessment_insert_boundary_check/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION cases_create_candidate_school_target\([\s\S]*FROM tianxing_app/);
});

test("Case fact tables expose exactly tenant-scoped SELECT and INSERT policies", async () => {
  const [sql, stageTransitionSql] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(stageTransitionMigrationPath, "utf8"),
  ]);
  const source = `${stageTransitionSql}\n${sql}`;
  for (const table of [
    "cases_service_case_transition_facts",
    "cases_service_case_lifecycle_facts",
  ]) {
    const policies = source.match(new RegExp(
      `CREATE POLICY [a-z_]+ ON ${table}\\s+[\\s\\S]*?;`,
      "g",
    )) ?? [];
    assert.equal(policies.length, 2);
    assert.equal(policies.filter((policy) => /FOR SELECT TO tianxing_app/.test(policy)).length, 1);
    assert.equal(policies.filter((policy) => /FOR INSERT TO tianxing_app/.test(policy)).length, 1);
    assert.match(
      policies.find((policy) => /FOR SELECT/.test(policy)) ?? "",
      /USING \(organization_id::text = current_setting\('app\.organization_id', true\)\)/,
    );
    assert.match(
      policies.find((policy) => /FOR INSERT/.test(policy)) ?? "",
      /WITH CHECK \(organization_id::text = current_setting\('app\.organization_id', true\)\)/,
    );
    assert.doesNotMatch(policies.join("\n"), /FOR (?:ALL|UPDATE|DELETE) TO tianxing_app/);
  }
  assert.match(
    sql,
    /REVOKE ALL ON TABLE cases_service_case_lifecycle_facts FROM tianxing_app;\s*GRANT SELECT ON TABLE cases_service_case_lifecycle_facts TO tianxing_app;\s*GRANT INSERT ON TABLE cases_service_case_lifecycle_facts TO tianxing_app;/,
  );
  for (const table of [
    "cases_service_case_transition_facts",
    "cases_service_case_lifecycle_facts",
  ]) {
    const grants = source.match(new RegExp(
      `GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL)(?:, (?:SELECT|INSERT|UPDATE|DELETE))* ON TABLE ${table} TO tianxing_app;`,
      "g",
    )) ?? [];
    assert.deepEqual(grants.sort(), [
      `GRANT INSERT ON TABLE ${table} TO tianxing_app;`,
      `GRANT SELECT ON TABLE ${table} TO tianxing_app;`,
    ]);
  }
  assert.doesNotMatch(
    source,
    /GRANT (?:ALL|UPDATE|DELETE).*cases_service_case_(?:transition|lifecycle)_facts/,
  );
});

test("Case workflow functions receive only the required column-level UPDATE ACL", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const grant = sql.match(
    /GRANT UPDATE \([^)]+\)\s+ON TABLE cases_service_cases TO tianxing_app;/,
  )?.[0] ?? "";

  assert.match(
    grant,
    /GRANT UPDATE \(stage, workflow_status, record_version, updated_at\)/,
  );
  assert.doesNotMatch(sql, /GRANT UPDATE ON TABLE cases_service_cases TO tianxing_app/);
  assert.doesNotMatch(
    grant,
    /organization_id|student_id|case_number|application_type|intake_year|admission_type|primary_role_binding_id|primary_membership_id|primary_user_id|primary_role|created_at/,
  );
});

test("migration 036 replaces the legacy SchoolTarget writer with a fixed decommission stub", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const stub = sql.match(
    /CREATE OR REPLACE FUNCTION cases_create_candidate_school_target\([\s\S]*?\n\$\$;/,
  )?.[0] ?? "";

  assert.match(
    stub,
    /p_case_id uuid,[\s\S]*p_target_id uuid,[\s\S]*p_school_id uuid,[\s\S]*p_resolved_revision_id uuid,[\s\S]*p_expected_resolution_sha256 text,[\s\S]*p_created_at timestamptz/,
  );
  assert.match(
    stub,
    /RETURNS TABLE \([\s\S]*decision text,[\s\S]*target_id uuid,[\s\S]*school_id uuid,[\s\S]*intake_year integer,[\s\S]*admission_type text,[\s\S]*state text,[\s\S]*record_version bigint,[\s\S]*resolved_revision_id uuid,[\s\S]*resolution_sha256 text,[\s\S]*created_at timestamptz/,
  );
  assert.match(stub, /SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
  assert.match(stub, /ERRCODE = '42501'/);
  assert.match(stub, /CONSTRAINT = 'cases_candidate_school_target_decommissioned_check'/);
  assert.doesNotMatch(stub, /\b(?:SELECT|INSERT|UPDATE|DELETE|PERFORM|RETURN QUERY)\b/);
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION cases_create_candidate_school_target\([\s\S]*?\) FROM PUBLIC;[\s\S]*REVOKE EXECUTE ON FUNCTION cases_create_candidate_school_target\([\s\S]*?\) FROM tianxing_app;/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT EXECUTE ON FUNCTION cases_create_candidate_school_target\([\s\S]*?TO tianxing_app/,
  );
});
