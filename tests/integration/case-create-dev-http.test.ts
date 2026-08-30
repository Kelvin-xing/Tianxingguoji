import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { Client, Pool } from "pg";

import {
  CaseWorkspaceService,
  isCaseWorkspaceRepositoryError,
} from "../../modules/cases/application/workspace-service.ts";
import {
  AssessmentService,
  isAssessmentServiceError,
} from "../../modules/cases/application/assessment-service.ts";
import { composeK12Manifest } from "../../modules/cases/domain/contract.ts";
import { resolveAssessmentSchema } from "../../modules/cases/domain/schema-resolver.ts";
import {
  createPostgreSqlAdapter,
  type PostgreSqlAdapter,
  type PostgreSqlQueryResult,
} from "../../modules/cases/infrastructure/postgresql.ts";
import { PostgresqlAssessmentRepository } from "../../modules/cases/infrastructure/postgresql-assessment-repository.ts";
import { PostgresqlCaseWorkspaceRepository } from "../../modules/cases/infrastructure/postgresql-workspace-repository.ts";
import type { IdentitySessionActor } from "../../modules/identity/public.ts";
import { createTenantTransactionRunner, type DatabasePool } from "../../modules/shared/server.ts";
import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_VERSION,
  verifyCommittedOneRoleBaseline,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  NEON_TEST_MANIFEST_ID,
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
  NEON_TEST_STUDENTS,
  loadNeonTestManifestFixture,
} from "../../scripts/db/neon-test-synthetic-fixture.ts";
import {
  runDatabaseTestProvisionCli,
  type DatabaseTestProvisionTarget,
} from "../../scripts/db/provision-database-test-identity.ts";
import { seedNeonTestRelease1 } from "../../scripts/db/seed-neon-test-release1.ts";
import {
  assertOneRoleBaselinePostflight,
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  type OneRoleBaselineDatabaseState,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const P2_BE_03_SCOPED = process.env.TIANXING_P2_BE_03_SCOPED === "1";
const RELEASE1_PRINCIPALS = NEON_TEST_PRINCIPALS.filter((principal) =>
  principal.role !== "advisor" || principal.roleBindingId === "51000000-0000-4000-8000-000000000303",
);
const FOUNDER = NEON_TEST_PRINCIPALS.find(({ role }) => role === "founder")!;
const ADVISOR = NEON_TEST_PRINCIPALS.find(({ role }) => role === "advisor")!;
const CONTRACTOR = NEON_TEST_PRINCIPALS.find(({ role }) => role === "contractor")!;
const OTHER_ADVISOR = Object.freeze({
  email: "case01-other-advisor@example.invalid",
  userId: "64000000-0000-4000-8000-000000000011",
  membershipId: "64000000-0000-4000-8000-000000000012",
  roleBindingId: "64000000-0000-4000-8000-000000000013",
});
const ASSESSMENT_COLLABORATOR = Object.freeze({
  id: "64000000-0000-4000-8000-000000000021",
  viewGrantId: "64000000-0000-4000-8000-000000000022",
  editGrantId: "64000000-0000-4000-8000-000000000023",
});
const FOREIGN_ORGANIZATION_ID = "64000000-0000-4000-8000-000000000001";
const FOREIGN_ADVISOR = Object.freeze({
  membershipId: "64000000-0000-4000-8000-000000000032",
  roleBindingId: "64000000-0000-4000-8000-000000000033",
});
const ASSESSMENT_PRIVATE_MARKER = "caseflow-assessment-private-marker";
const WORKFLOW_PRIVATE_MARKER = "caseflow-workflow-private-marker";
const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

type DirectCaseCreateProbeStage =
  | "connect"
  | "begin"
  | "tenant_context"
  | "receipt_claim"
  | "receipt_lock"
  | "actor_reauth"
  | "student_lock"
  | "primary_binding_lock"
  | "manifest_check"
  | "case_insert"
  | "assessment_insert"
  | "signed_advance"
  | "effects_audit"
  | "effects_outbox"
  | "receipt_complete"
  | "service_return"
  | "rollback"
  | "zero_effects"
  | "connection_close";

const DIRECT_PROBE_POSTGRES_CODES = new Set([
  "08003", "08006", "23503", "23505", "23514", "40001", "40P01", "42501",
  "42601", "42703", "42883", "42P01", "55P03", "57014", "57P01",
]);
const DIRECT_PROBE_POSTGRES_SEVERITIES = new Set([
  "ERROR", "FATAL", "PANIC",
]);
const DIRECT_PROBE_CONSTRAINTS = new Set([
  "cases_answers_manifest_field_check",
  "cases_answers_value_type_check",
  "cases_assessment_answers_identity_immutable_check",
  "cases_assessment_answers_record_version_transition_check",
  "cases_assessment_answers_timestamps_check",
  "cases_assessment_insert_boundary_check",
  "cases_assessment_write_boundary_check",
  "cases_assessments_manifest_approved_check",
  "cases_manifest_blocker_contract_check",
  "cases_service_case_transition_facts_direction_check",
  "cases_service_case_transition_facts_reason_length_check",
  "cases_service_case_transition_facts_time_boundary_check",
  "cases_service_case_transition_facts_timestamps_check",
  "cases_service_case_transition_facts_version_check",
  "cases_service_cases_active_principal_check",
  "cases_service_cases_admission_type_check",
  "cases_service_cases_application_type_check",
  "cases_service_cases_case_number_check",
  "cases_service_cases_closed_state_check",
  "cases_service_cases_initial_state_check",
  "cases_service_cases_intake_year_check",
  "cases_service_cases_one_active_student_case_idx",
  "cases_service_cases_primary_role_check",
  "cases_service_cases_record_version_check",
  "cases_service_cases_record_version_transition_check",
  "cases_service_cases_signed_commit_check",
  "cases_service_cases_stage_check",
  "cases_service_cases_stage_direction_check",
  "cases_service_cases_stage_transition_boundary_check",
  "cases_service_cases_tenant_context_check",
  "cases_service_cases_timestamps_check",
  "cases_service_cases_workflow_action_boundary_check",
  "cases_service_cases_workflow_status_check",
]);
const DIRECT_PROBE_APPLICATION_CODES = new Set([
  "CASE_WORKSPACE_FORBIDDEN",
  "CASE_WORKSPACE_INVALID",
  "CASE_WORKSPACE_STUDENT_NOT_FOUND",
  "CASE_WORKSPACE_BINDING_INACTIVE",
  "CASE_WORKSPACE_MANIFEST_NOT_APPROVED",
  "CASE_WORKSPACE_DUPLICATE",
  "CASE_WORKSPACE_IDEMPOTENCY_CONFLICT",
  "CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS",
]);

type DirectCaseCreateProbeFailureEvidence = Readonly<{
  event: "case01_direct_create_failure";
  stage: DirectCaseCreateProbeStage;
  postgres_code: string | null;
  postgres_constraint: string | null;
  application_code: string | null;
}>;

class DirectCaseCreateProbeFailure extends Error {
  readonly evidence: DirectCaseCreateProbeFailureEvidence;

  constructor(evidence: DirectCaseCreateProbeFailureEvidence) {
    super("CASE-01 direct create probe failed.");
    this.name = "DirectCaseCreateProbeFailure";
    this.evidence = evidence;
  }
}

type AssessmentGetProbeStage =
  | "transaction_context"
  | "header_query"
  | "actor_scope"
  | "manifest_fields"
  | "answers"
  | "projection";

type AssessmentGetProbeEvidence = Readonly<{
  event: "case01_assessment_get_diagnostic";
  http_status: 500;
  stage: AssessmentGetProbeStage;
  direct_read_completed: boolean;
  postgres_code: string | null;
  postgres_constraint: string | null;
  application_code: string | null;
  javascript_error_class: "Error" | "TypeError" | "RangeError" | null;
}>;

type AssessmentPatchProbeStage =
  | "read_header"
  | "read_actor"
  | "read_manifest"
  | "read_answers"
  | "receipt_claim"
  | "write_case_lock"
  | "write_actor"
  | "write_answer_lock"
  | "write_manifest"
  | "write_answer"
  | "effects"
  | "receipt_complete"
  | "rollback";

type AssessmentFillCategory = "date" | "enum" | "enum_set" | "integer" | "text";

type AssessmentPatchProbeEvidence = Readonly<{
  event: "case01_assessment_patch_diagnostic";
  http_status: 500;
  http_code: string | null;
  ordinal: number;
  category: AssessmentFillCategory;
  stage: AssessmentPatchProbeStage;
  direct_write_completed: boolean;
  postgres_code: string | null;
  postgres_constraint: string | null;
  application_code: string | null;
  javascript_error_class: "Error" | "TypeError" | "RangeError" | null;
}>;

type ForeignFixtureProbeStage =
  | "connection"
  | "organization_insert"
  | "membership_insert"
  | "role_binding_insert"
  | "commit"
  | "cleanup";

type ForeignFixtureProbeEvidence = Readonly<{
  event: "case01_foreign_fixture_diagnostic";
  stage: ForeignFixtureProbeStage;
  postgres_code: string | null;
  postgres_constraint: string | null;
  application_code: null;
  javascript_error_class: "Error" | "TypeError" | "RangeError" | null;
  rollback_completed: boolean;
  main_aggregate_unchanged: boolean;
  foreign_aggregate_unchanged: boolean;
}>;

test("CASE-01 works through PostgreSQL 17 and the real local Next Dev HTTP API", {
  timeout: 300_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-case01-pg17-${suffix}`;
  const credentialVolumeName = `tianxing-case01-credential-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const activePrincipals = P2_BE_03_SCOPED ? RELEASE1_PRINCIPALS : NEON_TEST_PRINCIPALS;
  const passwords = new Map(activePrincipals.map((principal) => [
    principal.role,
    randomBytes(32).toString("base64url"),
  ]));
  const otherAdvisorPassword = randomBytes(32).toString("base64url");
  const appDirectory = await createIsolatedAppDirectory();
  let containerStarted = false;
  let secretVolumeCreated = false;
  let devServer: ChildProcess | undefined;
  let evidence: Readonly<Record<string, unknown>> | undefined;

  try {
    await runDocker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_missing");
    await runDocker(["volume", "create", credentialVolumeName], "postgres_secret_volume_create");
    secretVolumeCreated = true;
    await runDocker([
      "run", "--rm", "--interactive", "--pull=never",
      "--volume", `${credentialVolumeName}:/run/secrets`,
      POSTGRES_IMAGE, "/bin/sh", "-c",
      "umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password",
    ], "postgres_secret_volume_populate", applicationPassword);
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", containerName,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env", "POSTGRES_DB=tianxing",
      "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/local_postgres_password",
      "--volume", `${credentialVolumeName}:/run/secrets:ro`,
      "--volume", `${resolve("infra/local/postgres/init")}:/docker-entrypoint-initdb.d:ro`,
      "--volume", `${resolve("infra/local/postgres/healthcheck.sh")}:/usr/local/bin/tianxing-postgres-healthcheck:ro`,
      "--publish", "127.0.0.1::5432",
      POSTGRES_IMAGE,
    ], "postgres_container_start");
    containerStarted = true;
    await waitForPostgres(containerName);

    const port = readLoopbackPort((await runDocker(
      ["port", containerName, "5432/tcp"],
      "postgres_port_inspection",
    )).stdout);
    const target = localTarget(port, applicationPassword);
    const postgresVersion = await readPostgresVersion(target);
    assert.equal(Number(postgresVersion.split(".")[0]), 17);

    const build = await verifyCommittedOneRoleBaseline();
    const manifestSha256 = createHash("sha256").update(build.manifestJson).digest("hex");
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply",
      target,
      build,
      dependencies: baselineDependencies(target),
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.postflight_state, "installed");
    assert.equal(baseline.generated_files, ONE_ROLE_SOURCE_COUNT + 1);
    assertDatabaseContract(await inspectBaselineWithNewClient(target), target, manifestSha256);

    const seed = await seedNeonTestRelease1(target, "apply", {
      includeTaskPolicy: !P2_BE_03_SCOPED,
    });
    assert.equal(seed.status, "pass");
    assert.equal(seed.baseline.id, ONE_ROLE_BASELINE_ID);
    assert.equal(seed.baseline.transform_version, ONE_ROLE_TRANSFORM_VERSION);
    assert.equal(seed.baseline.source_migration_count, ONE_ROLE_SOURCE_COUNT);
    assert.equal(seed.baseline.manifest_sha256, manifestSha256);
    const manifestFixture = await loadNeonTestManifestFixture();
    const assessmentSchema = resolveAssessmentSchema({
      manifestId: NEON_TEST_MANIFEST_ID,
      manifest: composeK12Manifest(manifestFixture.modules),
    });
    assert.equal(assessmentSchema.fields.length, 15);
    await assertAssessmentWriteDependencies(target);
    if (!P2_BE_03_SCOPED) await assertDirectCaseCreateSucceedsAndRollsBack(target);
    await prepareOtherAdvisor(target);
    for (const principal of activePrincipals) {
      assert.equal(await provision(target, principal.email, passwords.get(principal.role)!), "created");
    }
    assert.equal(await provision(target, OTHER_ADVISOR.email, otherAdvisorPassword), "created");

    const httpPort = await reserveLoopbackPort();
    devServer = startNextDev(appDirectory, httpPort, target.connectionString);
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    await waitForNextDev(baseUrl, devServer);

    const cookies = new Map<string, string>();
    for (const principal of activePrincipals) {
      cookies.set(principal.role, await login(
        baseUrl,
        principal.email,
        passwords.get(principal.role)!,
      ));
    }
    cookies.set("other_advisor", await login(baseUrl, OTHER_ADVISOR.email, otherAdvisorPassword));

    if (P2_BE_03_SCOPED) {
      const scopedEvidence = await assertP2CaseIntakeFlow({
        target,
        baseUrl,
        cookies,
        assessmentSchema,
        advisorPassword: passwords.get("advisor")!,
      });
      evidence = Object.freeze({
        status: "pass",
        scope: "P2-BE-03",
        postgres_major: 17,
        baseline_id: baseline.baseline_id,
        active_roles: Object.freeze(["founder", "admin", "advisor", "contractor"]),
        data_reviewer_active: false,
        case_create: scopedEvidence.caseCreate,
        assessment: scopedEvidence.assessment,
        excluded: Object.freeze(["candidate_list", "school_target", "task", "document", "portal"]),
      });
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
      return;
    }

    const founderOptions = await readOptions(baseUrl, cookies.get("founder")!);
    const advisorOptions = await readOptions(baseUrl, cookies.get("advisor")!);
    assert.equal(founderOptions.students.length, 2);
    assertSensitiveEqual(
      founderOptions.primaryBindings.map(({ id }) => id).sort(),
      [
        ...NEON_TEST_PRINCIPALS
          .filter(({ role }) => role === "advisor")
          .map(({ roleBindingId }) => roleBindingId),
        OTHER_ADVISOR.roleBindingId,
      ].sort(),
      "case_options_founder_primary_bindings",
    );
    assertSensitiveEqual(
      advisorOptions.primaryBindings.map(({ id }) => id),
      [ADVISOR.roleBindingId],
      "case_options_advisor_primary_binding",
    );
    for (const role of ["admin", "contractor"] as const) {
      assertApiError(
        await getJson(baseUrl, "/api/v1/cases/options", cookies.get(role)!),
        403,
        "FORBIDDEN",
      );
    }

    const founderBody = createBody(
      NEON_TEST_STUDENTS[0]!.id, 2027, "transfer", OTHER_ADVISOR.roleBindingId,
    );
    const advisorBody = createBody(NEON_TEST_STUDENTS[1]!.id, 2027, "s1_admission", ADVISOR.roleBindingId);
    const initialCounts = await readCaseCounts(target);

    const founderCreated = await createCase(
      baseUrl, cookies.get("founder")!, "case01-founder-create", founderBody,
    );
    const founderCaseId = await assertCaseCreated(
      baseUrl, cookies.get("founder")!, founderCreated, founderBody,
    );
    const advisorCreated = await createCase(
      baseUrl, cookies.get("advisor")!, "case01-advisor-create", advisorBody,
    );
    const advisorCaseId = await assertCaseCreated(
      baseUrl, cookies.get("advisor")!, advisorCreated, advisorBody,
    );
    const afterAllowed = await readCaseCounts(target);
    assert.deepEqual(caseDelta(initialCounts, afterAllowed), {
      cases: 2,
      assessments: 2,
      idempotency: 2,
      audit: 2,
      outbox: 2,
    });

    const replay = await createCase(
      baseUrl, cookies.get("founder")!, "case01-founder-create", founderBody,
    );
    assert.equal(replay.response.status, 200);
    assertSensitiveEqual(replay.body.data, founderCreated.body.data, "case_create_replay_receipt");
    assert.deepEqual(await readCaseCounts(target), afterAllowed);

    const invalidShape = await createCase(baseUrl, cookies.get("founder")!, "case01-invalid-shape", {
      ...founderBody,
      organization_id: NEON_TEST_ORGANIZATION.id,
    });
    assertApiError(invalidShape, 400, "INVALID_REQUEST");
    assertNoPrivateErrorEcho(invalidShape, Object.values(founderBody).map(String));
    assert.deepEqual(await readCaseCounts(target), afterAllowed);

    const changed = await createCase(baseUrl, cookies.get("founder")!, "case01-founder-create", {
      ...founderBody,
      intake_year: 2030,
    });
    assertApiError(changed, 409, "CONFLICT");
    assertNoPrivateErrorEcho(changed, Object.values(founderBody).map(String));
    assert.deepEqual(await readCaseCounts(target), afterAllowed);

    const duplicate = await createCase(
      baseUrl, cookies.get("founder")!, "case01-active-duplicate", founderBody,
    );
    assertApiError(duplicate, 409, "CONFLICT");
    assertNoPrivateErrorEcho(duplicate, Object.values(founderBody).map(String));
    assert.deepEqual(await readCaseCounts(target), afterAllowed);

    const advisorOtherPrimary = await createCase(
      baseUrl,
      cookies.get("advisor")!,
      "case01-advisor-other-primary",
      createBody(NEON_TEST_STUDENTS[1]!.id, 2031, "transfer", OTHER_ADVISOR.roleBindingId),
    );
    assertApiError(advisorOtherPrimary, 422, "VALIDATION_FAILED");
    assert.deepEqual(await readCaseCounts(target), afterAllowed);

    for (const role of ["admin", "contractor"] as const) {
      const deniedBody = createBody(
        NEON_TEST_STUDENTS[1]!.id,
        role === "admin" ? 2032 : 2034,
        "transfer",
        ADVISOR.roleBindingId,
      );
      const denied = await createCase(
        baseUrl, cookies.get(role)!, `case01-denied-${role}`, deniedBody,
      );
      assertApiError(denied, 403, "FORBIDDEN");
      assertNoPrivateErrorEcho(denied, Object.values(deniedBody).map(String));
    }
    assert.deepEqual(await readCaseCounts(target), afterAllowed);

    const caseParentWriteBoundary = await assertCaseParentWriteBoundary(target, founderCaseId);
    const founderList = await getJson(baseUrl, "/api/v1/cases", cookies.get("founder")!);
    const advisorList = await getJson(baseUrl, "/api/v1/cases", cookies.get("advisor")!);
    const founderCases = requiredArray(founderList.body.data?.cases);
    assert.equal(founderCases.length, 2);
    assertSensitiveEqual(
      requiredArray(advisorList.body.data?.cases)
        .map((record) => requiredString(record, "id")).sort(),
      [advisorCaseId],
      "case_list_advisor_ids",
    );
    for (const role of ["admin", "contractor"] as const) {
      assertApiError(
        await getJson(baseUrl, "/api/v1/cases", cookies.get(role)!),
        403,
        "FORBIDDEN",
      );
    }
    assert.equal((await getJson(
      baseUrl, `/api/v1/cases/${founderCaseId}`, cookies.get("founder")!,
    )).response.status, 200);
    assertApiError(await getJson(
      baseUrl, `/api/v1/cases/${founderCaseId}`, cookies.get("advisor")!,
    ), 404, "NOT_FOUND");
    assert.equal((await getJson(
      baseUrl, `/api/v1/cases/${founderCaseId}`, cookies.get("other_advisor")!,
    )).response.status, 200);
    assert.equal((await getJson(
      baseUrl, `/api/v1/cases/${advisorCaseId}`, cookies.get("advisor")!,
    )).response.status, 200);
    for (const role of ["admin", "contractor"] as const) {
      assertApiError(
        await getJson(baseUrl, `/api/v1/cases/${founderCaseId}`, cookies.get(role)!),
        403,
        "FORBIDDEN",
      );
    }

    const assessmentEvidence = await assertAssessmentHttpMatrix({
      target,
      baseUrl,
      cookies,
      caseId: advisorCaseId,
      expectedSchema: assessmentSchema,
      advisorPassword: passwords.get("advisor")!,
      release1FourRole: P2_BE_03_SCOPED,
    });

    const logout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { cookie: cookies.get("founder")! },
      redirect: "manual",
    });
    assert.equal(logout.status, 303);
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { cookie: cookies.get("founder")! },
    })).status, 401);
    const founderRelogin = await login(baseUrl, FOUNDER.email, passwords.get("founder")!);
    cookies.set("founder", founderRelogin);
    assert.equal((await getJson(
      baseUrl, `/api/v1/cases/${founderCaseId}`, founderRelogin,
    )).response.status, 200);

    if (P2_BE_03_SCOPED) {
      evidence = Object.freeze({
        status: "pass",
        scope: "P2-BE-03",
        postgres_major: 17,
        baseline_id: baseline.baseline_id,
        active_roles: Object.freeze(["founder", "admin", "advisor", "contractor"]),
        data_reviewer_active: false,
        case_create: Object.freeze({
          background: true,
          primary_advisor_history: true,
          exact_replay: "same_result_no_new_rows",
          changed_payload: "conflict_no_new_rows",
          transaction_effects: caseDelta(initialCounts, afterAllowed),
        }),
        assessment: assessmentEvidence,
        excluded: Object.freeze(["candidate_list", "school_target", "task", "document", "portal"]),
      });
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
      return;
    }

    const taskCountsBefore = await readTaskCounts(target);
    const founderTaskBody = taskCreateBody(founderCaseId, ADVISOR.userId, "Founder synthetic task");
    const founderTask = await createTask(baseUrl, founderRelogin, "task01-founder-create", founderTaskBody);
    assertTaskReceipt(founderTask, 201, 1);
    const founderTaskId = requiredString(founderTask.body.data, "id");
    const replayedTask = await createTask(baseUrl, founderRelogin, "task01-founder-create", founderTaskBody);
    assert.equal(replayedTask.response.status, 201);
    assertSensitiveEqual(replayedTask.body.data, founderTask.body.data, "task_create_replay_receipt");
    assertApiError(await createTask(baseUrl, founderRelogin, "task01-founder-create", {
      ...founderTaskBody, title: "Changed synthetic task",
    }), 409, "CONFLICT");

    const contractorTask = await createTask(baseUrl, founderRelogin, "task01-contractor-create",
      taskCreateBody(founderCaseId, CONTRACTOR.userId, "Contractor synthetic task"));
    assertTaskReceipt(contractorTask, 201, 1);
    const contractorTaskId = requiredString(contractorTask.body.data, "id");
    const advisorTask = await createTask(baseUrl, cookies.get("advisor")!, "task01-advisor-create",
      taskCreateBody(advisorCaseId, ADVISOR.userId, "Advisor synthetic task"));
    assertTaskReceipt(advisorTask, 201, 1);
    const advisorTaskId = requiredString(advisorTask.body.data, "id");
    const reassignmentTask = await createTask(baseUrl, founderRelogin, "task01-reassign-create",
      taskCreateBody(founderCaseId, ADVISOR.userId, "Reassignment synthetic task"));
    assertTaskReceipt(reassignmentTask, 201, 1);
    const reassignmentTaskId = requiredString(reassignmentTask.body.data, "id");
    const cancellationTask = await createTask(baseUrl, founderRelogin, "task01-cancel-create",
      taskCreateBody(founderCaseId, ADVISOR.userId, "Cancellation synthetic task"));
    assertTaskReceipt(cancellationTask, 201, 1);
    const cancellationTaskId = requiredString(cancellationTask.body.data, "id");
    const founderOtherCaseTask = await createTask(baseUrl, founderRelogin, "task01-founder-other-case",
      taskCreateBody(advisorCaseId, ADVISOR.userId, "Founder cross-primary synthetic task"));
    assertTaskReceipt(founderOtherCaseTask, 201, 1);
    assertApiError(await createTask(baseUrl, cookies.get("advisor")!, "task01-advisor-not-primary",
      taskCreateBody(founderCaseId, ADVISOR.userId, "Invisible synthetic task")), 404, "NOT_FOUND");
    for (const role of ["admin", "contractor"] as const) {
      assertApiError(await createTask(baseUrl, cookies.get(role)!, `task01-create-denied-${role}`,
        taskCreateBody(founderCaseId, ADVISOR.userId, "Denied synthetic task")), 403, "FORBIDDEN");
    }

    const founderTaskList = await getJson(baseUrl, "/api/v1/tasks", founderRelogin);
    assert.equal(founderTaskList.response.status, 200);
    const founderTaskListData = requiredRecord(founderTaskList.body.data);
    assert.equal(founderTaskListData.audience, "case_workspace");
    const contractorList = await getJson(baseUrl, "/api/v1/tasks", cookies.get("contractor")!);
    assert.equal(contractorList.response.status, 200);
    const contractorListData = requiredRecord(contractorList.body.data);
    assert.equal(contractorListData.audience, "assigned_task");
    const contractorItem = requiredRecord(requiredArray(contractorListData.tasks)[0]);
    assert.deepEqual(Object.keys(contractorItem).sort(), ["available_transitions","due_at","id","record_version",
      "state","task_brief","title","updated_at"].sort());
    assertSensitiveEqual(contractorItem.id, contractorTaskId, "task_contractor_item_id");
    for (const role of ["admin"] as const) {
      assertApiError(await getJson(baseUrl, "/api/v1/tasks", cookies.get(role)!), 403, "FORBIDDEN");
    }
    assert.equal((await getJson(baseUrl, `/api/v1/tasks/options?case_id=${founderCaseId}`, founderRelogin)).response.status, 200);
    assertApiError(await getJson(baseUrl, `/api/v1/tasks/options?case_id=${founderCaseId}`, cookies.get("contractor")!), 403, "FORBIDDEN");

    const accepted = await transitionTask(baseUrl, cookies.get("advisor")!, founderTaskId,
      "task01-advisor-accept", taskTransitionBody("accepted", 1, "", null));
    assertTaskReceipt(accepted, 200, 2);
    const stale = await transitionTask(baseUrl, cookies.get("advisor")!, founderTaskId,
      "task01-stale", taskTransitionBody("accepted", 1, "", null));
    assertApiError(stale, 409, "STALE_VERSION");
    const completed = await transitionTask(baseUrl, cookies.get("advisor")!, founderTaskId,
      "task01-advisor-complete", taskTransitionBody("completed", 2, "synthetic completion", null));
    assertTaskReceipt(completed, 200, 3);
    const approved = await transitionTask(baseUrl, founderRelogin, founderTaskId,
      "task01-founder-approve", taskTransitionBody("approved", 3, "synthetic approval", null));
    assertTaskReceipt(approved, 200, 4);
    const contractorAccepted = await transitionTask(baseUrl, cookies.get("contractor")!, contractorTaskId,
      "task01-contractor-accept", taskTransitionBody("accepted", 1, "", null));
    assertTaskReceipt(contractorAccepted, 200, 2);
    const beforeFounderOwnerDenial = await readTaskCounts(target);
    const founderOwnerDenied = await transitionTask(
      baseUrl,
      founderRelogin,
      reassignmentTaskId,
      "task01-founder-reassign-denied",
      taskTransitionBody("reassigned", 1, "synthetic denied reassignment", CONTRACTOR.userId),
    );
    assertApiError(founderOwnerDenied, 403, "FORBIDDEN");
    assertNoPrivateErrorEcho(founderOwnerDenied, ["synthetic denied reassignment"]);
    assert.deepEqual(await readTaskCounts(target), beforeFounderOwnerDenial);
    const reassigned = await transitionTask(baseUrl, cookies.get("other_advisor")!, reassignmentTaskId,
      "task01-founder-reassign", taskTransitionBody("reassigned", 1, "synthetic reassignment", CONTRACTOR.userId));
    assertTaskReceipt(reassigned, 200, 2);
    const cancelled = await transitionTask(baseUrl, cookies.get("other_advisor")!, cancellationTaskId,
      "task01-founder-cancel", taskTransitionBody("cancelled", 1, "synthetic cancellation", null));
    assertTaskReceipt(cancelled, 200, 2);
    const concurrentResults = await Promise.all([
      transitionTask(baseUrl, cookies.get("advisor")!, advisorTaskId,
        "task01-concurrent-a", taskTransitionBody("accepted", 1, "", null)),
      transitionTask(baseUrl, cookies.get("advisor")!, advisorTaskId,
        "task01-concurrent-b", taskTransitionBody("accepted", 1, "", null)),
    ]);
    assert.deepEqual(concurrentResults.map(({ response }) => response.status).sort(), [200, 409]);
    assertTaskReceipt(concurrentResults.find(({ response }) => response.status === 200)!, 200, 2);
    assertApiError(concurrentResults.find(({ response }) => response.status === 409)!, 409, "STALE_VERSION");
    assertApiError(await transitionTask(baseUrl, cookies.get("admin")!, contractorTaskId,
      "task01-admin-transition", taskTransitionBody("completed", 2, "denied", null)), 403, "FORBIDDEN");
    const taskDetail = await getJson(baseUrl, `/api/v1/tasks/${founderTaskId}`, founderRelogin);
    assert.equal(taskDetail.response.status, 200);
    const taskDetailData = requiredRecord(taskDetail.body.data);
    assert.equal(requiredRecord(taskDetailData.task).state, "approved");
    const reassignedDetail = await getJson(baseUrl, `/api/v1/tasks/${reassignmentTaskId}`, founderRelogin);
    const reassignedDetailData = requiredRecord(reassignedDetail.body.data);
    assert.equal(requiredRecord(reassignedDetailData.task).state, "reassigned");
    assertSensitiveEqual(
      requiredRecord(requiredRecord(reassignedDetailData.task).assignee).id,
      CONTRACTOR.userId,
      "task_reassigned_assignee_id",
    );
    const cancelledDetail = await getJson(baseUrl, `/api/v1/tasks/${cancellationTaskId}`, founderRelogin);
    const cancelledDetailData = requiredRecord(cancelledDetail.body.data);
    assert.equal(requiredRecord(cancelledDetailData.task).state, "cancelled");
    const taskCountsAfter = await readTaskCounts(target);
    assert.deepEqual(taskDelta(taskCountsBefore, taskCountsAfter), {
      tasks: 6, assignments: 7, transitions: 7, idempotency: 13, audit: 13, outbox: 13,
    });

    await installTaskFailure(target);
    try {
      const beforeTaskFailure = await readTaskCounts(target);
      const failedTask = await createTask(baseUrl, founderRelogin, "task01-transaction-failure",
        taskCreateBody(founderCaseId, ADVISOR.userId, "Rollback synthetic task"));
      assertApiError(failedTask, 503, "SERVICE_UNAVAILABLE");
      assertNoPrivateErrorEcho(failedTask, ["Rollback synthetic task"]);
      assert.deepEqual(await readTaskCounts(target), beforeTaskFailure);
    } finally {
      await removeTaskFailure(target);
    }

    await installAssessmentFailure(target);
    try {
      const failedBody = createBody(
        NEON_TEST_STUDENTS[1]!.id, 2035, "transfer", ADVISOR.roleBindingId,
      );
      const failed = await createCase(
        baseUrl, cookies.get("advisor")!, "case01-transaction-failure", failedBody,
      );
      assertApiError(failed, 500, "INTERNAL_ERROR");
      assertNoPrivateErrorEcho(failed, Object.values(failedBody).map(String));
      assert.deepEqual(await readCaseCounts(target), afterAllowed);
    } finally {
      await removeAssessmentFailure(target);
    }

    const legacyEvidence = await assertRetiredCaseHttpSurfaces({
      target,
      baseUrl,
      cookies,
      caseId: founderCaseId,
    });
    const workflowEvidence = await assertCaseWorkflowHttpMatrix({
      target,
      baseUrl,
      cookies,
      passwords,
      founderCaseId,
      advisorCaseId,
      founderTaskBody,
      founderTaskReceipt: founderTask.body.data,
      founderTaskId,
      expectedSchema: assessmentSchema,
    });

    await assertCrossTenantReadsAreEmpty(target, founderCaseId);
    assertDatabaseContract(await inspectBaselineWithNewClient(target), target, manifestSha256);
    assertNoSensitiveDevLogs(devServer, [
      ...NEON_TEST_STUDENTS.map(({ displayName }) => displayName),
      applicationPassword,
      ...passwords.values(),
      otherAdvisorPassword,
      "postgresql://",
      "XX001",
      "cases_assessments_pkey",
      ASSESSMENT_PRIVATE_MARKER,
      WORKFLOW_PRIVATE_MARKER,
    ]);

    evidence = Object.freeze({
      status: "pass",
      postgres_major: 17,
      baseline_id: baseline.baseline_id,
      generated_files: baseline.generated_files,
      role_contract: baseline.verification.role_contract,
      rls_not_forced_count: baseline.verification.rls_not_forced_count,
      unsafe_security_definer_count: baseline.verification.unsafe_security_definer_count,
      allowed_roles: Object.freeze(["founder", "advisor"]),
      denied_roles: Object.freeze(["admin", "contractor"]),
      case_parent_update_privilege: "five_columns_exact",
      case_parent_key_share: "pass",
      direct_case_updates: "fail_closed",
      case_parent_direct_guards: caseParentWriteBoundary,
      advisor_primary_self_only: true,
      exact_replay: "same_result_no_new_rows",
      changed_payload: "conflict_no_new_rows",
      active_duplicate: "conflict_no_new_rows",
      transaction_failure: "internal_error_full_rollback",
      cross_tenant_read: "current_reauth_forbidden",
      persisted_after_relogin: true,
      http: Object.freeze({ create: 200, list: 200, detail: 200, forbidden: 403 }),
      task_workflow: Object.freeze({ create: 201, read: 200, transition: 200,
        contractor_redaction: "exact", stale: 409, concurrent: "one_winner_one_stale",
        replay: "exact", rollback: "zero_effects", policy: "OD-06" }),
      assessment_workflow: assessmentEvidence,
      case_workflow: workflowEvidence,
      retired_case_surfaces: legacyEvidence,
    });
  } finally {
    await stopNextDev(devServer);
    await rm(appDirectory, { recursive: true, force: true });
    if (containerStarted) {
      await runDocker(["rm", "--force", containerName], "postgres_container_cleanup");
    }
    if (secretVolumeCreated) {
      await runDocker(["volume", "rm", "--force", credentialVolumeName], "postgres_secret_cleanup");
    }
  }

  process.stdout.write(`${JSON.stringify(evidence)}\n`);
});

