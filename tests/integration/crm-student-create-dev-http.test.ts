import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Client, Pool } from "pg";

import { StudentReadService } from "../../modules/crm/application/read-service.ts";
import { StudentCreateService } from "../../modules/crm/application/student-create-service.ts";
import { GuardianRelationshipService } from "../../modules/crm/application/guardian-relationship-service.ts";
import { PostgresqlStudentReadRepository } from "../../modules/crm/infrastructure/postgresql-read-repository.ts";
import { PostgresqlStudentCreateRepository } from "../../modules/crm/infrastructure/postgresql-student-create-repository.ts";
import { PostgresqlGuardianRelationshipRepository } from "../../modules/crm/infrastructure/postgresql-guardian-relationship-repository.ts";
import type { IdentitySessionActor } from "../../modules/identity/public.ts";
import { createTenantTransactionRunner, type DatabasePool } from "../../modules/shared/server.ts";
import { hashRequestPayload } from "../../modules/shared/public.ts";
import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_VERSION,
  verifyCommittedOneRoleBaseline,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  NEON_TEST_ORGANIZATION,
  NEON_TEST_MANIFEST_ID,
  NEON_TEST_PRINCIPALS,
  NEON_TEST_STUDENTS,
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
const ADVISOR = NEON_TEST_PRINCIPALS.find(({ role }) => role === "advisor")!;
const ADMIN = NEON_TEST_PRINCIPALS.find(({ role }) => role === "admin")!;
const FOUNDER = NEON_TEST_PRINCIPALS.find(({ role }) => role === "founder")!;
const DATA_REVIEWER = NEON_TEST_PRINCIPALS.find(({ role }) => role === "data_reviewer")!;
const CONTRACTOR = NEON_TEST_PRINCIPALS.find(({ role }) => role === "contractor")!;
const SHARED_GUARDIAN = NEON_TEST_STUDENTS[1]!;
const ALTERNATE_GUARDIAN = NEON_TEST_STUDENTS[0]!;
const FOREIGN_ORGANIZATION_ID = "63000000-0000-4000-8000-000000000001";
const FOREIGN_STUDENT_ID = "63000000-0000-4000-8000-000000000601";
const FOREIGN_GUARDIAN_ID = "63000000-0000-4000-8000-000000000701";
const FOREIGN_RELATIONSHIP_ID = "63000000-0000-4000-8000-000000000801";
const INACTIVE_GUARDIAN_ID = "51000000-0000-4000-8000-000000000799";
const PURGED_STUDENT_ID = "64000000-0000-4000-8000-000000000601";
const PURGED_GUARDIAN_ID = "64000000-0000-4000-8000-000000000701";
const CRM06_CLOSED_CASE_ID = "65000000-0000-4000-8000-000000000901";
const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

