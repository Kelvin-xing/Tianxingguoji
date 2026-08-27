import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Client } from "pg";

import {
  NEON_TEST_MANIFEST_ID,
  NEON_TEST_MANIFEST_COMPOSITION_VERSION,
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
  NEON_TEST_SCHOOL_SNAPSHOT_ID,
  NEON_TEST_SCHOOLS,
  NEON_TEST_STUDENTS,
  neonTestSchoolSnapshotManifestSha256,
  loadNeonTestManifestFixture,
} from "../../scripts/db/neon-test-synthetic-fixture.ts";
import {
  runDatabaseTestProvisionCli,
  type DatabaseTestProvisionTarget,
} from "../../scripts/db/provision-database-test-identity.ts";
import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_VERSION,
  verifyCommittedOneRoleBaseline,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  assertOneRoleBaselinePostflight,
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  type OneRoleBaselineDatabaseState,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const FOUNDER = NEON_TEST_PRINCIPALS.find(({ role }) => role === "founder")!;
const ADMIN = NEON_TEST_PRINCIPALS.find(({ role }) => role === "admin")!;
const ADVISOR = NEON_TEST_PRINCIPALS.find(({ role }) => role === "advisor")!;
const SECONDARY_ADVISOR = NEON_TEST_PRINCIPALS.find(({ email }) =>
  email === "advisor-secondary@env01.test.invalid")!;
const CONTRACTOR = NEON_TEST_PRINCIPALS.find(({ role }) => role === "contractor")!;
const STUDENT = NEON_TEST_STUDENTS[0]!;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

type ApiEnvelope = Readonly<{
  readonly api_version?: string;
  readonly data?: Record<string, unknown>;
  readonly error?: Readonly<{ code?: string }>;
}>;
type HttpResult = Readonly<{ response: Response; body: ApiEnvelope }>;

