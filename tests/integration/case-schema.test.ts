import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { Client } from "pg";

import {
  K12_MODULE_LAYERS,
  composeK12Manifest,
  evaluateAssessmentAnswer,
  evaluateAssessmentStatus,
  evaluateServiceCaseCreation,
  evaluateSchoolTargetCreation,
  evaluateSchoolTargetTransition,
  evaluateTargetOutcome,
  parseK12Module,
} from "../../modules/cases/contract.ts";
import { planMigration } from "../../scripts/db/plan-migration.ts";

const MODULE_PATHS = [
  "base.synthetic.v1.json",
  "education-stage.synthetic.v1.json",
  "school-system.synthetic.v1.json",
  "admission-route.synthetic.v1.json",
] as const;

test("composes the four structural K12 modules into a deterministic manifest", async () => {
  const modules = await readSyntheticModules();
  const manifest = composeK12Manifest(modules);

  assert.deepEqual(
    modules.map(({ layer }) => layer).sort(),
    [...K12_MODULE_LAYERS].sort(),
  );
  assert.equal(manifest.applicationType, "k12");
  assert.equal(manifest.modules.length, 4);
  assert.equal(manifest.fields.length, 4);
  assert.equal(
    manifest.contentSha256,
    "12dcb1fc0e37e80f05e3f506e5633782c3e6fb35290d6891054ba49e72228564",
  );
  assert.equal(manifest.productionEnabled, false);
  assert.equal(Object.isFrozen(manifest.modules), true);
  assert.equal(Object.isFrozen(manifest.modules[0]), true);
  assert.equal(Object.isFrozen(manifest.fields[0]), true);
});

test("rejects a missing K12 module layer", async () => {
  const modules = await readSyntheticModules();

  assert.throws(
    () => composeK12Manifest(modules.filter(({ layer }) => layer !== "school_system")),
    (error: unknown) => hasCode(error, "K12_MODULE_SET_INCOMPLETE"),
  );
});

test("rejects duplicate field identities across K12 modules", async () => {
  const modules = await readSyntheticModules();
  const [baseModule, ...otherModules] = modules;
  assert.ok(baseModule);

  const duplicateBase = {
    ...baseModule,
    fields: [
      ...baseModule.fields,
      {
        ...baseModule.fields[0],
        fieldId: otherModules[0]?.fields[0]?.fieldId ?? "fixture.missing",
      },
    ],
  };

  assert.throws(
    () => composeK12Manifest([duplicateBase, ...otherModules]),
    (error: unknown) => hasCode(error, "K12_FIELD_ID_DUPLICATE"),
  );
});

test("allows only an active K12 case with an approved primary binding", () => {
  assert.deepEqual(
    evaluateServiceCaseCreation({
      applicationType: "k12",
      organizationId: "org-1",
      studentOrganizationId: "org-1",
      studentStatus: "active",
      primaryRole: "advisor",
      primaryOrganizationId: "org-1",
      primaryBindingStatus: "active",
      manifestStatus: "approved",
      initialStage: "signed",
    }),
    { allowed: true },
  );
});

test("denies non-K12, cross-tenant, inactive-primary, and unapproved case creation", () => {
  const validInput = {
    applicationType: "k12",
    organizationId: "org-1",
    studentOrganizationId: "org-1",
    studentStatus: "active" as const,
    primaryRole: "advisor" as const,
    primaryOrganizationId: "org-1",
    primaryBindingStatus: "active" as const,
    manifestStatus: "approved" as const,
    initialStage: "signed" as const,
  };

  assert.deepEqual(
    evaluateServiceCaseCreation({ ...validInput, applicationType: "university" }),
    { allowed: false, code: "NON_K12_APPLICATION" },
  );
  assert.deepEqual(
    evaluateServiceCaseCreation({ ...validInput, studentOrganizationId: "org-2" }),
    { allowed: false, code: "TENANT_CONTEXT_MISMATCH" },
  );
  assert.deepEqual(
    evaluateServiceCaseCreation({ ...validInput, primaryBindingStatus: "revoked" }),
    { allowed: false, code: "PRIMARY_BINDING_INACTIVE" },
  );
  assert.deepEqual(
    evaluateServiceCaseCreation({ ...validInput, manifestStatus: "candidate" }),
    { allowed: false, code: "MANIFEST_NOT_APPROVED" },
  );
});

