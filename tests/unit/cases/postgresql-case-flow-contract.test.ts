import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PostgresqlAssessmentRepository } from "../../../modules/cases/infrastructure/postgresql-assessment-repository.ts";
import { getApprovedK12Catalogue } from "../../../modules/cases/infrastructure/approved-k12-catalogue.ts";
import type {
  PostgreSqlAdapter,
  PostgreSqlQueryResult,
  PostgreSqlTransaction,
} from "../../../modules/cases/infrastructure/postgresql.ts";

const CANONICAL_ASSESSMENT_FIELD_IDS = Object.freeze([
  "student_profile.date_of_birth",
  "student_profile.residency_status",
  "student_profile.primary_languages",
  "education_profile.current_stage",
  "education_profile.current_year_level",
  "education_profile.current_curriculum",
  "school_preferences.target_stage",
  "school_preferences.preferred_systems",
  "school_preferences.preferred_districts",
  "school_preferences.preferred_admission_route",
  "school_preferences.fee_band",
  "family_context.primary_contact_language",
  "family_context.education_priority",
  "family_context.transport_arrangement",
  "family_context.fee_preference",
]);

test("Case create and workflow replay lock the owning aggregate and current authority", async () => {
  const create = await readFile(
    "modules/cases/infrastructure/postgresql-workspace-repository.ts",
    "utf8",
  );
  const workflow = await readFile(
    "modules/cases/infrastructure/postgresql-workflow-repository.ts",
    "utf8",
  );

  assert.match(create, /FROM shared_idempotency_records[\s\S]*FOR UPDATE/);
  assert.match(create, /JOIN cases_service_cases AS service_case[\s\S]*FOR SHARE OF service_case/);
  assert.match(create, /await assertCurrentCaseCreator\(transaction, input\)/);
  assert.match(create, /storedReceipt\.response_hash !== hashRequestPayload/);
  assert.match(create, /if \(completed\.rowCount !== 1\)/);
  assert.match(create, /cases_advance_new_service_case/);
  assert.match(
    create,
    /primary_role, stage, created_at, updated_at\)[\s\S]*to_timestamp\(\$11 \/ 1000\.0\),to_timestamp\(\$11 \/ 1000\.0\)/,
  );
  assert.match(
    create,
    /selectedBinding\.membership_id, selectedBinding\.user_id, selectedBinding\.role,[\s\S]*input\.createdAtMs/,
  );
  for (const operation of ["listCases", "findCase", "listOptions"]) {
    const start = create.indexOf(`  ${operation}(`);
    const end = create.indexOf("\n  }", start);
    assert.match(create.slice(start, end), /assertCurrentWorkspaceActor\(transaction, input\)/);
  }
  assert.match(create, /FOR SHARE OF identity_user, membership, role_binding, organization/);

  const replayAuthority = workflow.indexOf("async function assertReplayAuthority");
  const replayResult = workflow.indexOf("async function readCompletedResult");
  assert.ok(replayAuthority >= 0 && replayResult > replayAuthority);
  assert.match(workflow, /FROM cases_service_cases[\s\S]*FOR UPDATE/);
  assert.match(workflow, /FROM crm_students WHERE id = \$1 AND status = 'active' FOR SHARE/);
  assert.match(workflow, /FOR SHARE OF identity_user, membership, role_binding, organization/);
  assert.match(workflow, /FROM cases_service_case_lifecycle_facts/);
  assert.match(workflow, /responseHash !== hashRequestPayload/);
});

test("Assessment mutations claim receipts before Case scope and lock concrete authorization rows", async () => {
  const source = await readFile(
    "modules/cases/infrastructure/postgresql-assessment-repository.ts",
    "utf8",
  );
  const update = source.slice(
    source.indexOf("  updateAssessmentAnswer("),
    source.indexOf("  completeBackgroundCollection("),
  );
  const complete = source.slice(
    source.indexOf("  completeBackgroundCollection("),
    source.indexOf("async function readAuthorizedHeader"),
  );

  for (const mutation of [update, complete]) {
    assert.ok(mutation.indexOf("claimIdempotency") < mutation.indexOf("readAuthorizedHeader"));
    assert.ok(mutation.indexOf("readAuthorizedHeader") < mutation.indexOf("readManifestFields"));
    assert.ok(mutation.indexOf("readManifestFields") < mutation.indexOf("!idempotency.claimed"));
  }
  assert.match(source, /FOR UPDATE OF service_case[\s\S]*FOR SHARE OF student/);
  assert.match(source, /FOR SHARE OF role_binding, membership, identity_user, organization/);
  assert.match(
    source,
    /role_binding\.user_id = \$1::uuid AND role_binding\.role::text = \$2::text/,
  );
  assert.equal((source.match(/\$3::uuid = \$1::uuid/g) ?? []).length, 2);
  assert.match(source, /\$4::text = 'read'/);
  assert.match(source, /FOR SHARE OF collaborator, scope_grant, role_binding, membership,[\s\S]*identity_user, organization/);
  assert.match(source, /access_can_complete_background: canEdit && header\.case_stage === "background_collection"/);
  assert.match(source, /acknowledgementReference\(header\.assessment_id, Number\(saved\.record_version\)\)/);
});

