import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { Client } from "pg";

import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  verifyCommittedOneRoleBaseline,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  assertOneRoleBaselinePostflight,
  assertOneRoleBaselinePreflight,
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  OneRoleBaselineOperationError,
  type OneRoleBaselineDatabaseState,
  type OneRoleBaselineFailureStage,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";
import {
  NEON_TEST_MANIFEST_ID,
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
  NEON_TEST_STUDENTS,
} from "../../scripts/db/neon-test-synthetic-fixture.ts";
import { seedNeonTestRelease1 } from "../../scripts/db/seed-neon-test-release1.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const POSTGRES_MAJOR = 17;
const CASE_FLOW_MIGRATION_NAME =
  "035_202608240020_036_complete_case_workflow_foundation.sql";
const SAFE_BASELINE_POSTGRES_CODES = new Set([
  "08003", "08006", "23503", "23505", "23514", "40001", "40P01", "42501",
  "42601", "42703", "42883", "42P01", "42P13", "55P03", "57014", "57P01",
]);
const SAFE_BASELINE_FAILURE_STAGES = new Set<OneRoleBaselineFailureStage>([
  "cli", "baseline_manifest", "preflight_database_inspection", "execution_connection",
  "transaction_begin", "transaction_execution", "advisory_lock", "locked_preflight",
  "generated_manifest_before", "generated_sql", "generated_manifest_after", "marker_write",
  "transaction_rollback", "transaction_commit", "execution_connection_close",
  "rollback_database_inspection", "rollback_state_verification",
  "postflight_database_inspection", "postflight_state_verification",
]);
const SAFE_PRIMARY_CONTACT_POSTGRES_CONSTRAINTS = new Set([
  "crm_guardians_purge_current_relationship_check",
  "crm_relationships_one_current_primary_idx",
  "crm_students_current_primary_contact_check",
]);
const SAFE_CASE_FLOW_POSTGRES_CONSTRAINTS = new Set([
  "cases_answers_manifest_field_check",
  "cases_answers_value_type_check",
  "cases_assessment_answers_identity_immutable_check",
  "cases_assessment_answers_record_version_transition_check",
  "cases_assessment_answers_timestamps_check",
  "cases_assessment_insert_boundary_check",
  "cases_assessment_write_boundary_check",
  "cases_candidate_school_target_decommissioned_check",
  "cases_assessments_blockers_incomplete_check",
  "cases_assessments_identity_immutable_check",
  "cases_assessments_manifest_approved_check",
  "cases_assessments_record_version_transition_check",
  "cases_assessments_status_transition_check",
  "cases_assessments_tenant_context_check",
  "cases_assessments_timestamps_check",
  "cases_manifest_blocker_contract_check",
  "cases_service_case_lifecycle_facts_action_check",
  "cases_service_case_lifecycle_facts_append_only_check",
  "cases_service_case_lifecycle_facts_reason_check",
  "cases_service_case_lifecycle_facts_time_boundary_check",
  "cases_service_case_lifecycle_facts_timestamps_check",
  "cases_service_case_lifecycle_facts_version_check",
  "cases_service_case_transition_facts_direction_check",
  "cases_service_cases_active_principal_check",
  "cases_service_cases_closed_state_check",
  "cases_service_cases_existing_data_unmapped_check",
  "cases_service_cases_identity_immutable_check",
  "cases_service_cases_initial_state_check",
  "cases_service_cases_primary_role_check",
  "cases_service_cases_record_version_transition_check",
  "cases_service_cases_signed_commit_check",
  "cases_service_cases_stage_check",
  "cases_service_cases_stage_direction_check",
  "cases_service_cases_stage_transition_boundary_check",
  "cases_service_cases_timestamps_check",
  "cases_service_cases_workflow_action_boundary_check",
  "cases_service_cases_workflow_status_check",
]);
const SAFE_POSTGRES_ERROR_SEVERITIES = new Set(["ERROR", "FATAL", "PANIC"]);

type PrimaryContactInvariantStage =
  | "rls_contract"
  | "fixture_create"
  | "pending_transition"
  | "zero_primary_rejection"
  | "multiple_primary_rejection"
  | "purged_rejection"
  | "transaction_boundary";

type CaseFlowInvariantStage =
  | "connection"
  | "fact_rls_contract"
  | "case_update_acl_contract"
  | "fixture_principal_and_case"
  | "signed_advance_execute_privilege"
  | "signed_advance_actor_binding"
  | "signed_advance_fact_insert"
  | "signed_advance_fact_and_case_update"
  | "signed_advance_function"
  | "signed_advance_commit"
  | "fact_insert_rls_rejections"
  | "invalid_initial_state"
  | "signed_only_commit"
  | "founder_primary"
  | "non_primary_advisor_advance"
  | "manifest_and_answers"
  | "background_blocker_rejections"
  | "background_complete"
  | "selection_blocker_rejections"
  | "selection_ready"
  | "legacy_school_target_denial"
  | "effects_zero"
  | "transaction_boundary";

type SignedAdvanceDiagnosticEvidence = {
  execute_privilege: boolean;
  actor_binding_lock: boolean;
  fact_insert: boolean;
  fact_and_case_update: boolean;
  function_response_reached: boolean;
  function_response_exact: boolean;
  transaction_commit_reached: boolean;
};