test("P2-BE-04 self-managed PostgreSQL 17 + Next HTTP candidate-list fixture", {
  timeout: 300_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-case04-pg17-${suffix}`;
  const credentialVolumeName = `tianxing-case04-credential-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const advisorPassword = randomBytes(32).toString("base64url");
  const founderPassword = randomBytes(32).toString("base64url");
  const adminPassword = randomBytes(32).toString("base64url");
  const secondaryAdvisorPassword = randomBytes(32).toString("base64url");
  const contractorPassword = randomBytes(32).toString("base64url");
  const appDirectory = await createIsolatedAppDirectory();
  let initDirectory: string | undefined;
  let containerStarted = false;
  let secretVolumeCreated = false;
  let devServer: ChildProcess | undefined;
  try {
    await runDocker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_missing");
    await runDocker(["volume", "create", credentialVolumeName], "postgres_secret_volume_create");
    secretVolumeCreated = true;
    initDirectory = await createPostgresInitDirectory();
    await runDocker([
      "run", "--rm", "--interactive", "--pull=never",
      "--volume", `${credentialVolumeName}:/run/secrets`, POSTGRES_IMAGE,
      "/bin/sh", "-c",
      "umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password",
    ], "postgres_secret_volume_populate", applicationPassword);
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", containerName,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env", "POSTGRES_DB=tianxing", "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/local_postgres_password",
      "--volume", `${credentialVolumeName}:/run/secrets:ro`,
      "--volume", `${initDirectory}:/docker-entrypoint-initdb.d:ro`,
      "--volume", `${resolve("infra/local/postgres/healthcheck.sh")}:/usr/local/bin/tianxing-postgres-healthcheck:ro`,
      "--publish", "127.0.0.1::5432", POSTGRES_IMAGE,
    ], "postgres_container_start");
    containerStarted = true;
    await waitForPostgres(containerName);

    const port = readLoopbackPort((await runDocker(
      ["port", containerName, "5432/tcp"], "postgres_port_inspection",
    )).stdout);
    const target = localTarget(port, applicationPassword);
    const build = await verifyCommittedOneRoleBaseline();
    const manifestSha256 = createHash("sha256").update(build.manifestJson).digest("hex");
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply", target, build, dependencies: baselineDependencies(target),
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.postflight_state, "installed");
    assert.equal(baseline.generated_files, ONE_ROLE_SOURCE_COUNT + 1);
    assertDatabaseContract(await inspectBaseline(target), target, manifestSha256);

    await installDisposablePgcrypto(target, applicationPassword);
    await grantDisposableCandidatePrivileges(target, applicationPassword);
    await seedCandidateFixture(target, applicationPassword);

    await provision(target, ADVISOR.email, advisorPassword);
    await provision(target, FOUNDER.email, founderPassword);
    await provision(target, ADMIN.email, adminPassword);
    await provision(target, SECONDARY_ADVISOR.email, secondaryAdvisorPassword);
    await provision(target, CONTRACTOR.email, contractorPassword);
    const httpPort = await reserveLoopbackPort();
    devServer = startNextDev(appDirectory, httpPort, target.connectionString);
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    await waitForNextDev(baseUrl, devServer);
    const advisorCookie = await login(baseUrl, ADVISOR.email, advisorPassword);
    const founderCookie = await login(baseUrl, FOUNDER.email, founderPassword);
    const adminCookie = await login(baseUrl, ADMIN.email, adminPassword);
    const secondaryAdvisorCookie = await login(
      baseUrl, SECONDARY_ADVISOR.email, secondaryAdvisorPassword,
    );
    const contractorCookie = await login(baseUrl, CONTRACTOR.email, contractorPassword);

    const options = await request(baseUrl, "/api/v1/cases/intake-options", advisorCookie);
    assert.equal(options.response.status, 200);
    const optionData = record(options.body.data);
    assert.ok(Array.isArray(optionData.students));
    assert.ok(Array.isArray(optionData.advisors));
    assert.ok(Array.isArray(optionData.referral_sources));
    assert.ok((optionData.students as unknown[]).length <= 20);

    const createdCase = await request(baseUrl, "/api/v1/cases", advisorCookie, "POST", {
      student_id: STUDENT.id,
      primary_advisor_role_binding_id: ADVISOR.roleBindingId,
      referral_source_id: null,
      intake_year: 2027,
      admission_type: "entry",
      signed_at: "2026-08-27T00:00:00+08:00",
    }, "case04-intake");
    assert.equal(createdCase.response.status, 200);
    const caseReceipt = record(createdCase.body.data);
    assert.deepEqual(Object.keys(caseReceipt).sort(), [
      "assessment_manifest", "assessment_url", "case_id", "record_version",
      "stage", "workflow_status",
    ]);
    const caseId = uuid(caseReceipt.case_id);
    assert.equal(caseReceipt.stage, "background_collection");
    assert.equal(caseReceipt.workflow_status, "active");
    const caseRecordVersion = number(caseReceipt.record_version);

    await completeAssessment(baseUrl, caseId, advisorCookie);
    const revisions = await insertResolvedRevisions(target, applicationPassword);
    await assertOneRolePostfixture(containerName);
    assert.equal(revisions.length, NEON_TEST_SCHOOLS.length);
    const items = NEON_TEST_SCHOOLS.map((school, index) => ({
      ordinal: index + 1,
      school_id: school.id,
      pinned_resolved_revision_id: revisions[index]!.id,
      pinned_resolution_sha256: school.recordSha256,
      application_deadline: `2027-0${index + 4}-15T12:00:00.000Z`,
    }));
    const countsBefore = await readCandidateCounts(target);
    const createdList = await request(
      baseUrl, `/api/v1/cases/${caseId}/candidate-lists`, advisorCookie, "POST", {
        change_summary: "Synthetic P2-BE-04 candidate list",
        expected_case_record_version: caseRecordVersion,
        items,
        previous_version_id: null,
      }, "case04-list-create",
    );
    if (createdList.response.status !== 200) {
      const code = createdList.body.error?.code;
      throw new HarnessError(
        `candidate_list_create_${createdList.response.status}_${code && /^[A-Z_]+$/.test(code) ? code : "error"}`,
      );
    }
    const listReceipt = record(createdList.body.data);
    const versionId = uuid(listReceipt.id);
    assert.equal(number(listReceipt.record_version), 2);

    const approved = await request(
      baseUrl, `/api/v1/cases/${caseId}/candidate-lists/${versionId}/review`, founderCookie,
      "POST", { decision: "approved", expected_record_version: 2, reason: "Founder approved synthetic list" },
      "case04-list-review",
    );
    assert.equal(approved.response.status, 200);
    const approvalData = record(approved.body.data);
    assert.equal(number(approvalData.record_version), 3);
    const founderDecisionHash = string(approvalData.founder_decision_sha256);
    assert.match(founderDecisionHash, /^[0-9a-f]{64}$/);

    const guardianDecidedAt = new Date().toISOString();
    const guardianBody = {
      bound_founder_decision_sha256: founderDecisionHash,
      channel: "in_person",
      decision: "confirmed",
      expected_case_record_version: caseRecordVersion,
      expected_list_record_version: 3,
      guardian_decided_at: guardianDecidedAt,
      guardian_id: STUDENT.guardianId,
      guardian_relationship_id: STUDENT.relationshipId,
    };
    const confirmed = await request(
      baseUrl, `/api/v1/cases/${caseId}/candidate-lists/${versionId}/guardian-decision`, advisorCookie,
      "POST", guardianBody, "case04-guardian-confirm",
    );
    if (confirmed.response.status !== 200) {
      const code = confirmed.body.error?.code;
      throw new HarnessError(
        `guardian_confirm_${confirmed.response.status}_${code && /^[A-Z_]+$/.test(code) ? code : "error"}`,
      );
    }
    const confirmationData = record(confirmed.body.data);
    assert.equal(number(confirmationData.record_version), 4);
    assert.equal(record(confirmationData.automation).application_tasks, "completed", JSON.stringify(confirmationData));
    assert.equal(number(record(confirmationData.automation).requested_count), NEON_TEST_SCHOOLS.length, JSON.stringify(confirmationData));
    assert.equal(number(record(confirmationData.automation).provisioned_count), NEON_TEST_SCHOOLS.length, JSON.stringify(confirmationData));
    const replay = await request(
      baseUrl, `/api/v1/cases/${caseId}/candidate-lists/${versionId}/guardian-decision`, advisorCookie,
      "POST", guardianBody, "case04-guardian-confirm",
    );
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body.data, confirmed.body.data);

    const candidateListPath = `/api/v1/cases/${caseId}/candidate-lists`;
    const advisorRead = await request(baseUrl, candidateListPath, advisorCookie);
    assert.equal(advisorRead.response.status, 200);
    const advisorReadData = record(advisorRead.body.data);
    assert.deepEqual(Object.keys(advisorReadData).sort(),["items","next_cursor"]);
    assert.equal(advisorReadData.next_cursor,null);
    const versions = array(advisorReadData.items).map(record);
    assert.equal(versions.length,1);
    const persistedVersion = versions[0]!;
    assert.equal(persistedVersion.id,versionId);
    assert.equal(number(persistedVersion.version_number),1);
    assert.equal(number(persistedVersion.record_version),4);
    assert.equal(persistedVersion.status,"confirmed");
    assert.equal(array(persistedVersion.items).length,NEON_TEST_SCHOOLS.length);
    assert.equal(record(persistedVersion.founder_approval).decision,"approved");
    assert.equal(record(persistedVersion.founder_approval).decision_sha256,founderDecisionHash);
    assert.equal(record(persistedVersion.guardian_decision).decision,"confirmed");
    assert.equal(record(persistedVersion.guardian_decision).guardian_id,STUDENT.guardianId);
    assert.equal(
      record(persistedVersion.guardian_decision).bound_founder_decision_sha256,
      founderDecisionHash,
    );
    const founderRead = await request(baseUrl, candidateListPath, founderCookie);
    assert.equal(founderRead.response.status,200);
    assert.deepEqual(founderRead.body.data,advisorRead.body.data);
    const nonPrimaryRead = await request(baseUrl,candidateListPath,secondaryAdvisorCookie);
    assert.equal(nonPrimaryRead.response.status,404);
    assert.equal(nonPrimaryRead.body.error?.code,"NOT_FOUND");
    for (const deniedCookie of [adminCookie,contractorCookie]) {
      const denied = await request(baseUrl,candidateListPath,deniedCookie);
      assert.equal(denied.response.status,403);
      assert.equal(denied.body.error?.code,"FORBIDDEN");
    }

    const after = await readCandidateCounts(target);
    assert.equal(after.versions - countsBefore.versions, 1);
    assert.equal(after.items - countsBefore.items, NEON_TEST_SCHOOLS.length);
    assert.equal(after.targets - countsBefore.targets, NEON_TEST_SCHOOLS.length);
    assert.equal(after.audit - countsBefore.audit, 9);
    assert.equal(after.outbox - countsBefore.outbox, 9);
    const caseState = await readCaseState(target, caseId);
    assert.equal(caseState.stage, "application_in_progress");
    assert.equal(caseState.workflow_status, "active");
    assert.notEqual(caseState.workflow_status, "closed");
    assertNoSensitiveDevLogs(devServer, [applicationPassword,advisorPassword,founderPassword,
      adminPassword,secondaryAdvisorPassword,contractorPassword,"postgresql://"]);

    process.stdout.write(`${JSON.stringify({
      status: "pass", scope: "P2-BE-04", postgres_major: 17,
      http: { intake_options: 200,case_create: 200,list_create: 200,founder_approve: 200,
        guardian_confirm: 200,replay: 200,candidate_list_read_advisor: 200,
        candidate_list_read_founder: 200,candidate_list_read_non_primary: 404,
        candidate_list_read_admin: 403,candidate_list_read_contractor: 403 },
      fixture: { synthetic_only: true, authenticated: true, resolved_revisions: revisions.length,
        targets: after.targets - countsBefore.targets, audit: after.audit - countsBefore.audit,
        outbox: after.outbox - countsBefore.outbox },
    })}\n`);
  } finally {
    await stopNextDev(devServer);
    await rm(appDirectory, { recursive: true, force: true });
    if (initDirectory) await rm(initDirectory, { recursive: true, force: true });
    if (containerStarted) await runDocker(["rm", "--force", containerName], "postgres_container_cleanup");
    if (secretVolumeCreated) await runDocker(["volume", "rm", "--force", credentialVolumeName], "postgres_secret_cleanup");
  }
});