async function assertP2CaseIntakeFlow(input: {
  readonly target: OneRoleBaselineTarget;
  readonly baseUrl: string;
  readonly cookies: Map<string, string>;
  readonly assessmentSchema: ExpectedAssessmentSchema;
  readonly advisorPassword: string;
}): Promise<Readonly<{
  readonly caseCreate: Readonly<Record<string, unknown>>;
  readonly assessment: Readonly<Record<string, unknown>>;
}>> {
  const advisorCookie = input.cookies.get("advisor")!;
  const options = await getJson(input.baseUrl, "/api/v1/cases/intake-options", advisorCookie);
  assert.equal(options.response.status, 200, JSON.stringify(options.body));
  const optionsData = requiredRecord(options.body.data);
  assert.deepEqual(Object.keys(optionsData).sort(), ["advisors", "referral_sources", "students"]);
  assert.equal(requiredArray(optionsData.students).length, 2);
  assert.ok(requiredArray(optionsData.advisors).length >= 1);
  assert.ok(requiredArray(optionsData.advisors).length <= 20);
  assert.ok(requiredArray(optionsData.referral_sources).length <= 20);
  for (const role of ["founder", "admin", "contractor"] as const) {
    const denied = await createCase(
      input.baseUrl,
      input.cookies.get(role)!,
      `p2-case-intake-denied-${role}`,
      {
        student_id: NEON_TEST_STUDENTS[0]!.id,
        primary_advisor_role_binding_id: ADVISOR.roleBindingId,
        intake_year: 2027,
        admission_type: "transfer",
        signed_at: "2027-01-15T08:00:00+08:00",
      },
    );
    assertApiError(denied, 403, "FORBIDDEN");
  }

  const body = Object.freeze({
    student_id: NEON_TEST_STUDENTS[0]!.id,
    primary_advisor_role_binding_id: ADVISOR.roleBindingId,
    intake_year: 2027,
    admission_type: "transfer",
    signed_at: "2027-01-15T08:00:00+08:00",
  });
  const before = await readCaseCounts(input.target);
  const created = await createCase(
    input.baseUrl,
    advisorCookie,
    "p2-case-intake-create",
    body,
  );
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  const receipt = requiredRecord(created.body.data);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "assessment_manifest",
    "assessment_url",
    "case_id",
    "record_version",
    "stage",
    "workflow_status",
  ]);
  const caseId = assertSensitiveUuid(requiredString(receipt, "case_id"), "case_intake_case_id");
  assert.equal(receipt.stage, "background_collection");
  assert.equal(receipt.workflow_status, "active");
  assert.equal(receipt.record_version, 2);
  assert.equal(receipt.assessment_url, `/cases/${caseId}/assessment`);
  const manifest = requiredRecord(receipt.assessment_manifest);
  assertSensitiveUuid(requiredString(manifest, "id"), "case_intake_manifest_id");
  assert.equal(typeof manifest.version, "string");

  const after = await readCaseCounts(input.target);
  assert.deepEqual(caseDelta(before, after), {
    cases: 1,
    assessments: 1,
    idempotency: 1,
    audit: 1,
    outbox: 1,
  });
  const replay = await createCase(
    input.baseUrl,
    advisorCookie,
    "p2-case-intake-create",
    body,
  );
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body.data, created.body.data);
  assert.deepEqual(await readCaseCounts(input.target), after);
  const conflict = await createCase(
    input.baseUrl,
    advisorCookie,
    "p2-case-intake-create",
    { ...body, intake_year: 2028 },
  );
  assertApiError(conflict, 409, "CONFLICT");
  assert.deepEqual(await readCaseCounts(input.target), after);
  const activeDuplicate = await createCase(
    input.baseUrl,
    advisorCookie,
    "p2-case-intake-active-duplicate",
    body,
  );
  assertApiError(activeDuplicate, 409, "CONFLICT");
  assert.deepEqual(await readCaseCounts(input.target), after);

  const detail = await getJson(input.baseUrl, `/api/v1/cases/${caseId}`, advisorCookie);
  assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
  const caseDetail = requiredRecord(detail.body.data?.case);
  assert.equal(caseDetail.id, caseId);
  assert.equal(caseDetail.stage, "background_collection");
  assert.equal(caseDetail.workflowStatus, "active");
  assert.equal(caseDetail.recordVersion, 2);

  const assessment = await assertAssessmentHttpMatrix({
    target: input.target,
    baseUrl: input.baseUrl,
    cookies: input.cookies,
    caseId,
    expectedSchema: input.assessmentSchema,
    advisorPassword: input.advisorPassword,
    release1FourRole: true,
  });
  return Object.freeze({
    caseCreate: Object.freeze({
      exact_receipt: true,
      idempotency_replay: "exact",
      changed_payload: "conflict",
      transaction_delta: caseDelta(before, after),
    }),
    assessment,
  });
}