test("CRM-01 through CRM-06 work through PostgreSQL 17 and the real local Next Dev HTTP API", {
  timeout: 360_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-crm01-pg17-${suffix}`;
  const credentialVolumeName = `tianxing-crm01-credential-volume-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const advisorPassword = randomBytes(32).toString("base64url");
  const adminPassword = randomBytes(32).toString("base64url");
  const founderPassword = randomBytes(32).toString("base64url");
  const dataReviewerPassword = randomBytes(32).toString("base64url");
  const contractorPassword = randomBytes(32).toString("base64url");
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
    const baselineState = await inspectBaselineWithNewClient(target);
    assertDatabaseContract(baselineState, target, manifestSha256);

    const seed = await seedNeonTestRelease1(target, "apply");
    assert.equal(seed.status, "pass");
    assert.equal(seed.baseline.id, ONE_ROLE_BASELINE_ID);
    assert.equal(seed.baseline.transform_version, ONE_ROLE_TRANSFORM_VERSION);
    assert.equal(seed.baseline.source_migration_count, ONE_ROLE_SOURCE_COUNT);
    assert.equal(seed.baseline.manifest_sha256, manifestSha256);

    assert.equal(await provision(target, ADVISOR.email, advisorPassword), "created");
    assert.equal(await provision(target, ADMIN.email, adminPassword), "created");
    assert.equal(await provision(target, FOUNDER.email, founderPassword), "created");
    assert.equal(await provision(target, DATA_REVIEWER.email, dataReviewerPassword), "created");
    assert.equal(await provision(target, CONTRACTOR.email, contractorPassword), "created");

    const directPool = new Pool({ ...createOneRoleBaselineClientConfig(target), max: 1 });
    try {
      const directRunner = createTenantTransactionRunner(
        directPool as unknown as DatabasePool,
        { expectedLoginUser: ONE_ROLE_CANONICAL_ROLE },
      );
      const directService = new StudentCreateService(
        new PostgresqlStudentCreateRepository(directRunner),
      );
      const direct = await directService.create({
        actor: advisorActor(),
        command: {
          student: {
            displayName: "CRM01 Repository Probe Student",
            dateOfBirth: null,
            contactEmail: null,
            contactPhone: null,
          },
          primaryGuardian: {
            displayName: "CRM01 Repository Probe Guardian",
            email: "crm01-repository-probe@example.invalid",
            phone: null,
            relationshipType: "other_guardian",
            isLegalGuardian: true,
          },
          requestId: "crm01-repository-probe",
          idempotencyKey: "crm01-repository-probe",
        },
      });
      assert.equal(direct.student.displayName, "CRM01 Repository Probe Student");
    } finally {
      await directPool.end().catch(() => {});
    }

    const portForHttp = await reserveLoopbackPort();
    devServer = startNextDev(appDirectory, portForHttp, target.connectionString);
    const baseUrl = `http://127.0.0.1:${portForHttp}`;
    await waitForNextDev(baseUrl, devServer);

    const advisorCookie = await login(baseUrl, ADVISOR.email, advisorPassword);
    const access = await getJson(baseUrl, "/api/v1/auth/me", advisorCookie);
    assert.equal(access.response.status, 200);
    assert.equal(access.body.data?.role, "advisor");
    assert.equal(access.body.data?.policy_version, "release1-bootstrap-v8");
    assert.equal((access.body.data?.capabilities as unknown[])?.includes("students.create"), true);

    const initialCounts = await readScopedCounts(target);
    const body = validCreateBody();
    const first = await createStudent(baseUrl, advisorCookie, "crm-http-attempt-1", body);
    assert.equal(first.response.status, 201);
    assert.equal(first.body.api_version, "v1");
    const studentData = requiredRecord(first.body.data?.student);
    const guardianData = requiredRecord(first.body.data?.primary_guardian);
    const relationshipData = requiredRecord(first.body.data?.relationship);
    assert.deepEqual(Object.keys(studentData).sort(), ["display_name", "id"]);
    assert.deepEqual(Object.keys(guardianData).sort(), ["display_name", "id"]);
    assert.deepEqual(Object.keys(relationshipData).sort(), ["id", "relationship_type"]);
    const studentId = requiredString(studentData, "id");
    const guardianId = requiredString(guardianData, "id");
    const relationshipId = requiredString(relationshipData, "id");
    assert.notEqual(relationshipId, studentId);
    assert.notEqual(relationshipId, guardianId);
    assert.equal(requiredString(studentData, "display_name"), "CRM01 Synthetic Student");
    assert.equal(requiredString(guardianData, "display_name"), "CRM01 Synthetic Guardian");
    assert.equal(requiredString(relationshipData, "relationship_type"), "father");

    const afterCreate = await readScopedCounts(target);
    assert.deepEqual(delta(initialCounts, afterCreate), {
      students: 1,
      guardians: 1,
      relationships: 1,
      idempotency: 1,
      audit: 1,
      outbox: 1,
    });

    const replay = await createStudent(baseUrl, advisorCookie, "crm-http-attempt-1", body);
    assert.equal(replay.response.status, 201);
    assert.deepEqual(replay.body.data, first.body.data);
    assert.deepEqual(await readScopedCounts(target), afterCreate);

    const changed = await createStudent(baseUrl, advisorCookie, "crm-http-attempt-1", {
      ...body,
      student: { ...body.student, display_name: "Changed Synthetic Student" },
    });
    assertApiError(changed, 409, "CONFLICT");
    assertNoPrivateErrorEcho(changed, ["Changed Synthetic Student"]);
    assert.deepEqual(await readScopedCounts(target), afterCreate);

    const invalidRelationship = await createStudent(baseUrl, advisorCookie, "crm-http-invalid-1", {
      ...body,
      primary_guardian: { ...body.primary_guardian, relationship_type: "parent" },
    });
    assertApiError(invalidRelationship, 422, "VALIDATION_FAILED");
    assertNoPrivateErrorEcho(invalidRelationship, [body.student.display_name, body.primary_guardian.email!]);
    const injectedOrganization = await createStudent(baseUrl, advisorCookie, "crm-http-invalid-2", {
      ...body,
      organization_id: NEON_TEST_ORGANIZATION.id,
    });
    assertApiError(injectedOrganization, 400, "INVALID_REQUEST");

    const adminCookie = await login(baseUrl, ADMIN.email, adminPassword);
    const adminAccess = await getJson(baseUrl, "/api/v1/auth/me", adminCookie);
    assert.equal(adminAccess.response.status, 200);
    assert.equal(adminAccess.body.data?.role, "admin");
    assert.equal((adminAccess.body.data?.capabilities as unknown[])?.includes("students.create"), false);
    for (const path of ["/students", "/students/new"] as const) {
      const page = await fetch(`${baseUrl}${path}`, { headers: { cookie: adminCookie } });
      assert.equal(page.status, 200);
      await page.body?.cancel();
    }
    const forbidden = await createStudent(baseUrl, adminCookie, "crm-http-admin-1", body);
    assertApiError(forbidden, 403, "FORBIDDEN");
    assertNoPrivateErrorEcho(forbidden, [body.student.display_name, body.primary_guardian.email!]);
    assert.deepEqual(await readScopedCounts(target), afterCreate);

    await installGuardianInsertFailure(target);
    try {
      const failed = await createStudent(baseUrl, advisorCookie, "crm-http-fault-1", {
        ...body,
        student: { ...body.student, display_name: "Rollback Synthetic Student" },
      });
      assertApiError(failed, 503, "SERVICE_UNAVAILABLE");
      assertNoPrivateErrorEcho(failed, ["Rollback Synthetic Student"]);
      assert.deepEqual(await readScopedCounts(target), afterCreate);
    } finally {
      await removeGuardianInsertFailure(target);
    }

    const crm02Before = await readGuardianWorkflowCounts(target, studentId);
    const currentBefore = await getJson(baseUrl, `/api/v1/students/${studentId}/guardians`, advisorCookie);
    assert.equal(currentBefore.response.status, 200);
    assertCurrentRelationshipResponse(currentBefore, studentId, guardianId);
    const initialRelationships = requiredArray(currentBefore.body.data?.relationships);
    assert.equal(initialRelationships.length, 1);
    const initialPrimary = requiredRecord(initialRelationships[0]);
    assert.equal(initialPrimary.is_primary_contact, true);
    const expectedPrimaryVersion = requiredNumber(initialPrimary, "record_version");

    const search = await postJson(
      baseUrl,
      `/api/v1/students/${studentId}/guardians/search`,
      advisorCookie,
      { query: SHARED_GUARDIAN.guardianName },
    );
    assert.equal(search.response.status, 200);
    const searchResults = requiredArray(search.body.data);
    assert.equal(searchResults.length <= 20, true);
    const candidate = searchResults.map(requiredRecord)
      .find(({ id }) => id === SHARED_GUARDIAN.guardianId);
    assert.ok(candidate);
    assert.deepEqual(Object.keys(candidate).sort(), ["display_name", "email_hint", "id", "phone_hint"]);
    assert.equal(JSON.stringify(search.body).includes(SHARED_GUARDIAN.guardianEmail!), false);

    const attachBody = {
      guardian_id: SHARED_GUARDIAN.guardianId,
      relationship_type: "mother",
      is_legal_guardian: true,
      is_emergency_contact: true,
      is_billing_contact: false,
      notification_consent: false,
    };
    const attached = await postJson(
      baseUrl,
      `/api/v1/students/${studentId}/guardians`,
      advisorCookie,
      attachBody,
      "crm02-attach-1",
    );
    assert.equal(attached.response.status, 201);
    const attachedRelationship = requiredRecord(requiredRecord(attached.body.data).relationship);
    assert.deepEqual(Object.keys(attachedRelationship).sort(), [
      "guardian_id", "is_billing_contact", "is_emergency_contact", "is_legal_guardian",
      "is_primary_contact", "notification_consent", "record_version", "relationship_id",
      "relationship_type", "starts_at",
    ]);
    assert.equal(attachedRelationship.is_primary_contact, false);
    assert.equal(attachedRelationship.guardian_id, SHARED_GUARDIAN.guardianId);
    const afterAttach = await readGuardianWorkflowCounts(target, studentId);
    assert.deepEqual(guardianDelta(crm02Before, afterAttach), {
      relationships: 1,
      current_relationships: 1,
      closed_relationships: 0,
      current_primary: 0,
      attach_receipts: 1,
      handoff_receipts: 0,
      audit: 1,
      outbox: 1,
    });

    const attachReplay = await postJson(
      baseUrl,
      `/api/v1/students/${studentId}/guardians`,
      advisorCookie,
      attachBody,
      "crm02-attach-1",
    );
    assert.equal(attachReplay.response.status, 201);
    assert.deepEqual(attachReplay.body.data, attached.body.data);
    assert.deepEqual(await readGuardianWorkflowCounts(target, studentId), afterAttach);

    const changedAttach = await postJson(
      baseUrl,
      `/api/v1/students/${studentId}/guardians`,
      advisorCookie,
      { ...attachBody, relationship_type: "father" },
      "crm02-attach-1",
    );
    assertApiError(changedAttach, 409, "CONFLICT");
    const duplicatePair = await postJson(
      baseUrl,
      `/api/v1/students/${studentId}/guardians`,
      advisorCookie,
      attachBody,
      "crm02-attach-duplicate",
    );
    assertApiError(duplicatePair, 409, "CONFLICT");
    assert.deepEqual(await readGuardianWorkflowCounts(target, studentId), afterAttach);

    await installRelationshipInsertFailure(target);
    try {
      const failedAttach = await postJson(
        baseUrl,
        `/api/v1/students/${studentId}/guardians`,
        advisorCookie,
        { ...attachBody, guardian_id: NEON_TEST_STUDENTS[0]!.guardianId },
        "crm02-attach-fault",
      );
      assertApiError(failedAttach, 503, "SERVICE_UNAVAILABLE");
      assertNoPrivateErrorEcho(failedAttach, [NEON_TEST_STUDENTS[0]!.guardianEmail!]);
      assert.deepEqual(await readGuardianWorkflowCounts(target, studentId), afterAttach);
    } finally {
      await removeRelationshipInsertFailure(target);
    }

    const alternateAttachBody = {
      ...attachBody,
      guardian_id: ALTERNATE_GUARDIAN.guardianId,
      relationship_type: "father",
      is_emergency_contact: false,
    };
    const alternateAttached = await postJson(
      baseUrl,
      `/api/v1/students/${studentId}/guardians`,
      advisorCookie,
      alternateAttachBody,
      "crm02-attach-2",
    );
    assert.equal(alternateAttached.response.status, 201);
    const afterTwoSecondaries = await readGuardianWorkflowCounts(target, studentId);
    assert.deepEqual(guardianDelta(afterAttach, afterTwoSecondaries), {
      relationships: 1,
      current_relationships: 1,
      closed_relationships: 0,
      current_primary: 0,
      attach_receipts: 1,
      handoff_receipts: 0,
      audit: 1,
      outbox: 1,
    });

    const handoffPath = `/api/v1/students/${studentId}/guardians/primary-handoffs`;
    const concurrentAttempts = [
      {
        body: {
          successor_guardian_id: SHARED_GUARDIAN.guardianId,
          expected_primary_record_version: expectedPrimaryVersion,
        },
        key: "crm02-handoff-concurrent-a",
      },
      {
        body: {
          successor_guardian_id: ALTERNATE_GUARDIAN.guardianId,
          expected_primary_record_version: expectedPrimaryVersion,
        },
        key: "crm02-handoff-concurrent-b",
      },
    ] as const;
    const inFlight = concurrentAttempts.map((attempt) => ({
      ...attempt,
      response: postJson(baseUrl, handoffPath, advisorCookie, attempt.body, attempt.key),
    }));
    const settled = await Promise.allSettled(inFlight.map(({ response }) => response));
    const outcomes = settled.map((result, index) => {
      if (result.status !== "fulfilled") throw new HarnessError("crm02_concurrent_http");
      return Object.freeze({ attempt: inFlight[index]!, result: result.value });
    });
    const concurrentStatuses = outcomes.map(({ result }) => result.response.status).sort();
    if (JSON.stringify(concurrentStatuses) !== JSON.stringify([200, 409])) {
      throw new HarnessError(
        `crm02_concurrent_outcome_status_${concurrentStatuses.join("_")}` +
        `_postgres_${readGuardianRelationshipPostgresCode(devServer) ?? "none"}`,
      );
    }
    const successfulOutcome = outcomes.find(({ result }) => result.response.status === 200);
    const staleOutcome = outcomes.find(({ result }) => result.response.status === 409);
    if (!successfulOutcome || !staleOutcome) throw new HarnessError("crm02_concurrent_outcome");
    assertApiError(staleOutcome.result, 409, "STALE_VERSION");

    const handedOff = successfulOutcome.result;
    const winningAttempt = successfulOutcome.attempt;
    const losingAttempt = staleOutcome.attempt;
    const handoffData = requiredRecord(handedOff.body.data);
    const newPrimary = requiredRecord(handoffData.relationship);
    assert.equal(newPrimary.guardian_id, winningAttempt.body.successor_guardian_id);
    assert.equal(newPrimary.is_primary_contact, true);
    assert.equal(newPrimary.record_version, 2);
    assert.deepEqual(Object.keys(requiredRecord(handoffData.closed_relationship_ids)).sort(), [
      "previous_primary", "successor_secondary",
    ]);
    const afterHandoff = await readGuardianWorkflowCounts(target, studentId);
    assert.deepEqual(guardianDelta(afterTwoSecondaries, afterHandoff), {
      relationships: 1,
      current_relationships: -1,
      closed_relationships: 2,
      current_primary: 0,
      attach_receipts: 0,
      handoff_receipts: 1,
      audit: 1,
      outbox: 1,
    });
    assert.equal(afterHandoff.current_primary, 1);

    const handoffReplay = await postJson(
      baseUrl,
      handoffPath,
      advisorCookie,
      winningAttempt.body,
      winningAttempt.key,
    );
    assert.equal(handoffReplay.response.status, 200);
    assert.deepEqual(handoffReplay.body.data, handedOff.body.data);
    const changedHandoff = await postJson(
      baseUrl,
      handoffPath,
      advisorCookie,
      { ...winningAttempt.body, expected_primary_record_version: expectedPrimaryVersion + 1 },
      winningAttempt.key,
    );
    assertApiError(changedHandoff, 409, "CONFLICT");
    const staleHandoff = await postJson(
      baseUrl,
      handoffPath,
      advisorCookie,
      losingAttempt.body,
      "crm02-handoff-stale",
    );
    assertApiError(staleHandoff, 409, "STALE_VERSION");
    assert.deepEqual(await readGuardianWorkflowCounts(target, studentId), afterHandoff);
    assert.equal(await countCurrentGuardianAssignments(target, SHARED_GUARDIAN.guardianId) >= 2, true);
    assert.equal(await countCurrentGuardianAssignments(target, ALTERNATE_GUARDIAN.guardianId) >= 2, true);

    const currentAfter = await getJson(baseUrl, `/api/v1/students/${studentId}/guardians`, advisorCookie);
    assert.equal(currentAfter.response.status, 200);
    const currentAfterRows = requiredArray(currentAfter.body.data?.relationships).map(requiredRecord);
    assert.equal(currentAfterRows.length, 2);
    assert.equal(currentAfterRows.filter(({ is_primary_contact }) => is_primary_contact).length, 1);
    const currentPrimary = currentAfterRows.find(({ is_primary_contact }) => is_primary_contact);
    const currentSecondary = currentAfterRows.find(({ is_primary_contact }) => !is_primary_contact);
    assert.equal(requiredRecord(currentPrimary?.guardian).id, winningAttempt.body.successor_guardian_id);
    assert.equal(requiredRecord(currentSecondary?.guardian).id, losingAttempt.body.successor_guardian_id);

    const roleCredentials = [
      [FOUNDER, founderPassword],
      [ADMIN, adminPassword],
      [DATA_REVIEWER, dataReviewerPassword],
      [CONTRACTOR, contractorPassword],
    ] as const;
    const beforeDenied = await readGuardianWorkflowCounts(target, studentId);
    for (const [principal, password] of roleCredentials) {
      const cookie = principal.role === "admin" ? adminCookie : await login(baseUrl, principal.email, password);
      const actorProbe = await getJson(baseUrl, "/api/v1/auth/me", cookie);
      if (actorProbe.response.status !== 200 || actorProbe.body.data?.role !== principal.role) {
        throw new HarnessError(
          `crm02_denied_${principal.role}_identity_status_${actorProbe.response.status}`,
        );
      }
      for (const [operation, path, deniedBody, key] of [
        ["search", `/api/v1/students/${studentId}/guardians/search`,
          { query: SHARED_GUARDIAN.guardianName }, undefined],
        ["attach", `/api/v1/students/${studentId}/guardians`, attachBody,
          `crm02-denied-attach-${principal.role}`],
        ["handoff", `/api/v1/students/${studentId}/guardians/primary-handoffs`, winningAttempt.body,
          `crm02-denied-handoff-${principal.role}`],
      ] as const) {
        const denied = await postJson(baseUrl, path, cookie, deniedBody, key);
        if (denied.response.status !== 403) {
          throw new HarnessError(
            `crm02_denied_${principal.role}_${operation}_status_${denied.response.status}`,
          );
        }
        assertApiError(denied, 403, "FORBIDDEN");
        assertNoPrivateErrorEcho(denied, [SHARED_GUARDIAN.guardianName, SHARED_GUARDIAN.guardianEmail!]);
      }
    }
    assert.deepEqual(await readGuardianWorkflowCounts(target, studentId), beforeDenied);

    await prepareProfileMaintenanceFixtures(target);
    const founderCookie = await login(baseUrl, FOUNDER.email, founderPassword);
    const assignedStudent = NEON_TEST_STUDENTS[0]!;
    const unassignedStudent = NEON_TEST_STUDENTS[1]!;
    const assignedCase = await postJson(baseUrl, "/api/v1/cases", founderCookie, {
      student_id: assignedStudent.id,
      intake_year: 2027,
      admission_type: "transfer",
      primary_role_binding_id: ADVISOR.roleBindingId,
      manifest_id: NEON_TEST_MANIFEST_ID,
    }, "crm03-advisor-assignment");
    assert.equal(assignedCase.response.status, 200);
    const assignedCaseId = requiredString(requiredRecord(assignedCase.body.data?.case), "id");

    const profileBefore = await readProfileMaintenanceCounts(target);
    const unassignedDetail = requiredRecord((await getJson(
      baseUrl, `/api/v1/students/${unassignedStudent.id}`, founderCookie,
    )).body.data?.student);
    const unassignedGuardian = requiredRecord(requiredArray(unassignedDetail.guardians)[0]);
    const founderStudentBody = {
      display_name: "CRM03 Founder Student",
      date_of_birth: "2013-03-03",
      contact_email: "crm03-founder-student@example.invalid",
      contact_phone: null,
      expected_record_version: requiredNumber(unassignedDetail, "recordVersion"),
    };
    const founderStudent = await patchJson(baseUrl, `/api/v1/students/${unassignedStudent.id}`,
      founderCookie, founderStudentBody, "crm03-founder-student");
    assertProfileAcknowledgement(founderStudent, "student", unassignedStudent.id, 2);
    const founderGuardianBody = {
      display_name: "CRM03 Founder Guardian",
      email: "crm03-founder-guardian@example.invalid",
      phone: null,
      expected_record_version: requiredNumber(unassignedGuardian, "recordVersion"),
    };
    const founderGuardian = await patchJson(baseUrl,
      `/api/v1/guardians/${unassignedStudent.guardianId}`, founderCookie,
      founderGuardianBody, "crm03-founder-guardian");
    assertProfileAcknowledgement(founderGuardian, "guardian", unassignedStudent.guardianId, 2);

    const assignedDetail = requiredRecord((await getJson(
      baseUrl, `/api/v1/students/${assignedStudent.id}`, advisorCookie,
    )).body.data?.student);
    const assignedGuardian = requiredRecord(requiredArray(assignedDetail.guardians)[0]);
    const advisorStudentBody = {
      display_name: "CRM03 Advisor Student First",
      date_of_birth: "2012-02-02",
      contact_email: "crm03-advisor-student@example.invalid",
      contact_phone: "+852 2000 0001",
      expected_record_version: requiredNumber(assignedDetail, "recordVersion"),
    };
    const advisorFirst = await patchJson(baseUrl, `/api/v1/students/${assignedStudent.id}`,
      advisorCookie, advisorStudentBody, "crm03-advisor-student-first");
    assertProfileAcknowledgement(advisorFirst, "student", assignedStudent.id, 2);
    const firstAcknowledgement = advisorFirst.body.data;
    const advisorGuardianBody = {
      display_name: "CRM03 Advisor Guardian",
      email: "crm03-advisor-guardian@example.invalid",
      phone: null,
      expected_record_version: requiredNumber(assignedGuardian, "recordVersion"),
    };
    assertProfileAcknowledgement(await patchJson(baseUrl,
      `/api/v1/guardians/${assignedStudent.guardianId}`, advisorCookie,
      advisorGuardianBody, "crm03-advisor-guardian"), "guardian", assignedStudent.guardianId, 2);

    const advisorSecondBody = {
      ...advisorStudentBody,
      display_name: "CRM03 Advisor Student Second",
      contact_email: "crm03-advisor-student-second@example.invalid",
      expected_record_version: 2,
    };
    assertProfileAcknowledgement(await patchJson(baseUrl, `/api/v1/students/${assignedStudent.id}`,
      advisorCookie, advisorSecondBody, "crm03-advisor-student-second"), "student",
    assignedStudent.id, 3);
    const permanentReplay = await patchJson(baseUrl, `/api/v1/students/${assignedStudent.id}`,
      advisorCookie, advisorStudentBody, "crm03-advisor-student-first");
    assert.equal(permanentReplay.response.status, 200);
    assert.deepEqual(permanentReplay.body.data, firstAcknowledgement);

    const afterAllowedProfiles = await readProfileMaintenanceCounts(target);
    assert.deepEqual(profileDelta(profileBefore, afterAllowedProfiles), {
      student_receipts: 3, guardian_receipts: 2, audit: 5, outbox: 5,
    });
    const profileHashEvidence = await readProfileReceiptHashEvidence(target);
    assert.deepEqual(profileHashEvidence, { total: 5, exact: 5, request_hash_alias: 0 });
    const changedProfile = await patchJson(baseUrl, `/api/v1/students/${assignedStudent.id}`,
      advisorCookie, { ...advisorStudentBody, display_name: "CRM03 Changed Payload" },
      "crm03-advisor-student-first");
    assertApiError(changedProfile, 409, "CONFLICT");
    const staleProfile = await patchJson(baseUrl, `/api/v1/students/${assignedStudent.id}`,
      advisorCookie, advisorStudentBody, "crm03-advisor-student-stale");
    assertApiError(staleProfile, 409, "STALE_VERSION");
    const extraField = await patchJson(baseUrl, `/api/v1/students/${assignedStudent.id}`,
      advisorCookie, { ...advisorSecondBody, organization_id: NEON_TEST_ORGANIZATION.id },
      "crm03-extra-field");
    assertApiError(extraField, 400, "INVALID_REQUEST");
    const invalidProfile = await patchJson(baseUrl, `/api/v1/guardians/${assignedStudent.guardianId}`,
      advisorCookie, { ...advisorGuardianBody, email: null, phone: null, expected_record_version: 2 },
      "crm03-invalid-guardian");
    assertApiError(invalidProfile, 422, "VALIDATION_FAILED");
    for (const denied of [
      await patchJson(baseUrl, `/api/v1/students/${unassignedStudent.id}`, advisorCookie,
        { ...founderStudentBody, expected_record_version: 2 }, "crm03-unassigned-student"),
      await patchJson(baseUrl, `/api/v1/guardians/${unassignedStudent.guardianId}`, advisorCookie,
        { ...founderGuardianBody, expected_record_version: 2 }, "crm03-unassigned-guardian"),
      await patchJson(baseUrl, `/api/v1/students/${assignedStudent.id}`, adminCookie,
        { ...advisorSecondBody, expected_record_version: 3 }, "crm03-admin-student"),
    ]) {
      assertApiError(denied, 403, "FORBIDDEN");
      assertNoPrivateErrorEcho(denied, ["CRM03", "example.invalid"]);
    }
    const crossTenant = await patchJson(baseUrl, `/api/v1/students/${FOREIGN_STUDENT_ID}`,
      founderCookie, { ...advisorStudentBody, expected_record_version: 1 }, "crm03-cross-tenant");
    assertApiError(crossTenant, 404, "NOT_FOUND");
    const inactive = await patchJson(baseUrl, `/api/v1/guardians/${INACTIVE_GUARDIAN_ID}`,
      founderCookie, { ...advisorGuardianBody, expected_record_version: 1 }, "crm03-inactive");
    assertApiError(inactive, 409, "CONFLICT");
    assert.deepEqual(await readProfileMaintenanceCounts(target), afterAllowedProfiles);

    await installProfileUpdateFailure(target);
    try {
      const failedProfile = await patchJson(baseUrl, `/api/v1/students/${unassignedStudent.id}`,
        founderCookie, { ...founderStudentBody, display_name: "CRM03 Rollback Student",
          expected_record_version: 2 }, "crm03-rollback");
      assertApiError(failedProfile, 503, "SERVICE_UNAVAILABLE");
      assertNoPrivateErrorEcho(failedProfile, ["CRM03 Rollback Student"]);
      assert.deepEqual(await readProfileMaintenanceCounts(target), afterAllowedProfiles);
    } finally {
      await removeProfileUpdateFailure(target);
    }

    const authoritativeAssigned = requiredRecord((await getJson(
      baseUrl, `/api/v1/students/${assignedStudent.id}`, advisorCookie,
    )).body.data?.student);
    assert.equal(authoritativeAssigned.displayName, advisorSecondBody.display_name);
    assert.equal(authoritativeAssigned.contactEmail, advisorSecondBody.contact_email);
    assert.equal(authoritativeAssigned.recordVersion, 3);
    const authoritativeGuardian = requiredRecord(requiredArray(authoritativeAssigned.guardians)[0]);
    assert.equal(authoritativeGuardian.displayName, advisorGuardianBody.display_name);
    assert.equal(authoritativeGuardian.recordVersion, 2);

    const duplicateBefore = await readDuplicateWorkflowCounts(target);
    const crm04SharedEmail = "crm04-shared-student@example.invalid";
    const leftProfileUpdate = await patchJson(baseUrl, `/api/v1/students/${assignedStudent.id}`,
      founderCookie, { display_name: "CRM04 Left Student", date_of_birth: "2012-02-02",
        contact_email: crm04SharedEmail, contact_phone: null, expected_record_version: 3 },
      "crm04-left-profile");
    assertProfileAcknowledgement(leftProfileUpdate, "student", assignedStudent.id, 4);
    const rightProfileUpdate = await patchJson(baseUrl, `/api/v1/students/${unassignedStudent.id}`,
      founderCookie, { display_name: "CRM04 Right Student", date_of_birth: "2014-04-04",
        contact_email: crm04SharedEmail, contact_phone: null, expected_record_version: 2 },
      "crm04-right-profile");
    assertProfileAcknowledgement(rightProfileUpdate, "student", unassignedStudent.id, 3);

    const candidateBody = { entity_type: "student", left_record_id: assignedStudent.id,
      right_record_id: unassignedStudent.id };
    const advisorUnassigned = await postJson(baseUrl, "/api/v1/crm/duplicate-candidates",
      advisorCookie, candidateBody, "crm04-unassigned-pair");
    assertApiError(advisorUnassigned, 404, "NOT_FOUND");
    assert.deepEqual(await readDuplicateWorkflowCounts(target), duplicateBefore);

    const secondAssignment = await postJson(baseUrl, "/api/v1/cases", founderCookie, {
      student_id: unassignedStudent.id, intake_year: 2028, admission_type: "transfer",
      primary_role_binding_id: ADVISOR.roleBindingId, manifest_id: NEON_TEST_MANIFEST_ID,
    }, "crm04-second-advisor-assignment");
    assert.equal(secondAssignment.response.status, 200);

    const crm04Search = await postJson(baseUrl, "/api/v1/crm/duplicate-records/search", advisorCookie,
      { entity_type: "student", query: "crm04-shared" });
    assert.equal(crm04Search.response.status, 200);
    const searchItems = requiredArray(crm04Search.body.data).map(requiredRecord);
    assert.equal(searchItems.length, 2);
    for (const item of searchItems) {
      assert.deepEqual(Object.keys(item).sort(), ["contact_hint", "display_label", "entity_type", "id"]);
      assert.equal(item.entity_type, "student");
      assert.equal(String(item.contact_hint).includes(crm04SharedEmail), false);
    }

    const candidateCreate = await postJson(baseUrl, "/api/v1/crm/duplicate-candidates",
      advisorCookie, candidateBody, "crm04-candidate-create");
    assert.equal(candidateCreate.response.status, 201);
    const crm04Candidate = requiredRecord(candidateCreate.body.data);
    assertDuplicateCandidateShape(crm04Candidate);
    assert.deepEqual(crm04Candidate.matching_signals, ["email"]);
    const candidateId = requiredString(crm04Candidate, "id");
    const candidateReplay = await postJson(baseUrl, "/api/v1/crm/duplicate-candidates",
      advisorCookie, candidateBody, "crm04-candidate-create");
    assert.equal(candidateReplay.response.status, 201);
    assert.deepEqual(candidateReplay.body.data, candidateCreate.body.data);
    const candidateChanged = await postJson(baseUrl, "/api/v1/crm/duplicate-candidates",
      advisorCookie, { ...candidateBody, right_record_id: FOREIGN_STUDENT_ID }, "crm04-candidate-create");
    assertApiError(candidateChanged, 409, "CONFLICT");

    const dataReviewerCookie = await login(baseUrl, DATA_REVIEWER.email, dataReviewerPassword);
    for (const cookie of [advisorCookie, dataReviewerCookie, founderCookie]) {
      const queue = await getJson(baseUrl,
        "/api/v1/crm/duplicate-candidates?entity_type=student&status=review_required", cookie);
      assert.equal(queue.response.status, 200);
      assert.equal(requiredArray(queue.body.data).some((item) => requiredRecord(item).id === candidateId), true);
    }
    const candidateDetailBefore = await getJson(baseUrl,
      `/api/v1/crm/duplicate-candidates/${candidateId}`, founderCookie);
    assert.equal(candidateDetailBefore.response.status, 200);
    assertDuplicateDetailShape(candidateDetailBefore.body.data, "student", false);
    assertDuplicateDetailPair(candidateDetailBefore.body.data);

    const leftId = requiredString(requiredRecord(crm04Candidate.left_record), "id");
    const rightId = requiredString(requiredRecord(crm04Candidate.right_record), "id");
    const recordVersions = new Map<string, number>([[assignedStudent.id, 4], [unassignedStudent.id, 3]]);
    const mergeBody = (sourceId: string, canonicalId: string) => ({
      source_record_id: sourceId, canonical_record_id: canonicalId,
      expected_candidate_record_version: 1,
      expected_source_record_version: recordVersions.get(sourceId),
      expected_canonical_record_version: recordVersions.get(canonicalId),
      field_selections: ["display_name", "date_of_birth", "contact_email", "contact_phone"]
        .map((field_name) => ({ field_name, source_record_id: canonicalId })),
      reason_code: "duplicate.confirmed",
    });
    const mergeAttempts = [
      { key: "crm04-merge-left", body: mergeBody(leftId, rightId) },
      { key: "crm04-merge-right", body: mergeBody(rightId, leftId) },
    ];
    const mergeOutcomes = await Promise.allSettled(mergeAttempts.map(async (attempt) => ({ attempt,
      result: await postJson(baseUrl, `/api/v1/crm/duplicate-candidates/${candidateId}/merges`,
        founderCookie, attempt.body, attempt.key) })));
    assert.equal(mergeOutcomes.every(({ status }) => status === "fulfilled"), true);
    const fulfilledMerges = mergeOutcomes.map((outcome) => {
      if (outcome.status !== "fulfilled") throw new HarnessError("crm04_concurrent_merge_transport");
      return outcome.value;
    });
    assert.deepEqual(fulfilledMerges.map(({ result }) => result.response.status).sort(), [200, 409]);
    const mergeWinner = fulfilledMerges.find(({ result }) => result.response.status === 200);
    const mergeLoser = fulfilledMerges.find(({ result }) => result.response.status === 409);
    if (!mergeWinner || !mergeLoser) throw new HarnessError("crm04_concurrent_merge_outcome");
    assertApiError(mergeLoser.result, 409, "STALE_VERSION");
    const mergeAcknowledgement = requiredRecord(mergeWinner.result.body.data);
    assert.deepEqual(Object.keys(mergeAcknowledgement).sort(), ["candidate_id", "canonical_record_id",
      "entity_type", "merge_id", "provenance_revision_id", "record_version", "source_record_id"]);
    assert.equal(mergeAcknowledgement.candidate_id, candidateId);
    assert.equal(mergeAcknowledgement.entity_type, "student");
    assert.equal(mergeAcknowledgement.source_record_id, mergeWinner.attempt.body.source_record_id);
    assert.equal(mergeAcknowledgement.canonical_record_id, mergeWinner.attempt.body.canonical_record_id);
    assert.equal(mergeAcknowledgement.record_version, 1);
    const mergeId = requiredString(mergeAcknowledgement, "merge_id");
    const winningReplay = await postJson(baseUrl,
      `/api/v1/crm/duplicate-candidates/${candidateId}/merges`, founderCookie,
      mergeWinner.attempt.body, mergeWinner.attempt.key);
    assert.equal(winningReplay.response.status, 200);
    assert.deepEqual(winningReplay.body.data, mergeWinner.result.body.data);
    const mergeChanged = await postJson(baseUrl,
      `/api/v1/crm/duplicate-candidates/${candidateId}/merges`, founderCookie,
      { ...mergeWinner.attempt.body, expected_candidate_record_version: 2 }, mergeWinner.attempt.key);
    assertApiError(mergeChanged, 409, "CONFLICT");

    const canonicalId = requiredString(mergeAcknowledgement, "canonical_record_id");
    const canonicalLabel = canonicalId === assignedStudent.id ? "CRM04 Left Student" : "CRM04 Right Student";
    for (const requestedId of [assignedStudent.id, unassignedStudent.id]) {
      const resolved = requiredRecord((await getJson(baseUrl, `/api/v1/students/${requestedId}`,
        founderCookie)).body.data?.student);
      assert.equal(resolved.id, canonicalId);
      assert.equal(resolved.displayName, canonicalLabel);
      assert.equal(resolved.contactEmail, crm04SharedEmail);
    }
    const mergedDetail = await getJson(baseUrl, `/api/v1/crm/duplicate-candidates/${candidateId}`,
      founderCookie);
    assert.equal(mergedDetail.response.status, 200);
    assertDuplicateDetailShape(mergedDetail.body.data, "student", true);
    assertDuplicateDetailPair(mergedDetail.body.data);
    assert.equal(requiredRecord(requiredRecord(mergedDetail.body.data).candidate).status, "merged");

    const beforeDeniedDuplicate = await readDuplicateWorkflowCounts(target);
    const contractorCookie = await login(baseUrl, CONTRACTOR.email, contractorPassword);
    const beforeContractorStudentRead = await readScopedCounts(target);
    const contractorStudentList = await getJson(baseUrl, "/api/v1/students", contractorCookie);
    assertApiError(contractorStudentList, 403, "FORBIDDEN");
    assertNoPrivateErrorEcho(contractorStudentList, [crm04SharedEmail, "CRM04 Left Student"]);
    const contractorStudentDetail = await getJson(baseUrl,
      `/api/v1/students/${assignedStudent.id}`, contractorCookie);
    assertApiError(contractorStudentDetail, 403, "FORBIDDEN");
    assertNoPrivateErrorEcho(contractorStudentDetail, [crm04SharedEmail, "CRM04 Left Student"]);
    assert.deepEqual(await readScopedCounts(target), beforeContractorStudentRead);
    for (const [role, cookie] of [["admin", adminCookie], ["contractor", contractorCookie]] as const) {
      const deniedRequests = [
        await postJson(baseUrl, "/api/v1/crm/duplicate-records/search", cookie,
          { entity_type: "student", query: "CRM04" }),
        await getJson(baseUrl, "/api/v1/crm/duplicate-candidates?entity_type=student&status=merged", cookie),
        await postJson(baseUrl, "/api/v1/crm/duplicate-candidates", cookie, candidateBody,
          `crm04-${role}-candidate-denied`),
        await getJson(baseUrl, `/api/v1/crm/duplicate-candidates/${candidateId}`, cookie),
        await postJson(baseUrl, `/api/v1/crm/duplicate-candidates/${candidateId}/merges`, cookie,
          mergeWinner.attempt.body, `crm04-${role}-merge-denied`),
        await postJson(baseUrl, `/api/v1/crm/duplicate-merges/${mergeId}/corrections`, cookie,
          { expected_merge_record_version: 1, reason_code: "duplicate.merge.corrected" },
          `crm04-${role}-correction-denied`),
      ];
      for (const denied of deniedRequests) {
        assertApiError(denied, 403, "FORBIDDEN");
        assertNoPrivateErrorEcho(denied, [crm04SharedEmail, "CRM04 Left Student"]);
      }
    }
    for (const [role, cookie] of [["advisor", advisorCookie],
      ["data-reviewer", dataReviewerCookie]] as const) {
      const mergeDenied = await postJson(baseUrl,
        `/api/v1/crm/duplicate-candidates/${candidateId}/merges`, cookie,
        mergeWinner.attempt.body, `crm04-${role}-merge-denied`);
      assertApiError(mergeDenied, 403, "FORBIDDEN");
      const correctionDenied = await postJson(baseUrl,
        `/api/v1/crm/duplicate-merges/${mergeId}/corrections`, cookie,
        { expected_merge_record_version: 1, reason_code: "duplicate.merge.corrected" },
        `crm04-${role}-correction-denied`);
      assertApiError(correctionDenied, 403, "FORBIDDEN");
    }
    assert.deepEqual(await readDuplicateWorkflowCounts(target), beforeDeniedDuplicate);

    const correctionBody = { expected_merge_record_version: 1,
      reason_code: "duplicate.merge.corrected" };
    const correction = await postJson(baseUrl, `/api/v1/crm/duplicate-merges/${mergeId}/corrections`,
      founderCookie, correctionBody, "crm04-correction");
    assert.equal(correction.response.status, 200);
    const correctionData = requiredRecord(correction.body.data);
    assert.deepEqual(Object.keys(correctionData).sort(), ["canonical_record_id", "corrective_revision_id",
      "merge_id", "record_version", "restored_alias_target_id", "source_record_id"]);
    const correctionReplay = await postJson(baseUrl,
      `/api/v1/crm/duplicate-merges/${mergeId}/corrections`, founderCookie,
      correctionBody, "crm04-correction");
    assert.equal(correctionReplay.response.status, 200);
    assert.deepEqual(correctionReplay.body.data, correction.body.data);
    const correctedDetail = await getJson(baseUrl,
      `/api/v1/crm/duplicate-candidates/${candidateId}`, founderCookie);
    assert.equal(correctedDetail.response.status, 200);
    const correctedMerge = requiredRecord(requiredRecord(correctedDetail.body.data).merge);
    assert.equal(correctedMerge.status, "corrected");
    assert.equal(correctedMerge.record_version, 2);
    assert.equal(typeof correctedMerge.correction_id, "string");
    assert.equal(requiredRecord(requiredRecord(correctedDetail.body.data).candidate).status, "merged");
    assertDuplicateDetailPair(correctedDetail.body.data);
    for (const requestedId of [assignedStudent.id, unassignedStudent.id]) {
      const restored = requiredRecord((await getJson(baseUrl, `/api/v1/students/${requestedId}`,
        founderCookie)).body.data?.student);
      assert.equal(restored.id, requestedId);
    }

    const crossTenantCandidate = await postJson(baseUrl, "/api/v1/crm/duplicate-candidates",
      founderCookie, { entity_type: "student", left_record_id: assignedStudent.id,
        right_record_id: FOREIGN_STUDENT_ID }, "crm04-cross-tenant");
    assertApiError(crossTenantCandidate, 404, "NOT_FOUND");
    assertNoPrivateErrorEcho(crossTenantCandidate, [crm04SharedEmail, "CRM04 Left Student"]);

    const assignedGuardianId = assignedStudent.guardianId;
    const unassignedGuardianId = unassignedStudent.guardianId;
    for (const [guardianIdValue, label, key] of [
      [assignedGuardianId, "CRM04 Left Guardian", "crm04-left-guardian"],
      [unassignedGuardianId, "CRM04 Right Guardian", "crm04-right-guardian"],
    ] as const) {
      const guardianDetail = guardianIdValue === assignedGuardianId ? authoritativeGuardian :
        requiredRecord(requiredArray(requiredRecord((await getJson(baseUrl,
          `/api/v1/students/${unassignedStudent.id}`, founderCookie)).body.data?.student).guardians)[0]);
      assertProfileAcknowledgement(await patchJson(baseUrl, `/api/v1/guardians/${guardianIdValue}`,
        founderCookie, { display_name: label, email: "crm04-shared-guardian@example.invalid", phone: null,
          expected_record_version: requiredNumber(guardianDetail, "recordVersion") }, key),
      "guardian", guardianIdValue, requiredNumber(guardianDetail, "recordVersion") + 1);
    }
    const beforeRollbackDuplicate = await readDuplicateWorkflowCounts(target);
    await installDuplicateAuditFailure(target);
    try {
      const failedDuplicate = await postJson(baseUrl, "/api/v1/crm/duplicate-candidates", founderCookie,
        { entity_type: "guardian", left_record_id: assignedGuardianId,
          right_record_id: unassignedGuardianId }, "crm04-rollback-candidate");
      assertApiError(failedDuplicate, 503, "SERVICE_UNAVAILABLE");
      assertNoPrivateErrorEcho(failedDuplicate, ["crm04-shared-guardian@example.invalid"]);
      assert.deepEqual(await readDuplicateWorkflowCounts(target), beforeRollbackDuplicate);
    } finally {
      await removeDuplicateAuditFailure(target);
    }

    const guardianCandidateCreate = await postJson(baseUrl, "/api/v1/crm/duplicate-candidates",
      founderCookie, { entity_type: "guardian", left_record_id: assignedGuardianId,
        right_record_id: unassignedGuardianId }, "crm04-guardian-candidate");
    assert.equal(guardianCandidateCreate.response.status, 201);
    const guardianCandidate = requiredRecord(guardianCandidateCreate.body.data);
    assertDuplicateCandidateShape(guardianCandidate);
    assert.deepEqual(guardianCandidate.matching_signals, ["email"]);
    const guardianCandidateId = requiredString(guardianCandidate, "id");
    const guardianDetail = await getJson(baseUrl,
      `/api/v1/crm/duplicate-candidates/${guardianCandidateId}`, founderCookie);
    assert.equal(guardianDetail.response.status, 200);
    assertDuplicateDetailShape(guardianDetail.body.data, "guardian", false);
    assertDuplicateDetailPair(guardianDetail.body.data);
    const guardianLeftId = requiredString(requiredRecord(guardianCandidate.left_record), "id");
    const guardianRightId = requiredString(requiredRecord(guardianCandidate.right_record), "id");
    const guardianMergeBody = {
      source_record_id: guardianLeftId, canonical_record_id: guardianRightId,
      expected_candidate_record_version: 1, expected_source_record_version: 3,
      expected_canonical_record_version: 3,
      field_selections: ["display_name", "email", "phone"].map((field_name) => ({
        field_name, source_record_id: guardianRightId,
      })),
      reason_code: "duplicate.confirmed",
    };
    const guardianMerge = await postJson(baseUrl,
      `/api/v1/crm/duplicate-candidates/${guardianCandidateId}/merges`, founderCookie,
      guardianMergeBody, "crm04-guardian-merge");
    assert.equal(guardianMerge.response.status, 200);
    const guardianMergeData = requiredRecord(guardianMerge.body.data);
    assert.deepEqual(Object.keys(guardianMergeData).sort(), ["candidate_id", "canonical_record_id",
      "entity_type", "merge_id", "provenance_revision_id", "record_version", "source_record_id"]);
    assert.equal(guardianMergeData.candidate_id, guardianCandidateId);
    assert.equal(guardianMergeData.entity_type, "guardian");
    assert.equal(guardianMergeData.source_record_id, guardianLeftId);
    assert.equal(guardianMergeData.canonical_record_id, guardianRightId);
    const guardianMergeId = requiredString(guardianMergeData, "merge_id");
    const mergedGuardianDetail = await getJson(baseUrl,
      `/api/v1/crm/duplicate-candidates/${guardianCandidateId}`, founderCookie);
    assert.equal(mergedGuardianDetail.response.status, 200);
    assertDuplicateDetailShape(mergedGuardianDetail.body.data, "guardian", true);
    assertDuplicateDetailPair(mergedGuardianDetail.body.data);
    for (const student of [assignedStudent, unassignedStudent]) {
      const resolvedStudent = requiredRecord((await getJson(baseUrl, `/api/v1/students/${student.id}`,
        founderCookie)).body.data?.student);
      const resolvedGuardian = requiredRecord(requiredArray(resolvedStudent.guardians)[0]);
      assert.equal(resolvedGuardian.id, guardianRightId);
      assert.equal(resolvedGuardian.email, "crm04-shared-guardian@example.invalid");
    }
    const guardianCorrection = await postJson(baseUrl,
      `/api/v1/crm/duplicate-merges/${guardianMergeId}/corrections`, founderCookie,
      { expected_merge_record_version: 1, reason_code: "duplicate.merge.corrected" },
      "crm04-guardian-correction");
    assert.equal(guardianCorrection.response.status, 200);
    const correctedGuardianDetail = await getJson(baseUrl,
      `/api/v1/crm/duplicate-candidates/${guardianCandidateId}`, founderCookie);
    assert.equal(correctedGuardianDetail.response.status, 200);
    assertDuplicateDetailShape(correctedGuardianDetail.body.data, "guardian", true);
    assertDuplicateDetailPair(correctedGuardianDetail.body.data);
    assert.equal(requiredRecord(requiredRecord(correctedGuardianDetail.body.data).merge).status, "corrected");
    for (const student of [assignedStudent, unassignedStudent]) {
      const restoredStudent = requiredRecord((await getJson(baseUrl, `/api/v1/students/${student.id}`,
        founderCookie)).body.data?.student);
      const restoredGuardian = requiredRecord(requiredArray(restoredStudent.guardians)[0]);
      assert.equal(restoredGuardian.id, student.guardianId);
    }

    const duplicateAfter = await readDuplicateWorkflowCounts(target);
    assert.deepEqual(duplicateDelta(duplicateBefore, duplicateAfter), {
      candidates: 2, merges: 2, alias_revisions: 4, provenance_revisions: 14,
      corrections: 2, candidate_receipts: 2, merge_receipts: 2, correction_receipts: 2,
      audit: 6, outbox: 6,
    });

    const crm06Before = await readReferralSourceWorkflowCounts(target, []);
    const founderAccessForCrm06 = await getJson(baseUrl, "/api/v1/auth/me", founderCookie);
    const adminAccessForCrm06 = await getJson(baseUrl, "/api/v1/auth/me", adminCookie);
    const advisorAccessForCrm06 = await getJson(baseUrl, "/api/v1/auth/me", advisorCookie);
    const dataReviewerAccessForCrm06 = await getJson(baseUrl, "/api/v1/auth/me", dataReviewerCookie);
    const contractorAccessForCrm06 = await getJson(baseUrl, "/api/v1/auth/me", contractorCookie);
    assert.deepEqual(referralCapabilities(founderAccessForCrm06), [
      "cases.referral_sources.assign", "referral_sources.manage", "referral_sources.read",
    ]);
    assert.deepEqual(referralCapabilities(adminAccessForCrm06), [
      "referral_sources.manage", "referral_sources.read",
    ]);
    assert.deepEqual(referralCapabilities(advisorAccessForCrm06), [
      "cases.referral_sources.assign", "referral_sources.read",
    ]);
    for (const accessResult of [dataReviewerAccessForCrm06, contractorAccessForCrm06]) {
      assert.deepEqual(referralCapabilities(accessResult), []);
    }

    const sourceA = await createReferralSource(baseUrl, founderCookie, "crm06-source-a",
      { display_name: "CRM06 Synthetic Bank", source_type: "bank" });
    const sourceAId = assertCommandAcknowledgement(sourceA, 201, 1);
    const sourceAReplay = await createReferralSource(baseUrl, founderCookie, "crm06-source-a",
      { display_name: "CRM06 Synthetic Bank", source_type: "bank" });
    assert.deepEqual(sourceAReplay.body.data, sourceA.body.data);
    assertApiError(await createReferralSource(baseUrl, founderCookie, "crm06-source-a",
      { display_name: "CRM06 Changed", source_type: "bank" }), 409, "CONFLICT");
    const sourceB = await createReferralSource(baseUrl, adminCookie, "crm06-source-b",
      { display_name: "CRM06 Synthetic Insurer", source_type: "insurance" });
    const sourceBId = assertCommandAcknowledgement(sourceB, 201, 1);
    const sourceCId = assertCommandAcknowledgement(await createReferralSource(baseUrl, founderCookie,
      "crm06-source-c", { display_name: "CRM06 Synthetic Bank", source_type: "other_partner" }), 201, 1);
    const sourceDId = assertCommandAcknowledgement(await createReferralSource(baseUrl, adminCookie,
      "crm06-source-d", { display_name: "CRM06 Synthetic Partner D", source_type: "bank" }), 201, 1);
    const sourceEId = assertCommandAcknowledgement(await createReferralSource(baseUrl, founderCookie,
      "crm06-source-e", { display_name: "CRM06 Synthetic Partner E", source_type: "insurance" }), 201, 1);

    const sourceList = await getJson(baseUrl, "/api/v1/referral-sources", advisorCookie);
    assert.equal(sourceList.response.status, 200);
    const sourceItems = requiredArray(sourceList.body.data).map(requiredRecord);
    assert.equal(sourceItems.length >= 5, true);
    sourceItems.forEach(assertReferralSourceView);
    assertReferralSourceOrder(sourceItems);
    const sourceDetail = await getJson(baseUrl, `/api/v1/referral-sources/${sourceAId}`, advisorCookie);
    assert.equal(sourceDetail.response.status, 200);
    assertReferralSourceView(requiredRecord(sourceDetail.body.data));
    assert.equal(sourceDetail.body.data?.display_name, "CRM06 Synthetic Bank");
    assertApiError(await createReferralSource(baseUrl, founderCookie, "crm06-source-extra",
      { display_name: "CRM06 Extra", source_type: "bank", organization_id: NEON_TEST_ORGANIZATION.id }),
    422, "VALIDATION_FAILED");
    assertApiError(await createReferralSource(baseUrl, founderCookie, "crm06-source-invalid-type",
      { display_name: "CRM06 Invalid", source_type: "school" }), 422, "VALIDATION_FAILED");
    assert.equal((await fetch(`${baseUrl}/api/v1/referral-sources/${sourceAId}`, {
      method: "DELETE", headers: { cookie: founderCookie }, redirect: "manual",
    })).status, 405);
    assertApiError(await postJson(baseUrl, "/api/v1/referral-sources", advisorCookie,
      { display_name: "CRM06 Advisor Denied", source_type: "bank" }, "crm06-advisor-denied"),
    403, "FORBIDDEN");
    for (const cookie of [dataReviewerCookie, contractorCookie]) {
      assertApiError(await getJson(baseUrl, "/api/v1/referral-sources", cookie), 403, "FORBIDDEN");
    }
    await prepareClosedReferralCase(target, assignedStudent.id);
    assertApiError(await postJson(baseUrl,
      `/api/v1/cases/${CRM06_CLOSED_CASE_ID}/referral-source-assignments`, advisorCookie,
      { referral_source_id: sourceAId, expected_current_assignment_record_version: null },
      "crm06-assignment-ended"), 409, "CONFLICT");

    const assignmentA = await postJson(baseUrl,
      `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, founderCookie,
      { referral_source_id: sourceAId, expected_current_assignment_record_version: null },
      "crm06-assignment-a");
    const assignmentAId = assertCommandAcknowledgement(assignmentA, 200, 1);
    assertApiError(await postJson(baseUrl,
      `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, founderCookie,
      { referral_source_id: sourceBId, expected_current_assignment_record_version: 1,
        actor_role: "founder" }, "crm06-assignment-extra"), 422, "VALIDATION_FAILED");
    const assignmentAReplay = await postJson(baseUrl,
      `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, founderCookie,
      { referral_source_id: sourceAId, expected_current_assignment_record_version: null },
      "crm06-assignment-a");
    assert.deepEqual(assignmentAReplay.body.data, assignmentA.body.data);
    assertApiError(await postJson(baseUrl,
      `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, founderCookie,
      { referral_source_id: sourceBId, expected_current_assignment_record_version: null },
      "crm06-assignment-a"), 409, "CONFLICT");
    const assignmentB = await postJson(baseUrl,
      `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, advisorCookie,
      { referral_source_id: sourceBId, expected_current_assignment_record_version: 1 },
      "crm06-assignment-b");
    assertCommandAcknowledgement(assignmentB, 200, 2);
    const assignmentAfterB = await getJson(baseUrl,
      `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, advisorCookie);
    assertAssignmentCollection(assignmentAfterB, sourceBId, 2, [assignmentAId]);

    const concurrentBodies = [sourceCId, sourceDId].map((referralSourceId, index) => ({
      key: `crm06-assignment-concurrent-${index}`,
      request: postJson(baseUrl, `/api/v1/cases/${assignedCaseId}/referral-source-assignments`,
        advisorCookie, { referral_source_id: referralSourceId,
          expected_current_assignment_record_version: 2 }, `crm06-assignment-concurrent-${index}`),
    }));
    const concurrentResults = await Promise.allSettled(concurrentBodies.map(({ request }) => request));
    const fulfilled = concurrentResults.map((result) => {
      if (result.status !== "fulfilled") throw new HarnessError("crm06_concurrent_http");
      return result.value;
    });
    assert.deepEqual(fulfilled.map(({ response }) => response.status).sort(), [200,409]);
    const concurrentWinner = fulfilled.find(({ response }) => response.status === 200)!;
    const concurrentLoser = fulfilled.find(({ response }) => response.status === 409)!;
    assertCommandAcknowledgement(concurrentWinner, 200, 3);
    assertApiError(concurrentLoser, 409, "STALE_VERSION");
    const winningSourceId = fulfilled[0] === concurrentWinner ? sourceCId : sourceDId;

    const sourceBUpdate = await patchJson(baseUrl, `/api/v1/referral-sources/${sourceBId}`, adminCookie,
      { expected_record_version: 1, display_name: "CRM06 Synthetic Insurer Renamed", status: "inactive" },
      "crm06-source-b-update");
    assertCommandAcknowledgement(sourceBUpdate, 200, 2);
    const sourceBUpdateReplay = await patchJson(baseUrl, `/api/v1/referral-sources/${sourceBId}`, adminCookie,
      { expected_record_version: 1, display_name: "CRM06 Synthetic Insurer Renamed", status: "inactive" },
      "crm06-source-b-update");
    assert.deepEqual(sourceBUpdateReplay.body.data, sourceBUpdate.body.data);
    assertApiError(await patchJson(baseUrl, `/api/v1/referral-sources/${sourceBId}`, adminCookie,
      { expected_record_version: 1, display_name: "CRM06 Changed Replay", status: "inactive" },
      "crm06-source-b-update"), 409, "CONFLICT");
    assertApiError(await patchJson(baseUrl, `/api/v1/referral-sources/${sourceBId}`, adminCookie,
      { expected_record_version: 2, display_name: "CRM06 Synthetic Insurer Renamed", status: "inactive" },
      "crm06-source-b-noop"), 409, "CONFLICT");
    assertApiError(await patchJson(baseUrl, `/api/v1/referral-sources/${sourceBId}`, adminCookie,
      { expected_record_version: 2, display_name: "CRM06 Synthetic Insurer Renamed", status: "active" },
      "crm06-source-b-reactivate"), 409, "CONFLICT");
    const inactiveList = await getJson(baseUrl, "/api/v1/referral-sources?status=inactive", adminCookie);
    assert.equal(inactiveList.response.status, 200);
    assert.equal(requiredArray(inactiveList.body.data).some((item) => requiredRecord(item).id === sourceBId), true);
    assertApiError(await postJson(baseUrl,
      `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, advisorCookie,
      { referral_source_id: sourceBId, expected_current_assignment_record_version: 3 },
      "crm06-assignment-inactive"), 409, "CONFLICT");
    const afterRenameAssignment = await getJson(baseUrl,
      `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, founderCookie);
    assert.equal(afterRenameAssignment.response.status, 200);
    const historicalB = requiredArray(requiredRecord(afterRenameAssignment.body.data).history)
      .map(requiredRecord).find(({ referral_source_id }) => referral_source_id === sourceBId);
    assert.equal(historicalB?.source_display_name, "CRM06 Synthetic Insurer");
    assert.equal(historicalB?.source_record_version, 1);
    assert.notEqual(requiredRecord(requiredRecord(afterRenameAssignment.body.data).current).referral_source_id,
      sourceBId);
    assert.equal([sourceCId,sourceDId].includes(winningSourceId), true);

    for (const cookie of [adminCookie,dataReviewerCookie,contractorCookie]) {
      assertApiError(await getJson(baseUrl,
        `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, cookie), 403, "FORBIDDEN");
      assertApiError(await postJson(baseUrl,
        `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, cookie,
        { referral_source_id: sourceEId, expected_current_assignment_record_version: 3 },
        `crm06-assignment-denied-${cookie.length}`), 403, "FORBIDDEN");
    }
    assertApiError(await postJson(baseUrl,
      `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, advisorCookie,
      { referral_source_id: sourceEId, expected_current_assignment_record_version: 2 },
      "crm06-assignment-stale"), 409, "STALE_VERSION");
    assertApiError(await postJson(baseUrl,
      `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, advisorCookie,
      { referral_source_id: "63000000-0000-4000-8000-000000000901",
        expected_current_assignment_record_version: 3 }, "crm06-assignment-cross-source"), 404, "NOT_FOUND");
    assertApiError(await getJson(baseUrl,
      `/api/v1/cases/63000000-0000-4000-8000-000000000902/referral-source-assignments`, founderCookie),
    404, "NOT_FOUND");

    const beforeFault = await readReferralSourceWorkflowCounts(target, []);
    await installCaseReferralSourceInsertFailure(target);
    try {
      const failed = await postJson(baseUrl,
        `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, advisorCookie,
        { referral_source_id: sourceEId, expected_current_assignment_record_version: 3 },
        "crm06-assignment-fault");
      assertApiError(failed, 503, "SERVICE_UNAVAILABLE");
      assertNoPrivateErrorEcho(failed, ["CRM06 Synthetic Partner E"]);
      assert.deepEqual(await readReferralSourceWorkflowCounts(target, []), beforeFault);
    } finally { await removeCaseReferralSourceInsertFailure(target); }

    const crm06After = await readReferralSourceWorkflowCounts(target, [
      "CRM06 Synthetic Bank", "CRM06 Synthetic Insurer", "CRM06 Synthetic Insurer Renamed",
      "CRM06 Synthetic Partner D", "CRM06 Synthetic Partner E",
    ]);
    assert.equal(crm06After.sources - crm06Before.sources, 5);
    assert.equal(crm06After.assignments - crm06Before.assignments, 3);
    assert.equal(crm06After.source_receipts - crm06Before.source_receipts, 6);
    assert.equal(crm06After.assignment_receipts - crm06Before.assignment_receipts, 3);
    assert.equal(crm06After.identity_users, crm06Before.identity_users);
    assert.equal(crm06After.memberships, crm06Before.memberships);
    assert.equal(crm06After.credentials, crm06Before.credentials);
    assert.equal(crm06After.private_matches, 0);

    const crm05PartnerCreate = await createStudent(baseUrl, founderCookie, "crm05-partner-create", {
      student: { display_name: "CRM05 Partner Student", date_of_birth: null,
        contact_email: null, contact_phone: null },
      primary_guardian: { display_name: "CRM05 Partner Guardian",
        email: "crm05-partner-guardian@example.invalid", phone: null,
        relationship_type: "other_guardian", is_legal_guardian: true },
    });
    assert.equal(crm05PartnerCreate.response.status, 201);
    const crm05PartnerStudentId = requiredString(crm05PartnerCreate.body.data?.student, "id");
    const crm05PartnerGuardianId = requiredString(crm05PartnerCreate.body.data?.primary_guardian, "id");
    const crm05SharedEmail = "crm05-shared-student@example.invalid";
    const crm05ForbiddenGuardianEmail = "crm05-forbidden-guardian-update@example.invalid";
    assertProfileAcknowledgement(await patchJson(baseUrl, `/api/v1/students/${studentId}`,
      founderCookie, { display_name: "CRM05 Lifecycle Student", date_of_birth: "2013-06-18",
        contact_email: crm05SharedEmail, contact_phone: null, expected_record_version: 1 },
      "crm05-lifecycle-profile"), "student", studentId, 2);
    assertProfileAcknowledgement(await patchJson(baseUrl, `/api/v1/students/${crm05PartnerStudentId}`,
      founderCookie, { display_name: "CRM05 Partner Student", date_of_birth: null,
        contact_email: crm05SharedEmail, contact_phone: null, expected_record_version: 1 },
      "crm05-partner-profile"), "student", crm05PartnerStudentId, 2);
    const crm05MergeCandidate = await postJson(baseUrl, "/api/v1/crm/duplicate-candidates",
      founderCookie, { entity_type: "student", left_record_id: studentId,
        right_record_id: crm05PartnerStudentId }, "crm05-merge-guard-candidate");
    assert.equal(crm05MergeCandidate.response.status, 201);
    const crm05MergeCandidateData = requiredRecord(crm05MergeCandidate.body.data);
    const crm05MergeCandidateId = requiredString(crm05MergeCandidateData, "id");

    const founderAccess = await getJson(baseUrl, "/api/v1/auth/me", founderCookie);
    const dataReviewerAccess = await getJson(baseUrl, "/api/v1/auth/me", dataReviewerCookie);
    const contractorAccess = await getJson(baseUrl, "/api/v1/auth/me", contractorCookie);
    assert.deepEqual(deletionCapabilities(founderAccess),
      ["students.deletion.request", "students.deletion.review"]);
    assert.deepEqual(deletionCapabilities(access), ["students.deletion.request"]);
    assert.deepEqual(deletionCapabilities(adminAccess), []);
    assert.deepEqual(deletionCapabilities(dataReviewerAccess), []);
    assert.deepEqual(deletionCapabilities(contractorAccess), []);

    const deletionBefore = await readDeletionWorkflowCounts(target, [
      "CRM05 Lifecycle Student", "CRM05 Partner Student", crm05SharedEmail,
      "crm05-partner-guardian@example.invalid", crm05ForbiddenGuardianEmail,
    ]);
    const deletionBody = (recordVersion: number) => ({
      expected_record_version: recordVersion,
      reason_code: "record.lifecycle.pending_delete_requested",
    });
    const scopedAdvisorDenied = await postJson(baseUrl,
      `/api/v1/students/${crm05PartnerStudentId}/deletion-requests`, advisorCookie,
      deletionBody(2), "crm05-advisor-unassigned");
    assertApiError(scopedAdvisorDenied, 404, "NOT_FOUND");
    const crossTenantDeletion = await postJson(baseUrl,
      `/api/v1/students/${FOREIGN_STUDENT_ID}/deletion-requests`, founderCookie,
      deletionBody(1), "crm05-cross-tenant");
    assertApiError(crossTenantDeletion, 404, "NOT_FOUND");
    const strictDeletionBody = await postJson(baseUrl,
      `/api/v1/students/${studentId}/deletion-requests`, founderCookie,
      { ...deletionBody(2), organization_id: NEON_TEST_ORGANIZATION.id }, "crm05-extra-field");
    assertApiError(strictDeletionBody, 422, "VALIDATION_FAILED");
    const missingIdempotency = await postJson(baseUrl,
      `/api/v1/students/${studentId}/deletion-requests`, founderCookie, deletionBody(2));
    assertApiError(missingIdempotency, 422, "VALIDATION_FAILED");
    const invalidQueue = await getJson(baseUrl,
      "/api/v1/crm/deletion-requests?entity_type=student&status=pending_delete", founderCookie);
    assertApiError(invalidQueue, 422, "VALIDATION_FAILED");
    const unauthenticatedQueue = await getJson(baseUrl, "/api/v1/crm/deletion-requests", "");
    assertApiError(unauthenticatedQueue, 401, "UNAUTHENTICATED");

    for (const [role, cookie] of [["admin", adminCookie], ["data_reviewer", dataReviewerCookie],
      ["contractor", contractorCookie]] as const) {
      const deniedRequest = await postJson(baseUrl,
        `/api/v1/students/${studentId}/deletion-requests`, cookie, deletionBody(2),
        `crm05-denied-${role}`);
      assertApiError(deniedRequest, 403, "FORBIDDEN");
      assertNoPrivateErrorEcho(deniedRequest, ["CRM05 Lifecycle Student", crm05SharedEmail]);
      const deniedQueue = await getJson(baseUrl, "/api/v1/crm/deletion-requests", cookie);
      assertApiError(deniedQueue, 403, "FORBIDDEN");
    }
    const advisorQueue = await getJson(baseUrl, "/api/v1/crm/deletion-requests", advisorCookie);
    assertApiError(advisorQueue, 403, "FORBIDDEN");
    assert.deepEqual(await readDeletionWorkflowCounts(target, []), deletionBefore);

    const founderDeletion = await postJson(baseUrl,
      `/api/v1/students/${studentId}/deletion-requests`, founderCookie,
      deletionBody(2), "crm05-founder-student");
    assertDeletionReceipt(founderDeletion, "student", studentId, 3);
    const founderDeletionReplay = await postJson(baseUrl,
      `/api/v1/students/${studentId}/deletion-requests`, founderCookie,
      deletionBody(2), "crm05-founder-student");
    assertDeletionReceipt(founderDeletionReplay, "student", studentId, 3);
    assert.deepEqual(founderDeletionReplay.body.data, founderDeletion.body.data);
    const founderDeletionChanged = await postJson(baseUrl,
      `/api/v1/students/${studentId}/deletion-requests`, founderCookie,
      deletionBody(3), "crm05-founder-student");
    assertApiError(founderDeletionChanged, 409, "CONFLICT");
    const alreadyPending = await postJson(baseUrl,
      `/api/v1/students/${studentId}/deletion-requests`, founderCookie,
      deletionBody(3), "crm05-already-pending");
    assertApiError(alreadyPending, 409, "CONFLICT");

    const assignedBeforeDeletion = requiredRecord((await getJson(baseUrl,
      `/api/v1/students/${assignedStudent.id}`, advisorCookie)).body.data?.student);
    const assignedGuardianBeforeDeletion = requiredRecord(requiredArray(
      assignedBeforeDeletion.guardians).find((item) => requiredRecord(item).id === assignedGuardianId));
    const advisorGuardianDeletion = await postJson(baseUrl,
      `/api/v1/guardians/${assignedGuardianId}/deletion-requests`, advisorCookie,
      deletionBody(requiredNumber(assignedGuardianBeforeDeletion, "recordVersion")),
      "crm05-advisor-guardian");
    if (advisorGuardianDeletion.response.status !== 200) {
      const failure = readDeletionReviewPostgresFailure(devServer);
      throw new HarnessError(`crm05_advisor_guardian_deletion_status_${advisorGuardianDeletion.response.status}` +
        `_stage_${failure?.stage ?? "NONE"}_postgres_${failure?.postgresCode ?? "NULL"}`);
    }
    assertDeletionReceipt(advisorGuardianDeletion, "guardian", assignedGuardianId,
      requiredNumber(assignedGuardianBeforeDeletion, "recordVersion") + 1);
    const studentWithPendingGuardian = requiredRecord((await getJson(baseUrl,
      `/api/v1/students/${assignedStudent.id}`, advisorCookie)).body.data?.student);
    const pendingGuardianView = requiredRecord(requiredArray(studentWithPendingGuardian.guardians)
      .find((item) => requiredRecord(item).id === assignedGuardianId));
    assert.equal(pendingGuardianView.status, "pending_delete");
    assert.deepEqual(Object.keys(pendingGuardianView).sort(), ["displayName", "email", "id",
      "isBillingContact", "isEmergencyContact", "isLegalGuardian", "isPrimaryContact",
      "notificationConsent", "phone", "recordVersion", "relationshipType", "status"]);

    const advisorStudentDeletion = await postJson(baseUrl,
      `/api/v1/students/${assignedStudent.id}/deletion-requests`, advisorCookie,
      deletionBody(requiredNumber(studentWithPendingGuardian, "recordVersion")),
      "crm05-advisor-student");
    assertDeletionReceipt(advisorStudentDeletion, "student", assignedStudent.id,
      requiredNumber(studentWithPendingGuardian, "recordVersion") + 1);
    assertApiError(await postJson(baseUrl,
      `/api/v1/cases/${assignedCaseId}/referral-source-assignments`, advisorCookie,
      { referral_source_id: sourceEId, expected_current_assignment_record_version: 3 },
      "crm06-assignment-pending-student"), 409, "CONFLICT");
    const pendingStudentView = requiredRecord((await getJson(baseUrl,
      `/api/v1/students/${assignedStudent.id}`, advisorCookie)).body.data?.student);
    assert.equal(pendingStudentView.status, "pending_delete");
    assert.equal(requiredRecord(requiredArray(pendingStudentView.guardians)
      .find((item) => requiredRecord(item).id === assignedGuardianId)).status, "pending_delete");
    const pendingRelationships = await getJson(baseUrl,
      `/api/v1/students/${assignedStudent.id}/guardians`, advisorCookie);
    assert.equal(pendingRelationships.response.status, 200);
    assertCurrentRelationshipResponse(pendingRelationships, assignedStudent.id, assignedGuardianId);
    assert.equal(JSON.stringify(pendingRelationships.body).includes(advisorGuardianBody.email), false);
    const purgedRelationships = await getJson(baseUrl,
      `/api/v1/students/${PURGED_STUDENT_ID}/guardians`, advisorCookie);
    assertApiError(purgedRelationships, 404, "NOT_FOUND");
    const crossTenantRelationships = await getJson(baseUrl,
      `/api/v1/students/${FOREIGN_STUDENT_ID}/guardians`, advisorCookie);
    assertApiError(crossTenantRelationships, 404, "NOT_FOUND");

    const unassignedBeforeDeletion = requiredRecord((await getJson(baseUrl,
      `/api/v1/students/${unassignedStudent.id}`, advisorCookie)).body.data?.student);
    const concurrentDeletionResults = await Promise.all([
      postJson(baseUrl, `/api/v1/students/${unassignedStudent.id}/deletion-requests`, advisorCookie,
        deletionBody(requiredNumber(unassignedBeforeDeletion, "recordVersion")), "crm05-concurrent-a"),
      postJson(baseUrl, `/api/v1/students/${unassignedStudent.id}/deletion-requests`, advisorCookie,
        deletionBody(requiredNumber(unassignedBeforeDeletion, "recordVersion")), "crm05-concurrent-b"),
    ]);
    assert.deepEqual(concurrentDeletionResults.map(({ response }) => response.status).sort(), [200, 409]);
    assertApiError(concurrentDeletionResults.find(({ response }) => response.status === 409)!,
      409, "CONFLICT");

    const unassignedGuardianBeforeDeletion = requiredRecord(requiredArray(
      unassignedBeforeDeletion.guardians).find((item) => requiredRecord(item).id === unassignedGuardianId));
    const staleDeletion = await postJson(baseUrl,
      `/api/v1/guardians/${unassignedGuardianId}/deletion-requests`, founderCookie,
      deletionBody(requiredNumber(unassignedGuardianBeforeDeletion, "recordVersion") - 1),
      "crm05-stale-guardian");
    assertApiError(staleDeletion, 409, "STALE_VERSION");

    await installDeletionAuditFailure(target);
    try {
      const failedDeletion = await postJson(baseUrl,
        `/api/v1/guardians/${crm05PartnerGuardianId}/deletion-requests`, founderCookie,
        deletionBody(1), "crm05-rollback-guardian");
      assertApiError(failedDeletion, 503, "SERVICE_UNAVAILABLE");
      assertNoPrivateErrorEcho(failedDeletion,
        ["CRM05 Partner Guardian", "crm05-partner-guardian@example.invalid"]);
    } finally {
      await removeDeletionAuditFailure(target);
    }
    const partnerAfterRollback = requiredRecord((await getJson(baseUrl,
      `/api/v1/students/${crm05PartnerStudentId}`, founderCookie)).body.data?.student);
    const partnerGuardianAfterRollback = requiredRecord(requiredArray(partnerAfterRollback.guardians)
      .find((item) => requiredRecord(item).id === crm05PartnerGuardianId));
    assert.equal(partnerGuardianAfterRollback.status, "active");
    assert.equal(partnerGuardianAfterRollback.recordVersion, 1);

    const pendingStudentProfile = await patchJson(baseUrl,
      `/api/v1/students/${assignedStudent.id}`, founderCookie,
      { display_name: "CRM05 Forbidden Student Update", date_of_birth: null,
        contact_email: null, contact_phone: null,
        expected_record_version: requiredNumber(pendingStudentView, "recordVersion") },
      "crm05-pending-student-profile");
    assertApiError(pendingStudentProfile, 409, "CONFLICT");
    const pendingProfileCounts = await readProfileMaintenanceCounts(target);
    const advisorPendingGuardianProfile = await patchJson(baseUrl,
      `/api/v1/guardians/${assignedGuardianId}`, advisorCookie,
      { display_name: "CRM05 Advisor Forbidden Guardian Update",
        email: "crm05-advisor-forbidden-guardian-update@example.invalid", phone: null,
        expected_record_version: requiredNumber(pendingGuardianView, "recordVersion") },
      "crm05-advisor-pending-guardian-profile");
    assertApiError(advisorPendingGuardianProfile, 409, "CONFLICT");
    assertNoPrivateErrorEcho(advisorPendingGuardianProfile,
      ["CRM05 Advisor Forbidden Guardian Update",
        "crm05-advisor-forbidden-guardian-update@example.invalid"]);
    assert.deepEqual(await readProfileMaintenanceCounts(target), pendingProfileCounts);
    const pendingGuardianProfile = await patchJson(baseUrl,
      `/api/v1/guardians/${assignedGuardianId}`, founderCookie,
      { display_name: "CRM05 Forbidden Guardian Update", email: crm05ForbiddenGuardianEmail, phone: null,
        expected_record_version: requiredNumber(pendingGuardianView, "recordVersion") },
      "crm05-pending-guardian-profile");
    assertApiError(pendingGuardianProfile, 409, "CONFLICT");
    assertNoPrivateErrorEcho(pendingGuardianProfile,
      ["CRM05 Forbidden Guardian Update", crm05ForbiddenGuardianEmail]);
    const unassignedPendingGuardianProfile = await patchJson(baseUrl,
      `/api/v1/guardians/${INACTIVE_GUARDIAN_ID}`, advisorCookie,
      { display_name: "CRM05 Hidden Pending Guardian", email: "hidden-pending@example.invalid",
        phone: null, expected_record_version: 1 }, "crm05-unassigned-pending-guardian-profile");
    assertApiError(unassignedPendingGuardianProfile, 403, "FORBIDDEN");
    assertNoPrivateErrorEcho(unassignedPendingGuardianProfile,
      ["CRM05 Hidden Pending Guardian", "hidden-pending@example.invalid"]);
    const purgedGuardianProfile = await patchJson(baseUrl,
      `/api/v1/guardians/${PURGED_GUARDIAN_ID}`, founderCookie,
      { display_name: "CRM05 Hidden Purged Guardian", email: "hidden-purged@example.invalid",
        phone: null, expected_record_version: 3 }, "crm05-purged-guardian-profile");
    assertApiError(purgedGuardianProfile, 404, "NOT_FOUND");
    assertNoPrivateErrorEcho(purgedGuardianProfile,
      ["CRM05 Hidden Purged Guardian", "hidden-purged@example.invalid"]);
    const crossTenantGuardianProfile = await patchJson(baseUrl,
      `/api/v1/guardians/${FOREIGN_GUARDIAN_ID}`, founderCookie,
      { display_name: "CRM05 Hidden Foreign Guardian", email: "hidden-foreign@example.invalid",
        phone: null, expected_record_version: 1 }, "crm05-cross-tenant-guardian-profile");
    assertApiError(crossTenantGuardianProfile, 404, "NOT_FOUND");
    assertNoPrivateErrorEcho(crossTenantGuardianProfile,
      ["CRM05 Hidden Foreign Guardian", "hidden-foreign@example.invalid"]);
    assert.deepEqual(await readProfileMaintenanceCounts(target), pendingProfileCounts);
    const pendingAttach = await postJson(baseUrl,
      `/api/v1/students/${assignedStudent.id}/guardians`, advisorCookie, attachBody,
      "crm05-pending-attach");
    assertApiError(pendingAttach, 404, "NOT_FOUND");
    const pendingGuardianAttach = await postJson(baseUrl,
      `/api/v1/students/${crm05PartnerStudentId}/guardians`, advisorCookie,
      { ...attachBody, guardian_id: assignedGuardianId }, "crm05-pending-guardian-attach");
    assertApiError(pendingGuardianAttach, 404, "NOT_FOUND");
    const pendingHandoff = await postJson(baseUrl,
      `/api/v1/students/${assignedStudent.id}/guardians/primary-handoffs`, advisorCookie,
      { successor_guardian_id: unassignedGuardianId, expected_primary_record_version: 2 },
      "crm05-pending-handoff");
    assertApiError(pendingHandoff, 404, "NOT_FOUND");
    const pendingDuplicateCandidate = await postJson(baseUrl, "/api/v1/crm/duplicate-candidates",
      founderCookie, { entity_type: "student", left_record_id: studentId,
        right_record_id: crm05PartnerStudentId }, "crm05-pending-candidate");
    assertApiError(pendingDuplicateCandidate, 404, "NOT_FOUND");
    const pendingMergeBody = {
      source_record_id: studentId,
      canonical_record_id: crm05PartnerStudentId,
      expected_candidate_record_version: 1,
      expected_source_record_version: 3,
      expected_canonical_record_version: 2,
      field_selections: ["display_name", "date_of_birth", "contact_email", "contact_phone"]
        .map((field_name) => ({ field_name, source_record_id: crm05PartnerStudentId })),
      reason_code: "duplicate.confirmed",
    };
    assert.deepEqual(Object.keys(pendingMergeBody).sort(), ["canonical_record_id",
      "expected_candidate_record_version", "expected_canonical_record_version",
      "expected_source_record_version", "field_selections", "reason_code", "source_record_id"]);
    assert.deepEqual(pendingMergeBody.field_selections.map(({ field_name }) => field_name),
      ["display_name", "date_of_birth", "contact_email", "contact_phone"]);
    assert.equal(pendingMergeBody.field_selections.every(({ source_record_id }) =>
      source_record_id === crm05PartnerStudentId), true);
    const pendingMerge = await postJson(baseUrl,
      `/api/v1/crm/duplicate-candidates/${crm05MergeCandidateId}/merges`, founderCookie,
      pendingMergeBody, "crm05-pending-merge");
    assertApiError(pendingMerge, 404, "NOT_FOUND");
    const pendingCase = await postJson(baseUrl, "/api/v1/cases", founderCookie, {
      student_id: studentId, intake_year: 2029, admission_type: "transfer",
      primary_role_binding_id: FOUNDER.roleBindingId, manifest_id: NEON_TEST_MANIFEST_ID,
    }, "crm05-pending-case");
    assertApiError(pendingCase, 404, "NOT_FOUND");
    const purgeRoute = await fetch(`${baseUrl}/api/v1/students/${studentId}/purge`, {
      method: "POST", headers: { cookie: founderCookie, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(purgeRoute.status, 404);
    await purgeRoute.body?.cancel();

    const deletionQueue = await getJson(baseUrl, "/api/v1/crm/deletion-requests", founderCookie);
    assert.equal(deletionQueue.response.status, 200);
    assert.equal(deletionQueue.response.headers.get("cache-control"), "no-store");
    const deletionQueueItems = requiredArray(deletionQueue.body.data).map(requiredRecord);
    assert.equal(deletionQueueItems.length <= 100, true);
    for (const item of deletionQueueItems) assertDeletionSummary(item);
    assertDeletionQueueOrder(deletionQueueItems);
    const studentDeletionQueue = await getJson(baseUrl,
      "/api/v1/crm/deletion-requests?entity_type=student", founderCookie);
    const studentDeletionItems = requiredArray(studentDeletionQueue.body.data).map(requiredRecord);
    assert.equal(studentDeletionItems.every(({ entity_type }) => entity_type === "student"), true);
    assert.equal(studentDeletionItems.some(({ entity_id }) => entity_id === studentId), true);
    const guardianDeletionQueue = await getJson(baseUrl,
      "/api/v1/crm/deletion-requests?entity_type=guardian", founderCookie);
    const guardianDeletionItems = requiredArray(guardianDeletionQueue.body.data).map(requiredRecord);
    assert.equal(guardianDeletionItems.every(({ entity_type }) => entity_type === "guardian"), true);
    assert.equal(guardianDeletionItems.some(({ entity_id }) => entity_id === assignedGuardianId), true);

    const deletionAfter = await readDeletionWorkflowCounts(target, [
      "CRM05 Lifecycle Student", "CRM05 Partner Student", crm05SharedEmail,
      "crm05-partner-guardian@example.invalid", "CRM05 Forbidden Student Update",
      "CRM05 Forbidden Guardian Update", crm05ForbiddenGuardianEmail,
    ]);
    assert.deepEqual(deletionDelta(deletionBefore, deletionAfter), {
      pending_students: 3, pending_guardians: 1, student_receipts: 3,
      guardian_receipts: 1, audit: 4, outbox: 4, private_matches: 0,
    });

    const list = await getJson(baseUrl, "/api/v1/students", advisorCookie);
    assert.equal(list.response.status, 200);
    assert.equal((list.body.data?.students as Array<{ id?: string }>).some(({ id }) => id === studentId), true);
    const detail = await getJson(baseUrl, `/api/v1/students/${studentId}`, advisorCookie);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.data?.student && (detail.body.data.student as { id?: string }).id, studentId);
    assert.equal((detail.body.data?.student as { guardians?: Array<{ id?: string }> })
      .guardians?.some(({ id }) => id === SHARED_GUARDIAN.guardianId), true);

    await assertCrossTenantReadsAreEmpty(target, studentId);
    const logout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { cookie: advisorCookie },
      redirect: "manual",
    });
    assert.equal(logout.status, 303);
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { cookie: advisorCookie },
    })).status, 401);

    const reloginCookie = await login(baseUrl, ADVISOR.email, advisorPassword);
    assert.equal((await getJson(baseUrl, `/api/v1/students/${studentId}`, reloginCookie)).response.status, 200);
    assertNoSensitiveDevLogs(devServer, [
      body.student.display_name,
      body.primary_guardian.email!,
      SHARED_GUARDIAN.guardianName,
      SHARED_GUARDIAN.guardianEmail!,
      ALTERNATE_GUARDIAN.guardianName,
      ALTERNATE_GUARDIAN.guardianEmail!,
      founderStudentBody.display_name,
      founderStudentBody.contact_email,
      founderGuardianBody.display_name,
      founderGuardianBody.email,
      advisorStudentBody.display_name,
      advisorStudentBody.contact_email,
      advisorSecondBody.display_name,
      advisorSecondBody.contact_email,
      advisorGuardianBody.display_name,
      advisorGuardianBody.email,
      "CRM04 Left Student",
      "CRM04 Right Student",
      crm04SharedEmail,
      "CRM04 Left Guardian",
      "CRM04 Right Guardian",
      "crm04-shared-guardian@example.invalid",
      "CRM05 Lifecycle Student",
      "CRM05 Partner Student",
      "CRM05 Partner Guardian",
      crm05SharedEmail,
      "crm05-partner-guardian@example.invalid",
      "CRM05 Forbidden Student Update",
      "CRM05 Forbidden Guardian Update",
      crm05ForbiddenGuardianEmail,
      "CRM06 Synthetic Bank",
      "CRM06 Synthetic Insurer",
      "CRM06 Synthetic Insurer Renamed",
      "CRM06 Synthetic Partner D",
      "CRM06 Synthetic Partner E",
      applicationPassword,
      advisorPassword,
      adminPassword,
      founderPassword,
      dataReviewerPassword,
      contractorPassword,
      "postgresql://",
      "XX001",
    ]);
    const finalState = await inspectBaselineWithNewClient(target);
    assertDatabaseContract(finalState, target, manifestSha256);

    evidence = Object.freeze({
      status: "pass",
      postgres_major: 17,
      baseline_id: baseline.baseline_id,
      generated_files: baseline.generated_files,
      role_contract: baseline.verification.role_contract,
      rls_not_forced_count: baseline.verification.rls_not_forced_count,
      unsafe_security_definer_count: baseline.verification.unsafe_security_definer_count,
      crm_created_counts: delta(initialCounts, afterCreate),
      exact_replay: "same_result_no_new_rows",
      changed_payload: "conflict_no_new_rows",
      transaction_failure: "rolled_back_no_new_rows",
      cross_tenant_read: "empty",
      guardian_workflow: Object.freeze({
        search: 200,
        attach: 201,
        handoff: 200,
        concurrent_handoff: "one_200_one_409_stale",
        exact_replay: "no_new_rows",
        changed_payload: 409,
        stale: 409,
        forbidden_roles: 4,
        history_preserved: true,
      }),
      profile_maintenance: Object.freeze({
        founder: 200,
        assigned_advisor: 200,
        unassigned_advisor: 403,
        admin: 403,
        exact_replay_after_later_update: true,
        changed_payload: 409,
        stale: 409,
        cross_tenant: 404,
        inactive: 409,
        rollback: 503,
        effects: profileDelta(profileBefore, afterAllowedProfiles),
        response_hash: profileHashEvidence,
      }),
      duplicate_review: Object.freeze({
        search: 200,
        candidate_create: 201,
        review_roles: 3,
        advisor_unassigned_pair: 404,
        concurrent_merge: "one_200_one_409_stale",
        merge_replay: "exact_no_new_rows",
        merge_changed_payload: 409,
        correction: 200,
        correction_replay: "exact_no_new_rows",
        denied_roles: "admin_contractor_advisor_data_reviewer",
        cross_tenant: 404,
        rollback: 503,
        resolved_reads: "student_and_guardian_both_ids_then_restored",
        append_only_effects: duplicateDelta(duplicateBefore, duplicateAfter),
      }),
      pending_delete_review: Object.freeze({
        founder_request: 200,
        assigned_advisor_request: 200,
        advisor_unassigned: 404,
        denied_roles: 3,
        founder_queue: 200,
        exact_replay: "same_result_no_new_rows",
        changed_payload: 409,
        stale: 409,
        concurrent_request: "one_200_one_409_conflict",
        rollback: 503,
        pending_reads: "student_embedded_guardian_and_current_relationships",
        assigned_advisor_pending_guardian_profile: 409,
        unassigned_advisor_pending_guardian_profile: 403,
        founder_pending_guardian_profile: 409,
        purged_guardian_profile: 404,
        cross_tenant_guardian_profile: 404,
        purged_relationships_read: 404,
        cross_tenant_relationships_read: 404,
        later_writes: "denied",
        no_purge_route: true,
        effects: deletionDelta(deletionBefore, deletionAfter),
      }),
      referral_source_case_link: Object.freeze({
        source_create_update: "founder_admin",
        source_read: "founder_admin_advisor",
        denied_source_roles: "data_reviewer_contractor",
        duplicate_names: true,
        exact_acknowledgement_replay: true,
        no_op_reactivate: 409,
        assignment: "founder_assigned_advisor",
        denied_case_roles: "admin_data_reviewer_contractor",
        concurrent_assignment: "one_200_one_409_stale",
        inactive_ended_pending_cross_tenant: "denied",
        snapshots_immutable: true,
        rollback: 503,
        identity_effects: 0,
        private_matches: crm06After.private_matches,
      }),
      http: Object.freeze({ create: 201, list: 200, detail: 200, forbidden: 403 }),
      persisted_after_relogin: true,
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

function validCreateBody() {
  return {
    student: {
      display_name: "CRM01 Synthetic Student",
      date_of_birth: "2013-06-18",
      contact_email: null,
      contact_phone: null,
    },
    primary_guardian: {
      display_name: "CRM01 Synthetic Guardian",
      email: "crm01-guardian@example.invalid",
      phone: null,
      relationship_type: "father",
      is_legal_guardian: true,
    },
  };
}

function advisorActor(): IdentitySessionActor {
  return {
    userId: ADVISOR.userId,
    organizationId: NEON_TEST_ORGANIZATION.id,
    role: "advisor",
    sessionId: "63000000-0000-4000-8000-000000000003",
    capturedSessionVersion: 1,
    reauthenticatedAtMs: null,
  };
}

async function createStudent(
  baseUrl: string,
  cookie: string,
  idempotencyKey: string,
  body: unknown,
) {
  const response = await fetch(`${baseUrl}/api/v1/students`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}

type ApiEnvelope = {
  readonly api_version?: string;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code?: string };
};

function assertApiError(
  result: Readonly<{ response: Response; body: ApiEnvelope }>,
  status: number,
  code: string,
): void {
  assert.equal(result.response.status, status);
  assert.equal(result.body.error?.code, code);
}

function assertCurrentRelationshipResponse(
  result: Readonly<{ response: Response; body: ApiEnvelope }>,
  studentId: string,
  guardianId: string,
): void {
  assert.equal(result.response.status, 200);
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data).sort(), ["relationships", "student"]);
  const student = requiredRecord(data.student);
  assert.deepEqual(Object.keys(student).sort(), ["display_name", "id"]);
  assert.equal(student.id, studentId);
  const relationships = requiredArray(data.relationships).map(requiredRecord);
  const relationship = relationships.find((item) => requiredRecord(item.guardian).id === guardianId);
  assert.ok(relationship);
  assert.deepEqual(Object.keys(relationship).sort(), [
    "guardian", "is_billing_contact", "is_emergency_contact", "is_legal_guardian",
    "is_primary_contact", "notification_consent", "record_version", "relationship_id",
    "relationship_type", "starts_at",
  ]);
  const guardian = requiredRecord(relationship.guardian);
  assert.deepEqual(Object.keys(guardian).sort(), ["display_name", "email_hint", "id", "phone_hint"]);
  assert.equal(guardian.id, guardianId);
}

function assertNoPrivateErrorEcho(
  result: Readonly<{ response: Response; body: ApiEnvelope }>,
  privateValues: readonly string[],
): void {
  const serialized = JSON.stringify(result.body);
  for (const value of privateValues) assert.equal(serialized.includes(value), false);
}

function deletionCapabilities(result: Readonly<{ response: Response; body: ApiEnvelope }>): string[] {
  assert.equal(result.response.status, 200);
  const capabilities = requiredArray(result.body.data?.capabilities);
  return capabilities.filter((capability): capability is string => typeof capability === "string")
    .filter((capability) => capability.startsWith("students.deletion."))
    .sort();
}

function referralCapabilities(result: Readonly<{ response: Response; body: ApiEnvelope }>): string[] {
  assert.equal(result.response.status, 200);
  return requiredArray(result.body.data?.capabilities)
    .filter((capability): capability is string => typeof capability === "string")
    .filter((capability) => capability.startsWith("referral_sources.") ||
      capability === "cases.referral_sources.assign").sort();
}

function createReferralSource(baseUrl: string, cookie: string, key: string, body: unknown) {
  return postJson(baseUrl, "/api/v1/referral-sources", cookie, body, key);
}

function assertCommandAcknowledgement(result: Readonly<{ response: Response; body: ApiEnvelope }>,
  status: number, recordVersion: number): string {
  assert.equal(result.response.status, status);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data).sort(), ["id","record_version"]);
  assert.equal(data.record_version, recordVersion);
  return requiredString(data, "id");
}

function assertReferralSourceView(item: Record<string, unknown>) {
  assert.deepEqual(Object.keys(item).sort(), ["display_name","id","record_version","source_type","status"]);
  assert.equal(["bank","insurance","other_partner"].includes(String(item.source_type)), true);
  assert.equal(["active","inactive"].includes(String(item.status)), true);
  assert.equal(Number.isSafeInteger(item.record_version), true);
}

function assertReferralSourceOrder(items: readonly Record<string, unknown>[]) {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!; const current = items[index]!;
    const previousStatus = previous.status === "active" ? 0 : 1;
    const currentStatus = current.status === "active" ? 0 : 1;
    const ordered = previousStatus < currentStatus || (previousStatus === currentStatus &&
      (String(previous.display_name) < String(current.display_name) ||
       (previous.display_name === current.display_name && String(previous.id) < String(current.id))));
    assert.equal(ordered, true);
  }
}

function assertAssignmentCollection(result: Readonly<{ response: Response; body: ApiEnvelope }>,
  currentSourceId: string, currentVersion: number, historicalIds: readonly string[]) {
  assert.equal(result.response.status, 200);
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data).sort(), ["current","history"]);
  const current = requiredRecord(data.current); assertAssignmentView(current);
  assert.equal(current.referral_source_id, currentSourceId);
  assert.equal(current.record_version, currentVersion);
  assert.equal(current.ends_at, null);
  const history = requiredArray(data.history).map(requiredRecord);
  history.forEach((item) => { assertAssignmentView(item); assert.notEqual(item.ends_at, null); });
  for (const id of historicalIds) assert.equal(history.some((item) => item.id === id), true);
}

function assertAssignmentView(item: Record<string, unknown>) {
  assert.deepEqual(Object.keys(item).sort(), ["ends_at","id","record_version","referral_source_id",
    "source_display_name","source_record_version","source_type","starts_at"]);
  assert.equal(["bank","insurance","other_partner"].includes(String(item.source_type)), true);
  assert.equal(new Date(requiredString(item, "starts_at")).toISOString(), item.starts_at);
  if (item.ends_at !== null) assert.equal(new Date(String(item.ends_at)).toISOString(), item.ends_at);
}

function assertDeletionReceipt(
  result: Readonly<{ response: Response; body: ApiEnvelope }>,
  entityType: "student" | "guardian",
  entityId: string,
  recordVersion: number,
): void {
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data).sort(), ["deletion_requested_at", "entity_id", "entity_type",
    "record_version", "status"]);
  assert.equal(data.entity_type, entityType);
  assert.equal(data.entity_id, entityId);
  assert.equal(data.status, "pending_delete");
  assert.equal(data.record_version, recordVersion);
  assert.equal(new Date(requiredString(data, "deletion_requested_at")).toISOString(),
    data.deletion_requested_at);
}

function assertDeletionSummary(item: Record<string, unknown>): void {
  assert.deepEqual(Object.keys(item).sort(), ["deletion_requested_at", "display_label", "entity_id",
    "entity_type", "record_version", "status"]);
  assert.equal(["student", "guardian"].includes(String(item.entity_type)), true);
  assert.equal(item.status, "pending_delete");
  assert.equal(typeof item.display_label, "string");
  assert.equal(new Date(requiredString(item, "deletion_requested_at")).toISOString(),
    item.deletion_requested_at);
}

function assertDeletionQueueOrder(items: readonly Record<string, unknown>[]): void {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!;
    const current = items[index]!;
    const previousTime = Date.parse(requiredString(previous, "deletion_requested_at"));
    const currentTime = Date.parse(requiredString(current, "deletion_requested_at"));
    assert.equal(previousTime >= currentTime, true);
    if (previousTime === currentTime) {
      assert.equal(requiredString(previous, "entity_id") <= requiredString(current, "entity_id"), true);
    }
  }
}

function requiredString(container: unknown, field: string): string {
  const value = requiredRecord(container)[field];
  if (typeof value !== "string") throw new HarnessError("http_response_shape");
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

function requiredNumber(container: unknown, field: string): number {
  const value = requiredRecord(container)[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new HarnessError("http_response_shape");
  }
  return value;
}

async function postJson(
  baseUrl: string,
  path: string,
  cookie: string,
  body: unknown,
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = { cookie, "content-type": "application/json" };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}

async function patchJson(
  baseUrl: string,
  path: string,
  cookie: string,
  body: unknown,
  idempotencyKey: string,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}

function assertProfileAcknowledgement(
  result: Readonly<{ response: Response; body: ApiEnvelope }>,
  resource: "student" | "guardian",
  expectedId: string,
  expectedVersion: number,
): void {
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data), [resource]);
  const acknowledgement = requiredRecord(data[resource]);
  assert.deepEqual(Object.keys(acknowledgement).sort(), ["id", "record_version", "updated_at"]);
  assert.equal(acknowledgement.id, expectedId);
  assert.equal(acknowledgement.record_version, expectedVersion);
  assert.equal(new Date(requiredString(acknowledgement, "updated_at")).toISOString(),
    acknowledgement.updated_at);
}

async function getJson(baseUrl: string, path: string, cookie: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}

function assertDuplicateCandidateShape(value: unknown): void {
  const candidate = requiredRecord(value);
  assert.deepEqual(Object.keys(candidate).sort(), ["entity_type", "id", "left_record", "matching_signals",
    "merge_id", "record_version", "right_record", "status"]);
  assert.deepEqual(Object.keys(requiredRecord(candidate.left_record)).sort(), ["display_label", "id"]);
  assert.deepEqual(Object.keys(requiredRecord(candidate.right_record)).sort(), ["display_label", "id"]);
}

function assertDuplicateDetailShape(value: unknown, entity: "student" | "guardian", merged: boolean): void {
  const detail = requiredRecord(value);
  assert.deepEqual(Object.keys(detail).sort(), ["candidate", "left_profile", "merge", "right_profile",
    "supported_fields"]);
  assertDuplicateCandidateShape(detail.candidate);
  const profileKeys = entity === "student" ? ["contact_email", "contact_phone", "date_of_birth",
    "display_name", "id", "record_version"] : ["display_name", "email", "id", "phone", "record_version"];
  assert.deepEqual(Object.keys(requiredRecord(detail.left_profile)).sort(), profileKeys);
  assert.deepEqual(Object.keys(requiredRecord(detail.right_profile)).sort(), profileKeys);
  assert.deepEqual(detail.supported_fields, entity === "student" ?
    ["display_name", "date_of_birth", "contact_email", "contact_phone"] :
    ["display_name", "email", "phone"]);
  assert.equal(detail.merge === null, !merged);
}

function assertDuplicateDetailPair(value: unknown): void {
  const detail = requiredRecord(value);
  const candidate = requiredRecord(detail.candidate);
  assert.equal(requiredRecord(detail.left_profile).id, requiredRecord(candidate.left_record).id);
  assert.equal(requiredRecord(detail.right_profile).id, requiredRecord(candidate.right_record).id);
}

interface DuplicateWorkflowCounts {
  candidates: number;
  merges: number;
  alias_revisions: number;
  provenance_revisions: number;
  corrections: number;
  candidate_receipts: number;
  merge_receipts: number;
  correction_receipts: number;
  audit: number;
  outbox: number;
}

async function readDuplicateWorkflowCounts(target: OneRoleBaselineTarget): Promise<DuplicateWorkflowCounts> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
    const result = await client.query<DuplicateWorkflowCounts>(`
      SELECT
        (SELECT count(*)::int FROM crm_duplicate_candidates) AS candidates,
        (SELECT count(*)::int FROM crm_duplicate_merges) AS merges,
        (SELECT count(*)::int FROM crm_duplicate_alias_revisions) AS alias_revisions,
        (SELECT count(*)::int FROM crm_duplicate_field_provenance_revisions) AS provenance_revisions,
        (SELECT count(*)::int FROM crm_duplicate_merge_corrections) AS corrections,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation='crm.create_duplicate_candidate') AS candidate_receipts,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation='crm.merge_duplicate_candidate') AS merge_receipts,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation='crm.correct_duplicate_merge') AS correction_receipts,
        (SELECT count(*)::int FROM audit_events WHERE event_type IN
          ('crm.duplicate_candidate_created','crm.duplicate_merge_approved','crm.duplicate_merge_corrected')) AS audit,
        (SELECT count(*)::int FROM audit_outbox WHERE event_type IN
          ('crm.duplicate_candidate_created','crm.duplicate_merge_approved','crm.duplicate_merge_corrected')) AS outbox
    `);
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) throw new HarnessError("crm04_count_inspection");
    return Object.freeze(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("crm04_count_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

function duplicateDelta(before: DuplicateWorkflowCounts, after: DuplicateWorkflowCounts): DuplicateWorkflowCounts {
  return Object.freeze(Object.fromEntries(Object.keys(before).map((key) => [key,
    after[key as keyof DuplicateWorkflowCounts] - before[key as keyof DuplicateWorkflowCounts],
  ]))) as unknown as DuplicateWorkflowCounts;
}

interface ProfileMaintenanceCounts {
  student_receipts: number;
  guardian_receipts: number;
  audit: number;
  outbox: number;
}

interface ProfileReceiptHashEvidence {
  total: number;
  exact: number;
  request_hash_alias: number;
}

async function readProfileReceiptHashEvidence(
  target: OneRoleBaselineTarget,
): Promise<ProfileReceiptHashEvidence> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
    const result = await client.query<{
      request_hash: string;
      response_hash: string;
      result_reference: string;
    }>(`
      SELECT request_hash, response_hash, result_reference
        FROM shared_idempotency_records
       WHERE operation IN ('crm.update_student_profile','crm.update_guardian_profile')
         AND state = 'completed'
       ORDER BY operation, idempotency_key
    `);
    await client.query("COMMIT");
    let exact = 0;
    let requestHashAlias = 0;
    for (const row of result.rows) {
      const match = /^([0-9a-f-]{36}):(\d{1,16}):(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/i
        .exec(row.result_reference);
      if (!match) throw new HarnessError("crm03_receipt_reference_shape");
      const expected = hashRequestPayload({
        id: match[1]!,
        record_version: Number(match[2]),
        updated_at: match[3]!,
      });
      if (row.response_hash === expected) exact += 1;
      if (row.response_hash === row.request_hash) requestHashAlias += 1;
    }
    return Object.freeze({ total: result.rows.length, exact, request_hash_alias: requestHashAlias });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("crm03_receipt_hash_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

async function readProfileMaintenanceCounts(
  target: OneRoleBaselineTarget,
): Promise<ProfileMaintenanceCounts> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
    const result = await client.query<ProfileMaintenanceCounts>(`
      SELECT
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation = 'crm.update_student_profile') AS student_receipts,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation = 'crm.update_guardian_profile') AS guardian_receipts,
        (SELECT count(*)::int FROM audit_events
          WHERE event_type IN ('crm.student_profile_updated','crm.guardian_profile_updated')) AS audit,
        (SELECT count(*)::int FROM audit_outbox
          WHERE event_type IN ('crm.student_profile_updated','crm.guardian_profile_updated')) AS outbox
    `);
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) throw new HarnessError("crm03_count_inspection");
    return Object.freeze(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("crm03_count_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

function profileDelta(
  before: ProfileMaintenanceCounts,
  after: ProfileMaintenanceCounts,
): ProfileMaintenanceCounts {
  return Object.freeze(Object.fromEntries(Object.keys(before).map((key) => [
    key,
    after[key as keyof ProfileMaintenanceCounts] - before[key as keyof ProfileMaintenanceCounts],
  ]))) as unknown as ProfileMaintenanceCounts;
}

async function prepareProfileMaintenanceFixtures(target: OneRoleBaselineTarget): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
    await client.query("SELECT set_config('app.organization_id',$1,true)", [FOREIGN_ORGANIZATION_ID]);
    await client.query(
      `INSERT INTO access_organizations (id, display_name, status)
       VALUES ($1,'CRM03 Synthetic Foreign Organization','disabled')`,
      [FOREIGN_ORGANIZATION_ID],
    );
    await client.query(
      `INSERT INTO crm_students (id, organization_id, display_name, status)
       VALUES ($1,$2,'CRM03 Synthetic Foreign Student','active')`,
      [FOREIGN_STUDENT_ID, FOREIGN_ORGANIZATION_ID],
    );
    await client.query(
      `INSERT INTO crm_guardians (id, organization_id, display_name, email, status)
       VALUES ($1,$2,'CRM03 Synthetic Foreign Guardian','foreign-guardian@crm03.test.invalid','active')`,
      [FOREIGN_GUARDIAN_ID, FOREIGN_ORGANIZATION_ID],
    );
    await client.query(
      `INSERT INTO crm_student_guardian_relationships
        (id, organization_id, student_id, guardian_id, relationship_type,
         is_legal_guardian, is_primary_contact, is_emergency_contact,
         is_billing_contact, notification_consent, starts_at)
       VALUES ($1,$2,$3,$4,'other_guardian',true,true,false,false,false,transaction_timestamp())`,
      [FOREIGN_RELATIONSHIP_ID, FOREIGN_ORGANIZATION_ID, FOREIGN_STUDENT_ID, FOREIGN_GUARDIAN_ID],
    );
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query(
      `INSERT INTO crm_guardians
        (id, organization_id, display_name, email, status, deletion_requested_at,
         deletion_requested_by_user_id, deletion_reason)
       VALUES ($1,$2,'CRM03 Synthetic Inactive Guardian','inactive-guardian@crm03.test.invalid',
         'pending_delete',transaction_timestamp(),$3,'crm03.local-test')`,
      [INACTIVE_GUARDIAN_ID, NEON_TEST_ORGANIZATION.id, FOUNDER.userId],
    );
    await client.query(
      `INSERT INTO crm_students
        (id, organization_id, display_name, date_of_birth, contact_email, contact_phone, status,
         deletion_requested_at, deletion_requested_by_user_id, deletion_reason,
         purge_approved_at, purge_approved_by_user_id, purged_at, record_version)
       VALUES ($1,$2,NULL,NULL,NULL,NULL,'purged',transaction_timestamp(),$3,NULL,
         transaction_timestamp(),$3,transaction_timestamp(),3)`,
      [PURGED_STUDENT_ID, NEON_TEST_ORGANIZATION.id, FOUNDER.userId],
    );
    await client.query(
      `INSERT INTO crm_guardians
        (id, organization_id, display_name, email, phone, status,
         deletion_requested_at, deletion_requested_by_user_id, deletion_reason,
         purge_approved_at, purge_approved_by_user_id, purged_at, record_version)
       VALUES ($1,$2,NULL,NULL,NULL,'purged',transaction_timestamp(),$3,NULL,
         transaction_timestamp(),$3,transaction_timestamp(),3)`,
      [PURGED_GUARDIAN_ID, NEON_TEST_ORGANIZATION.id, FOUNDER.userId],
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new HarnessError("crm03_fixture_setup");
  } finally {
    await client.end().catch(() => {});
  }
}

async function installProfileUpdateFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    CREATE FUNCTION public.test_crm03_fail_student_update()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
    AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = '57P01'; END; $$;
    CREATE TRIGGER test_crm03_fail_student_update_trg
    BEFORE UPDATE ON public.crm_students
    FOR EACH ROW EXECUTE FUNCTION public.test_crm03_fail_student_update()
  `, "crm03_fault_install");
}