test("dry-runs and applies the one-role baseline on disposable PostgreSQL 17", {
  timeout: 120_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-one-role-pg17-${suffix}`;
  const bootstrapPassword = randomBytes(32).toString("hex");
  const applicationPassword = randomBytes(32).toString("hex");
  let started = false;

  try {
    await runDocker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_missing");
    await runDocker([
      "run",
      "--rm",
      "--detach",
      "--pull=never",
      "--name",
      containerName,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env",
      "POSTGRES_DB=postgres",
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      "POSTGRES_PASSWORD",
      "--publish",
      "127.0.0.1::5432",
      POSTGRES_IMAGE,
    ], "postgres_container_start", undefined, {
      ...process.env,
      POSTGRES_PASSWORD: bootstrapPassword,
    });
    started = true;
    await waitForPostgres(containerName);
    await runDocker([
      "exec",
      "--interactive",
      containerName,
      "psql",
      "--set=ON_ERROR_STOP=1",
      "--username=postgres",
      "--dbname=postgres",
    ], "postgres_database_bootstrap", [
      `CREATE ROLE ${ONE_ROLE_CANONICAL_ROLE} WITH`,
      "  LOGIN",
      `  PASSWORD '${applicationPassword}'`,
      "  NOSUPERUSER",
      "  NOCREATEDB",
      "  NOCREATEROLE",
      "  NOINHERIT",
      "  NOREPLICATION",
      "  NOBYPASSRLS;",
      `CREATE DATABASE tianxing OWNER ${ONE_ROLE_CANONICAL_ROLE};`,
      "",
    ].join("\n"));

    const portOutput = await runDocker(
      ["port", containerName, "5432/tcp"],
      "postgres_port_inspection",
    );
    const port = readLoopbackPort(portOutput.stdout);
    const target = localIntegrationTarget(port, applicationPassword);
    assert.equal(target.port, port);
    assert.equal(Number(new URL(target.connectionString).port), target.port);
    const clientConfig = createOneRoleBaselineClientConfig(target);
    const postgresVersion = await readPostgresVersion(clientConfig);
    assert.equal(Number(postgresVersion.split(".")[0]), POSTGRES_MAJOR);

    const build = await verifyCommittedOneRoleBaseline();
    const dryRunEvidence = await observeCaseFlowBaselineFailure(executeOneRoleBaselineRun({
      mode: "dry-run",
      target,
      build,
      dependencies: {
        inspect: () => inspectWithNewClient(target),
        openExecutionConnection: async () => {
          const client = new Client(clientConfig);
          await client.connect();
          return Object.freeze({ client, close: () => client.end() });
        },
      },
    }));

    assert.equal(dryRunEvidence.status, "pass");
    assert.equal(dryRunEvidence.baseline_id, ONE_ROLE_BASELINE_ID);
    assert.equal(dryRunEvidence.generated_files, ONE_ROLE_SOURCE_COUNT + 1);
    assert.equal(dryRunEvidence.postflight_state, "clean");
    assert.equal(dryRunEvidence.marker, "rolled_back");

    const independentlyVerifiedDryRun = await inspectWithNewClient(target);
    assertOneRoleBaselinePreflight(independentlyVerifiedDryRun, target);
    assert.equal(independentlyVerifiedDryRun.publicObjectCount, 0);
    assert.equal(independentlyVerifiedDryRun.marker, null);

    const applyEvidence = await executeOneRoleBaselineRun({
      mode: "apply",
      target,
      build,
      dependencies: {
        inspect: () => inspectWithNewClient(target),
        openExecutionConnection: async () => {
          const client = new Client(clientConfig);
          await client.connect();
          return Object.freeze({ client, close: () => client.end() });
        },
      },
    });
    assert.equal(applyEvidence.status, "pass");
    assert.equal(applyEvidence.postflight_state, "installed");
    assert.equal(applyEvidence.marker, "installed");
    assert.equal(applyEvidence.verification.role_contract, "verified");
    assert.equal(applyEvidence.verification.member_of_neon_superuser, false);
    assert.equal(applyEvidence.verification.granted_role_count, 0);
    assert.equal(applyEvidence.verification.marker_ownership, "verified");
    assert.ok(applyEvidence.verification.public_object_count > 0);
    assert.equal(applyEvidence.verification.public_wrong_owner_count, 0);
    assert.equal(applyEvidence.verification.rls_not_forced_count, 0);
    assert.equal(applyEvidence.verification.unsafe_security_definer_count, 0);
    assert.equal(applyEvidence.verification.migration_metadata, "absent");
    assert.equal(applyEvidence.verification.stale_dry_run_schema_count, 0);

    const manifestSha256 = createHash("sha256").update(build.manifestJson).digest("hex");
    const independentlyVerifiedApply = await inspectWithNewClient(target);
    assertOneRoleBaselinePostflight({
      state: independentlyVerifiedApply,
      target,
      mode: "apply",
      manifestSha256,
    });
    assert.equal((await seedNeonTestRelease1(target, "apply")).status, "pass");
    await assertPrimaryContactLifecycleInvariant(clientConfig);
    await assertCaseFlowFoundationInvariant(clientConfig);

    process.stdout.write(`${JSON.stringify({
      status: "pass",
      postgres_version: postgresVersion,
      target_port: target.port,
      generated_files: dryRunEvidence.generated_files,
      dry_run: {
        postflight_state: dryRunEvidence.postflight_state,
        marker: dryRunEvidence.marker,
        independent_postflight: "clean",
      },
      apply: {
        postflight_state: applyEvidence.postflight_state,
        marker: applyEvidence.marker,
        independent_postflight: "verified",
        verification: applyEvidence.verification,
      },
      primary_contact_invariant: {
        active: "pass",
        pending_delete: "pass",
        purged: "rejected",
        zero: "rejected",
        multiple: "rejected",
      },
      case_flow_foundation: {
        signed_advance: "pass",
        signed_only_commit: "rejected",
        invalid_initial_state: "rejected",
        founder_primary: "rejected",
        non_primary_advisor_advance: "rejected",
        background_blockers: "provided_only",
        selection_blockers: "provided_only",
        school_target_legacy_function: "denied_zero_effects",
      },
    })}\n`);
  } finally {
    if (started) {
      await runDocker(
        ["rm", "--force", containerName],
        "postgres_container_cleanup",
      );
    }
  }
});

test("migration 036 rejects a populated cross-tenant Case without a tenant GUC", {
  timeout: 120_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-case-flow-preflight-pg17-${suffix}`;
  const bootstrapPassword = randomBytes(32).toString("hex");
  const applicationPassword = randomBytes(32).toString("hex");
  let started = false;
  try {
    await runDocker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_missing");
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", containerName,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env", "POSTGRES_DB=postgres", "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PASSWORD", "--publish", "127.0.0.1::5432", POSTGRES_IMAGE,
    ], "postgres_container_start", undefined, { ...process.env, POSTGRES_PASSWORD: bootstrapPassword });
    started = true;
    await waitForPostgres(containerName);
    await runDocker([
      "exec", "--interactive", containerName, "psql", "--set=ON_ERROR_STOP=1",
      "--username=postgres", "--dbname=postgres",
    ], "postgres_database_bootstrap", [
      `CREATE ROLE ${ONE_ROLE_CANONICAL_ROLE} WITH LOGIN PASSWORD '${applicationPassword}'`,
      "  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;",
      `CREATE DATABASE tianxing OWNER ${ONE_ROLE_CANONICAL_ROLE};`,
      "",
    ].join("\n"));
    const port = readLoopbackPort((await runDocker(
      ["port", containerName, "5432/tcp"], "postgres_port_inspection",
    )).stdout);
    const target = localIntegrationTarget(port, applicationPassword);
    const client = new Client(createOneRoleBaselineClientConfig(target));
    const build = await verifyCommittedOneRoleBaseline();
    const migration036Index = build.files.findIndex(({ name }) =>
      name === CASE_FLOW_MIGRATION_NAME);
    assert.equal(migration036Index, 34);
    try {
      await client.connect();
      await client.query("BEGIN");
      for (const file of build.files.slice(0, migration036Index)) {
        await client.query(file.contents);
      }
      const organizationId = "67000000-0000-4000-8000-000000000001";
      const founderId = "67000000-0000-4000-8000-000000000002";
      const advisorId = "67000000-0000-4000-8000-000000000003";
      await setTenantContext(client, organizationId, founderId);
      await client.query(`INSERT INTO identity_users (id,normalized_email,status) VALUES
        ($1,'case-flow-preflight-founder@example.invalid','active'),
        ($2,'case-flow-preflight-advisor@example.invalid','active')`, [founderId, advisorId]);
      await client.query(`INSERT INTO access_organizations (id,display_name,status,created_by_user_id)
        VALUES ($1,'Case Flow Preflight','active',$2)`, [organizationId, founderId]);
      await client.query(`INSERT INTO access_organization_memberships
        (id,organization_id,user_id,status,created_by_user_id) VALUES
        ('67000000-0000-4000-8000-000000000004',$1,$2,'active',$2),
        ('67000000-0000-4000-8000-000000000005',$1,$3,'active',$2)`, [
        organizationId, founderId, advisorId,
      ]);
      await client.query(`INSERT INTO access_role_bindings
        (id,organization_id,membership_id,user_id,role,status,created_by_user_id) VALUES
        ('67000000-0000-4000-8000-000000000006',$1,
          '67000000-0000-4000-8000-000000000004',$2,'founder','active',$2),
        ('67000000-0000-4000-8000-000000000007',$1,
          '67000000-0000-4000-8000-000000000005',$3,'advisor','active',$2)`, [
        organizationId, founderId, advisorId,
      ]);
      await client.query(`INSERT INTO crm_guardians
        (id,organization_id,display_name,status)
        VALUES ('67000000-0000-4000-8000-000000000008',$1,'Preflight Guardian','active')`,
      [organizationId]);
      await client.query(`INSERT INTO crm_students
        (id,organization_id,display_name,status)
        VALUES ('67000000-0000-4000-8000-000000000009',$1,'Preflight Student','active')`,
      [organizationId]);
      await client.query(`INSERT INTO crm_student_guardian_relationships
        (id,organization_id,student_id,guardian_id,relationship_type,is_legal_guardian,
         is_primary_contact,is_emergency_contact,is_billing_contact,notification_consent,starts_at)
        VALUES ('67000000-0000-4000-8000-000000000010',$1,
          '67000000-0000-4000-8000-000000000009','67000000-0000-4000-8000-000000000008',
          'other_guardian',true,true,false,false,false,transaction_timestamp())`, [organizationId]);
      await client.query(`INSERT INTO cases_service_cases
        (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
         primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage)
        VALUES ('67000000-0000-4000-8000-000000000011',$1,
          '67000000-0000-4000-8000-000000000009','CASE-FLOW-PREFLIGHT','k12',2099,'transfer',
          '67000000-0000-4000-8000-000000000007','67000000-0000-4000-8000-000000000005',
          $2,'advisor','signed')`, [organizationId, advisorId]);
      await client.query("COMMIT");
      const before = await client.query<{ objects: string }>(`SELECT count(*)::text AS objects
        FROM pg_class WHERE relnamespace='public'::regnamespace`);
      await client.query("BEGIN");
      try {
        await client.query(build.files[migration036Index]!.contents);
        throw new HarnessError("populated_migration_unexpected_allow");
      } catch (error) {
        if (error instanceof HarnessError) throw error;
        const postgres = error as { readonly code?: unknown; readonly constraint?: unknown };
        assert.equal(postgres.code, "23514");
        assert.equal(postgres.constraint, "cases_service_cases_existing_data_unmapped_check");
      }
      await client.query("ROLLBACK");
      const state = await client.query<{
        enable_rls: boolean;
        force_rls: boolean;
        workflow_column: boolean;
        objects: string;
      }>(`SELECT
        (SELECT relrowsecurity FROM pg_class WHERE oid='cases_service_cases'::regclass) AS enable_rls,
        (SELECT relforcerowsecurity FROM pg_class WHERE oid='cases_service_cases'::regclass) AS force_rls,
        EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='cases_service_cases'
            AND column_name='workflow_status') AS workflow_column,
        (SELECT count(*)::text FROM pg_class WHERE relnamespace='public'::regnamespace) AS objects`);
      assert.deepEqual(state.rows, [{
        enable_rls: true,
        force_rls: false,
        workflow_column: false,
        objects: before.rows[0]!.objects,
      }]);
      assertCaseTenantPolicy(await readCaseTenantPolicy(client));
    } finally {
      await client.end().catch(() => {});
    }
  } finally {
    if (started) await runDocker(["rm", "--force", containerName], "postgres_container_cleanup");
  }
});