async function completeAssessment(baseUrl: string, caseId: string, cookie: string): Promise<void> {
  const view = await request(baseUrl, `/api/v1/cases/${caseId}/assessment`, cookie);
  assert.equal(view.response.status, 200);
  const data = record(view.body.data);
  const schema = record(data.schema);
  const fields = array(schema.fields).map(record);
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const fieldId = string(field.field_id);
    const valueType = string(field.value_type);
    const enumValues = Array.isArray(field.enum_values) ? field.enum_values : [];
    const value = valueForField(valueType, enumValues, index);
    const result = await request(baseUrl, `/api/v1/cases/${caseId}/assessment`, cookie, "PATCH", {
      expected_record_version: 0, field_id: fieldId, semantic_state: "provided",
      value: { type: valueType, value }, value_type: valueType,
    }, `case04-assessment-${index}`);
    assert.equal(result.response.status, 200);
  }
  const completed = await request(
    baseUrl, `/api/v1/cases/${caseId}/assessment/background-completion`, cookie, "POST",
    { expected_record_version: 1 }, "case04-assessment-complete",
  );
  if (completed.response.status !== 200) {
    const code = completed.body.error?.code;
    throw new HarnessError(
      `assessment_complete_${completed.response.status}_${code && /^[A-Z_]+$/.test(code) ? code : "error"}`,
    );
  }
}