test("accepts each explicit assessment answer semantic state", () => {
  for (const semanticState of [
    "unknown",
    "not_applicable",
    "declined_to_provide",
  ] as const) {
    assert.deepEqual(
      evaluateAssessmentAnswer({
        semanticState,
        value: null,
        valueType: null,
        manifestValueType: "text",
      }),
      { allowed: true },
    );
  }

  assert.deepEqual(
    evaluateAssessmentAnswer({
      semanticState: "provided",
      value: { type: "text", value: "synthetic" },
      valueType: "text",
      manifestValueType: "text",
    }),
    { allowed: true },
  );
});

test("rejects mixed, missing, and mismatched assessment answer values", () => {
  const semanticStateInput = {
    semanticState: "unknown" as const,
    value: null,
    valueType: null,
    manifestValueType: "text",
  };

  assert.deepEqual(
    evaluateAssessmentAnswer({
      ...semanticStateInput,
      value: "unexpected",
    }),
    { allowed: false, code: "ANSWER_VALUE_FORBIDDEN" },
  );
  assert.deepEqual(
    evaluateAssessmentAnswer({
      semanticState: "provided",
      value: null,
      valueType: "text",
      manifestValueType: "text",
    }),
    { allowed: false, code: "ANSWER_VALUE_REQUIRED" },
  );
  assert.deepEqual(
    evaluateAssessmentAnswer({
      semanticState: "provided",
      value: { type: "number", value: 1 },
      valueType: "number",
      manifestValueType: "text",
    }),
    { allowed: false, code: "ANSWER_VALUE_TYPE_MISMATCH" },
  );
});