async function observeCaseFlowBaselineFailure<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof OneRoleBaselineOperationError) {
      const failure = error.originalFailure;
      process.stdout.write(`${JSON.stringify({
        event: "case_flow_baseline_failure",
        stage: SAFE_BASELINE_FAILURE_STAGES.has(failure.failure_stage)
          ? failure.failure_stage
          : "OTHER",
        migration: failure.migration_name === CASE_FLOW_MIGRATION_NAME
          ? CASE_FLOW_MIGRATION_NAME
          : failure.migration_name ? "OTHER" : "NULL",
        group: failure.migration_name === CASE_FLOW_MIGRATION_NAME && failure.migration_group
          ? failure.migration_group
          : "NULL",
        postgres_code: failure.postgres_code && SAFE_BASELINE_POSTGRES_CODES.has(
          failure.postgres_code,
        ) ? failure.postgres_code : failure.postgres_code ? "OTHER" : "NULL",
        postgres_constraint:
          failure.postgres_constraint === "cases_service_cases_existing_data_unmapped_check"
            ? failure.postgres_constraint
            : failure.postgres_constraint ? "OTHER" : "NULL",
      })}\n`);
    }
    throw error;
  }
}

type CaseTenantPolicyEvidence = Readonly<{
  check_matches: boolean;
  cmd_all: boolean;
  exists: boolean;
  role_tianxing_only: boolean;
  using_matches: boolean;
}>;

async function readCaseTenantPolicy(client: Client): Promise<CaseTenantPolicyEvidence> {
  const result = await client.query<CaseTenantPolicyEvidence>(`WITH policy AS (
    SELECT * FROM pg_policy
     WHERE polrelid='cases_service_cases'::regclass
       AND polname='tianxing_tenant_boundary'
  )
  SELECT
    count(*)=1 AS exists,
    count(*)=1 AND bool_and(polcmd='*') AS cmd_all,
    count(*)=1 AND bool_and(
      polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname=$1)]::oid[]
    ) AS role_tianxing_only,
    count(*)=1 AND bool_and(
      regexp_replace(pg_get_expr(polqual,polrelid),'[[:space:]()]|::text','','g')=
        'organization_id=current_setting''app.organization_id'',true'
    ) AS using_matches,
    count(*)=1 AND bool_and(
      regexp_replace(pg_get_expr(polwithcheck,polrelid),'[[:space:]()]|::text','','g')=
        'organization_id=current_setting''app.organization_id'',true'
    ) AS check_matches
  FROM policy`, [ONE_ROLE_CANONICAL_ROLE]);
  return result.rows[0]!;
}

function assertCaseTenantPolicy(evidence: CaseTenantPolicyEvidence): void {
  assert.deepEqual(evidence, {
    exists: true,
    cmd_all: true,
    role_tianxing_only: true,
    using_matches: true,
    check_matches: true,
  });
}