test("Assessment reads project editable fields and answers in canonical catalogue order", async () => {
  const manifest = getApprovedK12Catalogue();
  const manifestId = "65000000-0000-4000-8000-000000000001";
  const assessmentId = "65000000-0000-4000-8000-000000000002";
  const caseId = "65000000-0000-4000-8000-000000000003";
  const advisorId = "65000000-0000-4000-8000-000000000004";
  const manifestModuleForLayer = (layer: string) =>
    manifest.modules.find((candidate) => candidate.layer === layer)!;
  const storedFields = manifest.modules.flatMap((manifestModule) =>
    manifestModule.fields.map((field) => ({
      module_layer: manifestModule.layer,
      module_id: manifestModule.moduleId,
      module_version: manifestModule.version,
      field_id: field.fieldId,
      value_type: field.valueType,
      visibility: field.visibility,
      blocking_stages: field.blockingStages.map((stage) =>
        stage === "background_collection" ? "background_complete" : "selection_ready"),
    })),
  ).reverse();
  const storedAnswers = [
    "family_context.fee_preference",
    "education_profile.current_stage",
    "student_profile.date_of_birth",
  ].map((fieldId, index) => ({
    id: `65000000-0000-4000-8000-00000000001${index}`,
    field_id: fieldId,
    semantic_state: "provided",
    value_json: { type: "text", value: "synthetic" },
    value_type: "text",
    record_version: 1,
  }));
  const database: PostgreSqlAdapter = Object.freeze({
    async transaction<T>(
      _context: Readonly<{ organizationId: string; actorUserId: string }>,
      work: (transaction: PostgreSqlTransaction) => Promise<T>,
    ): Promise<T> {
      return work({
        async query<Row extends Record<string, unknown>>(
          text: string,
        ): Promise<PostgreSqlQueryResult<Row>> {
          const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
          let rows: readonly Record<string, unknown>[];
          if (normalized.startsWith("select assessment.id as assessment_id")) {
            rows = [{
              assessment_id: assessmentId,
              manifest_id: manifestId,
              assessment_status: "draft",
              assessment_record_version: 1,
              manifest_status: "approved",
              application_type: "k12",
              composition_version: manifest.compositionVersion,
              primary_user_id: advisorId,
              case_stage: "background_collection",
              case_workflow_status: "active",
              student_status: "active",
              base_module_id: manifestModuleForLayer("base").moduleId,
              base_module_version: manifestModuleForLayer("base").version,
              education_stage_module_id: manifestModuleForLayer("education_stage").moduleId,
              education_stage_module_version: manifestModuleForLayer("education_stage").version,
              school_system_module_id: manifestModuleForLayer("school_system").moduleId,
              school_system_module_version: manifestModuleForLayer("school_system").version,
              admission_route_module_id: manifestModuleForLayer("admission_route").moduleId,
              admission_route_module_version: manifestModuleForLayer("admission_route").version,
            }];
          } else if (normalized.includes("from access_role_bindings as role_binding")) {
            rows = [{ role: "advisor", is_primary: true }];
          } else if (normalized.includes("from cases_read_bound_assessment_manifest_fields")) {
            rows = storedFields;
          } else if (normalized.includes("from cases_assessment_answers")) {
            rows = storedAnswers;
          } else {
            assert.fail("Unexpected Assessment repository query.");
          }
          return Object.freeze({ rows: rows as Row[], rowCount: rows.length });
        },
      });
    },
  });
  const repository = new PostgresqlAssessmentRepository(database);

  const snapshot = await repository.readCaseAssessment({
    organizationId: "65000000-0000-4000-8000-000000000005",
    actorUserId: advisorId,
    actorRole: "advisor",
    caseId,
  });

  assert.deepEqual(snapshot.access.editableFieldIds, CANONICAL_ASSESSMENT_FIELD_IDS);
  assert.deepEqual(snapshot.answers.map(({ fieldId }) => fieldId), [
    "student_profile.date_of_birth",
    "education_profile.current_stage",
    "family_context.fee_preference",
  ]);
});