function createBody(
  studentId: string,
  intakeYear: number,
  admissionType: string,
  primaryRoleBindingId: string,
) {
  return Object.freeze({
    student_id: studentId,
    intake_year: intakeYear,
    admission_type: admissionType,
    primary_role_binding_id: primaryRoleBindingId,
    manifest_id: NEON_TEST_MANIFEST_ID,
  });
}

function taskCreateBody(caseId: string, assigneeUserId: string, title: string) {
  return Object.freeze({ case_id: caseId, title, task_brief: "Synthetic Task brief without private data.",
    due_at: "2027-06-01T00:00:00.000Z", assignee_user_id: assigneeUserId });
}
function taskTransitionBody(to: string, expectedRecordVersion: number, reason: string,
  nextAssigneeUserId: string | null) {
  return Object.freeze({ to, expected_record_version: expectedRecordVersion, reason,
    next_assignee_user_id: nextAssigneeUserId });
}
async function createTask(baseUrl: string, cookie: string, idempotencyKey: string, body: unknown) {
  const response = await fetch(`${baseUrl}/api/v1/tasks`, { method: "POST",
    headers: { cookie, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body) });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}
async function transitionTask(baseUrl: string, cookie: string, taskId: string,
  idempotencyKey: string, body: unknown) {
  const response = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/transitions`, { method: "POST",
    headers: { cookie, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body) });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}
function assertTaskReceipt(result: Readonly<{ response: Response; body: ApiEnvelope }>, status: number,
  expectedVersion: number): void {
  assert.equal(result.response.status, status);
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data).sort(), ["id", "record_version"]);
  assertSensitiveUuid(requiredString(data, "id"), "task_receipt_id");
  assert.equal(data.record_version, expectedVersion);
}

type ApiEnvelope = {
  readonly api_version?: string;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code?: string };
};

async function assertCaseCreated(
  baseUrl: string,
  cookie: string,
  result: Readonly<{ response: Response; body: ApiEnvelope }>,
  requestBody: ReturnType<typeof createBody>,
): Promise<string> {
  assert.equal(result.response.status, 200);
  assert.equal(result.body.api_version, "v1");
  const receipt = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(receipt).sort(), ["id", "record_version"]);
  const id = assertSensitiveUuid(requiredString(receipt, "id"), "case_create_receipt_id");
  assert.equal(receipt.record_version, 2);
  const authority = await getJson(baseUrl, `/api/v1/cases/${id}`, cookie);
  assert.equal(authority.response.status, 200);
  const created = requiredRecord(authority.body.data?.case);
  assertSensitiveEqual(created.id, id, "case_authority_id");
  assertSensitiveEqual(created.studentId, requestBody.student_id, "case_authority_student_id");
  assertSensitiveEqual(created.intakeYear, requestBody.intake_year, "case_authority_intake_year");
  assertSensitiveEqual(
    created.admissionType,
    requestBody.admission_type,
    "case_authority_admission_type",
  );
  assertSensitiveEqual(created.manifestId, requestBody.manifest_id, "case_authority_manifest_id");
  assert.equal(created.stage, "background_collection");
  assert.equal(created.workflowStatus, "active");
  assert.equal(created.recordVersion, 2);
  assert.deepEqual(created.availableWorkflowActions, ["pause"]);
  return id;
}

async function createCase(
  baseUrl: string,
  cookie: string,
  idempotencyKey: string,
  body: unknown,
) {
  const response = await fetch(`${baseUrl}/api/v1/cases`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}

async function getJson(baseUrl: string, path: string, cookie: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}

async function readOptions(baseUrl: string, cookie: string) {
  const result = await getJson(baseUrl, "/api/v1/cases/options", cookie);
  assert.equal(result.response.status, 200);
  const options = requiredRecord(result.body.data?.options);
  return Object.freeze({
    students: requiredArray(options.students).map(requiredRecord),
    primaryBindings: requiredArray(options.primaryBindings).map((value) => {
      const binding = requiredRecord(value);
      return Object.freeze({ id: requiredString(binding, "id") });
    }),
    manifests: requiredArray(options.manifests).map(requiredRecord),
  });
}

type ExpectedAssessmentSchema = ReturnType<typeof resolveAssessmentSchema>;
type HttpResult = Readonly<{ response: Response; body: ApiEnvelope }>;
type AssessmentAnswerCommand = Readonly<{
  field_id: string;
  semantic_state: "provided";
  value: Readonly<{ type: string; value: string | number | readonly string[] }>;
  value_type: string;
  expected_record_version: number;
}>;
type AssessmentAuthority = Readonly<{
  assessmentId: string;
  recordVersion: number;
  status: string;
  answers: readonly Readonly<Record<string, unknown>>[];
}>;

async function assertAssessmentHttpMatrix(input: {
  readonly target: OneRoleBaselineTarget;
  readonly baseUrl: string;
  readonly cookies: Map<string, string>;
  readonly caseId: string;
  readonly expectedSchema: ExpectedAssessmentSchema;
  readonly advisorPassword: string;
  readonly release1FourRole?: boolean;
}): Promise<Readonly<Record<string, unknown>>> {
  const primaryCookie = input.cookies.get("advisor")!;
  const fields = input.expectedSchema.fields;
  const editableFieldIds = fields.map(({ fieldId }) => fieldId);
  const primaryAccess = Object.freeze({
    mode: "full",
    can_edit: true,
    editable_field_ids: editableFieldIds,
    can_complete_background: true,
  });
  const readOnlyAccess = Object.freeze({
    mode: "full",
    can_edit: false,
    editable_field_ids: Object.freeze([]),
    can_complete_background: false,
  });
  const initialHttp = await getJson(input.baseUrl, assessmentPath(input.caseId), primaryCookie);
  if (initialHttp.response.status === 500) {
    await assertAssessmentGetDiagnostic(input.target, input.caseId);
  }
  const initial = assertAssessmentAuthority(
    initialHttp,
    input.expectedSchema,
    primaryAccess,
    "draft",
    1,
  );
  assert.equal(initial.answers.length, 0);
  for (const role of (input.release1FourRole ? ["founder"] as const : ["founder", "admin"] as const)) {
    const view = assertAssessmentAuthority(
      await getJson(input.baseUrl, assessmentPath(input.caseId), input.cookies.get(role)!),
      input.expectedSchema,
      readOnlyAccess,
      "draft",
      1,
    );
    assertSensitiveEqual(view.assessmentId, initial.assessmentId, `assessment_${role}_authority_id`);
  }
  assertApiError(
    await getJson(input.baseUrl, assessmentPath(input.caseId), input.cookies.get("other_advisor")!),
    404,
    "NOT_FOUND",
  );
  for (const role of ["admin", "contractor"] as const) {
    assertApiError(
      await getJson(input.baseUrl, assessmentPath(input.caseId), input.cookies.get(role)!),
      403,
      "FORBIDDEN",
    );
  }

  const commands = fields.map((field, index) => providedAnswerCommand(field, index, 0));
  const countsBefore = await readSliceOneCounts(input.target);
  const invalid = await patchAssessment(
    input.baseUrl,
    input.caseId,
    primaryCookie,
    "caseflow-assessment-invalid",
    { ...commands[0]!, unexpected: true },
  );
  assertApiError(invalid, 400, "INVALID_REQUEST");
  assert.deepEqual(await readSliceOneCounts(input.target), countsBefore);

  for (const role of (input.release1FourRole ? ["founder"] as const : ["founder", "admin"] as const)) {
    const denied = await patchAssessment(
      input.baseUrl,
      input.caseId,
      input.cookies.get(role)!,
      `caseflow-assessment-readonly-${role}`,
      commands[0]!,
    );
    assertApiError(denied, 403, "FORBIDDEN");
  }
  assertApiError(await patchAssessment(
    input.baseUrl,
    input.caseId,
    input.cookies.get("other_advisor")!,
    "caseflow-assessment-other-advisor",
    commands[0]!,
  ), 404, "NOT_FOUND");
  for (const role of ["admin", "contractor"] as const) {
    assertApiError(await patchAssessment(
      input.baseUrl,
      input.caseId,
      input.cookies.get(role)!,
      `caseflow-assessment-denied-${role}`,
      commands[0]!,
    ), 403, "FORBIDDEN");
  }
  assert.deepEqual(await readSliceOneCounts(input.target), countsBefore);

  const first = await patchAssessment(
    input.baseUrl,
    input.caseId,
    primaryCookie,
    "caseflow-assessment-answer-00",
    commands[0]!,
  );
  if (first.response.status === 500) {
    await assertAssessmentPatchDiagnostic({
      target: input.target,
      caseId: input.caseId,
      command: commands[0]!,
      expectedCounts: countsBefore,
      idempotencyKey: "caseflow-assessment-answer-00",
      ordinal: 1,
      category: assessmentFillCategory(commands[0]!),
      httpCode: safeAssessmentHttpCode(first),
    });
  }
  assertMutationAcknowledgement(first, initial.assessmentId, 1);
  const afterFirst = await readSliceOneCounts(input.target);
  const firstReplay = await patchAssessment(
    input.baseUrl,
    input.caseId,
    primaryCookie,
    "caseflow-assessment-answer-00",
    commands[0]!,
  );
  assert.equal(firstReplay.response.status, 200);
  assertSensitiveEqual(firstReplay.body.data, first.body.data, "assessment_answer_replay_receipt");
  assert.deepEqual(await readSliceOneCounts(input.target), afterFirst);
  assertApiError(await patchAssessment(
    input.baseUrl,
    input.caseId,
    primaryCookie,
    "caseflow-assessment-answer-00",
    { ...commands[0]!, expected_record_version: 1 },
  ), 409, "CONFLICT");
  assertApiError(await patchAssessment(
    input.baseUrl,
    input.caseId,
    primaryCookie,
    "caseflow-assessment-answer-stale",
    commands[0]!,
  ), 409, "STALE_VERSION");
  assert.deepEqual(await readSliceOneCounts(input.target), afterFirst);

  const concurrent = await Promise.all([
    patchAssessment(input.baseUrl, input.caseId, primaryCookie,
      "caseflow-assessment-answer-concurrent-a", commands[1]!),
    patchAssessment(input.baseUrl, input.caseId, primaryCookie,
      "caseflow-assessment-answer-concurrent-b", commands[1]!),
  ]);
  assert.deepEqual(concurrent.map(({ response }) => response.status).sort(), [200, 409]);
  assertMutationAcknowledgement(
    concurrent.find(({ response }) => response.status === 200)!,
    initial.assessmentId,
    1,
  );
  assertApiError(
    concurrent.find(({ response }) => response.status === 409)!,
    409,
    "STALE_VERSION",
  );

  const incompleteCounts = await readSliceOneCounts(input.target);
  assertApiError(await completeAssessment(
    input.baseUrl,
    input.caseId,
    primaryCookie,
    "caseflow-assessment-incomplete",
    1,
  ), 422, "VALIDATION_FAILED");
  assert.deepEqual(await readSliceOneCounts(input.target), incompleteCounts);

  await installAssessmentMutationFailure(input.target);
  try {
    const beforeRollback = await readSliceOneCounts(input.target);
    const rollback = await patchAssessment(
      input.baseUrl,
      input.caseId,
      primaryCookie,
      "caseflow-assessment-rollback",
      commands[2]!,
    );
    assertApiError(rollback, 500, "INTERNAL_ERROR");
    assertNoPrivateErrorEcho(rollback, [ASSESSMENT_PRIVATE_MARKER]);
    assert.deepEqual(await readSliceOneCounts(input.target), beforeRollback);
  } finally {
    await removeAssessmentMutationFailure(input.target);
  }

  for (let index = 2; index < commands.length; index += 1) {
    const ordinal = index + 1;
    const command = commands[index]!;
    const category = assessmentFillCategory(command);
    const idempotencyKey = `caseflow-assessment-answer-${String(index).padStart(2, "0")}`;
    const beforePatch = await readSliceOneCounts(input.target);
    const result = await patchAssessment(
      input.baseUrl,
      input.caseId,
      primaryCookie,
      idempotencyKey,
      command,
    );
    if (result.response.status === 500) {
      assertNoPrivateErrorEcho(result, [ASSESSMENT_PRIVATE_MARKER]);
      await assertAssessmentPatchDiagnostic({
        target: input.target,
        caseId: input.caseId,
        command,
        expectedCounts: beforePatch,
        idempotencyKey,
        ordinal,
        category,
        httpCode: safeAssessmentHttpCode(result),
      });
    }
    assertMutationAcknowledgement(result, initial.assessmentId, 1);
  }
  const answered = assertAssessmentAuthority(
    await getJson(input.baseUrl, assessmentPath(input.caseId), primaryCookie),
    input.expectedSchema,
    primaryAccess,
    "draft",
    1,
  );
  assertAssessmentAnswers(answered.answers, commands, input.expectedSchema);

  const beforeCompletionStale = await readSliceOneCounts(input.target);
  const completionStale = await completeAssessment(
    input.baseUrl,
    input.caseId,
    primaryCookie,
    "caseflow-assessment-complete-stale",
    2,
  );
  assertApiError(completionStale, 409, "STALE_VERSION");
  const completionStaleDetails = requiredRecord(requiredRecord(completionStale.body.error).details);
  assert.deepEqual(Object.keys(completionStaleDetails), ["current_version"]);
  assert.equal(completionStaleDetails.current_version, 1);
  assert.deepEqual(await readSliceOneCounts(input.target), beforeCompletionStale);
  const completed = await completeAssessment(
    input.baseUrl,
    input.caseId,
    primaryCookie,
    "caseflow-assessment-complete",
    1,
  );
  assertMutationAcknowledgement(completed, initial.assessmentId, 2);
  const afterCompleted = await readSliceOneCounts(input.target);
  const completionReplay = await completeAssessment(
    input.baseUrl,
    input.caseId,
    primaryCookie,
    "caseflow-assessment-complete",
    1,
  );
  assert.equal(completionReplay.response.status, 200);
  assertSensitiveEqual(
    completionReplay.body.data,
    completed.body.data,
    "assessment_completion_replay_receipt",
  );
  assert.deepEqual(await readSliceOneCounts(input.target), afterCompleted);
  assertApiError(await completeAssessment(
    input.baseUrl,
    input.caseId,
    primaryCookie,
    "caseflow-assessment-complete",
    2,
  ), 409, "CONFLICT");
  assert.deepEqual(await readSliceOneCounts(input.target), afterCompleted);

  const authority = assertAssessmentAuthority(
    await getJson(input.baseUrl, assessmentPath(input.caseId), primaryCookie),
    input.expectedSchema,
    primaryAccess,
    "background_complete",
    2,
  );
  assertAssessmentAnswers(authority.answers, commands, input.expectedSchema);
  const delta = sliceOneDelta(countsBefore, afterCompleted);
  assert.deepEqual(delta, {
    answers: 15,
    lifecycleFacts: 0,
    answerReceipts: 15,
    completionReceipts: 1,
    workflowReceipts: 0,
    audit: 16,
    outbox: 16,
    privateMatches: 0,
  });
  const collaborator = input.release1FourRole
    ? Object.freeze({ excluded: "collaborator_scope_out_of_p2_be_03" })
    : await assertAssessmentCollaboratorHttpMatrix({
      target: input.target,
      baseUrl: input.baseUrl,
      cookie: input.cookies.get("other_advisor")!,
      caseId: input.caseId,
      assessmentId: initial.assessmentId,
      expectedSchema: input.expectedSchema,
    });
  const foreignTenant = await assertForeignTenantAssessmentHttpMatrix({
    target: input.target,
    baseUrl: input.baseUrl,
    cookies: input.cookies,
    caseId: input.caseId,
    expectedSchema: input.expectedSchema,
    password: input.advisorPassword,
  });
  return Object.freeze({
    dto: "exact_15_field_full_projection",
    primary_write: 200,
    founder_admin_read_only: true,
    nonprimary_invisible: 404,
    denied_roles: 403,
    answer_replay: "exact",
    changed_payload: 409,
    stale: 409,
    concurrent: "one_200_one_409",
    rollback: "zero_effects",
    completion: 200,
    collaborator,
    foreign_tenant: foreignTenant,
    delta,
  });
}

async function assertAssessmentCollaboratorHttpMatrix(input: {
  readonly target: OneRoleBaselineTarget;
  readonly baseUrl: string;
  readonly cookie: string;
  readonly caseId: string;
  readonly assessmentId: string;
  readonly expectedSchema: ExpectedAssessmentSchema;
}): Promise<Readonly<Record<string, unknown>>> {
  const educationSchema = educationProfileSchema(input.expectedSchema);
  const educationFieldIds = educationSchema.fields.map(({ fieldId }) => fieldId);
  const viewAccess = Object.freeze({
    mode: "education_profile",
    can_edit: false,
    editable_field_ids: Object.freeze([]),
    can_complete_background: false,
  });
  const editAccess = Object.freeze({
    mode: "education_profile",
    can_edit: true,
    editable_field_ids: educationFieldIds,
    can_complete_background: false,
  });
  await prepareAssessmentCollaborator(input.target, input.caseId, "view");
  const viewAuthority = assertAssessmentAuthority(
    await getJson(input.baseUrl, assessmentPath(input.caseId), input.cookie),
    educationSchema,
    viewAccess,
    "background_complete",
    2,
  );
  assertSensitiveEqual(
    viewAuthority.assessmentId,
    input.assessmentId,
    "assessment_collaborator_view_authority_id",
  );
  assert.equal(viewAuthority.answers.length, 3);
  assertSensitiveEqual(
    viewAuthority.answers.map(({ field_id }) => field_id),
    educationFieldIds,
    "assessment_collaborator_view_answer_order",
  );
  const countsBeforeViewDenials = await readSliceOneCounts(input.target);
  const educationField = educationSchema.fields.find(
    ({ fieldId }) => fieldId === "education_profile.current_year_level",
  );
  if (!educationField) throw new HarnessError("assessment_collaborator_edit_field_fixture");
  const educationCommand = providedAnswerCommand(educationField, 200, 1);
  assertApiError(await patchAssessment(
    input.baseUrl,
    input.caseId,
    input.cookie,
    "caseflow-assessment-collaborator-view-patch",
    educationCommand,
  ), 404, "NOT_FOUND");
  assertApiError(await completeAssessment(
    input.baseUrl,
    input.caseId,
    input.cookie,
    "caseflow-assessment-collaborator-view-complete",
    2,
  ), 404, "NOT_FOUND");
  assertSensitiveEqual(
    await readSliceOneCounts(input.target),
    countsBeforeViewDenials,
    "assessment_collaborator_view_zero_effects",
  );

  await prepareAssessmentCollaborator(input.target, input.caseId, "edit");
  const editAuthority = assertAssessmentAuthority(
    await getJson(input.baseUrl, assessmentPath(input.caseId), input.cookie),
    educationSchema,
    editAccess,
    "background_complete",
    2,
  );
  assertSensitiveEqual(
    editAuthority.assessmentId,
    input.assessmentId,
    "assessment_collaborator_edit_authority_id",
  );
  assertSensitiveEqual(
    editAuthority.answers.map(({ field_id }) => field_id),
    educationFieldIds,
    "assessment_collaborator_edit_answer_order",
  );
  const beforeEdit = await readSliceOneCounts(input.target);
  const updated = await patchAssessment(
    input.baseUrl,
    input.caseId,
    input.cookie,
    "caseflow-assessment-collaborator-edit",
    educationCommand,
  );
  assertMutationAcknowledgement(updated, input.assessmentId, 2);
  const updatedAuthority = assertAssessmentAuthority(
    await getJson(input.baseUrl, assessmentPath(input.caseId), input.cookie),
    educationSchema,
    editAccess,
    "background_complete",
    2,
  );
  assertSensitiveEqual(
    updatedAuthority.answers.map(({ field_id }) => field_id),
    educationFieldIds,
    "assessment_collaborator_updated_answer_order",
  );
  const updatedAnswers = updatedAuthority.answers.filter(
    ({ field_id }) => field_id === educationCommand.field_id,
  );
  if (updatedAnswers.length !== 1) {
    throw new HarnessError("assessment_collaborator_edit_authority_answer");
  }
  const updatedAnswer = updatedAnswers[0]!;
  assertSensitiveEqual(
    updatedAnswer.field_id,
    educationCommand.field_id,
    "assessment_collaborator_edit_field_id",
  );
  assert.equal(updatedAnswer.record_version, 2);
  assertSensitiveEqual(
    updatedAnswer.value,
    educationCommand.value,
    "assessment_collaborator_edit_private_value",
  );
  const afterEdit = await readSliceOneCounts(input.target);
  assertSensitiveEqual(sliceOneDelta(beforeEdit, afterEdit), {
    answers: 0,
    lifecycleFacts: 0,
    answerReceipts: 1,
    completionReceipts: 0,
    workflowReceipts: 0,
    audit: 1,
    outbox: 1,
    privateMatches: 0,
  }, "assessment_collaborator_edit_delta");

  const outsideScopeField = input.expectedSchema.fields.find(
    ({ moduleId }) => moduleId !== "k12-education-profile",
  );
  if (!outsideScopeField) throw new HarnessError("assessment_collaborator_outside_scope_fixture");
  const beforeEditDenials = await readSliceOneCounts(input.target);
  assertApiError(await patchAssessment(
    input.baseUrl,
    input.caseId,
    input.cookie,
    "caseflow-assessment-collaborator-outside-scope",
    providedAnswerCommand(outsideScopeField, 201, 1),
  ), 404, "NOT_FOUND");
  assertApiError(await completeAssessment(
    input.baseUrl,
    input.caseId,
    input.cookie,
    "caseflow-assessment-collaborator-edit-complete",
    2,
  ), 404, "NOT_FOUND");
  assertSensitiveEqual(
    await readSliceOneCounts(input.target),
    beforeEditDenials,
    "assessment_collaborator_edit_denials_zero_effects",
  );
  return Object.freeze({
    schema: "education_profile_exact_three_canonical",
    view_only: "read_200_writes_404",
    edit: "in_scope_200_outside_scope_404",
    completion: 404,
    zero_effects: true,
  });
}

async function assertForeignTenantAssessmentHttpMatrix(input: {
  readonly target: OneRoleBaselineTarget;
  readonly baseUrl: string;
  readonly cookies: Map<string, string>;
  readonly caseId: string;
  readonly expectedSchema: ExpectedAssessmentSchema;
  readonly password: string;
}): Promise<Readonly<Record<string, unknown>>> {
  await prepareForeignAdvisor(input.target);
  const before = await readBusinessAggregateCounts(input.target);
  const foreignContext = Object.freeze({
    organizationId: FOREIGN_ORGANIZATION_ID,
    actorUserId: ADVISOR.userId,
  });
  const foreignBefore = await readBusinessAggregateCounts(input.target, foreignContext);
  let foreignActivated = false;
  let foreignCookie: string | undefined;
  let mainSessionLoggedOut = false;
  try {
    await logoutDatabaseTestSession(
      input.baseUrl,
      input.cookies.get("advisor")!,
      "assessment_foreign_tenant_main_logout",
    );
    mainSessionLoggedOut = true;
    await switchActiveOrganization(input.target, "foreign");
    foreignActivated = true;
    foreignCookie = await login(input.baseUrl, ADVISOR.email, input.password);
    await assertDatabaseTestSessionActor(
      input.baseUrl,
      foreignCookie,
      FOREIGN_ORGANIZATION_ID,
      "assessment_foreign_tenant_actor",
    );
    assertApiError(
      await getJson(input.baseUrl, assessmentPath(input.caseId), foreignCookie),
      404,
      "NOT_FOUND",
    );
    const command = providedAnswerCommand(input.expectedSchema.fields[0]!, 202, 1);
    const denied = await patchAssessment(
      input.baseUrl,
      input.caseId,
      foreignCookie,
      "caseflow-assessment-foreign-tenant",
      command,
    );
    assertApiError(denied, 404, "NOT_FOUND");
    assertNoPrivateErrorEcho(denied, [ASSESSMENT_PRIVATE_MARKER]);
  } finally {
    try {
      if (foreignCookie) {
        await logoutDatabaseTestSession(
          input.baseUrl,
          foreignCookie,
          "assessment_foreign_tenant_logout",
        );
      }
    } finally {
      if (foreignActivated) {
        await switchActiveOrganization(input.target, "main");
      }
      if (mainSessionLoggedOut) {
        const mainCookie = await login(input.baseUrl, ADVISOR.email, input.password);
        await assertDatabaseTestSessionActor(
          input.baseUrl,
          mainCookie,
          NEON_TEST_ORGANIZATION.id,
          "assessment_foreign_tenant_main_actor_restored",
        );
        input.cookies.set("advisor", mainCookie);
      }
    }
  }
  assertSensitiveEqual(
    await readBusinessAggregateCounts(input.target),
    before,
    "assessment_foreign_tenant_zero_effects",
  );
  assertSensitiveEqual(
    await readBusinessAggregateCounts(input.target, foreignContext),
    foreignBefore,
    "assessment_foreign_tenant_own_effects_zero",
  );
  return Object.freeze({ read: 404, patch: 404, zero_effects: true });
}

function educationProfileSchema(expectedSchema: ExpectedAssessmentSchema): ExpectedAssessmentSchema {
  const fields = expectedSchema.fields.filter(
    ({ moduleId }) => moduleId === "k12-education-profile",
  );
  if (fields.length !== 3) throw new HarnessError("assessment_collaborator_schema_fixture");
  return Object.freeze({ ...expectedSchema, fields: Object.freeze(fields) });
}

function assertAssessmentAuthority(
  result: HttpResult,
  expectedSchema: ExpectedAssessmentSchema,
  expectedAccess: Readonly<{
    mode: string;
    can_edit: boolean;
    editable_field_ids: readonly string[];
    can_complete_background: boolean;
  }>,
  expectedStatus: string,
  expectedRecordVersion: number,
): AssessmentAuthority {
  assert.equal(result.response.status, 200);
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data).sort(), [
    "access", "answers", "assessment_id", "manifest_id", "record_version", "schema", "status",
  ]);
  const assessmentId = assertSensitiveUuid(
    requiredString(data, "assessment_id"),
    "assessment_authority_id",
  );
  assertSensitiveEqual(data.manifest_id, NEON_TEST_MANIFEST_ID, "assessment_manifest_id");
  assert.equal(data.record_version, expectedRecordVersion);
  assert.equal(data.status, expectedStatus);
  assert.deepEqual(requiredRecord(data.access), expectedAccess);
  assertSensitiveEqual(requiredRecord(data.schema), {
    manifest_id: NEON_TEST_MANIFEST_ID,
    composition_version: expectedSchema.compositionVersion,
    fields: assessmentApiFields(expectedSchema),
  }, "assessment_schema_authority");
  const answers = requiredArray(data.answers).map((answer) => {
    const record = requiredRecord(answer);
    assert.deepEqual(Object.keys(record).sort(), [
      "field_id", "record_version", "semantic_state", "value", "value_type",
    ]);
    return Object.freeze(record);
  });
  return Object.freeze({
    assessmentId,
    recordVersion: expectedRecordVersion,
    status: expectedStatus,
    answers: Object.freeze(answers),
  });
}

function assessmentApiFields(expectedSchema: ExpectedAssessmentSchema) {
  return expectedSchema.fields.map((field) => ({
    field_id: field.fieldId,
    ...(field.label ? { label: field.label } : {}),
    layer: field.layer,
    ...(field.moduleId ? { module_id: field.moduleId } : {}),
    ...(field.moduleVersion ? { module_version: field.moduleVersion } : {}),
    value_type: field.valueType,
    ...(field.enumValues ? { enum_values: [...field.enumValues] } : {}),
    visibility: field.visibility,
    blocking_stages: [...field.blockingStages],
  }));
}

function providedAnswerCommand(
  field: ExpectedAssessmentSchema["fields"][number],
  index: number,
  expectedRecordVersion: number,
): AssessmentAnswerCommand {
  let value: string | number | readonly string[];
  switch (field.valueType) {
    case "text": value = `${ASSESSMENT_PRIVATE_MARKER}-${index}`; break;
    case "date": value = "2014-03-12"; break;
    case "integer": value = index + 1; break;
    case "enum": value = field.enumValues?.[0] ?? ""; break;
    case "enum_set": value = Object.freeze([field.enumValues?.[0] ?? ""]); break;
  }
  return Object.freeze({
    field_id: field.fieldId,
    semantic_state: "provided",
    value: Object.freeze({ type: field.valueType, value }),
    value_type: field.valueType,
    expected_record_version: expectedRecordVersion,
  });
}

function assessmentFillCategory(command: AssessmentAnswerCommand): AssessmentFillCategory {
  if (["date", "enum", "enum_set", "integer", "text"].includes(command.value_type)) {
    return command.value_type as AssessmentFillCategory;
  }
  throw new HarnessError("assessment_fill_category");
}

function safeAssessmentHttpCode(result: HttpResult): string | null {
  const code = result.body.error?.code;
  return code === "INTERNAL_ERROR" || code === "SERVICE_UNAVAILABLE" ? code : null;
}

function assertAssessmentAnswers(
  answers: readonly Readonly<Record<string, unknown>>[],
  commands: readonly AssessmentAnswerCommand[],
  expectedSchema: ExpectedAssessmentSchema,
): void {
  assert.equal(answers.length, expectedSchema.fields.length);
  assert.deepEqual(answers.map(({ field_id }) => field_id), expectedSchema.fields.map(({ fieldId }) => fieldId));
  for (let index = 0; index < answers.length; index += 1) {
    const answer = answers[index]!;
    const command = commands[index]!;
    assertSensitiveEqual(answer.field_id, command.field_id, "assessment_answer_field_id");
    assert.equal(answer.semantic_state, command.semantic_state);
    assertSensitiveEqual(answer.value, command.value, "assessment_answer_private_value");
    assert.equal(answer.value_type, command.value_type);
    assert.equal(answer.record_version, 1);
  }
}

function assessmentPath(caseId: string): string {
  return `/api/v1/cases/${caseId}/assessment`;
}

async function patchAssessment(
  baseUrl: string,
  caseId: string,
  cookie: string,
  idempotencyKey: string,
  body: unknown,
): Promise<HttpResult> {
  return jsonRequest(baseUrl, assessmentPath(caseId), cookie, "PATCH", body, idempotencyKey);
}

async function completeAssessment(
  baseUrl: string,
  caseId: string,
  cookie: string,
  idempotencyKey: string,
  expectedRecordVersion: number,
): Promise<HttpResult> {
  return jsonRequest(
    baseUrl,
    `${assessmentPath(caseId)}/background-completion`,
    cookie,
    "POST",
    { expected_record_version: expectedRecordVersion },
    idempotencyKey,
  );
}

function assertMutationAcknowledgement(
  result: HttpResult,
  expectedId: string,
  expectedRecordVersion: number,
): void {
  assert.equal(result.response.status, 200);
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data).sort(), ["id", "record_version"]);
  assertSensitiveEqual(data.id, expectedId, "assessment_mutation_receipt_id");
  assert.equal(data.record_version, expectedRecordVersion);
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  cookie: string,
  method: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<HttpResult> {
  const headers = new Headers({ cookie });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}

async function assertRetiredCaseHttpSurfaces(input: {
  readonly target: OneRoleBaselineTarget;
  readonly baseUrl: string;
  readonly cookies: ReadonlyMap<string, string>;
  readonly caseId: string;
}): Promise<Readonly<Record<string, unknown>>> {
  const founderCookie = input.cookies.get("founder")!;
  const before = await readBusinessAggregateCounts(input.target);
  const unauthenticated = await fetch(`${input.baseUrl}/api/cases`);
  assert.equal(unauthenticated.status, 401);
  const unauthenticatedBody = await unauthenticated.json() as ApiEnvelope;
  assert.equal(unauthenticatedBody.error?.code, "UNAUTHENTICATED");

  assertApiError(await getJson(input.baseUrl, "/api/cases", founderCookie), 409, "CONFLICT");
  assertApiError(await jsonRequest(
    input.baseUrl, "/api/cases", founderCookie, "POST",
  ), 409, "CONFLICT");
  assertApiError(await getJson(
    input.baseUrl, "/api/cases/options", founderCookie,
  ), 409, "CONFLICT");
  for (const path of ["/api/cases", "/api/cases/options"] as const) {
    assertApiError(await getJson(
      input.baseUrl, path, input.cookies.get("admin")!,
    ), 403, "FORBIDDEN");
  }
  assertApiError(await jsonRequest(
    input.baseUrl, "/api/cases", input.cookies.get("admin")!, "POST",
  ), 403, "FORBIDDEN");

  const schoolTargets = await getJson(
    input.baseUrl,
    `/api/v1/cases/${input.caseId}/school-targets`,
    founderCookie,
  );
  assert.equal(schoolTargets.response.status, 200);
  const schoolTargetData = requiredRecord(schoolTargets.body.data);
  assert.deepEqual(Object.keys(schoolTargetData).sort(), [
    "admission_type", "can_create", "case_id", "case_stage", "create_blocked_reason",
    "intake_year", "items", "school_options",
  ]);
  assertSensitiveEqual(schoolTargetData.case_id, input.caseId, "school_target_case_id");
  assert.equal(schoolTargetData.case_stage, "background_collection");
  assert.equal(schoolTargetData.can_create, false);
  assert.equal(schoolTargetData.create_blocked_reason, "selection_workflow_required");
  assert.deepEqual(schoolTargetData.items, []);
  assert.deepEqual(schoolTargetData.school_options, []);

  const targetId = randomUUID();
  const retiredPaths = [
    `/api/v1/cases/${input.caseId}/transitions`,
    `/api/v1/cases/${input.caseId}/school-targets`,
    `/api/v1/cases/${input.caseId}/school-targets/${targetId}/transitions`,
    `/api/v1/cases/${input.caseId}/school-targets/${targetId}/outcomes`,
  ] as const;
  for (const path of retiredPaths) {
    assertApiError(await jsonRequest(
      input.baseUrl, path, founderCookie, "POST",
    ), 409, "CONFLICT");
    assertApiError(await jsonRequest(
      input.baseUrl, path, input.cookies.get("admin")!, "POST",
    ), 403, "FORBIDDEN");
  }
  assertApiError(await jsonRequest(
    input.baseUrl, "/api/v1/cases/not-a-uuid/transitions", founderCookie, "POST",
  ), 422, "VALIDATION_FAILED");
  assertApiError(await jsonRequest(
    input.baseUrl,
    `/api/v1/cases/${input.caseId}/school-targets/not-a-uuid/transitions`,
    founderCookie,
    "POST",
  ), 422, "VALIDATION_FAILED");
  assert.deepEqual(await readBusinessAggregateCounts(input.target), before);
  return Object.freeze({
    non_versioned: "401_403_409",
    retired_v1_writes: "403_422_409",
    zero_effects: true,
    school_target_read: "exact_read_only",
  });
}

async function assertCaseWorkflowHttpMatrix(input: {
  readonly target: OneRoleBaselineTarget;
  readonly baseUrl: string;
  readonly cookies: Map<string, string>;
  readonly passwords: ReadonlyMap<string, string>;
  readonly founderCaseId: string;
  readonly advisorCaseId: string;
  readonly founderTaskBody: ReturnType<typeof taskCreateBody>;
  readonly founderTaskReceipt: unknown;
  readonly founderTaskId: string;
  readonly expectedSchema: ExpectedAssessmentSchema;
}): Promise<Readonly<Record<string, unknown>>> {
  const founderCookie = input.cookies.get("founder")!;
  const advisorCookie = input.cookies.get("advisor")!;
  const otherAdvisorCookie = input.cookies.get("other_advisor")!;
  const flowBefore = await readSliceOneCounts(input.target);
  const globalBefore = await readBusinessAggregateCounts(input.target);

  assertApiError(await applyWorkflow(input.baseUrl, input.founderCaseId, founderCookie,
    "caseflow-invalid-pause", { action: "pause", expected_record_version: 2, reason: "" }),
  422, "VALIDATION_FAILED");
  assertApiError(await applyWorkflow(input.baseUrl, input.founderCaseId, founderCookie,
    "caseflow-invalid-resume", { action: "resume", expected_record_version: 2, reason: "invalid" }),
  422, "VALIDATION_FAILED");
  assert.deepEqual(await readBusinessAggregateCounts(input.target), globalBefore);

  assertApiError(await applyWorkflow(input.baseUrl, input.advisorCaseId, otherAdvisorCookie,
    "caseflow-other-advisor", workflowBody("pause", 2, `${WORKFLOW_PRIVATE_MARKER}-denied`)),
  404, "NOT_FOUND");
  for (const role of ["admin", "contractor"] as const) {
    const denied = await applyWorkflow(
      input.baseUrl,
      input.founderCaseId,
      input.cookies.get(role)!,
      `caseflow-workflow-denied-${role}`,
      workflowBody("pause", 2, `${WORKFLOW_PRIVATE_MARKER}-${role}`),
    );
    assertApiError(denied, 403, "FORBIDDEN");
    assertNoPrivateErrorEcho(denied, [WORKFLOW_PRIVATE_MARKER]);
  }
  assert.deepEqual(await readBusinessAggregateCounts(input.target), globalBefore);

  const founderPauseBody = workflowBody("pause", 2, `${WORKFLOW_PRIVATE_MARKER}-founder-pause`);
  const founderPause = await applyWorkflow(
    input.baseUrl,
    input.founderCaseId,
    founderCookie,
    "caseflow-founder-pause",
    founderPauseBody,
  );
  assertMutationAcknowledgement(founderPause, input.founderCaseId, 3);
  assertCaseWorkflowAuthority(await getJson(
    input.baseUrl, `/api/v1/cases/${input.founderCaseId}`, founderCookie,
  ), "paused", 3, ["resume"]);
  const afterPause = await readBusinessAggregateCounts(input.target);
  const pauseReplay = await applyWorkflow(
    input.baseUrl,
    input.founderCaseId,
    founderCookie,
    "caseflow-founder-pause",
    founderPauseBody,
  );
  assert.equal(pauseReplay.response.status, 200);
  assertSensitiveEqual(
    pauseReplay.body.data,
    founderPause.body.data,
    "case_workflow_pause_replay_receipt",
  );
  assert.deepEqual(await readBusinessAggregateCounts(input.target), afterPause);
  assertApiError(await applyWorkflow(
    input.baseUrl,
    input.founderCaseId,
    founderCookie,
    "caseflow-founder-pause",
    workflowBody("pause", 2, `${WORKFLOW_PRIVATE_MARKER}-changed`),
  ), 409, "CONFLICT");
  assertApiError(await applyWorkflow(
    input.baseUrl,
    input.founderCaseId,
    founderCookie,
    "caseflow-founder-stale",
    workflowBody("resume", 2, null),
  ), 409, "STALE_VERSION");
  assert.deepEqual(await readBusinessAggregateCounts(input.target), afterPause);

  const pausedAssessment = assertAssessmentAuthority(
    await getJson(input.baseUrl, assessmentPath(input.founderCaseId), otherAdvisorCookie),
    input.expectedSchema,
    { mode: "full", can_edit: false, editable_field_ids: [], can_complete_background: false },
    "draft",
    1,
  );
  assert.equal(pausedAssessment.answers.length, 0);
  const pausedCommand = providedAnswerCommand(input.expectedSchema.fields[0]!, 100, 0);
  assertApiError(await patchAssessment(
    input.baseUrl,
    input.founderCaseId,
    otherAdvisorCookie,
    "caseflow-paused-assessment-write",
    pausedCommand,
  ), 404, "NOT_FOUND");
  assertApiError(await completeAssessment(
    input.baseUrl,
    input.founderCaseId,
    otherAdvisorCookie,
    "caseflow-paused-assessment-complete",
    1,
  ), 404, "NOT_FOUND");
  assertApiError(await getJson(
    input.baseUrl, `/api/v1/tasks/options?case_id=${input.founderCaseId}`, founderCookie,
  ), 404, "NOT_FOUND");
  assertApiError(await createTask(
    input.baseUrl,
    founderCookie,
    "caseflow-paused-task-create",
    taskCreateBody(input.founderCaseId, ADVISOR.userId, "Paused Case synthetic task"),
  ), 409, "CONFLICT");
  const taskBeforeReplay = await readTaskCounts(input.target);
  const taskReplay = await createTask(
    input.baseUrl,
    founderCookie,
    "task01-founder-create",
    input.founderTaskBody,
  );
  assert.equal(taskReplay.response.status, 201);
  assertSensitiveEqual(taskReplay.body.data, input.founderTaskReceipt, "paused_task_replay_receipt");
  assert.deepEqual(await readTaskCounts(input.target), taskBeforeReplay);
  assert.equal((await getJson(
    input.baseUrl, `/api/v1/tasks/${input.founderTaskId}`, founderCookie,
  )).response.status, 200);
  assert.deepEqual(await readBusinessAggregateCounts(input.target), afterPause);

  const primaryResume = await applyWorkflow(
    input.baseUrl,
    input.founderCaseId,
    otherAdvisorCookie,
    "caseflow-primary-resume",
    workflowBody("resume", 3, null),
  );
  assertMutationAcknowledgement(primaryResume, input.founderCaseId, 4);
  assertCaseWorkflowAuthority(await getJson(
    input.baseUrl, `/api/v1/cases/${input.founderCaseId}`, otherAdvisorCookie,
  ), "active", 4, ["pause"]);

  const concurrentPauseBody = workflowBody(
    "pause", 2, `${WORKFLOW_PRIVATE_MARKER}-advisor-pause`,
  );
  const concurrent = await Promise.all([
    applyWorkflow(input.baseUrl, input.advisorCaseId, advisorCookie,
      "caseflow-advisor-pause-a", concurrentPauseBody),
    applyWorkflow(input.baseUrl, input.advisorCaseId, advisorCookie,
      "caseflow-advisor-pause-b", concurrentPauseBody),
  ]);
  assert.deepEqual(concurrent.map(({ response }) => response.status).sort(), [200, 409]);
  assertMutationAcknowledgement(
    concurrent.find(({ response }) => response.status === 200)!, input.advisorCaseId, 3,
  );
  assertApiError(
    concurrent.find(({ response }) => response.status === 409)!, 409, "STALE_VERSION",
  );
  assertCaseWorkflowAuthority(await getJson(
    input.baseUrl, `/api/v1/cases/${input.advisorCaseId}`, advisorCookie,
  ), "paused", 3, ["resume"]);

  const logout = await fetch(`${input.baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: { cookie: advisorCookie },
    redirect: "manual",
  });
  assert.equal(logout.status, 303);
  const advisorRelogin = await login(
    input.baseUrl,
    ADVISOR.email,
    input.passwords.get("advisor")!,
  );
  input.cookies.set("advisor", advisorRelogin);
  assertCaseWorkflowAuthority(await getJson(
    input.baseUrl, `/api/v1/cases/${input.advisorCaseId}`, advisorRelogin,
  ), "paused", 3, ["resume"]);
  const advisorResume = await applyWorkflow(
    input.baseUrl,
    input.advisorCaseId,
    advisorRelogin,
    "caseflow-advisor-resume",
    workflowBody("resume", 3, null),
  );
  assertMutationAcknowledgement(advisorResume, input.advisorCaseId, 4);
  assertCaseWorkflowAuthority(await getJson(
    input.baseUrl, `/api/v1/cases/${input.advisorCaseId}`, advisorRelogin,
  ), "active", 4, ["pause"]);

  const flowAfter = await readSliceOneCounts(input.target);
  const flowDelta = sliceOneDelta(flowBefore, flowAfter);
  assert.deepEqual(flowDelta, {
    answers: 0,
    lifecycleFacts: 4,
    answerReceipts: 0,
    completionReceipts: 0,
    workflowReceipts: 4,
    audit: 4,
    outbox: 4,
    privateMatches: 0,
  });

  const pendingReceipt = await jsonRequest(
    input.baseUrl,
    `/api/v1/students/${NEON_TEST_STUDENTS[0]!.id}/deletion-requests`,
    founderCookie,
    "POST",
    { expected_record_version: 1, reason_code: "record.lifecycle.pending_delete_requested" },
    "caseflow-pending-student",
  );
  assert.equal(pendingReceipt.response.status, 200);
  const pendingReceiptData = requiredRecord(pendingReceipt.body.data);
  assert.deepEqual(Object.keys(pendingReceiptData).sort(), [
    "deletion_requested_at", "entity_id", "entity_type", "record_version", "status",
  ]);
  assert.equal(pendingReceiptData.entity_type, "student");
  assert.equal(pendingReceiptData.status, "pending_delete");
  const afterPendingTransition = await readBusinessAggregateCounts(input.target);
  assertCaseWorkflowAuthority(await getJson(
    input.baseUrl, `/api/v1/cases/${input.founderCaseId}`, founderCookie,
  ), "active", 4, []);
  assertAssessmentAuthority(
    await getJson(input.baseUrl, assessmentPath(input.founderCaseId), otherAdvisorCookie),
    input.expectedSchema,
    { mode: "full", can_edit: false, editable_field_ids: [], can_complete_background: false },
    "draft",
    1,
  );
  assertApiError(await applyWorkflow(
    input.baseUrl,
    input.founderCaseId,
    founderCookie,
    "caseflow-pending-workflow",
    workflowBody("pause", 4, `${WORKFLOW_PRIVATE_MARKER}-pending`),
  ), 404, "NOT_FOUND");
  assertApiError(await patchAssessment(
    input.baseUrl,
    input.founderCaseId,
    otherAdvisorCookie,
    "caseflow-pending-assessment-write",
    pausedCommand,
  ), 404, "NOT_FOUND");
  assertApiError(await completeAssessment(
    input.baseUrl,
    input.founderCaseId,
    otherAdvisorCookie,
    "caseflow-pending-assessment-complete",
    1,
  ), 404, "NOT_FOUND");
  assertApiError(await createTask(
    input.baseUrl,
    founderCookie,
    "caseflow-pending-task-create",
    taskCreateBody(input.founderCaseId, ADVISOR.userId, "Pending Student synthetic task"),
  ), 404, "NOT_FOUND");
  assertApiError(await getJson(
    input.baseUrl, `/api/v1/tasks/options?case_id=${input.founderCaseId}`, founderCookie,
  ), 404, "NOT_FOUND");
  assert.equal((await getJson(
    input.baseUrl, `/api/v1/tasks/${input.founderTaskId}`, founderCookie,
  )).response.status, 200);
  assert.deepEqual(await readBusinessAggregateCounts(input.target), afterPendingTransition);

  const absentCaseId = randomUUID();
  assertApiError(await getJson(
    input.baseUrl, `/api/v1/cases/${absentCaseId}`, founderCookie,
  ), 404, "NOT_FOUND");
  assertApiError(await getJson(
    input.baseUrl, assessmentPath(absentCaseId), founderCookie,
  ), 404, "NOT_FOUND");
  assertApiError(await applyWorkflow(
    input.baseUrl,
    absentCaseId,
    founderCookie,
    "caseflow-absent-workflow",
    workflowBody("pause", 1, `${WORKFLOW_PRIVATE_MARKER}-absent`),
  ), 404, "NOT_FOUND");
  assert.deepEqual(await readBusinessAggregateCounts(input.target), afterPendingTransition);

  return Object.freeze({
    founder_pause_primary_resume: true,
    advisor_concurrent_pause: "one_200_one_409",
    exact_replay: true,
    changed_payload: 409,
    stale: 409,
    relogin_persistence: true,
    paused_reads: "visible",
    paused_writes: "assessment_404_task_409",
    paused_task_replay: "exact",
    pending_reads: "visible_no_actions",
    pending_writes: 404,
    cross_tenant_or_absent: 404,
    delta: flowDelta,
  });
}