test("requires an approved manifest and complete blockers before assessment advancement", () => {
  const draft = {
    manifestStatus: "approved" as const,
    targetStatus: "draft" as const,
    requiredBlockingFieldIds: ["fixture.base.intent"],
    satisfiedBlockingFieldIds: [],
  };

  assert.deepEqual(evaluateAssessmentStatus(draft), { allowed: true });
  assert.deepEqual(
    evaluateAssessmentStatus({ ...draft, targetStatus: "background_complete" }),
    { allowed: false, code: "ASSESSMENT_BLOCKERS_INCOMPLETE" },
  );
  assert.deepEqual(
    evaluateAssessmentStatus({
      ...draft,
      targetStatus: "selection_ready",
      satisfiedBlockingFieldIds: ["fixture.base.intent"],
    }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateAssessmentStatus({ ...draft, manifestStatus: "retired" }),
    { allowed: false, code: "MANIFEST_NOT_APPROVED" },
  );
});

test("keeps live target creation and route transitions fail closed", () => {
  assert.deepEqual(
    evaluateSchoolTargetCreation({ initialState: "candidate" }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateSchoolTargetCreation({ initialState: "accepted" }),
    { allowed: false, code: "INVALID_INITIAL_TARGET_STATE" },
  );
  assert.deepEqual(
    evaluateSchoolTargetTransition({
      from: "candidate",
      to: "preparing",
      routePolicyApproved: false,
    }),
    { allowed: false, code: "TARGET_ROUTE_POLICY_REQUIRED" },
  );
});

test("requires one matching current outcome for terminal target facts", () => {
  assert.deepEqual(
    evaluateTargetOutcome({ targetState: "candidate", currentOutcomeCode: null }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateTargetOutcome({ targetState: "accepted", currentOutcomeCode: null }),
    { allowed: false, code: "TARGET_OUTCOME_REQUIRED" },
  );
  assert.deepEqual(
    evaluateTargetOutcome({ targetState: "accepted", currentOutcomeCode: "rejected" }),
    { allowed: false, code: "TARGET_OUTCOME_MISMATCH" },
  );
  assert.deepEqual(
    evaluateTargetOutcome({ targetState: "accepted", currentOutcomeCode: "accepted" }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateTargetOutcome({ targetState: "candidate", currentOutcomeCode: "accepted" }),
    { allowed: false, code: "OUTCOME_NOT_ALLOWED" },
  );
});

test("publishes the approved CaseWorkflow SQL through the migration planner", async () => {
  const plan = await planMigration({
    migrationDirectory: resolve("db/migrations"),
    snapshot: {
      target: "empty",
      applied: [],
      expectedSchemaSha256: null,
      actualSchemaSha256: null,
    },
  });

  assert.equal(plan.status, "pass");
  assert.deepEqual(plan.findings, []);
  assert.deepEqual(
    plan.migrations.find(({ name }) => name === "202608021830_003_expand_cases.sql"),
    {
      name: "202608021830_003_expand_cases.sql",
      sha256: "9bc3064eb8bbc82613b11a7627754b074eb5a13c905d4fdc1e5319039f9774b6",
      state: "pending",
    },
  );
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "applies the additive CaseWorkflow schema and enforces case, manifest, answer, target, and outcome invariants",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is required for PostgreSQL evidence" },
  async () => {
    const identitySql = await readFile(
      resolve("db/migrations/202608021330_001_expand_identity_access.sql"),
      "utf8",
    );
    const crmSql = await readFile(
      resolve("db/migrations/202608021630_002_expand_crm.sql"),
      "utf8",
    );
    const casesSql = await readFile(
      resolve("db/migrations/202608021830_003_expand_cases.sql"),
      "utf8",
    );
    const client = new Client({ connectionString: testDatabaseUrl });

    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(identitySql);
      await client.query(crmSql);
      await client.query(casesSql);
      await assertCaseTables(client);
      await seedCaseFixture(client);
      await assertCaseUniqueness(client);
      await assertManifestAndAnswerInvariants(client);
      await assertTargetAndOutcomeInvariants(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  },
);

async function assertCaseTables(client: Client): Promise<void> {
  const result = await client.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
      ORDER BY tablename`,
    [[
      "cases_assessment_answers",
      "cases_assessments",
      "cases_case_outcomes",
      "cases_schema_manifest_fields",
      "cases_schema_manifests",
      "cases_school_targets",
      "cases_service_cases",
    ]],
  );

  assert.deepEqual(result.rows.map(({ tablename }) => tablename), [
    "cases_assessment_answers",
    "cases_assessments",
    "cases_case_outcomes",
    "cases_schema_manifest_fields",
    "cases_schema_manifests",
    "cases_school_targets",
    "cases_service_cases",
  ]);

  const tenantConstraints = await client.query<{ conname: string }>(`
    SELECT conname
      FROM pg_catalog.pg_constraint
     WHERE conname IN (
       'cases_service_cases_student_fk',
       'cases_service_cases_primary_role_fk',
       'cases_assessments_case_fk',
       'cases_answers_assessment_fk',
       'cases_targets_case_fk',
       'cases_outcomes_target_fk'
     )
     ORDER BY conname;
  `);
  assert.deepEqual(tenantConstraints.rows.map(({ conname }) => conname), [
    "cases_answers_assessment_fk",
    "cases_assessments_case_fk",
    "cases_outcomes_target_fk",
    "cases_service_cases_primary_role_fk",
    "cases_service_cases_student_fk",
    "cases_targets_case_fk",
  ]);
}

async function seedCaseFixture(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO identity_users (id, normalized_email, status)
    VALUES
      ('00000000-0000-4000-8000-000000000021', 'case-founder@example.invalid', 'active'),
      ('00000000-0000-4000-8000-000000000022', 'case-advisor@example.invalid', 'active');

    INSERT INTO access_organizations (id, display_name, status, created_by_user_id)
    VALUES (
      '10000000-0000-4000-8000-000000000021',
      'Tianxing Case Synthetic',
      'active',
      '00000000-0000-4000-8000-000000000021'
    );

    INSERT INTO access_organization_memberships (
      id, organization_id, user_id, status, created_by_user_id
    ) VALUES
      (
        '20000000-0000-4000-8000-000000000021',
        '10000000-0000-4000-8000-000000000021',
        '00000000-0000-4000-8000-000000000021',
        'active',
        '00000000-0000-4000-8000-000000000021'
      ),
      (
        '20000000-0000-4000-8000-000000000022',
        '10000000-0000-4000-8000-000000000021',
        '00000000-0000-4000-8000-000000000022',
        'active',
        '00000000-0000-4000-8000-000000000021'
      );

    INSERT INTO access_role_bindings (
      id, organization_id, membership_id, user_id, role, status, created_by_user_id
    ) VALUES
      (
        '30000000-0000-4000-8000-000000000021',
        '10000000-0000-4000-8000-000000000021',
        '20000000-0000-4000-8000-000000000021',
        '00000000-0000-4000-8000-000000000021',
        'founder',
        'active',
        '00000000-0000-4000-8000-000000000021'
      ),
      (
        '30000000-0000-4000-8000-000000000022',
        '10000000-0000-4000-8000-000000000021',
        '20000000-0000-4000-8000-000000000022',
        '00000000-0000-4000-8000-000000000022',
        'advisor',
        'active',
        '00000000-0000-4000-8000-000000000021'
      );

    INSERT INTO crm_students (id, organization_id, display_name, status)
    VALUES
      (
        '40000000-0000-4000-8000-000000000021',
        '10000000-0000-4000-8000-000000000021',
        'Synthetic Student One',
        'active'
      ),
      (
        '40000000-0000-4000-8000-000000000022',
        '10000000-0000-4000-8000-000000000021',
        'Synthetic Student Two',
        'active'
      );

    INSERT INTO crm_guardians (id, organization_id, display_name, status)
    VALUES (
      '50000000-0000-4000-8000-000000000021',
      '10000000-0000-4000-8000-000000000021',
      'Synthetic Guardian',
      'active'
    );

    INSERT INTO crm_student_guardian_relationships (
      id,
      organization_id,
      student_id,
      guardian_id,
      relationship_type,
      is_legal_guardian,
      is_primary_contact,
      is_emergency_contact,
      is_billing_contact,
      notification_consent,
      starts_at
    ) VALUES
      (
        '60000000-0000-4000-8000-000000000021',
        '10000000-0000-4000-8000-000000000021',
        '40000000-0000-4000-8000-000000000021',
        '50000000-0000-4000-8000-000000000021',
        'parent',
        true,
        true,
        true,
        true,
        true,
        '2000-01-01T00:00:00.000Z'
      ),
      (
        '60000000-0000-4000-8000-000000000022',
        '10000000-0000-4000-8000-000000000021',
        '40000000-0000-4000-8000-000000000022',
        '50000000-0000-4000-8000-000000000021',
        'parent',
        true,
        true,
        true,
        true,
        true,
        '2000-01-01T00:00:00.000Z'
      );

    INSERT INTO cases_schema_manifests (
      id,
      application_type,
      composition_version,
      base_module_id,
      base_module_version,
      education_stage_module_id,
      education_stage_module_version,
      school_system_module_id,
      school_system_module_version,
      admission_route_module_id,
      admission_route_module_version,
      content_sha256,
      status
    ) VALUES (
      '70000000-0000-4000-8000-000000000021',
      'k12',
      'k12-structural-v1',
      'k12-base-synthetic',
      '1.0.0',
      'k12-education-stage-synthetic',
      '1.0.0',
      'k12-school-system-synthetic',
      '1.0.0',
      'k12-admission-route-synthetic',
      '1.0.0',
      '12dcb1fc0e37e80f05e3f506e5633782c3e6fb35290d6891054ba49e72228564',
      'candidate'
    );

    INSERT INTO cases_schema_manifest_fields (
      manifest_id,
      module_layer,
      module_id,
      module_version,
      field_id,
      value_type,
      visibility,
      blocking_stages
    ) VALUES
      (
        '70000000-0000-4000-8000-000000000021',
        'base',
        'k12-base-synthetic',
        '1.0.0',
        'fixture.base.intent',
        'text',
        'advisor',
        '["background_complete"]'
      ),
      (
        '70000000-0000-4000-8000-000000000021',
        'education_stage',
        'k12-education-stage-synthetic',
        '1.0.0',
        'fixture.education_stage.selection',
        'text',
        'advisor',
        '["background_complete"]'
      ),
      (
        '70000000-0000-4000-8000-000000000021',
        'school_system',
        'k12-school-system-synthetic',
        '1.0.0',
        'fixture.school_system.preference',
        'text',
        'advisor',
        '["selection_ready"]'
      ),
      (
        '70000000-0000-4000-8000-000000000021',
        'admission_route',
        'k12-admission-route-synthetic',
        '1.0.0',
        'fixture.admission_route.path',
        'text',
        'advisor',
        '["selection_ready"]'
      );

    UPDATE cases_schema_manifests
       SET status = 'approved',
           approved_by_user_id = '00000000-0000-4000-8000-000000000021',
           approved_at = transaction_timestamp(),
           updated_at = transaction_timestamp()
     WHERE id = '70000000-0000-4000-8000-000000000021';

    INSERT INTO cases_service_cases (
      id,
      organization_id,
      student_id,
      case_number,
      application_type,
      intake_year,
      admission_type,
      primary_role_binding_id,
      primary_membership_id,
      primary_user_id,
      primary_role,
      stage
    ) VALUES (
      '80000000-0000-4000-8000-000000000021',
      '10000000-0000-4000-8000-000000000021',
      '40000000-0000-4000-8000-000000000021',
      'CASE-SYN-001',
      'k12',
      2027,
      's1',
      '30000000-0000-4000-8000-000000000022',
      '20000000-0000-4000-8000-000000000022',
      '00000000-0000-4000-8000-000000000022',
      'advisor',
      'signed'
    );

    INSERT INTO cases_assessments (
      id, organization_id, service_case_id, manifest_id, status
    ) VALUES (
      '81000000-0000-4000-8000-000000000021',
      '10000000-0000-4000-8000-000000000021',
      '80000000-0000-4000-8000-000000000021',
      '70000000-0000-4000-8000-000000000021',
      'draft'
    );
  `);
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  await client.query("SET CONSTRAINTS ALL DEFERRED");
}

async function assertCaseUniqueness(client: Client): Promise<void> {
  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO cases_service_cases (
          id,
          organization_id,
          student_id,
          case_number,
          application_type,
          intake_year,
          admission_type,
          primary_role_binding_id,
          primary_membership_id,
          primary_user_id,
          primary_role,
          stage
        ) VALUES (
          '80000000-0000-4000-8000-000000000022',
          '10000000-0000-4000-8000-000000000021',
          '40000000-0000-4000-8000-000000000021',
          'CASE-SYN-002',
          'k12',
          2027,
          's1',
          '30000000-0000-4000-8000-000000000022',
          '20000000-0000-4000-8000-000000000022',
          '00000000-0000-4000-8000-000000000022',
          'advisor',
          'signed'
        )
      `),
    "23505",
    "cases_service_cases_one_active_student_case_idx",
  );

  await client.query(`
    INSERT INTO cases_service_cases (
      id,
      organization_id,
      student_id,
      case_number,
      application_type,
      intake_year,
      admission_type,
      primary_role_binding_id,
      primary_membership_id,
      primary_user_id,
      primary_role,
      stage
    ) VALUES (
      '80000000-0000-4000-8000-000000000023',
      '10000000-0000-4000-8000-000000000021',
      '40000000-0000-4000-8000-000000000022',
      'CASE-SYN-CLOSED',
      'k12',
      2028,
      's1',
      '30000000-0000-4000-8000-000000000022',
      '20000000-0000-4000-8000-000000000022',
      '00000000-0000-4000-8000-000000000022',
      'advisor',
      'closed'
    ), (
      '80000000-0000-4000-8000-000000000024',
      '10000000-0000-4000-8000-000000000021',
      '40000000-0000-4000-8000-000000000022',
      'CASE-SYN-004',
      'k12',
      2028,
      's1',
      '30000000-0000-4000-8000-000000000022',
      '20000000-0000-4000-8000-000000000022',
      '00000000-0000-4000-8000-000000000022',
      'advisor',
      'signed'
    );
  `);

  await expectSqlState(
    client,
    () =>
      client.query(`
        DELETE FROM cases_service_cases
         WHERE id = '80000000-0000-4000-8000-000000000023'
      `),
    "23514",
    "cases_service_cases_delete_rejected",
  );
}

async function assertManifestAndAnswerInvariants(client: Client): Promise<void> {
  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO cases_assessments (
          id, organization_id, service_case_id, manifest_id, status
        ) VALUES (
          '81000000-0000-4000-8000-000000000022',
          '10000000-0000-4000-8000-000000000021',
          '80000000-0000-4000-8000-000000000021',
          '70000000-0000-4000-8000-000000000021',
          'draft'
        )
      `),
    "23505",
    "cases_assessments_one_case_manifest_idx",
  );

  await client.query(`
    INSERT INTO cases_assessment_answers (
      id,
      organization_id,
      assessment_id,
      manifest_id,
      module_layer,
      module_id,
      module_version,
      field_id,
      semantic_state,
      value_json,
      value_type,
      source,
      visibility,
      updated_by_user_id
    ) VALUES (
      '82000000-0000-4000-8000-000000000021',
      '10000000-0000-4000-8000-000000000021',
      '81000000-0000-4000-8000-000000000021',
      '70000000-0000-4000-8000-000000000021',
      'base',
      'k12-base-synthetic',
      '1.0.0',
      'fixture.base.intent',
      'provided',
      '{"type":"text","value":"synthetic"}',
      'text',
      'advisor_entered',
      'advisor',
      '00000000-0000-4000-8000-000000000022'
    );
  `);

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE cases_assessment_answers
           SET value_json = '{"type":"text","value":"stale"}',
               record_version = 3,
               updated_at = transaction_timestamp()
         WHERE id = '82000000-0000-4000-8000-000000000021'
      `),
    "23514",
    "cases_assessment_answers_record_version_transition_check",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE cases_assessment_answers
           SET value_json = '{"type":"text","value":"rollback"}',
               record_version = 2,
               updated_at = '1999-01-01T00:00:00.000Z'
         WHERE id = '82000000-0000-4000-8000-000000000021'
      `),
    "23514",
    "cases_assessment_answers_timestamps_check",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE cases_schema_manifest_fields
           SET value_type = 'number'
         WHERE manifest_id = '70000000-0000-4000-8000-000000000021'
           AND field_id = 'fixture.base.intent'
      `),
    "23514",
    "cases_schema_manifest_fields_immutable_check",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE cases_schema_manifests
           SET status = 'retired',
               approved_by_user_id = '00000000-0000-4000-8000-000000000022',
               retired_by_user_id = '00000000-0000-4000-8000-000000000021',
               retired_at = transaction_timestamp(),
               retirement_reason = 'Synthetic receipt mutation',
               updated_at = transaction_timestamp()
         WHERE id = '70000000-0000-4000-8000-000000000021'
      `),
    "23514",
    "cases_schema_manifests_immutable_check",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE cases_schema_manifests
           SET status = 'retired',
               retired_by_user_id = '00000000-0000-4000-8000-000000000021',
               retired_at = transaction_timestamp(),
               retirement_reason = 'Synthetic timestamp rollback',
               updated_at = '1999-01-01T00:00:00.000Z'
         WHERE id = '70000000-0000-4000-8000-000000000021'
      `),
    "23514",
    "cases_schema_manifests_timestamps_check",
  );

  await client.query(`
    UPDATE cases_schema_manifests
       SET status = 'retired',
           retired_by_user_id = '00000000-0000-4000-8000-000000000021',
           retired_at = transaction_timestamp(),
           retirement_reason = 'Synthetic retirement test',
           updated_at = transaction_timestamp()
     WHERE id = '70000000-0000-4000-8000-000000000021';
  `);

  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO cases_assessments (
          id, organization_id, service_case_id, manifest_id, status
        ) VALUES (
          '81000000-0000-4000-8000-000000000023',
          '10000000-0000-4000-8000-000000000021',
          '80000000-0000-4000-8000-000000000024',
          '70000000-0000-4000-8000-000000000021',
          'draft'
        )
      `),
    "23514",
    "cases_assessments_manifest_approved_check",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        DELETE FROM cases_assessment_answers
         WHERE id = '82000000-0000-4000-8000-000000000021'
      `),
    "23514",
    "cases_assessment_answers_delete_rejected",
  );
}

async function assertTargetAndOutcomeInvariants(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO cases_school_targets (
      id,
      organization_id,
      service_case_id,
      school_id,
      intake_year,
      admission_type,
      state
    ) VALUES (
      '90000000-0000-4000-8000-000000000021',
      '10000000-0000-4000-8000-000000000021',
      '80000000-0000-4000-8000-000000000021',
      '91000000-0000-4000-8000-000000000021',
      2027,
      's1',
      'candidate'
    );
  `);

  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO cases_school_targets (
          id,
          organization_id,
          service_case_id,
          school_id,
          intake_year,
          admission_type,
          state
        ) VALUES (
          '90000000-0000-4000-8000-000000000022',
          '10000000-0000-4000-8000-000000000021',
          '80000000-0000-4000-8000-000000000021',
          '91000000-0000-4000-8000-000000000021',
          2027,
          's1',
          'candidate'
        )
      `),
    "23505",
    "cases_school_targets_identity_idx",
  );

  await expectDeferredConstraint(
    client,
    () =>
      client.query(`
        INSERT INTO cases_school_targets (
          id,
          organization_id,
          service_case_id,
          school_id,
          intake_year,
          admission_type,
          state
        ) VALUES (
          '90000000-0000-4000-8000-000000000023',
          '10000000-0000-4000-8000-000000000021',
          '80000000-0000-4000-8000-000000000021',
          '91000000-0000-4000-8000-000000000023',
          2027,
          's1',
          'accepted'
        )
      `),
    "23514",
    "cases_targets_current_outcome_check",
  );

  await client.query(`
    INSERT INTO cases_school_targets (
      id,
      organization_id,
      service_case_id,
      school_id,
      intake_year,
      admission_type,
      state
    ) VALUES (
      '90000000-0000-4000-8000-000000000024',
      '10000000-0000-4000-8000-000000000021',
      '80000000-0000-4000-8000-000000000021',
      '91000000-0000-4000-8000-000000000024',
      2027,
      's1',
      'accepted'
    );

    INSERT INTO cases_case_outcomes (
      id,
      organization_id,
      service_case_id,
      school_target_id,
      outcome_code,
      outcome_date,
      evidence_json,
      source,
      actor_user_id,
      revision_number
    ) VALUES (
      '92000000-0000-4000-8000-000000000021',
      '10000000-0000-4000-8000-000000000021',
      '80000000-0000-4000-8000-000000000021',
      '90000000-0000-4000-8000-000000000024',
      'accepted',
      '2027-01-01',
      '{"fixture":true}',
      'synthetic_fixture',
      '00000000-0000-4000-8000-000000000022',
      1
    );
  `);
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  await client.query("SET CONSTRAINTS ALL DEFERRED");

  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO cases_case_outcomes (
          id,
          organization_id,
          service_case_id,
          school_target_id,
          outcome_code,
          outcome_date,
          evidence_json,
          source,
          actor_user_id,
          revision_number
        ) VALUES (
          '92000000-0000-4000-8000-000000000022',
          '10000000-0000-4000-8000-000000000021',
          '80000000-0000-4000-8000-000000000021',
          '90000000-0000-4000-8000-000000000024',
          'accepted',
          '2027-01-02',
          '{"fixture":true}',
          'synthetic_fixture',
          '00000000-0000-4000-8000-000000000022',
          2
        )
      `),
    "23505",
    "cases_outcomes_one_current_per_target_idx",
  );

  await client.query(`
    UPDATE cases_case_outcomes
       SET superseded_at = transaction_timestamp(),
           superseded_by_outcome_id = '92000000-0000-4000-8000-000000000022',
           supersession_reason = 'Synthetic correction',
           record_version = 2,
           updated_at = transaction_timestamp()
     WHERE id = '92000000-0000-4000-8000-000000000021';

    INSERT INTO cases_case_outcomes (
      id,
      organization_id,
      service_case_id,
      school_target_id,
      outcome_code,
      outcome_date,
      evidence_json,
      source,
      actor_user_id,
      revision_number,
      previous_outcome_id
    ) VALUES (
      '92000000-0000-4000-8000-000000000022',
      '10000000-0000-4000-8000-000000000021',
      '80000000-0000-4000-8000-000000000021',
      '90000000-0000-4000-8000-000000000024',
      'accepted',
      '2027-01-02',
      '{"fixture":true,"revision":2}',
      'synthetic_fixture',
      '00000000-0000-4000-8000-000000000022',
      2,
      '92000000-0000-4000-8000-000000000021'
    );
  `);
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  await client.query("SET CONSTRAINTS ALL DEFERRED");

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE cases_school_targets
           SET state = 'preparing',
               record_version = 2,
               updated_at = transaction_timestamp()
         WHERE id = '90000000-0000-4000-8000-000000000021'
      `),
    "23514",
    "cases_school_targets_status_immutable_check",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        DELETE FROM cases_case_outcomes
         WHERE id = '92000000-0000-4000-8000-000000000022'
      `),
    "23514",
    "cases_case_outcomes_delete_rejected",
  );
}

