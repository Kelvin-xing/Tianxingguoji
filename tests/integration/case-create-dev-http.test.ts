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

import { CaseWorkspaceService } from "../../modules/cases/application/workspace-service.ts";
import {
  createPostgreSqlAdapter,
  type PostgreSqlAdapter,
  type PostgreSqlQueryResult,
} from "../../modules/cases/infrastructure/postgresql.ts";
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
const FOUNDER = NEON_TEST_PRINCIPALS.find(({ role }) => role === "founder")!;
const ADVISOR = NEON_TEST_PRINCIPALS.find(({ role }) => role === "advisor")!;
const FOREIGN_ORGANIZATION_ID = "64000000-0000-4000-8000-000000000001";
const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

test("CASE-01 works through PostgreSQL 17 and the real local Next Dev HTTP API", {
  timeout: 300_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-case01-pg17-${suffix}`;
  const credentialVolumeName = `tianxing-case01-credential-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const passwords = new Map(NEON_TEST_PRINCIPALS.map((principal) => [
    principal.role,
    randomBytes(32).toString("base64url"),
  ]));
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

    const seed = await seedNeonTestRelease1(target, "apply");
    assert.equal(seed.status, "pass");
    assert.equal(seed.baseline.id, ONE_ROLE_BASELINE_ID);
    assert.equal(seed.baseline.transform_version, ONE_ROLE_TRANSFORM_VERSION);
    assert.equal(seed.baseline.source_migration_count, ONE_ROLE_SOURCE_COUNT);
    assert.equal(seed.baseline.manifest_sha256, manifestSha256);
    await assertAssessmentWriteDependencies(target);
    await assertDirectCaseCreateSucceedsAndRollsBack(target);
    for (const principal of NEON_TEST_PRINCIPALS) {
      assert.equal(await provision(target, principal.email, passwords.get(principal.role)!), "created");
    }

    const httpPort = await reserveLoopbackPort();
    devServer = startNextDev(appDirectory, httpPort, target.connectionString);
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    await waitForNextDev(baseUrl, devServer);

    const cookies = new Map<string, string>();
    for (const principal of NEON_TEST_PRINCIPALS) {
      cookies.set(principal.role, await login(
        baseUrl,
        principal.email,
        passwords.get(principal.role)!,
      ));
    }

    const founderOptions = await readOptions(baseUrl, cookies.get("founder")!);
    const advisorOptions = await readOptions(baseUrl, cookies.get("advisor")!);
    assert.equal(founderOptions.students.length, 2);
    assert.deepEqual(advisorOptions.primaryBindings.map(({ id }) => id), [ADVISOR.roleBindingId]);
    for (const role of ["admin", "data_reviewer", "contractor"] as const) {
      assertApiError(
        await getJson(baseUrl, "/api/v1/cases/options", cookies.get(role)!),
        403,
        "FORBIDDEN",
      );
    }

    const founderBody = createBody(NEON_TEST_STUDENTS[0]!.id, 2027, "transfer", FOUNDER.roleBindingId);
    const founderAdvisorBody = createBody(
      NEON_TEST_STUDENTS[0]!.id, 2028, "transfer", ADVISOR.roleBindingId,
    );
    const advisorBody = createBody(NEON_TEST_STUDENTS[1]!.id, 2027, "s1_admission", ADVISOR.roleBindingId);
    const initialCounts = await readCaseCounts(target);

    const founderCreated = await createCase(
      baseUrl, cookies.get("founder")!, "case01-founder-create", founderBody,
    );
    assertCaseCreated(founderCreated, founderBody);
    const founderAdvisorCreated = await createCase(
      baseUrl, cookies.get("founder")!, "case01-founder-advisor-primary", founderAdvisorBody,
    );
    assertCaseCreated(founderAdvisorCreated, founderAdvisorBody);
    const advisorCreated = await createCase(
      baseUrl, cookies.get("advisor")!, "case01-advisor-create", advisorBody,
    );
    assertCaseCreated(advisorCreated, advisorBody);
    const afterAllowed = await readCaseCounts(target);
    assert.deepEqual(caseDelta(initialCounts, afterAllowed), {
      cases: 3,
      assessments: 3,
      idempotency: 3,
      audit: 3,
      outbox: 3,
    });

    const replay = await createCase(
      baseUrl, cookies.get("founder")!, "case01-founder-create", founderBody,
    );
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body.data, founderCreated.body.data);
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
      createBody(NEON_TEST_STUDENTS[1]!.id, 2031, "transfer", FOUNDER.roleBindingId),
    );
    assertApiError(advisorOtherPrimary, 422, "VALIDATION_FAILED");
    assert.deepEqual(await readCaseCounts(target), afterAllowed);

    for (const role of ["admin", "data_reviewer", "contractor"] as const) {
      const deniedBody = createBody(
        NEON_TEST_STUDENTS[1]!.id,
        role === "admin" ? 2032 : role === "data_reviewer" ? 2033 : 2034,
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

    const founderCase = requiredRecord(founderCreated.body.data?.case);
    const founderCaseId = requiredString(founderCase, "id");
    const founderAdvisorCaseId = requiredString(
      requiredRecord(founderAdvisorCreated.body.data?.case), "id",
    );
    const advisorCaseId = requiredString(requiredRecord(advisorCreated.body.data?.case), "id");
    await assertCaseParentWriteBoundary(target, founderCaseId);
    const founderList = await getJson(baseUrl, "/api/v1/cases", cookies.get("founder")!);
    const advisorList = await getJson(baseUrl, "/api/v1/cases", cookies.get("advisor")!);
    assert.equal(requiredArray(founderList.body.data?.cases).length, 3);
    assert.deepEqual(
      requiredArray(advisorList.body.data?.cases)
        .map((record) => requiredString(record, "id")).sort(),
      [founderAdvisorCaseId, advisorCaseId].sort(),
    );
    for (const role of ["admin", "data_reviewer", "contractor"] as const) {
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
      baseUrl, `/api/v1/cases/${advisorCaseId}`, cookies.get("advisor")!,
    )).response.status, 200);
    for (const role of ["admin", "data_reviewer", "contractor"] as const) {
      assertApiError(
        await getJson(baseUrl, `/api/v1/cases/${founderCaseId}`, cookies.get(role)!),
        403,
        "FORBIDDEN",
      );
    }

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
    assert.equal((await getJson(
      baseUrl, `/api/v1/cases/${founderCaseId}`, founderRelogin,
    )).response.status, 200);

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

    await assertCrossTenantReadsAreEmpty(target, founderCaseId);
    assertDatabaseContract(await inspectBaselineWithNewClient(target), target, manifestSha256);
    assertNoSensitiveDevLogs(devServer, [
      ...NEON_TEST_STUDENTS.map(({ displayName }) => displayName),
      applicationPassword,
      ...passwords.values(),
      "postgresql://",
      "XX001",
      "cases_assessments_pkey",
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
      denied_roles: Object.freeze(["admin", "data_reviewer", "contractor"]),
      case_parent_update_privilege: "id_column_only",
      case_parent_key_share: "pass",
      direct_case_updates: "fail_closed",
      advisor_primary_self_only: true,
      exact_replay: "same_result_no_new_rows",
      changed_payload: "conflict_no_new_rows",
      active_duplicate: "conflict_no_new_rows",
      transaction_failure: "internal_error_full_rollback",
      cross_tenant_read: "empty",
      persisted_after_relogin: true,
      http: Object.freeze({ create: 200, list: 200, detail: 200, forbidden: 403 }),
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

type ApiEnvelope = {
  readonly api_version?: string;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code?: string };
};

function assertCaseCreated(
  result: Readonly<{ response: Response; body: ApiEnvelope }>,
  requestBody: ReturnType<typeof createBody>,
): void {
  assert.equal(result.response.status, 200);
  assert.equal(result.body.api_version, "v1");
  const created = requiredRecord(result.body.data?.case);
  assert.deepEqual(Object.keys(created).sort(), [
    "admissionType", "assessmentId", "caseNumber", "id", "intakeYear",
    "manifestId", "recordVersion", "stage", "studentId",
  ]);
  assert.equal(created.studentId, requestBody.student_id);
  assert.equal(created.intakeYear, requestBody.intake_year);
  assert.equal(created.admissionType, requestBody.admission_type);
  assert.equal(created.manifestId, requestBody.manifest_id);
  assert.equal(created.stage, "signed");
  assert.equal(created.recordVersion, 1);
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
  assert.equal(new URL(response.headers.get("location")!).pathname, "/today");
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new HarnessError("login_cookie_missing");
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; SameSite=Lax/i);
  assert.doesNotMatch(setCookie, /; Secure/i);
  return setCookie.split(";", 1)[0]!;
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
          WHERE operation = 'cases.create_existing_student') AS idempotency,
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
    assert.deepEqual(await service.listCases(actor), []);
    assert.equal(await service.findCase(actor, caseId), null);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function assertDirectCaseCreateSucceedsAndRollsBack(
  target: OneRoleBaselineTarget,
): Promise<void> {
  try {
    await runDirectCaseCreateProbe(target);
  } catch {
    throw new HarnessError("direct_case_create_or_rollback");
  }
}