function workflowBody(
  action: "pause" | "resume",
  expectedRecordVersion: number,
  reason: string | null,
) {
  return Object.freeze({
    action,
    expected_record_version: expectedRecordVersion,
    reason,
  });
}

async function applyWorkflow(
  baseUrl: string,
  caseId: string,
  cookie: string,
  idempotencyKey: string,
  body: unknown,
): Promise<HttpResult> {
  return jsonRequest(
    baseUrl,
    `/api/v1/cases/${caseId}/workflow-actions`,
    cookie,
    "POST",
    body,
    idempotencyKey,
  );
}

function assertCaseWorkflowAuthority(
  result: HttpResult,
  expectedStatus: string,
  expectedRecordVersion: number,
  expectedActions: readonly string[],
): void {
  assert.equal(result.response.status, 200);
  const item = requiredRecord(result.body.data?.case);
  assert.equal(item.workflowStatus, expectedStatus);
  assert.equal(item.recordVersion, expectedRecordVersion);
  assert.deepEqual(item.availableWorkflowActions, expectedActions);
}

function assertApiError(
  result: Readonly<{ response: Response; body: ApiEnvelope }>,
  status: number,
  code: string,
): void {
  assert.equal(result.response.status, status);
  assert.equal(result.body.error?.code, code);
}