let expectedFailureSequence = 0;

async function expectSqlState(
  client: Client,
  operation: () => Promise<unknown>,
  expectedCode: string,
  expectedConstraint: string,
): Promise<void> {
  const savepoint = `case_expected_failure_${expectedFailureSequence++}`;
  let caughtError: unknown;

  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await operation();
  } catch (error: unknown) {
    caughtError = error;
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }

  assert.ok(caughtError instanceof Error, `Expected SQLSTATE ${expectedCode}`);
  const databaseError = caughtError as Error & { code?: string; constraint?: string };
  assert.equal(databaseError.code, expectedCode);
  assert.equal(databaseError.constraint, expectedConstraint);
}

async function expectDeferredConstraint(
  client: Client,
  operation: () => Promise<unknown>,
  expectedCode: string,
  expectedConstraint: string,
): Promise<void> {
  await expectSqlState(
    client,
    async () => {
      await operation();
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    },
    expectedCode,
    expectedConstraint,
  );
  await client.query("SET CONSTRAINTS ALL DEFERRED");
}


async function readSyntheticModules() {
  return Promise.all(
    MODULE_PATHS.map(async (fileName) =>
      parseK12Module(
        JSON.parse(
          await readFile(resolve("schema/k12", fileName), "utf8"),
        ) as unknown,
      ),
    ),
  );
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