test("CASE-01 HTTP harness keeps private authority comparisons out of AssertionError output", async () => {
  const source = await readFile("tests/integration/case-create-dev-http.test.ts", "utf8");
  assert.match(source, /function assertSensitiveEqual[\s\S]*isDeepStrictEqual[\s\S]*new HarnessError/);
  assert.match(source, /function assertSensitiveUuid[\s\S]*new HarnessError/);
  assert.match(source, /case01_assessment_patch_diagnostic[\s\S]*ordinal: number[\s\S]*category: AssessmentFillCategory/);
  assert.match(source, /if \(result\.response\.status === 500\)[\s\S]*assertAssessmentPatchDiagnostic/);
  for (const forbidden of [
    "assert.deepEqual(replay.body.data",
    "assert.deepEqual(replayedTask.body.data",
    "assert.deepEqual(firstReplay.body.data",
    "assert.deepEqual(completionReplay.body.data",
    "assert.deepEqual(pauseReplay.body.data",
    "assert.deepEqual(taskReplay.body.data",
    "assert.deepEqual(answer.value",
    "assert.equal(created.id",
    "assert.equal(created.studentId",
    "assert.equal(created.manifestId",
    "assert.equal(data.manifest_id",
    "assert.equal(data.id, expectedId",
    "assert.match(requiredString(data, \"id\")",
    "field_id: input.command.field_id",
  ]) {
    assert.equal(source.includes(forbidden), false);
  }
});