function valueForField(valueType: string, enumValues: readonly unknown[], index: number): string | number | readonly string[] {
  switch (valueType) {
    case "date": return "2014-03-12";
    case "integer": return index + 1;
    case "enum": return typeof enumValues[0] === "string" ? enumValues[0] : "unknown";
    case "enum_set": return [typeof enumValues[0] === "string" ? enumValues[0] : "unknown"];
    default: return `synthetic-case04-${index}`;
  }
}

async function insertResolvedRevisions(
  target: OneRoleBaselineTarget,
  password: string,
): Promise<readonly { id: string }[]> {
  const client = new Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: "postgres",
    password,
    ssl: false,
    application_name: "tianxing-p2-be-04-resolved-fixture",
  });
  try {
    await client.connect();
    const result: { id: string }[] = [];
    for (const school of NEON_TEST_SCHOOLS) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO schools_resolved_revisions
          (id, organization_id, school_id, base_snapshot_id, overlay_revision_id,
           resolution_sha256, fields_json, provenance_json, conflicts_json, created_at)
         VALUES ($1,$2,$3,$4,NULL,$5,$6::jsonb,$7::jsonb,'[]'::jsonb,transaction_timestamp())`,
        [id, NEON_TEST_ORGANIZATION.id, school.id, NEON_TEST_SCHOOL_SNAPSHOT_ID,
          school.recordSha256, JSON.stringify(school.fields), JSON.stringify(school.provenance)],
      );
      result.push({ id });
    }
    await client.query("ALTER ROLE postgres NOLOGIN");
    return Object.freeze(result);
  } catch (error) {
    const constraint = postgresConstraint(error);
    throw new HarnessError(`resolved_revision_fixture_${postgresCode(error)}${constraint ? `_${constraint}` : ""}`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function seedCandidateFixture(target: OneRoleBaselineTarget, password: string): Promise<void> {
  const client = controlClient(target, password);
  let stage = "connect";
  try {
    const fixture = await loadNeonTestManifestFixture();
    const founder = NEON_TEST_PRINCIPALS.find(({ role }) => role === "founder")!;
    await client.connect();
    await client.query("SELECT set_config('app.organization_id',$1,false)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,false)", [founder.userId]);
    await client.query("BEGIN");
    stage = "identity";
    for (const principal of NEON_TEST_PRINCIPALS) {
      await client.query(
        `INSERT INTO identity_users
          (id, normalized_email, status, activated_at, created_by_user_id)
         VALUES ($1,$2,'active',transaction_timestamp(),$3)`,
        [principal.userId, principal.email, principal.role === "founder" ? null : founder.userId],
      );
    }
    stage = "organization";
    await client.query(
      `INSERT INTO access_organizations (id, display_name, status, created_by_user_id)
       VALUES ($1,$2,'active',$3)`,
      [NEON_TEST_ORGANIZATION.id, "P2-BE-04 synthetic organization", founder.userId],
    );
    stage = "memberships";
    for (const principal of NEON_TEST_PRINCIPALS) {
      await client.query(
        `INSERT INTO access_organization_memberships
          (id, organization_id, user_id, status, activated_at, created_by_user_id)
         VALUES ($1,$2,$3,'active',transaction_timestamp(),$4)`,
        [principal.membershipId, NEON_TEST_ORGANIZATION.id, principal.userId, founder.userId],
      );
      await client.query(
        `INSERT INTO access_role_bindings
          (id, organization_id, membership_id, user_id, role, status, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,'active',$6)`,
        [principal.roleBindingId, NEON_TEST_ORGANIZATION.id, principal.membershipId,
          principal.userId, principal.role, founder.userId],
      );
    }
    stage = "crm";
    for (const student of NEON_TEST_STUDENTS) {
      await client.query(
        `INSERT INTO crm_students
          (id, organization_id, display_name, date_of_birth, contact_email, contact_phone, status)
         VALUES ($1,$2,$3,$4,$5,$6,'active')`,
        [student.id, NEON_TEST_ORGANIZATION.id, student.displayName, student.dateOfBirth,
          student.contactEmail, student.contactPhone],
      );
      await client.query(
        `INSERT INTO crm_guardians (id, organization_id, display_name, email, phone, status)
         VALUES ($1,$2,$3,$4,$5,'active')`,
        [student.guardianId, NEON_TEST_ORGANIZATION.id, student.guardianName,
          student.guardianEmail, student.guardianPhone],
      );
      await client.query(
        `INSERT INTO crm_student_guardian_relationships
          (id, organization_id, student_id, guardian_id, relationship_type,
           is_legal_guardian, is_primary_contact, is_emergency_contact,
           is_billing_contact, notification_consent, starts_at)
         VALUES ($1,$2,$3,$4,'parent',true,true,true,false,true,transaction_timestamp())`,
        [student.relationshipId, NEON_TEST_ORGANIZATION.id, student.id, student.guardianId],
      );
    }
    stage = "manifest_insert";
    const layers = fixture.modulesByLayer;
    await client.query(
      `INSERT INTO cases_schema_manifests
        (id, application_type, composition_version, base_module_id, base_module_version,
         education_stage_module_id, education_stage_module_version, school_system_module_id,
         school_system_module_version, admission_route_module_id, admission_route_module_version,
         content_sha256, status)
       VALUES ($1,'k12',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'candidate')`,
      [NEON_TEST_MANIFEST_ID, NEON_TEST_MANIFEST_COMPOSITION_VERSION,
        layers.get("base")!.moduleId, layers.get("base")!.version,
        layers.get("education_stage")!.moduleId, layers.get("education_stage")!.version,
        layers.get("school_system")!.moduleId, layers.get("school_system")!.version,
        layers.get("admission_route")!.moduleId, layers.get("admission_route")!.version,
        fixture.contentSha256],
    );
    stage = "manifest_fields";
    for (const field of fixture.fields) {
      await client.query(
        `INSERT INTO cases_schema_manifest_fields
          (manifest_id, module_layer, module_id, module_version, field_id,
           value_type, visibility, blocking_stages)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [NEON_TEST_MANIFEST_ID, field.moduleLayer, field.moduleId, field.moduleVersion,
          field.fieldId, field.valueType, field.visibility, JSON.stringify(field.blockingStages)],
      );
    }
    stage = "manifest_approve";
    await client.query(
      `UPDATE cases_schema_manifests
          SET status='approved', approved_by_user_id=$2,
              approved_at=transaction_timestamp(), updated_at=transaction_timestamp()
        WHERE id=$1 AND status='candidate'`,
      [NEON_TEST_MANIFEST_ID, founder.userId],
    );
    stage = "schools";
    for (const school of NEON_TEST_SCHOOLS) {
      await client.query(
        `INSERT INTO schools_schools (id, organization_id, source_school_key, record_version)
         VALUES ($1,$2,$3,1)`,
        [school.id, NEON_TEST_ORGANIZATION.id, school.sourceSchoolKey],
      );
    }
    await client.query(
      `INSERT INTO schools_snapshots
        (id, organization_id, source_release_id, manifest_sha256, file_set_json, status, record_count)
       VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6)`,
      ["51000000-0000-4000-8000-000000000902", NEON_TEST_ORGANIZATION.id,
        "env01-synthetic-schools-v1", neonTestSchoolSnapshotManifestSha256(),
        JSON.stringify({ kind: "p2_be_04_test", version: 1 }), NEON_TEST_SCHOOLS.length],
    );
    for (const school of NEON_TEST_SCHOOLS) {
      await client.query(
        `INSERT INTO schools_snapshot_records
          (id, organization_id, snapshot_id, school_id, source_school_key,
           fields_json, provenance_json, record_sha256)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [school.recordId, NEON_TEST_ORGANIZATION.id, "51000000-0000-4000-8000-000000000902",
          school.id, school.sourceSchoolKey, JSON.stringify(school.fields),
          JSON.stringify(school.provenance), school.recordSha256],
      );
    }
    stage = "commit";
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError(`candidate_fixture_seed_${stage}_${postgresCode(error)}`);
  } finally {
    await client.end().catch(() => {});
  }
}

function postgresCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown";
}

function postgresConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === "string" && /^[a-z0-9_]{1,64}$/.test(constraint)
    ? constraint
    : null;
}

function controlClient(target: OneRoleBaselineTarget, password: string): Client {
  return new Client({
    ...createOneRoleBaselineClientConfig(target),
    application_name: "tianxing-p2-be-04-fixture",
  });
}

async function readCandidateCounts(target: OneRoleBaselineTarget): Promise<Readonly<{ versions: number; items: number; targets: number; audit: number; outbox: number; preparing: number; requestedAudit: number; requestedOutbox: number }>> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("SELECT set_config('app.organization_id',$1,false)", [NEON_TEST_ORGANIZATION.id]);
    const result = await client.query<{ versions: string; items: string; targets: string; audit: string; outbox: string; preparing: string; requested_audit: string; requested_outbox: string }>(
      `SELECT
         (SELECT count(*)::text FROM cases_candidate_school_list_versions WHERE organization_id=$1) AS versions,
         (SELECT count(*)::text FROM cases_candidate_school_list_items WHERE organization_id=$1) AS items,
         (SELECT count(*)::text FROM cases_school_targets WHERE organization_id=$1) AS targets,
         (SELECT count(*)::text FROM audit_events WHERE organization_id=$1) AS audit,
         (SELECT count(*)::text FROM audit_outbox WHERE organization_id=$1) AS outbox,
         (SELECT count(*)::text FROM cases_school_targets WHERE organization_id=$1 AND state='preparing') AS preparing,
         (SELECT count(*)::text FROM audit_events WHERE organization_id=$1 AND event_type='cases.application_task_requested') AS requested_audit,
         (SELECT count(*)::text FROM audit_outbox WHERE organization_id=$1 AND event_type='cases.application_task_requested') AS requested_outbox`,
      [NEON_TEST_ORGANIZATION.id],
    );
    const row = result.rows[0];
    if (!row) throw new HarnessError("candidate_counts");
    return Object.freeze({ versions: Number(row.versions), items: Number(row.items), targets: Number(row.targets), audit: Number(row.audit), outbox: Number(row.outbox), preparing: Number(row.preparing), requestedAudit: Number(row.requested_audit), requestedOutbox: Number(row.requested_outbox) });
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("candidate_counts");
  } finally { await client.end().catch(() => {}); }
}

async function installDisposablePgcrypto(
  target: OneRoleBaselineTarget,
  password: string,
): Promise<void> {
  const client = new Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: "postgres",
    password,
    ssl: false,
    application_name: "tianxing-p2-be-04-pgcrypto-fixture",
  });
  try {
    await client.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
  } catch (error) {
    throw new HarnessError(`postgres_pgcrypto_fixture_${postgresCode(error)}`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function grantDisposableCandidatePrivileges(
  target: OneRoleBaselineTarget,
  password: string,
): Promise<void> {
  const client = new Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: "postgres",
    password,
    ssl: false,
    application_name: "tianxing-p2-be-04-privilege-fixture",
  });
  try {
    await client.connect();
    await client.query("GRANT SELECT, INSERT ON TABLE cases_candidate_school_list_versions TO tianxing_app");
    await client.query(`GRANT UPDATE (
      status, submitted_at, founder_decision, founder_decided_by_user_id, founder_decided_at,
      founder_decision_reason, founder_decision_sha256, guardian_id,
      guardian_relationship_id, guardian_decision, guardian_decided_at,
      guardian_confirmation_channel, guardian_recorded_by_user_id,
      guardian_recorded_at, guardian_bound_founder_decision_sha256,
      record_version, updated_at
    ) ON TABLE cases_candidate_school_list_versions TO tianxing_app`);
    await client.query("GRANT SELECT, INSERT ON TABLE cases_candidate_school_list_items TO tianxing_app");
    await client.query("GRANT UPDATE (school_target_id) ON TABLE cases_candidate_school_list_items TO tianxing_app");
    await client.query("GRANT INSERT ON TABLE cases_school_targets TO tianxing_app");
    await client.query("GRANT SELECT ON TABLE schools_resolved_revisions TO tianxing_app");
  } catch (error) {
    throw new HarnessError(`candidate_privilege_fixture_${postgresCode(error)}`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function readCaseState(target: OneRoleBaselineTarget, caseId: string): Promise<Readonly<{ stage: string; workflow_status: string }>> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("SELECT set_config('app.organization_id',$1,false)", [NEON_TEST_ORGANIZATION.id]);
    const result = await client.query<{ stage: string; workflow_status: string }>(
      "SELECT stage, workflow_status FROM cases_service_cases WHERE id=$1 AND organization_id=$2",
      [caseId, NEON_TEST_ORGANIZATION.id],
    );
    const row = result.rows[0];
    if (!row) throw new HarnessError("case_state");
    return Object.freeze({ stage: row.stage, workflow_status: row.workflow_status });
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("case_state");
  } finally { await client.end().catch(() => {}); }
}

async function request(baseUrl: string, path: string, cookie: string, method = "GET", body?: unknown, key?: string): Promise<HttpResult> {
  const headers = new Headers({ cookie });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (key !== undefined) headers.set("idempotency-key", key);
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }), redirect: "manual",
  });
  if (response.status !== 303) throw new HarnessError("login_status");
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
  if (!setCookie) {
    const location = response.headers.get("location");
    const errorCode = location ? new URL(location).searchParams.get("error") : null;
    throw new HarnessError(`login_cookie_${errorCode && /^[a-z_]+$/.test(errorCode) ? errorCode : "missing"}`);
  }
  return setCookie.split(";", 1)[0]!;
}

async function provision(target: OneRoleBaselineTarget, email: string, password: string): Promise<void> {
  await runDatabaseTestProvisionCli({
    arguments: ["--password-stdin", `--email=${email}`],
    inputStream: streamOf(Buffer.from(`${password}\n`)),
    readTarget: () => Object.freeze({
      connectionString: target.connectionString, loginUser: target.user, databaseName: target.database,
      connectionTimeoutMs: 5_000, statementTimeoutMs: 10_000, ssl: false,
    }) satisfies DatabaseTestProvisionTarget,
  });
}

async function* streamOf(chunk: Buffer): AsyncIterable<Buffer> { yield chunk; }

function baselineDependencies(target: OneRoleBaselineTarget) {
  return {
    inspect: () => inspectBaseline(target),
    openExecutionConnection: async () => {
      const client = new Client(createOneRoleBaselineClientConfig(target));
      await client.connect();
      return Object.freeze({ client, close: () => client.end() });
    },
  };
}

async function inspectBaseline(target: OneRoleBaselineTarget): Promise<OneRoleBaselineDatabaseState> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try { await client.connect(); return await inspectOneRoleBaselineDatabase(client); }
  catch { throw new HarnessError("baseline_inspection"); }
  finally { await client.end().catch(() => {}); }
}

function assertDatabaseContract(state: OneRoleBaselineDatabaseState, target: OneRoleBaselineTarget, manifestSha256: string): void {
  assertOneRoleBaselinePostflight({ state, target, mode: "apply", manifestSha256 });
  assert.equal(state.marker?.baselineId, ONE_ROLE_BASELINE_ID);
  assert.equal(state.marker?.transformVersion, ONE_ROLE_TRANSFORM_VERSION);
  assert.equal(state.marker?.sourceMigrationCount, ONE_ROLE_SOURCE_COUNT);
  assert.equal(state.marker?.manifestSha256, manifestSha256);
  assert.equal(state.userName, ONE_ROLE_CANONICAL_ROLE);
  assert.equal(state.databaseOwner, ONE_ROLE_CANONICAL_ROLE);
  assert.equal(state.login, true);
  assert.equal(state.superuser, false);
  assert.equal(state.bypassRls, false);
}

async function createIsolatedAppDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tianxing-case04-next-dev-"));
  try {
    const excluded = new Set([".git", ".next", "node_modules"]);
    for (const entry of await readdir(process.cwd())) {
      if (excluded.has(entry) || entry.startsWith(".env") || entry === ".DS_Store") continue;
      await cp(resolve(entry), join(directory, entry), { recursive: true });
    }
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    return directory;
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new HarnessError("next_workspace_setup");
  }
}

async function createPostgresInitDirectory(): Promise<string> {
  const directory = await mkdtemp(join(resolve("tests/integration"), ".p2-be-04-pg-init-"));
  try {
    const source = resolve("infra/local/postgres/init");
    for (const entry of await readdir(source)) {
      if (entry === "001-local-roles.sh") continue;
      await cp(join(source, entry), join(directory, entry), { recursive: true });
    }
    await cp(
      resolve("tests/integration/fixtures/p2-be-04-local-roles.sh"),
      join(directory, "001-local-roles.sh"),
    );
    return directory;
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new HarnessError("postgres_init_fixture");
  }
}

function startNextDev(directory: string, port: number, connectionString: string): ChildProcess {
  const child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
      NEXT_TELEMETRY_DISABLED: "1", APP_ENV: "development", NODE_ENV: "development",
      APP_RUNTIME_MODE: "local-synthetic", AUTH_MODE: "database-test",
      LOCAL_SYNTHETIC_DATABASE_URL: connectionString,
      LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { logs.stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { logs.stderr += chunk; });
  DEV_LOGS.set(child, logs);
  return child;
}

function assertNoSensitiveDevLogs(child: ChildProcess, values: readonly string[]): void {
  const logs = DEV_LOGS.get(child);
  if (!logs) throw new HarnessError("next_log_capture");
  const output = `${logs.stdout}\n${logs.stderr}`;
  if (values.some((value) => value && output.includes(value))) throw new HarnessError("next_log_privacy");
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new HarnessError("next_dev_early_exit");
    try {
      const response = await fetch(`${baseUrl}/api/v1/auth/me`);
      if (response.status === 401) return;
    } catch { /* readiness retry */ }
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
      server.close((error) => error || port < 1 ? reject(new HarnessError("next_port_reservation")) : resolvePort(port));
    });
  });
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await runDocker([
      "exec", containerName, "/bin/sh", "-c",
      "PGPASSWORD=\"$(cat /run/secrets/local_postgres_password)\" psql --host=127.0.0.1 --username=tianxing_app --dbname=tianxing --no-psqlrc --command='SELECT 1'",
    ], "postgres_readiness", undefined, process.env, true);
    if (result.exitCode === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new HarnessError("postgres_readiness_timeout");
}

async function assertOneRolePostfixture(containerName: string): Promise<void> {
  const result = await runDocker(
    ["exec", containerName, "/bin/sh", "/usr/local/bin/tianxing-postgres-healthcheck"],
    "postgres_postfixture_contract",
    undefined,
    process.env,
    true,
  );
  if (result.exitCode !== 0) throw new HarnessError("postgres_postfixture_contract");
}

function readLoopbackPort(output: string): number {
  const port = Number(/^127\.0\.0\.1:([0-9]+)\s*$/.exec(output)?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new HarnessError("postgres_port_inspection");
  return port;
}

function localTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({ connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`, host: "127.0.0.1", port, database: "tianxing", user: ONE_ROLE_CANONICAL_ROLE, ssl: false });
}

async function runDocker(arguments_: readonly string[], stage: string, input?: string, environment: NodeJS.ProcessEnv = process.env, allowFailure = false): Promise<Readonly<{ exitCode: number; stdout: string }>> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("docker", arguments_, { cwd: process.cwd(), env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", () => {});
    child.once("error", () => reject(new HarnessError(stage)));
    child.once("close", (code) => { const exitCode = code ?? 1; if (exitCode !== 0 && !allowFailure) reject(new HarnessError(stage)); else resolveRun(Object.freeze({ exitCode, stdout })); });
    child.stdin.end(input);
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HarnessError("http_response_shape");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new HarnessError("http_response_shape"); return value; }
function string(value: unknown): string { if (typeof value !== "string") throw new HarnessError("http_response_shape"); return value; }
function number(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new HarnessError("http_response_shape"); return value; }
function uuid(value: unknown): string { const result = string(value); if (!UUID.test(result)) throw new HarnessError("http_response_uuid"); return result; }

class HarnessError extends Error {
  readonly stage: string;

  constructor(stage: string) {
    super(`P2-BE-04 local HTTP fixture failed at ${stage}.`);
    this.name = "P2Be04HarnessError";
    this.stage = stage;
  }
}