function assertNoPrivateErrorEcho(
  result: Readonly<{ response: Response; body: ApiEnvelope }>,
  privateValues: readonly string[],
): void {
  const serialized = JSON.stringify(result.body);
  for (const value of privateValues) {
    if (serialized.includes(value)) throw new HarnessError("private_error_echo");
  }
}

function assertSensitiveEqual(actual: unknown, expected: unknown, stage: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new HarnessError(stage);
}

function assertSensitiveUuid(value: string, stage: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )) {
    throw new HarnessError(stage);
  }
  return value;
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessError("http_response_shape");
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new HarnessError("http_response_shape");
  return value;
}

function requiredString(container: unknown, field: string): string {
  const value = requiredRecord(container)[field];
  if (typeof value !== "string") throw new HarnessError("http_response_shape");
  return value;
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(
    new URL(response.headers.get("location")!).pathname,
    email === CONTRACTOR.email ? "/tasks" : "/today",
  );
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new HarnessError("login_cookie_missing");
  if (!/; HttpOnly/i.test(setCookie)) throw new HarnessError("login_cookie_http_only");
  if (!/; SameSite=Lax/i.test(setCookie)) throw new HarnessError("login_cookie_same_site");
  if (/; Secure/i.test(setCookie)) throw new HarnessError("login_cookie_local_secure");
  return setCookie.split(";", 1)[0]!;
}