async function removeProfileUpdateFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    DROP TRIGGER IF EXISTS test_crm03_fail_student_update_trg ON public.crm_students;
    DROP FUNCTION IF EXISTS public.test_crm03_fail_student_update()
  `, "crm03_fault_cleanup");
}

async function installDuplicateAuditFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    CREATE FUNCTION public.test_crm04_fail_duplicate_audit()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
    AS $$ BEGIN
      IF NEW.event_type = 'crm.duplicate_candidate_created' THEN
        RAISE EXCEPTION USING ERRCODE = '57P01';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER test_crm04_fail_duplicate_audit_trg
    BEFORE INSERT ON public.audit_events
    FOR EACH ROW EXECUTE FUNCTION public.test_crm04_fail_duplicate_audit()
  `, "crm04_fault_install");
}

async function removeDuplicateAuditFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    DROP TRIGGER IF EXISTS test_crm04_fail_duplicate_audit_trg ON public.audit_events;
    DROP FUNCTION IF EXISTS public.test_crm04_fail_duplicate_audit()
  `, "crm04_fault_cleanup");
}

async function installDeletionAuditFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    CREATE FUNCTION public.test_crm05_fail_deletion_audit()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
    AS $$ BEGIN
      IF NEW.event_type IN ('crm.student_pending_delete_requested',
                            'crm.guardian_pending_delete_requested') THEN
        RAISE EXCEPTION USING ERRCODE = '57P01';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER test_crm05_fail_deletion_audit_trg
    BEFORE INSERT ON public.audit_events
    FOR EACH ROW EXECUTE FUNCTION public.test_crm05_fail_deletion_audit()
  `, "crm05_fault_install");
}