async function runDirectCaseCreateProbe(
  target: OneRoleBaselineTarget,
): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    const adapter: PostgreSqlAdapter = Object.freeze({
      async transaction<T>(context: Readonly<{ organizationId: string; actorUserId: string }>, work: (
        transaction: { query<Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ): Promise<PostgreSqlQueryResult<Row>> },
      ) => Promise<T>): Promise<T> {
        await client.query("BEGIN");
        try {
          await client.query("SELECT set_config('app.organization_id',$1,true)", [context.organizationId]);
          await client.query("SELECT set_config('app.actor_user_id',$1,true)", [context.actorUserId]);
          return await work({
            async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
              const result = await client.query<Row>(text, values as unknown[] | undefined);
              return Object.freeze({ rows: result.rows, rowCount: result.rowCount ?? result.rows.length });
            },
          });
        } finally {
          await client.query("ROLLBACK").catch(() => {});
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
        primaryRoleBindingId: FOUNDER.roleBindingId,
        manifestId: NEON_TEST_MANIFEST_ID,
        requestId: "case01-direct-transaction-probe",
        idempotencyKey: "case01-direct-transaction-probe",
      },
    });
    assert.deepEqual(await readCaseCounts(target), {
      cases: 0,
      assessments: 0,
      idempotency: 0,
      audit: 0,
      outbox: 0,
    });
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
): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    const acl = await client.query<{
      id_update_granted: boolean;
      table_update_granted: boolean;
      other_column_update_grants: number;
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
          SELECT 1 FROM column_acl
          WHERE attname = 'id' AND privilege_type = 'UPDATE'
            AND grantee = current_user::regrole::oid
        ) AS id_update_granted,
        EXISTS (
          SELECT 1 FROM table_acl
          WHERE privilege_type = 'UPDATE' AND grantee = current_user::regrole::oid
        ) AS table_update_granted,
        (SELECT count(*)::int FROM column_acl
          WHERE attname <> 'id' AND privilege_type = 'UPDATE'
            AND grantee = current_user::regrole::oid) AS other_column_update_grants
    `);
    assert.deepEqual(acl.rows[0], {
      id_update_granted: true,
      table_update_granted: false,
      other_column_update_grants: 0,
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
  await executeCaseParentQuery(target, caseId, "case_parent_stage_update", `
    UPDATE public.cases_service_cases SET stage = stage WHERE id = $1
  `, Object.freeze({ code: "42501" }));
  await executeCaseParentQuery(target, caseId, "case_parent_other_update", `
    UPDATE public.cases_service_cases SET intake_year = intake_year WHERE id = $1
  `, Object.freeze({ code: "42501" }));
}

async function executeCaseParentQuery(
  target: OneRoleBaselineTarget,
  caseId: string,
  stage: string,
  sql: string,
  expectedFailure: Readonly<{ code: string; constraint?: string }> | undefined,
): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
    await client.query(sql, [caseId]);
    if (expectedFailure !== undefined) throw new HarnessError(`${stage}_unexpected_allow`);
    await client.query("ROLLBACK");
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