async function logoutDatabaseTestSession(
  baseUrl: string,
  cookie: string,
  stage: string,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
  if (response.status !== 303) throw new HarnessError(`${stage}_status`);
  const invalidated = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie } });
  if (invalidated.status !== 401) throw new HarnessError(`${stage}_session_active`);
}

async function assertDatabaseTestSessionActor(
  baseUrl: string,
  cookie: string,
  expectedOrganizationId: string,
  stage: string,
): Promise<void> {
  const actor = await getJson(baseUrl, "/api/v1/auth/me", cookie);
  if (actor.response.status !== 200) throw new HarnessError(`${stage}_status`);
  const data = requiredRecord(actor.body.data);
  if (
    data.user_id !== ADVISOR.userId ||
    data.organization_id !== expectedOrganizationId ||
    data.role !== "advisor"
  ) {
    throw new HarnessError(`${stage}_contract`);
  }
}

interface CaseCounts {
  readonly cases: number;
  readonly assessments: number;
  readonly idempotency: number;
  readonly audit: number;
  readonly outbox: number;
}

async function readCaseCounts(target: OneRoleBaselineTarget): Promise<CaseCounts> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [ADVISOR.userId]);
    const result = await client.query<CaseCounts>(`
      SELECT
        (SELECT count(*)::int FROM cases_service_cases) AS cases,
        (SELECT count(*)::int FROM cases_assessments) AS assessments,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation IN ('cases.create_existing_student', 'cases.create_k12_case')) AS idempotency,
        (SELECT count(*)::int FROM audit_events
          WHERE event_type = 'cases.service_case_created') AS audit,
        (SELECT count(*)::int FROM audit_outbox
          WHERE event_type = 'cases.service_case_created') AS outbox
    `);
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) throw new HarnessError("case_count_inspection");
    return Object.freeze(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("case_count_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

function caseDelta(before: CaseCounts, after: CaseCounts): CaseCounts {
  return Object.freeze({
    cases: after.cases - before.cases,
    assessments: after.assessments - before.assessments,
    idempotency: after.idempotency - before.idempotency,
    audit: after.audit - before.audit,
    outbox: after.outbox - before.outbox,
  });
}

interface SliceOneCounts {
  readonly answers: number;
  readonly lifecycleFacts: number;
  readonly answerReceipts: number;
  readonly completionReceipts: number;
  readonly workflowReceipts: number;
  readonly audit: number;
  readonly outbox: number;
  readonly privateMatches: number;
}

async function readSliceOneCounts(target: OneRoleBaselineTarget): Promise<SliceOneCounts> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [ADVISOR.userId]);
    const result = await client.query<{
      answers: number;
      lifecycle_facts: number;
      answer_receipts: number;
      completion_receipts: number;
      workflow_receipts: number;
      audit: number;
      outbox: number;
      private_matches: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM cases_assessment_answers) AS answers,
        (SELECT count(*)::int FROM cases_service_case_lifecycle_facts) AS lifecycle_facts,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation = 'cases.assessment_answer.update') AS answer_receipts,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation = 'cases.assessment.background_complete') AS completion_receipts,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation = 'cases.service_case.workflow_action') AS workflow_receipts,
        (SELECT count(*)::int FROM audit_events
          WHERE event_type IN ('cases.assessment_answer_updated',
            'cases.assessment_background_completed', 'cases.service_case_paused',
            'cases.service_case_resumed')) AS audit,
        (SELECT count(*)::int FROM audit_outbox
          WHERE event_type IN ('cases.assessment_answer_updated',
            'cases.assessment_background_completed', 'cases.service_case_paused',
            'cases.service_case_resumed')) AS outbox,
        ((SELECT count(*)::int FROM audit_events
          WHERE event_type IN ('cases.assessment_answer_updated',
            'cases.assessment_background_completed', 'cases.service_case_paused',
            'cases.service_case_resumed')
            AND (metadata::text LIKE '%' || $1 || '%' OR metadata::text LIKE '%' || $2 || '%'))
        + (SELECT count(*)::int FROM audit_outbox
          WHERE event_type IN ('cases.assessment_answer_updated',
            'cases.assessment_background_completed', 'cases.service_case_paused',
            'cases.service_case_resumed')
            AND (payload::text LIKE '%' || $1 || '%' OR payload::text LIKE '%' || $2 || '%')))
          AS private_matches
    `, [ASSESSMENT_PRIVATE_MARKER, WORKFLOW_PRIVATE_MARKER]);
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) throw new HarnessError("slice_one_count_inspection");
    return Object.freeze({
      answers: row.answers,
      lifecycleFacts: row.lifecycle_facts,
      answerReceipts: row.answer_receipts,
      completionReceipts: row.completion_receipts,
      workflowReceipts: row.workflow_receipts,
      audit: row.audit,
      outbox: row.outbox,
      privateMatches: row.private_matches,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("slice_one_count_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

function sliceOneDelta(before: SliceOneCounts, after: SliceOneCounts): SliceOneCounts {
  return Object.freeze({
    answers: after.answers - before.answers,
    lifecycleFacts: after.lifecycleFacts - before.lifecycleFacts,
    answerReceipts: after.answerReceipts - before.answerReceipts,
    completionReceipts: after.completionReceipts - before.completionReceipts,
    workflowReceipts: after.workflowReceipts - before.workflowReceipts,
    audit: after.audit - before.audit,
    outbox: after.outbox - before.outbox,
    privateMatches: after.privateMatches - before.privateMatches,
  });
}

interface BusinessAggregateCounts {
  readonly cases: number;
  readonly assessments: number;
  readonly answers: number;
  readonly lifecycleFacts: number;
  readonly schoolTargets: number;
  readonly tasks: number;
  readonly taskAssignments: number;
  readonly taskTransitions: number;
  readonly idempotency: number;
  readonly audit: number;
  readonly outbox: number;
}

async function readBusinessAggregateCounts(
  target: OneRoleBaselineTarget,
  context: Readonly<{ organizationId: string; actorUserId: string }> = Object.freeze({
    organizationId: NEON_TEST_ORGANIZATION.id,
    actorUserId: ADVISOR.userId,
  }),
): Promise<BusinessAggregateCounts> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [context.organizationId]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [context.actorUserId]);
    const result = await client.query<{
      cases: number;
      assessments: number;
      answers: number;
      lifecycle_facts: number;
      school_targets: number;
      tasks: number;
      task_assignments: number;
      task_transitions: number;
      idempotency: number;
      audit: number;
      outbox: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM cases_service_cases) AS cases,
        (SELECT count(*)::int FROM cases_assessments) AS assessments,
        (SELECT count(*)::int FROM cases_assessment_answers) AS answers,
        (SELECT count(*)::int FROM cases_service_case_lifecycle_facts) AS lifecycle_facts,
        (SELECT count(*)::int FROM cases_school_targets) AS school_targets,
        (SELECT count(*)::int FROM tasks_tasks) AS tasks,
        (SELECT count(*)::int FROM tasks_task_assignments) AS task_assignments,
        (SELECT count(*)::int FROM tasks_task_transition_receipts) AS task_transitions,
        (SELECT count(*)::int FROM shared_idempotency_records) AS idempotency,
        (SELECT count(*)::int FROM audit_events) AS audit,
        (SELECT count(*)::int FROM audit_outbox) AS outbox
    `);
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) throw new HarnessError("business_aggregate_inspection");
    return Object.freeze({
      cases: row.cases,
      assessments: row.assessments,
      answers: row.answers,
      lifecycleFacts: row.lifecycle_facts,
      schoolTargets: row.school_targets,
      tasks: row.tasks,
      taskAssignments: row.task_assignments,
      taskTransitions: row.task_transitions,
      idempotency: row.idempotency,
      audit: row.audit,
      outbox: row.outbox,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("business_aggregate_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

interface TaskCounts { readonly tasks:number;readonly assignments:number;readonly transitions:number;
  readonly idempotency:number;readonly audit:number;readonly outbox:number }
async function readTaskCounts(target:OneRoleBaselineTarget):Promise<TaskCounts>{const client=new Client(createOneRoleBaselineClientConfig(target));try{
  await client.connect();await client.query("BEGIN");await client.query("SELECT set_config('app.organization_id',$1,true)",[NEON_TEST_ORGANIZATION.id]);
  await client.query("SELECT set_config('app.actor_user_id',$1,true)",[ADVISOR.userId]);const result=await client.query<TaskCounts>(`SELECT
    (SELECT count(*)::int FROM tasks_tasks) AS tasks,(SELECT count(*)::int FROM tasks_task_assignments) AS assignments,
    (SELECT count(*)::int FROM tasks_task_transition_receipts) AS transitions,
    (SELECT count(*)::int FROM shared_idempotency_records WHERE operation IN ('tasks.create','tasks.transition')) AS idempotency,
    (SELECT count(*)::int FROM audit_events WHERE event_type IN ('tasks.task_created','tasks.task_transitioned')) AS audit,
    (SELECT count(*)::int FROM audit_outbox WHERE event_type IN ('tasks.task_created','tasks.task_transitioned')) AS outbox`);
  await client.query("COMMIT");const row=result.rows[0];if(!row)throw new HarnessError("task_count_inspection");return Object.freeze(row);
  }catch(error){await client.query("ROLLBACK").catch(()=>{});if(error instanceof HarnessError)throw error;throw new HarnessError("task_count_inspection");}
  finally{await client.end().catch(()=>{});}}
function taskDelta(before:TaskCounts,after:TaskCounts):TaskCounts{return Object.freeze({tasks:after.tasks-before.tasks,
  assignments:after.assignments-before.assignments,transitions:after.transitions-before.transitions,
  idempotency:after.idempotency-before.idempotency,audit:after.audit-before.audit,outbox:after.outbox-before.outbox});}

async function installAssessmentFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    CREATE FUNCTION public.test_case01_fail_assessment_insert()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
    AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = '23505',
      CONSTRAINT = 'cases_assessments_pkey'; END; $$;
    CREATE TRIGGER test_case01_fail_assessment_insert_trg
    BEFORE INSERT ON public.cases_assessments
    FOR EACH ROW EXECUTE FUNCTION public.test_case01_fail_assessment_insert()
  `, "case_fault_install");
}

async function removeAssessmentFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    DROP TRIGGER IF EXISTS test_case01_fail_assessment_insert_trg ON public.cases_assessments;
    DROP FUNCTION IF EXISTS public.test_case01_fail_assessment_insert()
  `, "case_fault_cleanup");
}

async function installAssessmentMutationFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    CREATE FUNCTION public.test_caseflow01_fail_assessment_effect()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
    AS $$ BEGIN
      IF NEW.event_type = 'cases.assessment_answer_updated' THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
          CONSTRAINT = 'test_caseflow01_assessment_effect_failure';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER test_caseflow01_fail_assessment_effect_trg
    BEFORE INSERT ON public.audit_events
    FOR EACH ROW EXECUTE FUNCTION public.test_caseflow01_fail_assessment_effect()
  `, "assessment_mutation_fault_install");
}

async function removeAssessmentMutationFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    DROP TRIGGER IF EXISTS test_caseflow01_fail_assessment_effect_trg ON public.audit_events;
    DROP FUNCTION IF EXISTS public.test_caseflow01_fail_assessment_effect()
  `, "assessment_mutation_fault_cleanup");
}

async function installTaskFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    CREATE FUNCTION public.test_task01_fail_task_insert()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
    AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = '55000',
      CONSTRAINT = 'test_task01_insert_failure'; END; $$;
    CREATE TRIGGER test_task01_fail_task_insert_trg
    BEFORE INSERT ON public.tasks_tasks
    FOR EACH ROW EXECUTE FUNCTION public.test_task01_fail_task_insert()
  `, "task_fault_install");
}

async function removeTaskFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    DROP TRIGGER IF EXISTS test_task01_fail_task_insert_trg ON public.tasks_tasks;
    DROP FUNCTION IF EXISTS public.test_task01_fail_task_insert()
  `, "task_fault_cleanup");
}

async function executeTestDdl(
  target: OneRoleBaselineTarget,
  sql: string,
  stage: string,
): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query(sql);
  } catch {
    throw new HarnessError(stage);
  } finally {
    await client.end().catch(() => {});
  }
}

async function assertCrossTenantReadsAreEmpty(
  target: OneRoleBaselineTarget,
  caseId: string,
): Promise<void> {
  const pool = new Pool({ ...createOneRoleBaselineClientConfig(target), max: 1 });
  try {
    const adapter = createPostgreSqlAdapter(createTenantTransactionRunner(
      pool as unknown as DatabasePool,
      { expectedLoginUser: ONE_ROLE_CANONICAL_ROLE },
    ));
    const service = new CaseWorkspaceService(new PostgresqlCaseWorkspaceRepository(adapter));
    const actor: IdentitySessionActor = {
      userId: ADVISOR.userId,
      organizationId: FOREIGN_ORGANIZATION_ID,
      role: "advisor",
      sessionId: "64000000-0000-4000-8000-000000000002",
      capturedSessionVersion: 1,
      reauthenticatedAtMs: null,
    };
    const before = await readCaseCounts(target);
    await assert.rejects(
      service.listCases(actor),
      (error: unknown) => isCaseWorkspaceRepositoryError(error) &&
        error.code === "CASE_WORKSPACE_FORBIDDEN",
    );
    assert.deepEqual(await readCaseCounts(target), before);
    await assert.rejects(
      service.findCase(actor, caseId),
      (error: unknown) => isCaseWorkspaceRepositoryError(error) &&
        error.code === "CASE_WORKSPACE_FORBIDDEN",
    );
    assert.deepEqual(await readCaseCounts(target), before);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function assertDirectCaseCreateSucceedsAndRollsBack(
  target: OneRoleBaselineTarget,
): Promise<void> {
  try {
    await runDirectCaseCreateProbe(target);
  } catch (error) {
    if (error instanceof DirectCaseCreateProbeFailure) {
      process.stdout.write(`${JSON.stringify(error.evidence)}\n`);
      throw new HarnessError(`direct_case_create_${error.evidence.stage}`);
    }
    throw new HarnessError("direct_case_create_unknown");
  }
}

async function assertAssessmentGetDiagnostic(
  target: OneRoleBaselineTarget,
  caseId: string,
): Promise<never> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  let stage: AssessmentGetProbeStage = "transaction_context";
  let evidence: AssessmentGetProbeEvidence;
  try {
    await client.connect();
    const adapter: PostgreSqlAdapter = Object.freeze({
      async transaction<T>(context: Readonly<{ organizationId: string; actorUserId: string }>, work: (
        transaction: { query<Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ): Promise<PostgreSqlQueryResult<Row>> },
      ) => Promise<T>): Promise<T> {
        stage = "transaction_context";
        await client.query("BEGIN");
        try {
          await client.query("SELECT set_config('app.organization_id',$1,true)", [context.organizationId]);
          await client.query("SELECT set_config('app.actor_user_id',$1,true)", [context.actorUserId]);
          return await work({
            async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
              const queryStage = assessmentGetProbeQueryStage(text, stage);
              stage = queryStage;
              const result = await client.query<Row>(text, values as unknown[] | undefined);
              if (queryStage === "answers") stage = "projection";
              return Object.freeze({ rows: result.rows, rowCount: result.rowCount ?? result.rows.length });
            },
          });
        } finally {
          await client.query("ROLLBACK").catch(() => {});
        }
      },
    });
    const service = new AssessmentService({
      repository: new PostgresqlAssessmentRepository(adapter),
    });
    const actor: IdentitySessionActor = {
      userId: ADVISOR.userId,
      organizationId: NEON_TEST_ORGANIZATION.id,
      role: "advisor",
      sessionId: "64000000-0000-4000-8000-000000000004",
      capturedSessionVersion: 1,
      reauthenticatedAtMs: null,
    };
    await service.getCaseAssessment({ actor, caseId });
    stage = "projection";
    evidence = assessmentGetProbeEvidence(stage, null, true);
  } catch (error) {
    evidence = assessmentGetProbeEvidence(stage, error, false);
  } finally {
    await client.end().catch(() => {});
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  throw new HarnessError("assessment_get_diagnostic");
}