async function removeDeletionAuditFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    DROP TRIGGER IF EXISTS test_crm05_fail_deletion_audit_trg ON public.audit_events;
    DROP FUNCTION IF EXISTS public.test_crm05_fail_deletion_audit()
  `, "crm05_fault_cleanup");
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location")!).pathname, "/today");
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new HarnessError("login_cookie_missing");
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; SameSite=Lax/i);
  assert.doesNotMatch(setCookie, /; Secure/i);
  return setCookie.split(";", 1)[0]!;
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

interface ReferralSourceWorkflowCounts {
  sources: number; assignments: number; source_receipts: number; assignment_receipts: number;
  audit: number; outbox: number; identity_users: number; memberships: number; credentials: number;
  private_matches: number;
}

async function readReferralSourceWorkflowCounts(target: OneRoleBaselineTarget,
  privateValues: readonly string[]): Promise<ReferralSourceWorkflowCounts> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect(); await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
    const result = await client.query<ReferralSourceWorkflowCounts>(`SELECT
      (SELECT count(*)::int FROM crm_referral_sources) AS sources,
      (SELECT count(*)::int FROM cases_case_referral_source_assignments) AS assignments,
      (SELECT count(*)::int FROM shared_idempotency_records WHERE operation IN
        ('crm.referral_source.create','crm.referral_source.update')) AS source_receipts,
      (SELECT count(*)::int FROM shared_idempotency_records WHERE operation=
        'cases.referral_source.assign') AS assignment_receipts,
      (SELECT count(*)::int FROM audit_events WHERE event_type IN
        ('crm.referral_source_created','crm.referral_source_updated','cases.referral_source_assigned')) AS audit,
      (SELECT count(*)::int FROM audit_outbox WHERE event_type IN
        ('crm.referral_source_created','crm.referral_source_updated','cases.referral_source_assigned')) AS outbox,
      (SELECT count(*)::int FROM identity_users) AS identity_users,
      (SELECT count(*)::int FROM access_organization_memberships) AS memberships,
      (SELECT count(*)::int FROM identity_database_test_credentials) AS credentials,
      ((SELECT count(*) FROM audit_events AS event WHERE event.event_type IN
          ('crm.referral_source_created','crm.referral_source_updated','cases.referral_source_assigned')
          AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS private_value
            WHERE event.metadata::text LIKE '%' || private_value || '%')) +
       (SELECT count(*) FROM audit_outbox AS message WHERE message.event_type IN
          ('crm.referral_source_created','crm.referral_source_updated','cases.referral_source_assigned')
          AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS private_value
            WHERE message.payload::text LIKE '%' || private_value || '%')))::int AS private_matches`,
    [privateValues]);
    await client.query("COMMIT");
    const row = result.rows[0]; if (!row) throw new HarnessError("crm06_count_inspection");
    return Object.freeze(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("crm06_count_inspection");
  } finally { await client.end().catch(() => {}); }
}

async function prepareClosedReferralCase(target: OneRoleBaselineTarget, studentId: string) {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect(); await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
    await client.query(`INSERT INTO cases_service_cases
      (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
       primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,record_version)
      VALUES ($1,$2,$3,'CRM06-CLOSED-CASE','k12',2031,'transfer',$4,$5,$6,'advisor','closed',1)`,
    [CRM06_CLOSED_CASE_ID,NEON_TEST_ORGANIZATION.id,studentId,ADVISOR.roleBindingId,
      ADVISOR.membershipId,ADVISOR.userId]);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new HarnessError("crm06_closed_case_fixture");
  } finally { await client.end().catch(() => {}); }
}

async function installCaseReferralSourceInsertFailure(target: OneRoleBaselineTarget) {
  await executeTestDdl(target, `CREATE FUNCTION public.test_crm06_fail_assignment_insert()
    RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
    AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='XX001'; END; $$;
    CREATE TRIGGER test_crm06_fail_assignment_insert_trg
    BEFORE INSERT ON public.cases_case_referral_source_assignments
    FOR EACH ROW EXECUTE FUNCTION public.test_crm06_fail_assignment_insert()`, "crm06_fault_install");
}
async function removeCaseReferralSourceInsertFailure(target: OneRoleBaselineTarget) {
  await executeTestDdl(target, `DROP TRIGGER IF EXISTS test_crm06_fail_assignment_insert_trg
      ON public.cases_case_referral_source_assignments;
    DROP FUNCTION IF EXISTS public.test_crm06_fail_assignment_insert()`, "crm06_fault_cleanup");
}

interface DeletionWorkflowCounts {
  pending_students: number;
  pending_guardians: number;
  student_receipts: number;
  guardian_receipts: number;
  audit: number;
  outbox: number;
  private_matches: number;
}

async function readDeletionWorkflowCounts(
  target: OneRoleBaselineTarget,
  privateValues: readonly string[],
): Promise<DeletionWorkflowCounts> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
    const result = await client.query<DeletionWorkflowCounts>(`
      SELECT
        (SELECT count(*)::int FROM crm_students WHERE status='pending_delete') AS pending_students,
        (SELECT count(*)::int FROM crm_guardians WHERE status='pending_delete') AS pending_guardians,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation='crm.request_student_pending_delete') AS student_receipts,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation='crm.request_guardian_pending_delete') AS guardian_receipts,
        (SELECT count(*)::int FROM audit_events WHERE event_type IN
          ('crm.student_pending_delete_requested','crm.guardian_pending_delete_requested')) AS audit,
        (SELECT count(*)::int FROM audit_outbox WHERE event_type IN
          ('crm.student_pending_delete_requested','crm.guardian_pending_delete_requested')) AS outbox,
        ((SELECT count(*) FROM audit_events AS event
          WHERE event.event_type IN
            ('crm.student_pending_delete_requested','crm.guardian_pending_delete_requested')
            AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS private_value
              WHERE event.metadata::text LIKE '%' || private_value || '%')) +
         (SELECT count(*) FROM audit_outbox AS message
          WHERE message.event_type IN
            ('crm.student_pending_delete_requested','crm.guardian_pending_delete_requested')
            AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS private_value
              WHERE message.payload::text LIKE '%' || private_value || '%')))::int AS private_matches
    `, [privateValues]);
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) throw new HarnessError("crm05_count_inspection");
    return Object.freeze(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("crm05_count_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

function deletionDelta(
  before: DeletionWorkflowCounts,
  after: DeletionWorkflowCounts,
): DeletionWorkflowCounts {
  return Object.freeze(Object.fromEntries(Object.keys(before).map((key) => [
    key,
    after[key as keyof DeletionWorkflowCounts] - before[key as keyof DeletionWorkflowCounts],
  ]))) as unknown as DeletionWorkflowCounts;
}

interface ScopedCounts {
  students: number;
  guardians: number;
  relationships: number;
  idempotency: number;
  audit: number;
  outbox: number;
}

interface GuardianWorkflowCounts {
  relationships: number;
  current_relationships: number;
  closed_relationships: number;
  current_primary: number;
  attach_receipts: number;
  handoff_receipts: number;
  audit: number;
  outbox: number;
}

async function readGuardianWorkflowCounts(
  target: OneRoleBaselineTarget,
  studentId: string,
): Promise<GuardianWorkflowCounts> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [ADVISOR.userId]);
    const result = await client.query<GuardianWorkflowCounts>(`
      SELECT
        (SELECT count(*)::int FROM crm_student_guardian_relationships
          WHERE student_id = $1) AS relationships,
        (SELECT count(*)::int FROM crm_student_guardian_relationships
          WHERE student_id = $1 AND ends_at IS NULL) AS current_relationships,
        (SELECT count(*)::int FROM crm_student_guardian_relationships
          WHERE student_id = $1 AND ends_at IS NOT NULL) AS closed_relationships,
        (SELECT count(*)::int FROM crm_student_guardian_relationships
          WHERE student_id = $1 AND ends_at IS NULL AND is_primary_contact) AS current_primary,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation = 'crm.attach_student_guardian') AS attach_receipts,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation = 'crm.handoff_student_primary_guardian') AS handoff_receipts,
        (SELECT count(*)::int FROM audit_events
          WHERE event_type IN ('crm.student_guardian_relationship_created',
            'crm.student_guardian_primary_handed_off')) AS audit,
        (SELECT count(*)::int FROM audit_outbox
          WHERE event_type IN ('crm.student_guardian_relationship_created',
            'crm.student_guardian_primary_handed_off')) AS outbox
    `, [studentId]);
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) throw new HarnessError("crm02_count_inspection");
    return Object.freeze(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("crm02_count_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

function guardianDelta(
  before: GuardianWorkflowCounts,
  after: GuardianWorkflowCounts,
): GuardianWorkflowCounts {
  return Object.freeze(Object.fromEntries(
    Object.keys(before).map((key) => [
      key,
      after[key as keyof GuardianWorkflowCounts] - before[key as keyof GuardianWorkflowCounts],
    ]),
  )) as unknown as GuardianWorkflowCounts;
}

async function countCurrentGuardianAssignments(
  target: OneRoleBaselineTarget,
  guardianId: string,
): Promise<number> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [ADVISOR.userId]);
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM crm_student_guardian_relationships
        WHERE guardian_id = $1 AND ends_at IS NULL`,
      [guardianId],
    );
    await client.query("COMMIT");
    return result.rows[0]?.count ?? 0;
  } finally {
    await client.end().catch(() => {});
  }
}

