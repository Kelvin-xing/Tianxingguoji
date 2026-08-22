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
import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_VERSION,
  verifyCommittedOneRoleBaseline,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  NEON_TEST_ORGANIZATION,
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
const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

test("CRM-01 and CRM-02 work through PostgreSQL 17 and the real local Next Dev HTTP API", {
  timeout: 300_000,
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
    assert.equal(baseline.generated_files, 28);
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
    assert.equal(access.body.data?.policy_version, "release1-bootstrap-v3");
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
    assert.deepEqual(outcomes.map(({ result }) => result.response.status).sort(), [200, 409]);
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
      for (const [path, deniedBody, key] of [
        [`/api/v1/students/${studentId}/guardians/search`, { query: SHARED_GUARDIAN.guardianName }, undefined],
        [`/api/v1/students/${studentId}/guardians`, attachBody, `crm02-denied-attach-${principal.role}`],
        [`/api/v1/students/${studentId}/guardians/primary-handoffs`, winningAttempt.body,
          `crm02-denied-handoff-${principal.role}`],
      ] as const) {
        const denied = await postJson(baseUrl, path, cookie, deniedBody, key);
        assertApiError(denied, 403, "FORBIDDEN");
        assertNoPrivateErrorEcho(denied, [SHARED_GUARDIAN.guardianName, SHARED_GUARDIAN.guardianEmail!]);
      }
    }
    assert.deepEqual(await readGuardianWorkflowCounts(target, studentId), beforeDenied);

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

function assertNoPrivateErrorEcho(
  result: Readonly<{ response: Response; body: ApiEnvelope }>,
  privateValues: readonly string[],
): void {
  const serialized = JSON.stringify(result.body);
  for (const value of privateValues) assert.equal(serialized.includes(value), false);
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

async function getJson(baseUrl: string, path: string, cookie: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
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
    assert.deepEqual(await service.listStudents(foreignActor), []);
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