function assessmentGetProbeQueryStage(
  text: string,
  currentStage: AssessmentGetProbeStage,
): AssessmentGetProbeStage {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.startsWith("select assessment.id as assessment_id")) return "header_query";
  if (normalized.includes("from access_role_bindings as role_binding") ||
      normalized.includes("from access_case_collaborators as collaborator")) {
    return "actor_scope";
  }
  if (normalized.includes("from cases_read_bound_assessment_manifest_fields")) {
    return "manifest_fields";
  }
  if (normalized.includes("from cases_assessment_answers")) return "answers";
  return currentStage;
}

function assessmentGetProbeEvidence(
  stage: AssessmentGetProbeStage,
  error: unknown,
  directReadCompleted: boolean,
): AssessmentGetProbeEvidence {
  const postgres = safeDirectProbePostgresError(error);
  const applicationCode = isAssessmentServiceError(error) ? error.code : null;
  return Object.freeze({
    event: "case01_assessment_get_diagnostic",
    http_status: 500,
    stage,
    direct_read_completed: directReadCompleted,
    postgres_code: postgres?.code ?? null,
    postgres_constraint: postgres?.constraint ?? null,
    application_code: applicationCode,
    javascript_error_class: postgres || applicationCode ? null : safeJavaScriptErrorClass(error),
  });
}

function safeJavaScriptErrorClass(
  error: unknown,
): "Error" | "TypeError" | "RangeError" | null {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof Error) return "Error";
  return null;
}

async function assertAssessmentPatchDiagnostic(input: {
  readonly target: OneRoleBaselineTarget;
  readonly caseId: string;
  readonly command: AssessmentAnswerCommand;
  readonly expectedCounts: SliceOneCounts;
  readonly idempotencyKey: string;
  readonly ordinal: number;
  readonly category: AssessmentFillCategory;
  readonly httpCode: string | null;
}): Promise<never> {
  const beforeDirect = await readSliceOneCounts(input.target);
  if (!sameSliceOneCounts(beforeDirect, input.expectedCounts)) {
    throw new HarnessError("assessment_patch_http_zero_effects");
  }
  const client = new Client(createOneRoleBaselineClientConfig(input.target));
  let stage: AssessmentPatchProbeStage = "read_header";
  let transactionCount = 0;
  let evidence: AssessmentPatchProbeEvidence;
  try {
    await client.connect();
    const adapter: PostgreSqlAdapter = Object.freeze({
      async transaction<T>(context: Readonly<{ organizationId: string; actorUserId: string }>, work: (
        transaction: { query<Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ): Promise<PostgreSqlQueryResult<Row>> },
      ) => Promise<T>): Promise<T> {
        transactionCount += 1;
        const phase = transactionCount === 1 ? "read" : "write";
        stage = phase === "read" ? "read_header" : "receipt_claim";
        await client.query("BEGIN");
        try {
          await client.query("SELECT set_config('app.organization_id',$1,true)", [context.organizationId]);
          await client.query("SELECT set_config('app.actor_user_id',$1,true)", [context.actorUserId]);
          return await work({
            async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
              stage = assessmentPatchProbeQueryStage(text, phase, stage);
              const result = await client.query<Row>(text, values as unknown[] | undefined);
              return Object.freeze({ rows: result.rows, rowCount: result.rowCount ?? result.rows.length });
            },
          });
        } finally {
          const operationStage = stage;
          try {
            await client.query("ROLLBACK");
            stage = operationStage;
          } catch (error) {
            stage = "rollback";
            throw error;
          }
        }
      },
    });
    const service = new AssessmentService({
      repository: new PostgresqlAssessmentRepository(adapter),
    });
    const actor: IdentitySessionActor = {
      userId: ADVISOR.userId,
      organizationId: NEON_TEST_ORGANIZATION.id,
      role: "advisor",
      sessionId: "64000000-0000-4000-8000-000000000006",
      capturedSessionVersion: 1,
      reauthenticatedAtMs: null,
    };
    await service.updateAssessmentAnswer({
      actor,
      caseId: input.caseId,
      command: {
        fieldId: input.command.field_id,
        semanticState: input.command.semantic_state,
        value: input.command.value,
        valueType: input.command.value_type,
        expectedRecordVersion: input.command.expected_record_version,
        requestId: input.idempotencyKey,
        idempotencyKey: input.idempotencyKey,
      },
    });
    evidence = assessmentPatchProbeEvidence(input, stage, null, true);
  } catch (error) {
    evidence = assessmentPatchProbeEvidence(input, stage, error, false);
  } finally {
    await client.end().catch(() => {});
  }
  const afterDirect = await readSliceOneCounts(input.target);
  if (!sameSliceOneCounts(afterDirect, beforeDirect)) {
    throw new HarnessError("assessment_patch_direct_zero_effects");
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  throw new HarnessError("assessment_patch_diagnostic");
}

function assessmentPatchProbeQueryStage(
  text: string,
  phase: "read" | "write",
  currentStage: AssessmentPatchProbeStage,
): AssessmentPatchProbeStage {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (phase === "read") {
    if (normalized.startsWith("select assessment.id as assessment_id")) return "read_header";
    if (normalized.includes("from access_role_bindings as role_binding") ||
        normalized.includes("from access_case_collaborators as collaborator")) return "read_actor";
    if (normalized.includes("from cases_read_bound_assessment_manifest_fields")) {
      return "read_manifest";
    }
    if (normalized.includes("from cases_assessment_answers")) return "read_answers";
    return currentStage;
  }
  if (normalized.startsWith("insert into shared_idempotency_records") ||
      normalized.includes("from shared_idempotency_records")) return "receipt_claim";
  if (normalized.startsWith("select service_case.id") ||
      normalized.startsWith("select assessment.id as assessment_id")) return "write_case_lock";
  if (normalized.includes("from access_role_bindings as role_binding") ||
      normalized.includes("from access_case_collaborators as collaborator")) return "write_actor";
  if (normalized.includes("from cases_assessment_answers") && normalized.includes("for update")) {
    return "write_answer_lock";
  }
  if (normalized.includes("from cases_schema_manifests") ||
      normalized.includes("from cases_read_bound_assessment_manifest_fields")) {
    return "write_manifest";
  }
  if (normalized.startsWith("insert into cases_assessment_answers") ||
      normalized.startsWith("update cases_assessment_answers")) return "write_answer";
  if (normalized.startsWith("insert into audit_events") ||
      normalized.startsWith("insert into audit_outbox")) return "effects";
  if (normalized.startsWith("update shared_idempotency_records")) return "receipt_complete";
  return currentStage;
}

function assessmentPatchProbeEvidence(
  input: Readonly<{
    ordinal: number;
    category: AssessmentFillCategory;
    httpCode: string | null;
  }>,
  stage: AssessmentPatchProbeStage,
  error: unknown,
  directWriteCompleted: boolean,
): AssessmentPatchProbeEvidence {
  const postgres = safeDirectProbePostgresError(error);
  const applicationCode = isAssessmentServiceError(error) ? error.code : null;
  return Object.freeze({
    event: "case01_assessment_patch_diagnostic",
    http_status: 500,
    http_code: input.httpCode,
    ordinal: input.ordinal,
    category: input.category,
    stage,
    direct_write_completed: directWriteCompleted,
    postgres_code: postgres?.code ?? null,
    postgres_constraint: postgres?.constraint ?? null,
    application_code: applicationCode,
    javascript_error_class: postgres || applicationCode ? null : safeJavaScriptErrorClass(error),
  });
}

function sameSliceOneCounts(left: SliceOneCounts, right: SliceOneCounts): boolean {
  return left.answers === right.answers &&
    left.lifecycleFacts === right.lifecycleFacts &&
    left.answerReceipts === right.answerReceipts &&
    left.completionReceipts === right.completionReceipts &&
    left.workflowReceipts === right.workflowReceipts &&
    left.audit === right.audit &&
    left.outbox === right.outbox &&
    left.privateMatches === right.privateMatches;
}

async function runDirectCaseCreateProbe(
  target: OneRoleBaselineTarget,
): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  let stage: DirectCaseCreateProbeStage = "connect";
  try {
    await client.connect();
    const adapter: PostgreSqlAdapter = Object.freeze({
      async transaction<T>(context: Readonly<{ organizationId: string; actorUserId: string }>, work: (
        transaction: { query<Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ): Promise<PostgreSqlQueryResult<Row>> },
      ) => Promise<T>): Promise<T> {
        stage = "begin";
        await client.query("BEGIN");
        try {
          stage = "tenant_context";
          await client.query("SELECT set_config('app.organization_id',$1,true)", [context.organizationId]);
          await client.query("SELECT set_config('app.actor_user_id',$1,true)", [context.actorUserId]);
          return await work({
            async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
              stage = directCaseCreateProbeQueryStage(text);
              const result = await client.query<Row>(text, values as unknown[] | undefined);
              return Object.freeze({ rows: result.rows, rowCount: result.rowCount ?? result.rows.length });
            },
          });
        } finally {
          const operationStage = stage;
          stage = "rollback";
          await client.query("ROLLBACK");
          stage = operationStage;
        }
      },
    });
    const service = new CaseWorkspaceService(new PostgresqlCaseWorkspaceRepository(adapter));
    const actor: IdentitySessionActor = {
      userId: FOUNDER.userId,
      organizationId: NEON_TEST_ORGANIZATION.id,
      role: "founder",
      sessionId: "64000000-0000-4000-8000-000000000003",
      capturedSessionVersion: 1,
      reauthenticatedAtMs: null,
    };
    await service.createCase({
      actor,
      command: {
        studentId: NEON_TEST_STUDENTS[0]!.id,
        intakeYear: 2099,
        admissionType: "transaction_probe",
        primaryRoleBindingId: ADVISOR.roleBindingId,
        manifestId: NEON_TEST_MANIFEST_ID,
        requestId: "case01-direct-transaction-probe",
        idempotencyKey: "case01-direct-transaction-probe",
      },
    });
    stage = "service_return";
    stage = "zero_effects";
    assert.deepEqual(await readCaseCounts(target), {
      cases: 0,
      assessments: 0,
      idempotency: 0,
      audit: 0,
      outbox: 0,
    });
  } catch (error) {
    if (error instanceof DirectCaseCreateProbeFailure) throw error;
    throw new DirectCaseCreateProbeFailure(directCaseCreateProbeFailureEvidence(stage, error));
  } finally {
    stage = "connection_close";
    await client.end().catch(() => {});
  }
}

function directCaseCreateProbeQueryStage(text: string): DirectCaseCreateProbeStage {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.startsWith("insert into shared_idempotency_records")) return "receipt_claim";
  if (normalized.startsWith("select request_hash, state, result_reference, response_hash") &&
      normalized.includes("from shared_idempotency_records")) return "receipt_lock";
  if (normalized.includes("from identity_users as identity_user")) return "actor_reauth";
  if (normalized.startsWith("select id from crm_students")) return "student_lock";
  if (normalized.includes("from access_role_bindings as role_binding") &&
      normalized.includes("where role_binding.id = $1")) return "primary_binding_lock";
  if (normalized.startsWith("select $1::uuid as id where cases_manifest_is_approved")) {
    return "manifest_check";
  }
  if (normalized.startsWith("insert into cases_service_cases")) return "case_insert";
  if (normalized.startsWith("insert into cases_assessments")) return "assessment_insert";
  if (normalized.includes("from cases_advance_new_service_case")) return "signed_advance";
  if (normalized.startsWith("insert into audit_events")) return "effects_audit";
  if (normalized.startsWith("insert into audit_outbox")) return "effects_outbox";
  if (normalized.startsWith("update shared_idempotency_records")) return "receipt_complete";
  return "service_return";
}

function directCaseCreateProbeFailureEvidence(
  stage: DirectCaseCreateProbeStage,
  error: unknown,
): DirectCaseCreateProbeFailureEvidence {
  const postgres = safeDirectProbePostgresError(error);
  const applicationCode = safeDirectProbeApplicationCode(error);
  return Object.freeze({
    event: "case01_direct_create_failure",
    stage,
    postgres_code: postgres?.code ?? null,
    postgres_constraint: postgres?.constraint ?? null,
    application_code: applicationCode,
  });
}

function safeDirectProbePostgresError(error: unknown): Readonly<{
  code: string;
  constraint: string | null;
}> | null {
  if (!(error instanceof Error)) return null;
  const candidate = error as Error & {
    readonly severity?: unknown;
    readonly code?: unknown;
    readonly constraint?: unknown;
  };
  if (typeof candidate.severity !== "string" ||
      !DIRECT_PROBE_POSTGRES_SEVERITIES.has(candidate.severity) ||
      typeof candidate.code !== "string" || !/^[0-9A-Z]{5}$/.test(candidate.code)) {
    return null;
  }
  const code = DIRECT_PROBE_POSTGRES_CODES.has(candidate.code) ? candidate.code : "OTHER";
  const constraint = typeof candidate.constraint === "string"
    ? (DIRECT_PROBE_CONSTRAINTS.has(candidate.constraint) ? candidate.constraint : "OTHER")
    : null;
  return Object.freeze({ code, constraint });
}

function safeDirectProbeApplicationCode(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "CaseWorkspaceError") return null;
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === "string" && DIRECT_PROBE_APPLICATION_CODES.has(code) ? code : null;
}

async function prepareOtherAdvisor(target: OneRoleBaselineTarget): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.organization_id',$1,true), set_config('app.actor_user_id',$2,true)",
      [NEON_TEST_ORGANIZATION.id, FOUNDER.userId],
    );
    await client.query(
      `INSERT INTO identity_users
        (id,normalized_email,status,activated_at,created_by_user_id)
       VALUES ($1,$2,'active',transaction_timestamp(),$3)`,
      [OTHER_ADVISOR.userId, OTHER_ADVISOR.email, FOUNDER.userId],
    );
    await client.query(
      `INSERT INTO access_organization_memberships
        (id,organization_id,user_id,status,activated_at,created_by_user_id)
       VALUES ($1,$2,$3,'active',transaction_timestamp(),$4)`,
      [OTHER_ADVISOR.membershipId, NEON_TEST_ORGANIZATION.id,
        OTHER_ADVISOR.userId, FOUNDER.userId],
    );
    await client.query(
      `INSERT INTO access_employee_profiles
        (membership_id,organization_id,display_name,employment_type)
       VALUES ($1,$2,$3,'FULL_TIME')`,
      [OTHER_ADVISOR.membershipId, NEON_TEST_ORGANIZATION.id,
        "CASE-01 Synthetic Other Advisor"],
    );
    await client.query(
      `INSERT INTO access_role_bindings
        (id,organization_id,membership_id,user_id,role,status,created_by_user_id)
       VALUES ($1,$2,$3,$4,'advisor','active',$5)`,
      [OTHER_ADVISOR.roleBindingId, NEON_TEST_ORGANIZATION.id,
        OTHER_ADVISOR.membershipId, OTHER_ADVISOR.userId, FOUNDER.userId],
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new HarnessError("other_advisor_fixture");
  } finally {
    await client.end().catch(() => {});
  }
}