async function assertPrimaryContactLifecycleInvariant(
  clientConfig: ReturnType<typeof createOneRoleBaselineClientConfig>,
): Promise<void> {
  const client = new Client(clientConfig);
  let stage: PrimaryContactInvariantStage = "transaction_boundary";
  const founder = NEON_TEST_PRINCIPALS.find(({ role }) => role === "founder")!;
  const organizationId = NEON_TEST_ORGANIZATION.id;
  const actorId = founder.userId;
  const studentId = "65000000-0000-4000-8000-000000000601";
  const guardianId = "65000000-0000-4000-8000-000000000701";
  const alternateGuardianId = "65000000-0000-4000-8000-000000000702";
  const relationshipId = "65000000-0000-4000-8000-000000000801";
  try {
    await client.connect();
    stage = "rls_contract";
    const caseRls = await client.query<{
      enable_rls: boolean;
      force_rls: boolean;
    }>(`SELECT
      (SELECT relrowsecurity FROM pg_class WHERE oid='cases_service_cases'::regclass) AS enable_rls,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='cases_service_cases'::regclass) AS force_rls`);
    assert.deepEqual(caseRls.rows, [{
      enable_rls: true,
      force_rls: true,
    }]);
    assertCaseTenantPolicy(await readCaseTenantPolicy(client));
    stage = "fixture_create";
    await client.query("BEGIN");
    await setTenantContext(client, organizationId, actorId);
    await client.query(`INSERT INTO crm_guardians (id,organization_id,display_name,status)
      VALUES ($1,$3,'CRM05 Primary Guardian','active'),
             ($2,$3,'CRM05 Alternate Guardian','active')`,
    [guardianId, alternateGuardianId, organizationId]);
    await client.query(`INSERT INTO crm_students (id,organization_id,display_name,status)
      VALUES ($1,$2,'CRM05 Primary Student','active')`, [studentId, organizationId]);
    await client.query(`INSERT INTO crm_student_guardian_relationships
        (id,organization_id,student_id,guardian_id,relationship_type,is_legal_guardian,
         is_primary_contact,is_emergency_contact,is_billing_contact,notification_consent,starts_at)
      VALUES ($1,$2,$3,$4,'other_guardian',true,true,false,false,false,transaction_timestamp())`,
    [relationshipId, organizationId, studentId, guardianId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");

    stage = "pending_transition";
    await client.query("BEGIN");
    await setTenantContext(client, organizationId, actorId);
    await client.query(`UPDATE crm_guardians
      SET status='pending_delete',deletion_requested_at=transaction_timestamp(),
          deletion_requested_by_user_id=$2,deletion_reason='record.lifecycle.pending_delete_requested',
          record_version=record_version+1,updated_at=transaction_timestamp()
      WHERE id=$1`, [guardianId, actorId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");

    stage = "zero_primary_rejection";
    await expectRejectedTransaction(client, organizationId, actorId, async () => {
      await client.query(`UPDATE crm_student_guardian_relationships
        SET ends_at=transaction_timestamp(),ended_by_user_id=$2,end_reason='local invariant test',
            record_version=record_version+1,updated_at=transaction_timestamp()
        WHERE id=$1`, [relationshipId, actorId]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    }, "23514", "crm_students_current_primary_contact_check");

    stage = "multiple_primary_rejection";
    await expectRejectedTransaction(client, organizationId, actorId, async () => {
      await client.query(`INSERT INTO crm_student_guardian_relationships
        (id,organization_id,student_id,guardian_id,relationship_type,is_legal_guardian,
         is_primary_contact,is_emergency_contact,is_billing_contact,notification_consent,starts_at)
        VALUES ('65000000-0000-4000-8000-000000000802',$1,$2,$3,'other_guardian',true,true,
          false,false,false,transaction_timestamp())`,
      [organizationId, studentId, alternateGuardianId]);
    }, "23505", "crm_relationships_one_current_primary_idx");

    stage = "purged_rejection";
    await expectRejectedTransaction(client, organizationId, actorId, async () => {
      await client.query(`UPDATE crm_guardians
        SET status='purged',display_name=NULL,email=NULL,phone=NULL,deletion_reason=NULL,
            purge_approved_at=transaction_timestamp(),purge_approved_by_user_id=$2,
            purged_at=transaction_timestamp(),record_version=record_version+1,
            updated_at=transaction_timestamp()
        WHERE id=$1`, [guardianId, actorId]);
    }, "23514", "crm_guardians_purge_current_relationship_check");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    writePrimaryContactInvariantFailure(stage, error);
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("primary_contact_invariant");
  } finally {
    await client.end().catch(() => {});
  }
}

function writePrimaryContactInvariantFailure(
  stage: PrimaryContactInvariantStage,
  error: unknown,
): void {
  let postgresCode = "NULL";
  let postgresConstraint = "NULL";
  if (error instanceof Error) {
    const candidate = error as Error & {
      readonly code?: unknown;
      readonly constraint?: unknown;
      readonly severity?: unknown;
    };
    if (
      typeof candidate.severity === "string"
      && SAFE_POSTGRES_ERROR_SEVERITIES.has(candidate.severity)
      && typeof candidate.code === "string"
      && /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      postgresCode = SAFE_BASELINE_POSTGRES_CODES.has(candidate.code)
        ? candidate.code
        : "OTHER";
      if (typeof candidate.constraint === "string") {
        postgresConstraint = SAFE_PRIMARY_CONTACT_POSTGRES_CONSTRAINTS.has(candidate.constraint)
          ? candidate.constraint
          : "OTHER";
      }
    }
  }
  process.stdout.write(`${JSON.stringify({
    event: "primary_contact_invariant_failure",
    stage,
    postgres_code: postgresCode,
    postgres_constraint: postgresConstraint,
  })}\n`);
}

async function assertCaseFlowFoundationInvariant(
  clientConfig: ReturnType<typeof createOneRoleBaselineClientConfig>,
): Promise<void> {
  const client = new Client(clientConfig);
  let stage: CaseFlowInvariantStage = "connection";
  const founder = NEON_TEST_PRINCIPALS.find(({ role }) => role === "founder")!;
  const advisor = NEON_TEST_PRINCIPALS.find(({ role }) => role === "advisor")!;
  const otherAdvisor = NEON_TEST_PRINCIPALS.find(({ role }) => role === "data_reviewer")!;
  const caseId = "66000000-0000-4000-8000-000000000101";
  const assessmentId = "66000000-0000-4000-8000-000000000102";
  const transitionFactId = "66000000-0000-4000-8000-000000000103";
  const otherAdvisorBindingId = "66000000-0000-4000-8000-000000000104";
  const blockerField = "student_profile.date_of_birth";
  const signedAdvanceEvidence: SignedAdvanceDiagnosticEvidence = {
    execute_privilege: false,
    actor_binding_lock: false,
    fact_insert: false,
    fact_and_case_update: false,
    function_response_reached: false,
    function_response_exact: false,
    transaction_commit_reached: false,
  };
  try {
    await client.connect();
    stage = "fact_rls_contract";
    assert.deepEqual(await readCaseFactPolicyEvidence(client), [
      {
        table_name: "cases_service_case_lifecycle_facts",
        enable_rls: true,
        force_rls: true,
        exact_policy_count: true,
        select_policy_exact: true,
        insert_policy_exact: true,
        select_privilege: true,
        insert_privilege: true,
        update_privilege: false,
        delete_privilege: false,
      },
      {
        table_name: "cases_service_case_transition_facts",
        enable_rls: true,
        force_rls: true,
        exact_policy_count: true,
        select_policy_exact: true,
        insert_policy_exact: true,
        select_privilege: true,
        insert_privilege: true,
        update_privilege: false,
        delete_privilege: false,
      },
    ]);
    stage = "case_update_acl_contract";
    assert.deepEqual(await readCaseUpdatePrivilegeEvidence(client), [{
      table_update: false,
      id_update: true,
      stage_update: true,
      workflow_status_update: true,
      record_version_update: true,
      updated_at_update: true,
      organization_id_update: false,
      student_id_update: false,
      case_number_update: false,
      application_type_update: false,
      intake_year_update: false,
      admission_type_update: false,
      primary_role_binding_id_update: false,
      primary_membership_id_update: false,
      primary_user_id_update: false,
      primary_role_update: false,
      created_at_update: false,
    }]);
    stage = "transaction_boundary";
    await client.query("BEGIN");
    stage = "fixture_principal_and_case";
    await setTenantContext(client, NEON_TEST_ORGANIZATION.id, founder.userId);
    await client.query(`INSERT INTO access_role_bindings
      (id,organization_id,membership_id,user_id,role,status,created_by_user_id)
      VALUES ($1,$2,$3,$4,'advisor','active',$5)`, [
      otherAdvisorBindingId, NEON_TEST_ORGANIZATION.id, otherAdvisor.membershipId,
      otherAdvisor.userId, founder.userId,
    ]);
    await client.query(`INSERT INTO cases_service_cases
      (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
       primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,
       workflow_status,record_version)
      VALUES ($1,$2,$3,'CASE-FLOW-PG17','k12',2090,'transfer',$4,$5,$6,'advisor','signed',
        'active',1)`, [caseId, NEON_TEST_ORGANIZATION.id, NEON_TEST_STUDENTS[0]!.id,
      advisor.roleBindingId, advisor.membershipId, advisor.userId]);
    await client.query(`INSERT INTO cases_assessments
      (id,organization_id,service_case_id,manifest_id,status,record_version)
      VALUES ($1,$2,$3,$4,'draft',1)`, [
      assessmentId, NEON_TEST_ORGANIZATION.id, caseId, NEON_TEST_MANIFEST_ID,
    ]);

    stage = "signed_advance_execute_privilege";
    const executePrivilege = await client.query<{ allowed: boolean }>(
      `SELECT has_function_privilege(
        current_user,
        'cases_advance_new_service_case(uuid,text,uuid,timestamptz)',
        'EXECUTE'
      ) AS allowed`,
    );
    assert.deepEqual(executePrivilege.rows, [{ allowed: true }]);
    signedAdvanceEvidence.execute_privilege = true;

    stage = "signed_advance_actor_binding";
    const actorBinding = await client.query<{ allowed: boolean }>(`SELECT true AS allowed
      FROM access_role_bindings AS role_binding
      JOIN access_organization_memberships AS membership
        ON membership.id=role_binding.membership_id
       AND membership.organization_id=role_binding.organization_id
       AND membership.user_id=role_binding.user_id
      JOIN access_organizations AS organization
        ON organization.id=role_binding.organization_id
      JOIN identity_users AS identity_user ON identity_user.id=role_binding.user_id
     WHERE role_binding.id=$1
       AND role_binding.organization_id=$2
       AND role_binding.user_id=$3
       AND role_binding.role='founder'
       AND role_binding.status='active'
       AND membership.status='active'
       AND organization.status='active'
       AND identity_user.status='active'
     FOR SHARE OF role_binding,membership,organization,identity_user`, [
      founder.roleBindingId, NEON_TEST_ORGANIZATION.id, founder.userId,
    ]);
    assert.deepEqual(actorBinding.rows, [{ allowed: true }]);
    signedAdvanceEvidence.actor_binding_lock = true;

    stage = "signed_advance_fact_insert";
    await client.query("SAVEPOINT case_flow_fact_insert_probe");
    try {
      await client.query(`INSERT INTO cases_service_case_transition_facts
        (id,organization_id,service_case_id,actor_user_id,from_stage,to_stage,
         from_record_version,to_record_version,reason,transitioned_at,created_at)
        VALUES ('66000000-0000-4000-8000-000000000106',$1,$2,$3,'signed',
          'background_collection',1,2,NULL,transaction_timestamp(),transaction_timestamp())`, [
        NEON_TEST_ORGANIZATION.id, caseId, founder.userId,
      ]);
      signedAdvanceEvidence.fact_insert = true;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT case_flow_fact_insert_probe");
      await client.query("RELEASE SAVEPOINT case_flow_fact_insert_probe");
    }

    stage = "signed_advance_fact_and_case_update";
    await client.query("SAVEPOINT case_flow_fact_update_probe");
    try {
      await client.query(`INSERT INTO cases_service_case_transition_facts
        (id,organization_id,service_case_id,actor_user_id,from_stage,to_stage,
         from_record_version,to_record_version,reason,transitioned_at,created_at)
        VALUES ('66000000-0000-4000-8000-000000000107',$1,$2,$3,'signed',
          'background_collection',1,2,NULL,transaction_timestamp(),transaction_timestamp())`, [
        NEON_TEST_ORGANIZATION.id, caseId, founder.userId,
      ]);
      await client.query("SELECT set_config('app.case_stage_transition','authorized',true)");
      const diagnosticUpdate = await client.query(`UPDATE cases_service_cases
        SET stage='background_collection',record_version=2,updated_at=transaction_timestamp()
        WHERE id=$1 AND organization_id=$2 AND stage='signed' AND record_version=1`, [
        caseId, NEON_TEST_ORGANIZATION.id,
      ]);
      assert.equal(diagnosticUpdate.rowCount, 1);
      signedAdvanceEvidence.fact_and_case_update = true;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT case_flow_fact_update_probe");
      await client.query("RELEASE SAVEPOINT case_flow_fact_update_probe");
    }

    stage = "signed_advance_function";
    const advanced = await client.query<{
      decision: string;
      result_stage: string;
      result_record_version: string;
    }>("SELECT * FROM cases_advance_new_service_case($1,'founder',$2,transaction_timestamp())", [
      caseId, transitionFactId,
    ]);
    signedAdvanceEvidence.function_response_reached = true;
    assert.deepEqual(advanced.rows, [{
      decision: "allowed",
      result_stage: "background_collection",
      result_record_version: "2",
    }]);
    signedAdvanceEvidence.function_response_exact = true;
    stage = "signed_advance_commit";
    await client.query("COMMIT");
    signedAdvanceEvidence.transaction_commit_reached = true;

    stage = "fact_insert_rls_rejections";
    const deniedTransitionFactId = "66000000-0000-4000-8000-000000000116";
    const deniedLifecycleFactId = "66000000-0000-4000-8000-000000000117";
    await expectRlsRejectedTransaction(client, async () => {
      await client.query(`INSERT INTO cases_service_case_transition_facts
        (id,organization_id,service_case_id,actor_user_id,from_stage,to_stage,
         from_record_version,to_record_version,reason,transitioned_at,created_at)
        VALUES ($1,$2,$3,$4,'signed','background_collection',2,3,NULL,
          transaction_timestamp(),transaction_timestamp())`, [
        deniedTransitionFactId, NEON_TEST_ORGANIZATION.id, caseId, founder.userId,
      ]);
    });
    await expectRlsRejectedTransaction(client, async () => {
      await client.query(`INSERT INTO cases_service_case_lifecycle_facts
        (id,organization_id,service_case_id,actor_user_id,action,from_status,to_status,
         from_record_version,to_record_version,reason,occurred_at,created_at)
        VALUES ($1,$2,$3,$4,'pause','active','paused',2,3,'test-only reason',
          transaction_timestamp(),transaction_timestamp())`, [
        deniedLifecycleFactId, NEON_TEST_ORGANIZATION.id, caseId, founder.userId,
      ]);
    });
    await client.query("BEGIN");
    await setTenantContext(client, NEON_TEST_ORGANIZATION.id, founder.userId);
    const deniedFacts = await client.query<{ facts: string }>(`SELECT (
      (SELECT count(*) FROM cases_service_case_transition_facts WHERE id=$1)
      + (SELECT count(*) FROM cases_service_case_lifecycle_facts WHERE id=$2)
    )::text AS facts`, [deniedTransitionFactId, deniedLifecycleFactId]);
    assert.deepEqual(deniedFacts.rows, [{ facts: "0" }]);
    await client.query("ROLLBACK");

    stage = "invalid_initial_state";
    await expectRejectedTransaction(
      client, NEON_TEST_ORGANIZATION.id, founder.userId,
      async () => { await client.query(`INSERT INTO cases_service_cases
        (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
         primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,
         workflow_status,record_version)
        VALUES ('66000000-0000-4000-8000-000000000111',$1,$2,'CASE-FLOW-BACKGROUND',
          'k12',2091,'transfer',$3,$4,$5,'advisor','background_collection','active',1)`, [
        NEON_TEST_ORGANIZATION.id, NEON_TEST_STUDENTS[1]!.id, advisor.roleBindingId,
        advisor.membershipId, advisor.userId,
      ]); },
      "23514", "cases_service_cases_initial_state_check",
    );
    stage = "signed_only_commit";
    await expectRejectedTransaction(
      client, NEON_TEST_ORGANIZATION.id, founder.userId,
      async () => { await client.query(`INSERT INTO cases_service_cases
        (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
         primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,
         workflow_status,record_version)
        VALUES ('66000000-0000-4000-8000-000000000112',$1,$2,'CASE-FLOW-SIGNED-ONLY',
          'k12',2092,'transfer',$3,$4,$5,'advisor','signed','active',1)`, [
        NEON_TEST_ORGANIZATION.id, NEON_TEST_STUDENTS[1]!.id, advisor.roleBindingId,
        advisor.membershipId, advisor.userId,
      ]); },
      "23514", "cases_service_cases_signed_commit_check",
    );
    stage = "founder_primary";
    await expectRejectedTransaction(
      client, NEON_TEST_ORGANIZATION.id, founder.userId,
      async () => { await client.query(`INSERT INTO cases_service_cases
        (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
         primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,
         workflow_status,record_version)
        VALUES ('66000000-0000-4000-8000-000000000113',$1,$2,'CASE-FLOW-FOUNDER',
          'k12',2093,'transfer',$3,$4,$5,'founder','signed','active',1)`, [
        NEON_TEST_ORGANIZATION.id, NEON_TEST_STUDENTS[1]!.id, founder.roleBindingId,
        founder.membershipId, founder.userId,
      ]); },
      "23514", "cases_service_cases_active_principal_check",
    );

    stage = "non_primary_advisor_advance";
    await client.query("BEGIN");
    await setTenantContext(client, NEON_TEST_ORGANIZATION.id, otherAdvisor.userId);
    await client.query(`INSERT INTO cases_service_cases
      (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
       primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,
       workflow_status,record_version)
      VALUES ('66000000-0000-4000-8000-000000000114',$1,$2,'CASE-FLOW-NONPRIMARY',
        'k12',2094,'transfer',$3,$4,$5,'advisor','signed','active',1)`, [
      NEON_TEST_ORGANIZATION.id, NEON_TEST_STUDENTS[1]!.id, advisor.roleBindingId,
      advisor.membershipId, advisor.userId,
    ]);
    const deniedAdvance = await client.query<{ decision: string }>(
      "SELECT decision FROM cases_advance_new_service_case($1,'advisor',$2,transaction_timestamp())",
      ["66000000-0000-4000-8000-000000000114", "66000000-0000-4000-8000-000000000115"],
    );
    assert.equal(deniedAdvance.rows[0]?.decision, "CASE_WORKSPACE_NOT_FOUND");
    await client.query("ROLLBACK");

    stage = "manifest_and_answers";
    await client.query("BEGIN");
    await setTenantContext(client, NEON_TEST_ORGANIZATION.id, advisor.userId);
    await client.query(`SELECT cases_assert_case_flow_v1_manifest($1)`, [NEON_TEST_MANIFEST_ID]);
    await client.query(`INSERT INTO cases_assessment_answers
      (id,organization_id,assessment_id,manifest_id,module_layer,module_id,module_version,
       field_id,semantic_state,value_json,value_type,source,visibility,is_derived,updated_by_user_id)
      SELECT gen_random_uuid(),$1,$2,field.manifest_id,field.module_layer,field.module_id,
             field.module_version,field.field_id,'provided',
             jsonb_build_object('type',field.value_type,'value','synthetic'),field.value_type,
             'advisor_input',field.visibility,false,$3
        FROM cases_schema_manifest_fields AS field
       WHERE field.manifest_id=$4`, [
      NEON_TEST_ORGANIZATION.id, assessmentId, advisor.userId, NEON_TEST_MANIFEST_ID,
    ]);
    for (const stage of ["background_complete", "selection_ready"] as const) {
      const missing = await client.query<{ field_id: string }>(
        "SELECT field_id FROM cases_lock_assessment_blockers($1,$2,$3)",
        [assessmentId, NEON_TEST_MANIFEST_ID, stage],
      );
      assert.deepEqual(missing.rows, []);
    }
    await client.query("COMMIT");

    stage = "background_blocker_rejections";
    for (const semanticState of ["unknown", "declined_to_provide", "not_applicable"] as const) {
      await expectRejectedTransaction(
        client, NEON_TEST_ORGANIZATION.id, advisor.userId,
        async () => {
          await client.query(`UPDATE cases_assessment_answers
            SET semantic_state=$3,value_json=NULL,value_type=NULL,record_version=record_version+1,
                updated_by_user_id=$4,updated_at=transaction_timestamp()
            WHERE assessment_id=$1 AND field_id=$2`, [
            assessmentId, blockerField, semanticState, advisor.userId,
          ]);
          await client.query(`UPDATE cases_assessments
            SET status='background_complete',record_version=record_version+1,
                updated_at=transaction_timestamp() WHERE id=$1`, [assessmentId]);
        },
        "23514", "cases_assessments_blockers_incomplete_check",
      );
    }

    stage = "background_complete";
    await client.query("BEGIN");
    await setTenantContext(client, NEON_TEST_ORGANIZATION.id, advisor.userId);
    await client.query(`UPDATE cases_assessments
      SET status='background_complete',record_version=record_version+1,
      updated_at=transaction_timestamp() WHERE id=$1`, [assessmentId]);
    await client.query("COMMIT");

    stage = "selection_blocker_rejections";
    for (const semanticState of ["unknown", "declined_to_provide", "not_applicable"] as const) {
      await expectRejectedTransaction(
        client, NEON_TEST_ORGANIZATION.id, advisor.userId,
        async () => {
          await client.query(`UPDATE cases_assessment_answers
            SET semantic_state=$3,value_json=NULL,value_type=NULL,record_version=record_version+1,
                updated_by_user_id=$4,updated_at=transaction_timestamp()
            WHERE assessment_id=$1 AND field_id=$2`, [
            assessmentId, blockerField, semanticState, advisor.userId,
          ]);
          await client.query(`UPDATE cases_assessments
            SET status='selection_ready',record_version=record_version+1,
                updated_at=transaction_timestamp() WHERE id=$1`, [assessmentId]);
        },
        "23514", "cases_assessments_blockers_incomplete_check",
      );
    }
    stage = "selection_ready";
    await client.query("BEGIN");
    await setTenantContext(client, NEON_TEST_ORGANIZATION.id, advisor.userId);
    await client.query(`UPDATE cases_assessments
      SET status='selection_ready',record_version=record_version+1,
      updated_at=transaction_timestamp() WHERE id=$1`, [assessmentId]);
    await client.query("COMMIT");

    stage = "legacy_school_target_denial";
    await client.query("BEGIN");
    await setTenantContext(client, NEON_TEST_ORGANIZATION.id, advisor.userId);
    const effectsBefore = await client.query<{ targets: string; receipts: string; audit: string; outbox: string }>(
      `SELECT (SELECT count(*) FROM cases_school_targets)::text AS targets,
              (SELECT count(*) FROM shared_idempotency_records)::text AS receipts,
              (SELECT count(*) FROM audit_events)::text AS audit,
              (SELECT count(*) FROM audit_outbox)::text AS outbox`,
    );
    try {
      await client.query(
        "SELECT * FROM cases_create_candidate_school_target($1,$2,$3,$4,$5,transaction_timestamp())",
        [caseId, "66000000-0000-4000-8000-000000000121",
          "66000000-0000-4000-8000-000000000122",
          "66000000-0000-4000-8000-000000000123", "a".repeat(64)],
      );
      throw new HarnessError("school_target_function_unexpected_allow");
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      const postgres = error as { readonly code?: unknown; readonly constraint?: unknown };
      assert.equal(postgres.code, "42501");
      assert.equal(postgres.constraint, "cases_candidate_school_target_decommissioned_check");
    }
    await client.query("ROLLBACK");
    stage = "effects_zero";
    await client.query("BEGIN");
    await setTenantContext(client, NEON_TEST_ORGANIZATION.id, advisor.userId);
    const effectsAfter = await client.query<{ targets: string; receipts: string; audit: string; outbox: string }>(
      `SELECT (SELECT count(*) FROM cases_school_targets)::text AS targets,
              (SELECT count(*) FROM shared_idempotency_records)::text AS receipts,
              (SELECT count(*) FROM audit_events)::text AS audit,
              (SELECT count(*) FROM audit_outbox)::text AS outbox`,
    );
    assert.deepEqual(effectsAfter.rows, effectsBefore.rows);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    writeCaseFlowInvariantFailure(stage, error, signedAdvanceEvidence);
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("case_flow_foundation_invariant");
  } finally {
    await client.end().catch(() => {});
  }
}

function writeCaseFlowInvariantFailure(
  stage: CaseFlowInvariantStage,
  error: unknown,
  signedAdvance: SignedAdvanceDiagnosticEvidence,
): void {
  let postgresCode = "NULL";
  let postgresConstraint = "NULL";
  if (error instanceof Error) {
    const candidate = error as Error & {
      readonly code?: unknown;
      readonly constraint?: unknown;
      readonly severity?: unknown;
    };
    if (
      typeof candidate.severity === "string"
      && SAFE_POSTGRES_ERROR_SEVERITIES.has(candidate.severity)
      && typeof candidate.code === "string"
      && /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      postgresCode = SAFE_BASELINE_POSTGRES_CODES.has(candidate.code)
        ? candidate.code
        : "OTHER";
      if (typeof candidate.constraint === "string") {
        postgresConstraint = SAFE_CASE_FLOW_POSTGRES_CONSTRAINTS.has(candidate.constraint)
          ? candidate.constraint
          : "OTHER";
      }
    }
  }
  process.stdout.write(`${JSON.stringify({
    event: "case_flow_foundation_invariant_failure",
    status: "failed",
    stage,
    postgres_code: postgresCode,
    postgres_constraint: postgresConstraint,
    signed_advance: signedAdvance,
  })}\n`);
}

type CaseFactPolicyEvidence = Readonly<{
  table_name: string;
  enable_rls: boolean;
  force_rls: boolean;
  exact_policy_count: boolean;
  select_policy_exact: boolean;
  insert_policy_exact: boolean;
  select_privilege: boolean;
  insert_privilege: boolean;
  update_privilege: boolean;
  delete_privilege: boolean;
}>;

async function readCaseFactPolicyEvidence(client: Client): Promise<readonly CaseFactPolicyEvidence[]> {
  const result = await client.query<CaseFactPolicyEvidence>(`WITH fact_tables(table_name) AS (
    VALUES ('cases_service_case_lifecycle_facts'::text),
           ('cases_service_case_transition_facts'::text)
  )
  SELECT fact.table_name,
         class.relrowsecurity AS enable_rls,
         class.relforcerowsecurity AS force_rls,
         has_table_privilege(current_user,'public.' || fact.table_name,'SELECT')
           AS select_privilege,
         has_table_privilege(current_user,'public.' || fact.table_name,'INSERT')
           AS insert_privilege,
         has_table_privilege(current_user,'public.' || fact.table_name,'UPDATE')
           AS update_privilege,
         has_table_privilege(current_user,'public.' || fact.table_name,'DELETE')
           AS delete_privilege,
         count(policy.*)=2 AS exact_policy_count,
         count(*) FILTER (
           WHERE policy.polname='tianxing_tenant_boundary'
             AND policy.polcmd='r'
             AND policy.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname=$1)]::oid[]
             AND regexp_replace(pg_get_expr(policy.polqual,policy.polrelid),'[[:space:]()]|::text','','g')=
               'organization_id=current_setting''app.organization_id'',true'
             AND policy.polwithcheck IS NULL
         )=1 AS select_policy_exact,
         count(*) FILTER (
           WHERE policy.polname='tianxing_tenant_insert_boundary'
             AND policy.polcmd='a'
             AND policy.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname=$1)]::oid[]
             AND policy.polqual IS NULL
             AND regexp_replace(pg_get_expr(policy.polwithcheck,policy.polrelid),'[[:space:]()]|::text','','g')=
               'organization_id=current_setting''app.organization_id'',true'
         )=1 AS insert_policy_exact
    FROM fact_tables AS fact
    JOIN pg_class AS class ON class.oid=('public.' || fact.table_name)::regclass
    LEFT JOIN pg_policy AS policy ON policy.polrelid=class.oid
   GROUP BY fact.table_name,class.relrowsecurity,class.relforcerowsecurity
   ORDER BY fact.table_name`, [ONE_ROLE_CANONICAL_ROLE]);
  return result.rows;
}

type CaseUpdatePrivilegeEvidence = Readonly<{
  table_update: boolean;
  id_update: boolean;
  stage_update: boolean;
  workflow_status_update: boolean;
  record_version_update: boolean;
  updated_at_update: boolean;
  organization_id_update: boolean;
  student_id_update: boolean;
  case_number_update: boolean;
  application_type_update: boolean;
  intake_year_update: boolean;
  admission_type_update: boolean;
  primary_role_binding_id_update: boolean;
  primary_membership_id_update: boolean;
  primary_user_id_update: boolean;
  primary_role_update: boolean;
  created_at_update: boolean;
}>;

async function readCaseUpdatePrivilegeEvidence(
  client: Client,
): Promise<readonly CaseUpdatePrivilegeEvidence[]> {
  const result = await client.query<CaseUpdatePrivilegeEvidence>(`SELECT
    has_table_privilege(current_user,'cases_service_cases','UPDATE') AS table_update,
    has_column_privilege(current_user,'cases_service_cases','id','UPDATE') AS id_update,
    has_column_privilege(current_user,'cases_service_cases','stage','UPDATE') AS stage_update,
    has_column_privilege(current_user,'cases_service_cases','workflow_status','UPDATE')
      AS workflow_status_update,
    has_column_privilege(current_user,'cases_service_cases','record_version','UPDATE')
      AS record_version_update,
    has_column_privilege(current_user,'cases_service_cases','updated_at','UPDATE') AS updated_at_update,
    has_column_privilege(current_user,'cases_service_cases','organization_id','UPDATE')
      AS organization_id_update,
    has_column_privilege(current_user,'cases_service_cases','student_id','UPDATE')
      AS student_id_update,
    has_column_privilege(current_user,'cases_service_cases','case_number','UPDATE')
      AS case_number_update,
    has_column_privilege(current_user,'cases_service_cases','application_type','UPDATE')
      AS application_type_update,
    has_column_privilege(current_user,'cases_service_cases','intake_year','UPDATE')
      AS intake_year_update,
    has_column_privilege(current_user,'cases_service_cases','admission_type','UPDATE')
      AS admission_type_update,
    has_column_privilege(current_user,'cases_service_cases','primary_role_binding_id','UPDATE')
      AS primary_role_binding_id_update,
    has_column_privilege(current_user,'cases_service_cases','primary_membership_id','UPDATE')
      AS primary_membership_id_update,
    has_column_privilege(current_user,'cases_service_cases','primary_user_id','UPDATE')
      AS primary_user_id_update,
    has_column_privilege(current_user,'cases_service_cases','primary_role','UPDATE')
      AS primary_role_update,
    has_column_privilege(current_user,'cases_service_cases','created_at','UPDATE')
      AS created_at_update`);
  return result.rows;
}

async function expectRlsRejectedTransaction(
  client: Client,
  operation: () => Promise<void>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await operation();
    await client.query("COMMIT");
    throw new HarnessError("fact_insert_rls_unexpected_allow");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    assert.equal((error as { readonly code?: unknown }).code, "42501");
  }
}

async function setTenantContext(client: Client, organizationId: string, actorId: string): Promise<void> {
  await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
  await client.query("SELECT set_config('app.actor_user_id',$1,true)", [actorId]);
}

async function expectRejectedTransaction(
  client: Client,
  organizationId: string,
  actorId: string,
  operation: () => Promise<void>,
  expectedCode: string,
  expectedConstraint: string,
): Promise<void> {
  await client.query("BEGIN");
  await setTenantContext(client, organizationId, actorId);
  try {
    await operation();
    await client.query("COMMIT");
    throw new HarnessError("primary_contact_expected_rejection");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    const postgres = error as { readonly code?: unknown; readonly constraint?: unknown };
    assert.equal(postgres.code, expectedCode);
    assert.equal(postgres.constraint, expectedConstraint);
  }
}

async function inspectWithNewClient(
  target: OneRoleBaselineTarget,
): Promise<OneRoleBaselineDatabaseState> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await inspectOneRoleBaselineDatabase(client);
  } catch {
    throw new HarnessError("postgres_state_inspection");
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

async function readPostgresVersion(
  clientConfig: ReturnType<typeof createOneRoleBaselineClientConfig>,
): Promise<string> {
  const client = new Client(clientConfig);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const result = await client.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    const version = result.rows[0]?.version;
    if (!version) throw new HarnessError("postgres_version_inspection");
    return version;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("postgres_version_inspection");
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

function localIntegrationTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({
    connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`,
    host: "127.0.0.1",
    port,
    database: "tianxing",
    user: ONE_ROLE_CANONICAL_ROLE,
    ssl: false,
  });
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = await runDocker([
      "exec",
      containerName,
      "pg_isready",
      "--host=127.0.0.1",
      "--username=postgres",
      "--dbname=postgres",
    ], "postgres_readiness", undefined, process.env, true);
    if (probe.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new HarnessError("postgres_readiness_timeout");
}

function readLoopbackPort(output: string): number {
  const match = /^127\.0\.0\.1:([0-9]+)\s*$/.exec(output);
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new HarnessError("postgres_port_inspection");
  }
  return port;
}

class HarnessError extends Error {
  readonly code = "ONE_ROLE_POSTGRESQL_HARNESS_FAILED" as const;
  readonly stage: string;

  constructor(stage: string) {
    super(`One-role PostgreSQL integration harness failed at ${stage}.`);
    this.name = "HarnessError";
    this.stage = stage;
  }
}

async function runDocker(
  arguments_: readonly string[],
  failureStage: string,
  input?: string,
  environment: NodeJS.ProcessEnv = process.env,
  allowFailure = false,
): Promise<Readonly<{ exitCode: number; stdout: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", () => {});
    child.once("error", () => reject(new HarnessError(failureStage)));
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !allowFailure) {
        reject(new HarnessError(failureStage));
        return;
      }
      resolve(Object.freeze({ exitCode, stdout }));
    });
    child.stdin.end(input);
  });
}