test("CASE-01 HTTP harness permanently covers Assessment collaborator and tenant boundaries", async () => {
  const source = await readFile("tests/integration/case-create-dev-http.test.ts", "utf8");
  const foreignFixture = source.slice(
    source.indexOf("async function prepareForeignAdvisor"),
    source.indexOf("async function switchActiveOrganization"),
  );

  assert.match(source, /assertAssessmentCollaboratorHttpMatrix/);
  assert.match(source, /educationProfileSchema[\s\S]*fields\.length !== 3/);
  assert.match(source, /mode: "education_profile"[\s\S]*can_edit: false/);
  assert.match(source, /mode: "education_profile"[\s\S]*can_edit: true/);
  assert.match(source, /prepareAssessmentCollaborator\(input\.target, input\.caseId, "view"\)/);
  assert.match(source, /prepareAssessmentCollaborator\(input\.target, input\.caseId, "edit"\)/);
  assert.match(source, /assessment_collaborator_view_answer_order/);
  assert.match(source, /assessment_collaborator_edit_answer_order/);
  assert.match(source, /assessment_collaborator_view_zero_effects/);
  assert.match(source, /assessment_collaborator_edit_denials_zero_effects/);
  assert.match(source, /assertForeignTenantAssessmentHttpMatrix/);
  assert.match(source, /assessment_foreign_tenant_zero_effects/);
  assert.match(source, /assessment_foreign_tenant_own_effects_zero/);
  assert.match(source, /case01_foreign_fixture_diagnostic/);
  for (const stage of [
    "connection", "organization_insert", "membership_insert",
    "role_binding_insert", "commit", "cleanup",
  ]) {
    assert.match(source, new RegExp(`\\| "${stage}"`));
  }
  assert.doesNotMatch(source, /\| "identity_insert"/);
  assert.doesNotMatch(foreignFixture, /INSERT INTO identity_users/);
  assert.doesNotMatch(source, /FOREIGN_ADVISOR\.(?:email|userId)/);
  assert.doesNotMatch(source, /assessment_foreign_tenant_provision/);
  assert.match(source, /organizationId: FOREIGN_ORGANIZATION_ID,[\s\S]*actorUserId: ADVISOR\.userId/);
  assert.match(source, /readonly cookies: Map<string, string>/);
  assert.match(source, /assessment_foreign_tenant_main_logout/);
  assert.match(source, /switchActiveOrganization\(input\.target, "foreign"\)/);
  assert.match(source, /login\(input\.baseUrl, ADVISOR\.email, input\.password\)/);
  assert.match(source, /assessment_foreign_tenant_actor/);
  assert.match(source, /assessment_foreign_tenant_logout/);
  assert.match(source, /switchActiveOrganization\(input\.target, "main"\)/);
  assert.match(source, /assessment_foreign_tenant_main_actor_restored/);
  assert.match(source, /input\.cookies\.set\("advisor", mainCookie\)/);
  assert.match(
    source,
    /assessment_foreign_tenant_main_logout[\s\S]*switchActiveOrganization\(input\.target, "foreign"\)[\s\S]*assessment_foreign_tenant_actor[\s\S]*assessment_foreign_tenant_logout[\s\S]*switchActiveOrganization\(input\.target, "main"\)[\s\S]*assessment_foreign_tenant_main_actor_restored[\s\S]*input\.cookies\.set\("advisor", mainCookie\)/,
  );
  assert.match(source, /data\.user_id !== ADVISOR\.userId/);
  assert.match(source, /data\.organization_id !== expectedOrganizationId/);
  assert.match(source, /data\.role !== "advisor"/);
  assert.match(source, /main_aggregate_unchanged: isDeepStrictEqual/);
  assert.match(source, /foreign_aggregate_unchanged: isDeepStrictEqual/);
  assert.doesNotMatch(source, /connection\.username = "postgres"/);
  assert.doesNotMatch(source, /assert\.deepEqual\([^\n]*collaborator/);
});

test("legacy production Case writer is fail closed and absent from the Cases server boundary", async () => {
  const repository = await readFile(
    "modules/cases/infrastructure/production-repository.ts",
    "utf8",
  );
  const server = await readFile("modules/cases/server.ts", "utf8");
  const legacy = await readFile("modules/cases/infrastructure/legacy-service.ts", "utf8");

  assert.match(repository, /throw new Error\("CASE_CREATION_LEGACY_PATH_DISABLED"\)/);
  assert.doesNotMatch(repository, /INSERT INTO cases_service_cases/);
  assert.doesNotMatch(server, /production-repository\.ts/);
  assert.doesNotMatch(server, /outcome-service|transition-service|postgresql-school-target-repository/);
  assert.doesNotMatch(legacy, /withAuthTransaction|INSERT INTO cases_service_cases|SELECT[\s\S]+FROM cases_service_cases/);
  assert.equal((legacy.match(/throw new CaseCommandError\('FORBIDDEN'\)/g) ?? []).length, 4);
});

test("SchoolTarget public runtime is read-only and pending Students never project workflow actions", async () => {
  const runtime = await readFile(
    "modules/cases/infrastructure/school-target-runtime.ts",
    "utf8",
  );
  const workspace = await readFile(
    "modules/cases/infrastructure/postgresql-workspace-repository.ts",
    "utf8",
  );

  assert.match(runtime, /Pick<SchoolTargetService, "getSchoolTargets">/);
  assert.doesNotMatch(runtime.slice(runtime.indexOf("runtime = Object.freeze")), /createSchoolTarget/);
  const actionProjection = workspace.slice(workspace.indexOf("function workflowActions"));
  assert.ok(
    actionProjection.indexOf('row.student_status !== "active"') <
      actionProjection.indexOf('row.workflow_status === "paused"'),
  );
});

test("ad-hoc Task creation locks Case before reauthorization and preserves paused replay", async () => {
  const source = await readFile(
    "modules/tasks/infrastructure/postgresql-workspace-repository.ts",
    "utf8",
  );
  const create = source.slice(source.indexOf("  create(input:"), source.indexOf("  transition(input:"));

  assert.ok(create.indexOf("claimReceipt") < create.indexOf("lockCase"));
  assert.ok(create.indexOf("lockCase") < create.indexOf("assertActor"));
  assert.ok(create.indexOf("assertActor") < create.indexOf("if (replay) return replay"));
  assert.ok(
    create.indexOf("if (replay) return replay") <
      create.indexOf('serviceCase.workflow_status !== "active"'),
  );
});

test("Task transition locates and locks the owning Case before actor, Task and assignment locks", async () => {
  const source = await readFile(
    "modules/tasks/infrastructure/postgresql-workspace-repository.ts",
    "utf8",
  );
  const transition = source.slice(
    source.indexOf("  transition(input:"),
    source.indexOf("  private run<"),
  );

  assert.ok(transition.indexOf("claimReceipt") < transition.indexOf("locateTaskCase"));
  assert.ok(transition.indexOf("locateTaskCase") < transition.indexOf("lockCase"));
  assert.ok(transition.indexOf("lockCase") < transition.indexOf("assertActor"));
  assert.ok(transition.indexOf("assertActor") < transition.indexOf("selectVisibleTasks"));
  assert.ok(transition.indexOf("selectVisibleTasks") < transition.indexOf("lockTaskAssignments"));
  assert.ok(transition.indexOf("lockTaskAssignments") < transition.indexOf("if (replay) return replay"));
  assert.match(source, /SELECT service_case_id FROM tasks_tasks WHERE id=\$1/);
  assert.match(source, /FOR UPDATE OF service_case FOR SHARE OF student/);
  assert.match(source, /FOR UPDATE OF task/);
  assert.match(source, /FROM tasks_task_assignments AS assignment[\s\S]*FOR UPDATE OF assignment/);
});