async function prepareAssessmentCollaborator(
  target: OneRoleBaselineTarget,
  caseId: string,
  capability: "view" | "edit",
): Promise<void> {
  const startsAt = "2027-01-01T00:00:00.000Z";
  const expiresAt = "2027-01-06T00:00:00.000Z";
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.organization_id',$1,true), set_config('app.actor_user_id',$2,true)",
      [NEON_TEST_ORGANIZATION.id, FOUNDER.userId],
    );
    if (capability === "view") {
      await client.query(
        `INSERT INTO access_case_collaborators
          (id,organization_id,case_id,user_id,membership_id,advisor_role_binding_id,
           required_role,status,starts_at,expires_at,granted_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,'advisor','active',
           $7,$8,$9)`,
        [ASSESSMENT_COLLABORATOR.id, NEON_TEST_ORGANIZATION.id, caseId,
          OTHER_ADVISOR.userId, OTHER_ADVISOR.membershipId, OTHER_ADVISOR.roleBindingId,
          startsAt, expiresAt, FOUNDER.userId],
      );
    }
    await client.query(
      `INSERT INTO access_scope_grants
        (id,organization_id,case_id,collaborator_id,scope,capability,status,
         starts_at,expires_at,requested_by_user_id)
       VALUES ($1,$2,$3,$4,'education_profile',$5,'active',
         $6,$7,$8)`,
      [capability === "view" ? ASSESSMENT_COLLABORATOR.viewGrantId
        : ASSESSMENT_COLLABORATOR.editGrantId,
      NEON_TEST_ORGANIZATION.id, caseId, ASSESSMENT_COLLABORATOR.id, capability,
      startsAt, expiresAt, FOUNDER.userId],
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new HarnessError(`assessment_collaborator_${capability}_fixture`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function prepareForeignAdvisor(target: OneRoleBaselineTarget): Promise<void> {
  const mainBefore = await readBusinessAggregateCounts(target);
  const foreignContext = Object.freeze({
    organizationId: FOREIGN_ORGANIZATION_ID,
    actorUserId: ADVISOR.userId,
  });
  const foreignBefore = await readBusinessAggregateCounts(target, foreignContext);
  const client = new Client(createOneRoleBaselineClientConfig(target));
  let stage: ForeignFixtureProbeStage = "connection";
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    stage = "organization_insert";
    await client.query(
      `INSERT INTO access_organizations
        (id,display_name,status,created_by_user_id)
       VALUES ($1,'CASE-01 foreign tenant','disabled',$2)`,
      [FOREIGN_ORGANIZATION_ID, FOUNDER.userId],
    );
    await client.query(
      "SELECT set_config('app.organization_id',$1,true), set_config('app.actor_user_id',$2,true)",
      [FOREIGN_ORGANIZATION_ID, ADVISOR.userId],
    );
    stage = "membership_insert";
    await client.query(
      `INSERT INTO access_organization_memberships
        (id,organization_id,user_id,status,activated_at,created_by_user_id)
       VALUES ($1,$2,$3,'active',transaction_timestamp(),$4)`,
      [FOREIGN_ADVISOR.membershipId, FOREIGN_ORGANIZATION_ID,
        ADVISOR.userId, FOUNDER.userId],
    );
    await client.query(
      `INSERT INTO access_employee_profiles
        (membership_id,organization_id,display_name,employment_type)
       VALUES ($1,$2,$3,'FULL_TIME')`,
      [FOREIGN_ADVISOR.membershipId, FOREIGN_ORGANIZATION_ID,
        "CASE-01 Synthetic Foreign Advisor"],
    );
    stage = "role_binding_insert";
    await client.query(
      `INSERT INTO access_role_bindings
        (id,organization_id,membership_id,user_id,role,status,created_by_user_id)
       VALUES ($1,$2,$3,$4,'advisor','active',$5)`,
      [FOREIGN_ADVISOR.roleBindingId, FOREIGN_ORGANIZATION_ID,
        FOREIGN_ADVISOR.membershipId, ADVISOR.userId, FOUNDER.userId],
    );
    stage = "commit";
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    const failureStage = stage;
    let rollbackCompleted = !transactionStarted;
    if (transactionStarted) {
      rollbackCompleted = await client.query("ROLLBACK").then(
        () => true,
        () => false,
      );
      transactionStarted = false;
    }
    const postgres = safeDirectProbePostgresError(error);
    const mainAfter = await readBusinessAggregateCounts(target);
    const foreignAfter = await readBusinessAggregateCounts(target, foreignContext);
    const evidence: ForeignFixtureProbeEvidence = Object.freeze({
      event: "case01_foreign_fixture_diagnostic",
      stage: failureStage,
      postgres_code: postgres?.code ?? null,
      postgres_constraint: postgres?.constraint ?? null,
      application_code: null,
      javascript_error_class: postgres ? null : safeJavaScriptErrorClass(error),
      rollback_completed: rollbackCompleted,
      main_aggregate_unchanged: isDeepStrictEqual(mainAfter, mainBefore),
      foreign_aggregate_unchanged: isDeepStrictEqual(foreignAfter, foreignBefore),
    });
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    throw new HarnessError(`assessment_foreign_tenant_fixture_${failureStage}`);
  } finally {
    stage = "cleanup";
    await client.end().catch(() => {});
  }
}

async function switchActiveOrganization(
  target: OneRoleBaselineTarget,
  active: "main" | "foreign",
): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  const activateId = active === "main" ? NEON_TEST_ORGANIZATION.id : FOREIGN_ORGANIZATION_ID;
  const disableId = active === "main" ? FOREIGN_ORGANIZATION_ID : NEON_TEST_ORGANIZATION.id;
  try {
    await client.connect();
    await client.query("BEGIN");
    const disabled = await client.query(
      `UPDATE access_organizations
          SET status='disabled', record_version=record_version+1,
              updated_at=transaction_timestamp()
        WHERE id=$1 AND status='active'`,
      [disableId],
    );
    const activated = await client.query(
      `UPDATE access_organizations
          SET status='active', record_version=record_version+1,
              updated_at=transaction_timestamp()
        WHERE id=$1 AND status='disabled'`,
      [activateId],
    );
    if (disabled.rowCount !== 1 || activated.rowCount !== 1) {
      throw new HarnessError("assessment_foreign_tenant_organization_switch");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("assessment_foreign_tenant_organization_switch");
  } finally {
    await client.end().catch(() => {});
  }
}

async function assertAssessmentWriteDependencies(
  target: OneRoleBaselineTarget,
): Promise<void> {
  const permissionClient = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await permissionClient.connect();
    const permissions = await permissionClient.query<{
      owner_exact: boolean;
      insert_allowed: boolean;
      select_allowed: boolean;
      trigger_execute_allowed: boolean;
      row_security: boolean;
      force_row_security: boolean;
    }>(`
      SELECT
        class_row.relowner = current_user::regrole AS owner_exact,
        has_table_privilege(current_user, 'public.cases_assessments', 'INSERT') AS insert_allowed,
        has_table_privilege(current_user, 'public.cases_assessments', 'SELECT') AS select_allowed,
        has_function_privilege(current_user, 'public.cases_validate_assessment_write()', 'EXECUTE')
          AS trigger_execute_allowed,
        class_row.relrowsecurity AS row_security,
        class_row.relforcerowsecurity AS force_row_security
      FROM pg_catalog.pg_class AS class_row
      JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
      WHERE namespace_row.nspname = 'public' AND class_row.relname = 'cases_assessments'
    `);
    const row = permissions.rows[0];
    if (!row) throw new HarnessError("assessment_permission_inventory_missing");
    for (const [name, value] of Object.entries(row)) {
      if (value !== true) throw new HarnessError(`assessment_permission_${name}_false`);
    }
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError(`assessment_permission_inventory_${safePostgresCode(error)}`);
  } finally {
    await permissionClient.end().catch(() => {});
  }

  for (const probe of [
    Object.freeze({ stage: "service_case_select", clause: "" }),
    Object.freeze({ stage: "service_case_key_share", clause: " FOR KEY SHARE" }),
  ]) {
    const client = new Client(createOneRoleBaselineClientConfig(target));
    try {
      await client.connect();
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
      await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
      await client.query(`SELECT id FROM cases_service_cases WHERE false${probe.clause}`);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new HarnessError(`${probe.stage}_${safePostgresCode(error)}`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  for (const probe of [
    Object.freeze({ stage: "manifest_select", clause: "" }),
    Object.freeze({ stage: "manifest_key_share", clause: " FOR KEY SHARE" }),
    Object.freeze({ stage: "manifest_share", clause: " FOR SHARE" }),
    Object.freeze({ stage: "manifest_no_key_update", clause: " FOR NO KEY UPDATE" }),
    Object.freeze({ stage: "manifest_update", clause: " FOR UPDATE" }),
  ]) {
    const client = new Client(createOneRoleBaselineClientConfig(target));
    try {
      await client.connect();
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
      await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
      await client.query(
        `SELECT id FROM cases_schema_manifests WHERE id = $1${probe.clause}`,
        [NEON_TEST_MANIFEST_ID],
      );
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new HarnessError(`${probe.stage}_${safePostgresCode(error)}`);
    } finally {
      await client.end().catch(() => {});
    }
  }
}

async function assertCaseParentWriteBoundary(
  target: OneRoleBaselineTarget,
  caseId: string,
): Promise<Readonly<{
  stage_self_update: CaseParentQueryEvidence;
  unapproved_column_update: CaseParentQueryEvidence;
}>> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    const acl = await client.query<{
      table_update_granted: boolean;
      update_column_count: number;
      update_columns: string[];
    }>(`
      WITH target_table AS MATERIALIZED (
        SELECT class_row.oid, class_row.relacl
        FROM pg_catalog.pg_class AS class_row
        JOIN pg_catalog.pg_namespace AS namespace_row
          ON namespace_row.oid = class_row.relnamespace
        WHERE namespace_row.nspname = 'public'
          AND class_row.relname = 'cases_service_cases'
      ), column_acl AS MATERIALIZED (
        SELECT attribute_row.attname, privilege_row.privilege_type,
               privilege_row.grantee
        FROM target_table
        JOIN pg_catalog.pg_attribute AS attribute_row
          ON attribute_row.attrelid = target_table.oid
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) AS privilege_row
      ), table_acl AS MATERIALIZED (
        SELECT privilege_row.privilege_type, privilege_row.grantee
        FROM target_table
        CROSS JOIN LATERAL pg_catalog.aclexplode(target_table.relacl) AS privilege_row
      )
      SELECT
        EXISTS (
          SELECT 1 FROM table_acl
          WHERE privilege_type = 'UPDATE' AND grantee = current_user::regrole::oid
        ) AS table_update_granted,
        (SELECT count(*)::int FROM column_acl
          WHERE privilege_type = 'UPDATE'
            AND grantee = current_user::regrole::oid) AS update_column_count,
        (SELECT array_agg(attname::text ORDER BY attname)::text[] FROM column_acl
          WHERE privilege_type = 'UPDATE'
            AND grantee = current_user::regrole::oid) AS update_columns
    `);
    assert.deepEqual(acl.rows[0], {
      table_update_granted: false,
      update_column_count: 5,
      update_columns: ["id", "record_version", "stage", "updated_at", "workflow_status"],
    });
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    throw new HarnessError(`case_parent_acl_${safePostgresCode(error)}`);
  } finally {
    await client.end().catch(() => {});
  }

  await executeCaseParentQuery(target, caseId, "case_parent_key_share", `
    SELECT id FROM public.cases_service_cases WHERE id = $1 FOR KEY SHARE
  `, undefined);
  await executeCaseParentQuery(target, caseId, "case_parent_id_self_update", `
    UPDATE public.cases_service_cases SET id = id WHERE id = $1
  `, Object.freeze({
    code: "23514",
    constraint: "cases_service_cases_record_version_transition_check",
  }));
  await executeCaseParentQuery(target, caseId, "case_parent_id_change", `
    UPDATE public.cases_service_cases
       SET id = '64000000-0000-4000-8000-000000000099'
     WHERE id = $1
  `, Object.freeze({ code: "23514", constraint: "cases_service_cases_identity_immutable_check" }));
  const stageSelfUpdate = await executeCaseParentQuery(target, caseId, "case_parent_stage_update", `
    UPDATE public.cases_service_cases SET stage = stage WHERE id = $1
  `, Object.freeze({
    code: "23514",
    constraint: "cases_service_cases_record_version_transition_check",
  }));
  const unapprovedColumnUpdate = await executeCaseParentQuery(
    target,
    caseId,
    "case_parent_other_update",
    `
    UPDATE public.cases_service_cases SET intake_year = intake_year WHERE id = $1
  `,
    Object.freeze({ code: "42501" }),
  );
  return Object.freeze({
    stage_self_update: stageSelfUpdate,
    unapproved_column_update: unapprovedColumnUpdate,
  });
}

type CaseParentQueryEvidence = Readonly<{
  code: string | null;
  constraint: string | null;
}>;

async function executeCaseParentQuery(
  target: OneRoleBaselineTarget,
  caseId: string,
  stage: string,
  sql: string,
  expectedFailure: Readonly<{ code: string; constraint?: string }> | undefined,
): Promise<CaseParentQueryEvidence> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
    await client.query(sql, [caseId]);
    if (expectedFailure !== undefined) throw new HarnessError(`${stage}_unexpected_allow`);
    await client.query("ROLLBACK");
    return Object.freeze({ code: null, constraint: null });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    if (expectedFailure === undefined) {
      throw new HarnessError(`${stage}_${safePostgresCode(error)}`);
    }
    if (
      safePostgresCode(error) !== expectedFailure.code ||
      (expectedFailure.constraint !== undefined &&
        safeConstraint(error) !== expectedFailure.constraint)
    ) {
      throw new HarnessError(`${stage}_unexpected_failure`);
    }
    return Object.freeze({
      code: expectedFailure.code,
      constraint: expectedFailure.constraint ?? null,
    });
  } finally {
    await client.end().catch(() => {});
  }
}

function safePostgresCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) ? value : "unknown";
}

function safeConstraint(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const value = (error as { readonly constraint?: unknown }).constraint;
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value)
    ? value
    : "unknown";
}

async function provision(target: OneRoleBaselineTarget, email: string, password: string) {
  return runDatabaseTestProvisionCli({
    arguments: ["--password-stdin", `--email=${email}`],
    inputStream: streamOf(Buffer.from(`${password}\n`)),
    readTarget: () => localProvisionTarget(target),
  });
}

async function* streamOf(chunk: Buffer): AsyncIterable<Buffer> {
  yield chunk;
}

function localProvisionTarget(target: OneRoleBaselineTarget): DatabaseTestProvisionTarget {
  return Object.freeze({
    connectionString: target.connectionString,
    loginUser: target.user,
    databaseName: target.database,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
    ssl: false,
  });
}

function baselineDependencies(target: OneRoleBaselineTarget) {
  return {
    inspect: () => inspectBaselineWithNewClient(target),
    openExecutionConnection: async () => {
      const client = new Client(createOneRoleBaselineClientConfig(target));
      await client.connect();
      return Object.freeze({ client, close: () => client.end() });
    },
  };
}

async function inspectBaselineWithNewClient(
  target: OneRoleBaselineTarget,
): Promise<OneRoleBaselineDatabaseState> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    return await inspectOneRoleBaselineDatabase(client);
  } catch {
    throw new HarnessError("baseline_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

function assertDatabaseContract(
  state: OneRoleBaselineDatabaseState,
  target: OneRoleBaselineTarget,
  manifestSha256: string,
): void {
  assertOneRoleBaselinePostflight({ state, target, mode: "apply", manifestSha256 });
  assert.equal(state.marker?.baselineId, ONE_ROLE_BASELINE_ID);
  assert.equal(state.marker?.transformVersion, ONE_ROLE_TRANSFORM_VERSION);
  assert.equal(state.marker?.sourceMigrationCount, ONE_ROLE_SOURCE_COUNT);
  assert.equal(state.marker?.manifestSha256, manifestSha256);
  assert.equal(state.userName, ONE_ROLE_CANONICAL_ROLE);
  assert.equal(state.databaseOwner, ONE_ROLE_CANONICAL_ROLE);
  assert.equal(state.login, true);
  assert.equal(state.superuser, false);
  assert.equal(state.createDatabase, false);
  assert.equal(state.createRole, false);
  assert.equal(state.inherit, false);
  assert.equal(state.replication, false);
  assert.equal(state.bypassRls, false);
  assert.equal(state.grantedRoleCount, 0);
  assert.equal(state.publicWrongOwnerCount, 0);
  assert.equal(state.rlsNotForcedCount, 0);
  assert.equal(state.unsafeSecurityDefinerCount, 0);
  assert.equal(state.migrationSchemaPresent, false);
  assert.equal(state.migrationLedgerPresent, false);
  assert.equal(state.staleDryRunSchemaCount, 0);
}

function localTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({
    connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`,
    host: "127.0.0.1",
    port,
    database: "tianxing",
    user: ONE_ROLE_CANONICAL_ROLE,
    ssl: false,
  });
}

async function readPostgresVersion(target: OneRoleBaselineTarget): Promise<string> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    const result = await client.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    if (!result.rows[0]?.version) throw new HarnessError("postgres_version_inspection");
    return result.rows[0].version;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("postgres_version_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

async function createIsolatedAppDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tianxing-case01-next-dev-"));
  const excluded = new Set([".git", ".next", "node_modules"]);
  try {
    for (const entry of await readdir(process.cwd())) {
      if (excluded.has(entry) || entry.startsWith(".env") || [
        ".DS_Store", ".idea", ".kition", ".pnpm-store",
      ].includes(entry)) continue;
      await cp(resolve(entry), join(directory, entry), { recursive: true });
    }
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    return directory;
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new HarnessError("next_workspace_setup");
  }
}

function startNextDev(directory: string, port: number, connectionString: string): ChildProcess {
  const child = spawn(process.execPath, [
    resolve("node_modules/next/dist/bin/next"),
    "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port),
  ], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      NEXT_TELEMETRY_DISABLED: "1",
      APP_ENV: "development",
      NODE_ENV: "development",
      APP_RUNTIME_MODE: "local-synthetic",
      AUTH_MODE: "database-test",
      LOCAL_SYNTHETIC_DATABASE_URL: connectionString,
      LOCAL_SYNTHETIC_LOCALSTACK_ENDPOINT: "http://127.0.0.1:4566",
      LOCAL_SYNTHETIC_AWS_REGION: "ap-east-1",
      LOCAL_SYNTHETIC_S3_BUCKET: "tianxing-local-documents",
      LOCAL_SYNTHETIC_SQS_QUEUE: "tianxing-local-document-scan",
      LOCAL_SYNTHETIC_SQS_DLQ: "tianxing-local-document-scan-dlq",
      LOCAL_SYNTHETIC_CLAMAV_HOST: "127.0.0.1",
      LOCAL_SYNTHETIC_CLAMAV_PORT: "3310",
      LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { logs.stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { logs.stderr += chunk; });
  DEV_LOGS.set(child, logs);
  return child;
}

function assertNoSensitiveDevLogs(child: ChildProcess, forbidden: readonly string[]): void {
  const logs = DEV_LOGS.get(child);
  if (!logs) throw new HarnessError("next_log_capture");
  const combined = `${logs.stdout}\n${logs.stderr}`;
  for (const value of forbidden) {
    if (value && combined.includes(value)) throw new HarnessError("next_log_privacy");
  }
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  child.stdout?.resume();
  child.stderr?.resume();
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new HarnessError("next_dev_early_exit");
    try {
      const response = await fetch(`${baseUrl}/api/v1/auth/me`);
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new HarnessError("next_dev_readiness_timeout");
}

async function stopNextDev(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise<boolean>((resolveStopped) => child.once("close", () => resolveStopped(true))),
    new Promise<boolean>((resolveStopped) => setTimeout(() => resolveStopped(false), 10_000)),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolveStopped) => child.once("close", () => resolveStopped()));
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => reject(new HarnessError("next_port_reservation")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error || port < 1) reject(new HarnessError("next_port_reservation"));
        else resolvePort(port);
      });
    });
  });
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = await runDocker([
      "exec", containerName, "/bin/sh", "/usr/local/bin/tianxing-postgres-healthcheck",
    ], "postgres_readiness", undefined, process.env, true);
    if (probe.exitCode === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
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
  readonly code = "CASE01_DEV_HTTP_HARNESS_FAILED" as const;
  readonly stage: string;

  constructor(stage: string) {
    super(`CASE-01 Dev HTTP harness failed at ${stage}.`);
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
  return new Promise((resolveRun, reject) => {
    const child = spawn("docker", arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", () => {});
    child.once("error", () => reject(new HarnessError(failureStage)));
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !allowFailure) reject(new HarnessError(failureStage));
      else resolveRun(Object.freeze({ exitCode, stdout }));
    });
    child.stdin.end(input);
  });
}