async function readScopedCounts(target: OneRoleBaselineTarget): Promise<ScopedCounts> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [ADVISOR.userId]);
    const result = await client.query<ScopedCounts>(`
      SELECT
        (SELECT count(*)::int FROM crm_students) AS students,
        (SELECT count(*)::int FROM crm_guardians) AS guardians,
        (SELECT count(*)::int FROM crm_student_guardian_relationships) AS relationships,
        (SELECT count(*)::int FROM shared_idempotency_records
          WHERE operation = 'crm.create_student_primary_guardian') AS idempotency,
        (SELECT count(*)::int FROM audit_events
          WHERE event_type = 'crm.student_primary_guardian_created') AS audit,
        (SELECT count(*)::int FROM audit_outbox
          WHERE event_type = 'crm.student_primary_guardian_created') AS outbox
    `);
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) throw new HarnessError("crm_count_inspection");
    return Object.freeze(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("crm_count_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

function delta(before: ScopedCounts, after: ScopedCounts): ScopedCounts {
  return Object.freeze(Object.fromEntries(
    Object.keys(before).map((key) => [key, after[key as keyof ScopedCounts] - before[key as keyof ScopedCounts]]),
  )) as unknown as ScopedCounts;
}

async function assertCrossTenantReadsAreEmpty(
  target: OneRoleBaselineTarget,
  studentId: string,
): Promise<void> {
  const pool = new Pool({ ...createOneRoleBaselineClientConfig(target), max: 1 });
  try {
    const repository = new PostgresqlStudentReadRepository(createTenantTransactionRunner(
      pool as unknown as DatabasePool,
      { expectedLoginUser: ONE_ROLE_CANONICAL_ROLE },
    ));
    const service = new StudentReadService(repository);
    const foreignActor: IdentitySessionActor = {
      userId: ADVISOR.userId,
      organizationId: FOREIGN_ORGANIZATION_ID,
      role: "advisor",
      sessionId: "63000000-0000-4000-8000-000000000002",
      capturedSessionVersion: 1,
      reauthenticatedAtMs: null,
    };
    const foreignStudents = await service.listStudents(foreignActor);
    assert.equal(foreignStudents.some(({ id }) => id === studentId), false);
    assert.equal(foreignStudents.every(({ id }) => id === FOREIGN_STUDENT_ID), true);
    assert.equal(await service.findStudent(foreignActor, studentId), null);
    const guardianService = new GuardianRelationshipService(
      new PostgresqlGuardianRelationshipRepository(createTenantTransactionRunner(
        pool as unknown as DatabasePool,
        { expectedLoginUser: ONE_ROLE_CANONICAL_ROLE },
      )),
    );
    await assert.rejects(
      guardianService.listCurrent(foreignActor, studentId),
      (error: unknown) => error instanceof Error &&
        (error as Error & { readonly code?: unknown }).code ===
          "GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND",
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

async function installGuardianInsertFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    CREATE FUNCTION public.test_crm01_fail_guardian_insert()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
    AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = 'XX001'; END; $$;
    CREATE TRIGGER test_crm01_fail_guardian_insert_trg
    BEFORE INSERT ON public.crm_guardians
    FOR EACH ROW EXECUTE FUNCTION public.test_crm01_fail_guardian_insert()
  `, "crm_fault_install");
}

async function removeGuardianInsertFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    DROP TRIGGER IF EXISTS test_crm01_fail_guardian_insert_trg ON public.crm_guardians;
    DROP FUNCTION IF EXISTS public.test_crm01_fail_guardian_insert()
  `, "crm_fault_cleanup");
}

async function installRelationshipInsertFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    CREATE FUNCTION public.test_crm02_fail_relationship_insert()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
    AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = 'XX001'; END; $$;
    CREATE TRIGGER test_crm02_fail_relationship_insert_trg
    BEFORE INSERT ON public.crm_student_guardian_relationships
    FOR EACH ROW EXECUTE FUNCTION public.test_crm02_fail_relationship_insert()
  `, "crm02_fault_install");
}

async function removeRelationshipInsertFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeTestDdl(target, `
    DROP TRIGGER IF EXISTS test_crm02_fail_relationship_insert_trg
      ON public.crm_student_guardian_relationships;
    DROP FUNCTION IF EXISTS public.test_crm02_fail_relationship_insert()
  `, "crm02_fault_cleanup");
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
  const directory = await mkdtemp(join(tmpdir(), "tianxing-crm01-next-dev-"));
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

function readGuardianRelationshipPostgresCode(child: ChildProcess): string | null {
  const logs = DEV_LOGS.get(child);
  if (!logs) throw new HarnessError("next_log_capture");
  const matches = `${logs.stdout}\n${logs.stderr}`.matchAll(
    /(?:^|\n)event=guardian_relationship_postgres_failure postgres_code=(40001|40P01|55P03|57014)(?:\n|$)/g,
  );
  let code: string | null = null;
  for (const match of matches) code = match[1] ?? null;
  return code;
}

function readDeletionReviewPostgresFailure(child: ChildProcess): Readonly<{
  stage: string; postgresCode: string;
}> | null {
  const logs = DEV_LOGS.get(child);
  if (!logs) throw new HarnessError("next_log_capture");
  const matches = `${logs.stdout}\n${logs.stderr}`.matchAll(
    /(?:^|\n)event=deletion_review_postgres_failure stage=(receipt_claim|actor_reauthorization|target_lock|advisor_scope|target_update|effects_append|receipt_complete|transaction_boundary) postgres_code=(08003|08006|23503|23505|23514|40001|40P01|42501|42601|42703|42883|42P01|55P03|57014|57P01|OTHER|NULL)(?:\n|$)/g,
  );
  let result: Readonly<{ stage: string; postgresCode: string }> | null = null;
  for (const match of matches) result = Object.freeze({ stage: match[1]!, postgresCode: match[2]! });
  return result;
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
  readonly code = "CRM01_DEV_HTTP_HARNESS_FAILED" as const;
  readonly stage: string;

  constructor(stage: string) {
    super(`CRM-01 Dev HTTP harness failed at ${stage}.`);
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
