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

import {
  DocumentWorkspaceService,
  isDocumentWorkspaceError,
} from "../../modules/documents/application/workspace-service.ts";
import { PostgresqlDocumentWorkspaceRepository } from "../../modules/documents/infrastructure/postgresql-workspace-repository.ts";
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
const FOUNDER = principal("founder");
const ADVISOR = principal("advisor");
const CLOSED_CASE_ID = "82000000-0000-4000-8000-000000000001";
const CLOSED_DOCUMENT_ID = "82000000-0000-4000-8000-000000000002";
const OPAQUE_NOT_VISIBLE_ORGANIZATION_ID = "82000000-0000-4000-8000-000000000105";
const OPAQUE_NOT_VISIBLE_CASE_ID = "82000000-0000-4000-8000-000000000106";
const OPAQUE_NOT_VISIBLE_DOCUMENT_ID = "82000000-0000-4000-8000-000000000107";
const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

type Role = "founder" | "advisor" | "admin" | "data_reviewer" | "contractor";
type Envelope = { readonly data?: unknown; readonly error?: { readonly code?: string } };
type HttpResult = Readonly<{ response: Response; body: Envelope }>;

test("DOC-01 works through PostgreSQL 17 and the real local Next Dev HTTP API", {
  timeout: 360_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-doc01-http-pg17-${suffix}`;
  const volumeName = `tianxing-doc01-http-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const passwords = new Map<Role, string>(NEON_TEST_PRINCIPALS.map((value) => [
    value.role as Role,
    randomBytes(32).toString("base64url"),
  ]));
  let stage = "postgres_image";
  let containerStarted = false;
  let volumeCreated = false;
  let appDirectory = "";
  let devServer: ChildProcess | undefined;
  let failureStage: string | null = null;
  const cleanup = { dev_stopped: false, app_removed: false, container_removed: false, volume_removed: false };
  const evidence: Record<string, unknown> = {};

  try {
    await runDocker(["image", "inspect", POSTGRES_IMAGE], stage);
    stage = "postgres_setup";
    await runDocker(["volume", "create", volumeName], stage);
    volumeCreated = true;
    await runDocker([
      "run", "--rm", "--interactive", "--pull=never",
      "--volume", `${volumeName}:/run/secrets`, POSTGRES_IMAGE,
      "/bin/sh", "-c",
      "umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password",
    ], stage, applicationPassword);
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", containerName,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env", "POSTGRES_DB=tianxing", "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/local_postgres_password",
      "--volume", `${volumeName}:/run/secrets:ro`,
      "--volume", `${resolve("infra/local/postgres/init")}:/docker-entrypoint-initdb.d:ro`,
      "--volume", `${resolve("infra/local/postgres/healthcheck.sh")}:/usr/local/bin/tianxing-postgres-healthcheck:ro`,
      "--publish", "127.0.0.1::5432", POSTGRES_IMAGE,
    ], stage);
    containerStarted = true;
    await waitForPostgres(containerName);
    const port = readLoopbackPort((await runDocker(["port", containerName, "5432/tcp"], stage)).stdout);
    const target = localTarget(port, applicationPassword);

    stage = "baseline_seed";
    const build = await verifyCommittedOneRoleBaseline();
    const manifestSha256 = createHash("sha256").update(build.manifestJson).digest("hex");
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply",
      target,
      build,
      dependencies: baselineDependencies(target),
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.generated_files, 36);
    assertDatabaseContract(await inspectBaselineWithNewClient(target), target, manifestSha256);
    assert.equal((await seedNeonTestRelease1(target, "apply")).status, "pass");

    stage = "identity_provision";
    for (const value of NEON_TEST_PRINCIPALS) {
      assert.equal(await provision(target, value.email, passwords.get(value.role as Role)!), "created");
    }
    const identityBefore = await readIdentityCounts(target);

    stage = "next_dev";
    appDirectory = await createIsolatedAppDirectory();
    const httpPort = await reserveLoopbackPort();
    devServer = startNextDev(appDirectory, httpPort, target.connectionString);
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    await waitForNextDev(baseUrl, devServer);

    stage = "login";
    const cookies = new Map<Role, string>();
    for (const value of NEON_TEST_PRINCIPALS) {
      const role = value.role as Role;
      const cookie = await login(baseUrl, value.email, passwords.get(role)!);
      cookies.set(role, cookie);
      assert.equal((await getJson(baseUrl, "/api/v1/auth/me", cookie)).response.status, 200);
    }

    stage = "founder_case";
    const founderCaseId = await createCase(baseUrl, cookies.get("founder")!,
      NEON_TEST_STUDENTS[0]!.id, ADVISOR.roleBindingId, 2051, "doc01-founder-case");
    stage = "advisor_case";
    const advisorCaseId = await createCase(baseUrl, cookies.get("advisor")!,
      NEON_TEST_STUDENTS[1]!.id, ADVISOR.roleBindingId, 2052, "doc01-advisor-case");
    stage = "closed_fixture";
    await insertClosedFixture(target);
    const beforeDocuments = await readDocumentCounts(target);

    stage = "strict_contract";
    assertApiError(await getJson(baseUrl, "/api/v1/documents?status=active", cookies.get("founder")!), 422, "VALIDATION_FAILED");
    for (const body of [
      { display_name: "", classification: "identity_and_case_evidence" },
      { display_name: " padded", classification: "identity_and_case_evidence" },
      { display_name: "x".repeat(201), classification: "identity_and_case_evidence" },
      { display_name: "Synthetic invalid", classification: "temporary_upload" },
      { display_name: "Synthetic invalid", classification: "operational_attachment", owner_kind: "case" },
    ]) {
      const invalid = await postDocument(baseUrl, cookies.get("founder")!, founderCaseId,
        `doc01-invalid-${randomBytes(4).toString("hex")}`, body);
      assertApiError(invalid, 422, "VALIDATION_FAILED");
      assertNoPrivateEcho(invalid, Object.values(body).map(String));
    }
    assert.deepEqual(await readDocumentCounts(target), beforeDocuments);

    stage = "founder_idempotency";
    const founderName = "Synthetic DOC-01 Founder Evidence";
    const founderBody = { display_name: founderName, classification: "identity_and_case_evidence" };
    const concurrent = await Promise.all([
      postDocument(baseUrl, cookies.get("founder")!, founderCaseId, "doc01-founder", founderBody),
      postDocument(baseUrl, cookies.get("founder")!, founderCaseId, "doc01-founder", founderBody),
    ]);
    const founderReceipts = concurrent.map(assertAcknowledgement);
    assert.deepEqual(founderReceipts[0], founderReceipts[1]);
    const founderReplay = assertAcknowledgement(await postDocument(
      baseUrl, cookies.get("founder")!, founderCaseId, "doc01-founder", founderBody,
    ));
    assert.deepEqual(founderReplay, founderReceipts[0]);
    const changed = await postDocument(baseUrl, cookies.get("founder")!, founderCaseId,
      "doc01-founder", { ...founderBody, classification: "operational_attachment" });
    assertApiError(changed, 409, "CONFLICT");
    assertNoPrivateEcho(changed, [founderName]);

    stage = "authoritative_reads";
    const founderDetail = await getJson(baseUrl,
      `/api/v1/cases/${founderCaseId}/documents/${founderReceipts[0]!.id}`,
      cookies.get("founder")!);
    assert.equal(founderDetail.response.status, 200);
    const founderItem = assertDetail(founderDetail, founderCaseId, founderName);
    assert.equal(founderItem.record_version, 1);
    assert.equal(founderItem.latest_version_state, null);
    assert.equal(founderItem.has_active_version, false);
    const caseList = assertCollection(await getJson(baseUrl,
      `/api/v1/cases/${founderCaseId}/documents`, cookies.get("founder")!));
    assert.equal(caseList.length, 1);

    stage = "advisor_registration";
    const advisorName = "Synthetic DOC-01 Advisor Evidence";
    const advisorReceipt = assertAcknowledgement(await postDocument(
      baseUrl, cookies.get("advisor")!, advisorCaseId, "doc01-advisor",
      { display_name: advisorName, classification: "operational_attachment" },
    ));
    assert.equal(assertDetail(await getJson(baseUrl,
      `/api/v1/cases/${advisorCaseId}/documents/${advisorReceipt.id}`,
      cookies.get("advisor")!), advisorCaseId, advisorName).classification,
    "operational_attachment");
    assertApiError(await getJson(baseUrl, `/api/v1/cases/${founderCaseId}/documents`,
      cookies.get("advisor")!), 404, "NOT_FOUND");
    assertApiError(await postDocument(baseUrl, cookies.get("advisor")!, founderCaseId,
      "doc01-unassigned", { display_name: "Synthetic invisible", classification: "operational_attachment" }),
    404, "NOT_FOUND");

    stage = "denied_roles";
    for (const role of ["admin", "data_reviewer", "contractor"] as const) {
      assertApiError(await getJson(baseUrl, "/api/v1/documents", cookies.get(role)!), 403, "FORBIDDEN");
      const denied = await postDocument(baseUrl, cookies.get(role)!, founderCaseId,
        `doc01-denied-${role}`, { display_name: "Synthetic denied", classification: "operational_attachment" });
      assertApiError(denied, 403, "FORBIDDEN");
      assertNoPrivateEcho(denied, ["Synthetic denied"]);
    }
    assertApiError(await getJson(baseUrl, "/api/v1/documents", ""), 401, "UNAUTHENTICATED");

    stage = "closed_case";
    const closedList = assertCollection(await getJson(baseUrl,
      `/api/v1/cases/${CLOSED_CASE_ID}/documents`, cookies.get("founder")!));
    assert.equal(closedList.length, 1);
    assert.equal(closedList[0]!.id, CLOSED_DOCUMENT_ID);
    assertApiError(await postDocument(baseUrl, cookies.get("founder")!, CLOSED_CASE_ID,
      "doc01-closed", { display_name: "Synthetic closed", classification: "operational_attachment" }),
    409, "CONFLICT");

    stage = "opaque_not_visible_probe";
    const beforeOpaqueProbe = await readDocumentCounts(target);
    assertApiError(await getJson(baseUrl,
      `/api/v1/cases/${OPAQUE_NOT_VISIBLE_CASE_ID}/documents/${OPAQUE_NOT_VISIBLE_DOCUMENT_ID}`,
      cookies.get("founder")!), 404, "NOT_FOUND");
    const opaqueProbe = await postDocument(
      baseUrl,
      cookies.get("founder")!,
      OPAQUE_NOT_VISIBLE_CASE_ID,
      "doc01-opaque-not-visible",
      { display_name: "Synthetic opaque probe", classification: "operational_attachment" },
    );
    assertApiError(opaqueProbe, 404, "NOT_FOUND");
    assertNoPrivateEcho(opaqueProbe, ["Synthetic opaque probe"]);
    assert.deepEqual(await readDocumentCounts(target), beforeOpaqueProbe);
    await assertRepositoryTenantScope(target, founderCaseId);

    stage = "pending_purged_owner";
    await markStudentPending(target, NEON_TEST_STUDENTS[1]!.id);
    assertApiError(await postDocument(baseUrl, cookies.get("advisor")!, advisorCaseId,
      "doc01-pending", { display_name: "Synthetic pending", classification: "operational_attachment" }),
    404, "NOT_FOUND");
    await purgeStudent(target, NEON_TEST_STUDENTS[1]!.id);
    assertApiError(await postDocument(baseUrl, cookies.get("advisor")!, advisorCaseId,
      "doc01-purged", { display_name: "Synthetic purged", classification: "operational_attachment" }),
    404, "NOT_FOUND");
    assert.equal(assertCollection(await getJson(baseUrl,
      `/api/v1/cases/${advisorCaseId}/documents`, cookies.get("advisor")!)).length, 1);

    stage = "fault_rollback";
    const beforeFault = await readDocumentCounts(target);
    await installDocumentFailure(target);
    const failed = await postDocument(baseUrl, cookies.get("founder")!, founderCaseId,
      "doc01-fault", { display_name: "Synthetic rollback", classification: "operational_attachment" });
    assertApiError(failed, 503, "SERVICE_UNAVAILABLE");
    assertNoPrivateEcho(failed, ["Synthetic rollback"]);
    await removeDocumentFailure(target);
    assert.deepEqual(await readDocumentCounts(target), beforeFault);

    stage = "directory_relogin";
    const founderDirectory = assertCollection(await getJson(baseUrl, "/api/v1/documents",
      cookies.get("founder")!));
    assert.equal(founderDirectory.length, 3);
    assertSorted(founderDirectory);
    assert.equal(founderDirectory.length <= 100, true);
    const replacementFounderCookie = await login(baseUrl, FOUNDER.email, passwords.get("founder")!);
    const persisted = assertCollection(await getJson(baseUrl, "/api/v1/documents", replacementFounderCookie));
    assert.equal(persisted.some((item) => item.id === founderReceipts[0]!.id), true);

    stage = "database_aggregates";
    const afterDocuments = await readDocumentCounts(target);
    assert.deepEqual(delta(beforeDocuments, afterDocuments), {
      documents: 2, versions: 0, scans: 0, receipts: 2, audit: 2, outbox: 2,
    });
    assert.deepEqual(await readIdentityCounts(target), identityBefore);
    assert.equal(await privateEffectMatches(target, [founderName, advisorName]), 0);
    assertNoSensitiveDevLogs(devServer, [
      applicationPassword, ...passwords.values(), ...NEON_TEST_PRINCIPALS.map((value) => value.email),
      founderName, advisorName, "postgresql://", "tx_session=",
    ]);
    evidence.baseline = { source_migrations: 35, generated_files: 36, postgres_version: 17 };
    evidence.http = {
      founder_create_read: 201,
      advisor_create_read: 201,
      denied_roles: 3,
      unassigned: 404,
      closed: 409,
      pending: 404,
      purged: 404,
      opaque_not_visible_uuid_http: 404,
      tenant_isolation_basis: "repository_service_scope_force_rls_minimum_grants",
      idempotency: "exact_concurrent_replay",
      rollback: "zero_effects",
      metadata_only: true,
      relogin: true,
    };
    stage = "complete";
  } catch {
    failureStage = stage;
  } finally {
    cleanup.dev_stopped = await stopNextDev(devServer);
    cleanup.app_removed = await removeDirectory(appDirectory);
    cleanup.container_removed = !containerStarted ||
      (await runDocker(["rm", "--force", containerName], "cleanup", undefined, true)).exitCode === 0;
    cleanup.volume_removed = !volumeCreated ||
      (await runDocker(["volume", "rm", "--force", volumeName], "cleanup", undefined, true)).exitCode === 0;
  }

  const cleanupComplete = Object.values(cleanup).every(Boolean);
  process.stdout.write(`${JSON.stringify({
    status: failureStage === null && cleanupComplete ? "pass" : "failed",
    stage: failureStage ?? (cleanupComplete ? "complete" : "cleanup"),
    evidence,
    cleanup,
    local_dev: failureStage === null && cleanupComplete ? "pass" : "failed",
    vercel_test: "not_run_unverified",
    aws_production: "not_run_unverified",
  })}\n`);
  if (failureStage !== null || !cleanupComplete) throw new HarnessError(failureStage ?? "cleanup");
});

function principal(role: Role) {
  const value = NEON_TEST_PRINCIPALS.find((candidate) => candidate.role === role);
  if (!value) throw new Error("Synthetic principal contract is incomplete.");
  return value;
}

async function createCase(baseUrl: string, cookie: string, studentId: string,
  bindingId: string, intakeYear: number, key: string): Promise<string> {
  const result = await postJson(baseUrl, "/api/v1/cases", cookie, key, {
    student_id: studentId,
    intake_year: intakeYear,
    admission_type: "transfer",
    primary_role_binding_id: bindingId,
    manifest_id: NEON_TEST_MANIFEST_ID,
  });
  assert.equal(result.response.status, 200);
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data).sort(), ["id", "record_version"]);
  const id = requiredString(data.id);
  assert.equal(data.record_version, 2);
  const authority = await getJson(baseUrl, `/api/v1/cases/${id}`, cookie);
  assert.equal(authority.response.status, 200);
  const created = requiredRecord(requiredRecord(authority.body.data).case);
  assert.equal(created.id, id);
  assert.equal(created.studentId, studentId);
  assert.equal(created.stage, "background_collection");
  assert.equal(created.workflowStatus, "active");
  assert.equal(created.recordVersion, 2);
  return id;
}

async function postDocument(baseUrl: string, cookie: string, caseId: string,
  key: string, body: unknown): Promise<HttpResult> {
  return postJson(baseUrl, `/api/v1/cases/${caseId}/documents`, cookie, key, body);
}

async function postJson(baseUrl: string, path: string, cookie: string,
  key: string, body: unknown): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
  return Object.freeze({ response, body: await response.json() as Envelope });
}

async function getJson(baseUrl: string, path: string, cookie: string): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, { headers: cookie ? { cookie } : {} });
  return Object.freeze({ response, body: await response.json() as Envelope });
}

function assertAcknowledgement(result: HttpResult): { readonly id: string; readonly record_version: number } {
  assert.equal(result.response.status, 201);
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data).sort(), ["id", "record_version"]);
  assert.match(requiredString(data.id), /^[0-9a-f-]{36}$/i);
  assert.equal(data.record_version, 1);
  return Object.freeze({ id: data.id as string, record_version: 1 });
}

function assertCollection(result: HttpResult): readonly Record<string, unknown>[] {
  assert.equal(result.response.status, 200);
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data), ["documents"]);
  assert.equal(Array.isArray(data.documents), true);
  const items = data.documents as Record<string, unknown>[];
  for (const item of items) assertDocumentItem(item);
  return items;
}

function assertDetail(result: HttpResult, caseId: string, displayName: string): Record<string, unknown> {
  assert.equal(result.response.status, 200);
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data), ["document"]);
  const item = requiredRecord(data.document);
  assertDocumentItem(item);
  assert.equal(item.case_id, caseId);
  assert.equal(item.display_name, displayName);
  return item;
}

function assertDocumentItem(item: Record<string, unknown>): void {
  assert.deepEqual(Object.keys(item).sort(), [
    "id", "case_id", "case_number", "display_name", "classification", "lifecycle_state",
    "latest_version_state", "has_active_version", "record_version", "updated_at",
  ].sort());
}

function assertApiError(result: HttpResult, status: number, code: string): void {
  assert.equal(result.response.status, status);
  assert.equal(result.body.error?.code, code);
}

function assertNoPrivateEcho(result: HttpResult, values: readonly string[]): void {
  const serialized = JSON.stringify(result.body);
  for (const value of values) if (value !== "") assert.equal(serialized.includes(value), false);
}

function assertSorted(items: readonly Record<string, unknown>[]): void {
  const expected = [...items].sort((left, right) => {
    const byTime = requiredString(right.updated_at).localeCompare(requiredString(left.updated_at));
    return byTime !== 0 ? byTime : requiredString(left.id).localeCompare(requiredString(right.id));
  });
  assert.deepEqual(items, expected);
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HarnessError("http_shape");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new HarnessError("http_shape");
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
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new HarnessError("login_cookie");
  assert.match(cookie, /; HttpOnly/i);
  assert.match(cookie, /; SameSite=Lax/i);
  assert.doesNotMatch(cookie, /; Secure/i);
  return cookie.split(";", 1)[0]!;
}

interface Counts {
  readonly documents: number;
  readonly versions: number;
  readonly scans: number;
  readonly receipts: number;
  readonly audit: number;
  readonly outbox: number;
}

async function readDocumentCounts(target: OneRoleBaselineTarget): Promise<Counts> {
  return tenantQuery(target, NEON_TEST_ORGANIZATION.id, FOUNDER.userId, async (client) => {
    const result = await client.query<Counts>(`SELECT
      (SELECT count(*)::int FROM documents_documents) AS documents,
      (SELECT count(*)::int FROM documents_document_versions) AS versions,
      (SELECT count(*)::int FROM documents_scan_results) AS scans,
      (SELECT count(*)::int FROM shared_idempotency_records
        WHERE operation='documents.register_case_metadata') AS receipts,
      (SELECT count(*)::int FROM audit_events
        WHERE event_type='documents.document_registered') AS audit,
      (SELECT count(*)::int FROM audit_outbox
        WHERE event_type='documents.document_registered') AS outbox`);
    const row = result.rows[0];
    if (!row) throw new HarnessError("document_counts");
    return row;
  });
}

function delta(before: Counts, after: Counts): Counts {
  return Object.freeze({
    documents: after.documents - before.documents,
    versions: after.versions - before.versions,
    scans: after.scans - before.scans,
    receipts: after.receipts - before.receipts,
    audit: after.audit - before.audit,
    outbox: after.outbox - before.outbox,
  });
}

async function readIdentityCounts(target: OneRoleBaselineTarget) {
  return tenantQuery(target, NEON_TEST_ORGANIZATION.id, FOUNDER.userId, async (client) => {
    const result = await client.query<{ users: number; memberships: number; bindings: number; credentials: number }>(`SELECT
      (SELECT count(*)::int FROM identity_users) AS users,
      (SELECT count(*)::int FROM access_organization_memberships) AS memberships,
      (SELECT count(*)::int FROM access_role_bindings) AS bindings,
      (SELECT count(*)::int FROM identity_database_test_credentials) AS credentials`);
    return result.rows[0]!;
  });
}

async function privateEffectMatches(target: OneRoleBaselineTarget, values: readonly string[]): Promise<number> {
  return tenantQuery(target, NEON_TEST_ORGANIZATION.id, FOUNDER.userId, async (client) => {
    let matches = 0;
    for (const value of values) {
      const result = await client.query<{ matches: number }>(`SELECT
        ((SELECT count(*) FROM audit_events WHERE metadata::text LIKE '%' || $1 || '%') +
         (SELECT count(*) FROM audit_outbox WHERE payload::text LIKE '%' || $1 || '%'))::int AS matches`, [value]);
      matches += result.rows[0]?.matches ?? 0;
    }
    return matches;
  });
}

async function assertRepositoryTenantScope(
  target: OneRoleBaselineTarget,
  visibleCaseId: string,
): Promise<void> {
  const pool = new Pool({ ...createOneRoleBaselineClientConfig(target), max: 1 });
  try {
    const service = new DocumentWorkspaceService(new PostgresqlDocumentWorkspaceRepository(
      createTenantTransactionRunner(pool as unknown as DatabasePool, {
        expectedLoginUser: ONE_ROLE_CANONICAL_ROLE,
      }),
    ));
    const actor: IdentitySessionActor = Object.freeze({
      userId: FOUNDER.userId,
      organizationId: OPAQUE_NOT_VISIBLE_ORGANIZATION_ID,
      role: "founder",
      sessionId: "82000000-0000-4000-8000-000000000108",
      capturedSessionVersion: 1,
      reauthenticatedAtMs: null,
    });
    await assert.rejects(
      service.listCase(actor, visibleCaseId),
      (error) => isDocumentWorkspaceError(error, "DOCUMENT_WORKSPACE_FORBIDDEN"),
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

async function insertClosedFixture(target: OneRoleBaselineTarget): Promise<void> {
  await tenantQuery(target, NEON_TEST_ORGANIZATION.id, FOUNDER.userId, async (client) => {
    await client.query("ALTER TABLE cases_service_cases DISABLE TRIGGER USER");
    await client.query(`INSERT INTO cases_service_cases
      (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
       primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,
       workflow_status,record_version)
      VALUES ($1,$2,$3,'DOC01-CLOSED','k12',2053,'transfer',$4,$5,$6,'advisor','closed',
        'closed',1)`,
    [CLOSED_CASE_ID, NEON_TEST_ORGANIZATION.id, NEON_TEST_STUDENTS[0]!.id,
      ADVISOR.roleBindingId, ADVISOR.membershipId, ADVISOR.userId]);
    await client.query("ALTER TABLE cases_service_cases ENABLE TRIGGER USER");
    const triggerState = await client.query<{ all_enabled: boolean }>(`SELECT bool_and(tgenabled = 'O') AS all_enabled
      FROM pg_trigger WHERE tgrelid = 'cases_service_cases'::regclass AND NOT tgisinternal`);
    assert.equal(triggerState.rows[0]?.all_enabled, true);
    await client.query(`INSERT INTO documents_documents
      (id,organization_id,owner_kind,service_case_id,display_name,classification,lifecycle_state,legal_hold)
      VALUES ($1,$2,'case',$3,'Synthetic Closed Evidence','operational_attachment','active',false)`,
    [CLOSED_DOCUMENT_ID, NEON_TEST_ORGANIZATION.id, CLOSED_CASE_ID]);
  });
}

async function markStudentPending(target: OneRoleBaselineTarget, studentId: string): Promise<void> {
  await tenantQuery(target, NEON_TEST_ORGANIZATION.id, FOUNDER.userId, async (client) => {
    await client.query(`UPDATE crm_students SET status='pending_delete',
      deletion_requested_at=transaction_timestamp(),deletion_requested_by_user_id=$2,
      deletion_reason='privacy_request',record_version=record_version+1,
      updated_at=transaction_timestamp() WHERE id=$1`, [studentId, FOUNDER.userId]);
  });
}

async function purgeStudent(target: OneRoleBaselineTarget, studentId: string): Promise<void> {
  await tenantQuery(target, NEON_TEST_ORGANIZATION.id, FOUNDER.userId, async (client) => {
    await client.query(`UPDATE crm_student_guardian_relationships SET
      ends_at=transaction_timestamp(),ended_by_user_id=$2,end_reason_code='privacy_purge',
      record_version=record_version+1,updated_at=transaction_timestamp()
      WHERE student_id=$1 AND ends_at IS NULL`, [studentId, FOUNDER.userId]);
    await client.query(`UPDATE crm_students SET status='purged',display_name=NULL,date_of_birth=NULL,
      contact_email=NULL,contact_phone=NULL,deletion_reason=NULL,
      purge_approved_at=transaction_timestamp(),purge_approved_by_user_id=$2,
      purged_at=transaction_timestamp(),record_version=record_version+1,
      updated_at=transaction_timestamp() WHERE id=$1`, [studentId, FOUNDER.userId]);
  });
}

async function installDocumentFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeDdl(target, `CREATE FUNCTION public.test_doc01_fail_insert()
    RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
    AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='55000'; END; $$;
    CREATE TRIGGER test_doc01_fail_insert_trg BEFORE INSERT ON public.documents_documents
    FOR EACH ROW EXECUTE FUNCTION public.test_doc01_fail_insert()`);
}

async function removeDocumentFailure(target: OneRoleBaselineTarget): Promise<void> {
  await executeDdl(target, `DROP TRIGGER IF EXISTS test_doc01_fail_insert_trg ON public.documents_documents;
    DROP FUNCTION IF EXISTS public.test_doc01_fail_insert()`);
}

async function executeDdl(target: OneRoleBaselineTarget, sql: string): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try { await client.connect(); await client.query(sql); }
  catch { throw new HarnessError("test_ddl"); }
  finally { await client.end().catch(() => {}); }
}

async function tenantQuery<Result>(target: OneRoleBaselineTarget, organizationId: string,
  actorUserId: string, operation: (client: Client) => Promise<Result>): Promise<Result> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [actorUserId]);
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new HarnessError("fixture_or_inspection");
  } finally { await client.end().catch(() => {}); }
}

async function provision(target: OneRoleBaselineTarget, email: string, password: string) {
  return runDatabaseTestProvisionCli({
    arguments: ["--password-stdin", `--email=${email}`],
    inputStream: streamOf(Buffer.from(`${password}\n`)),
    readTarget: () => localProvisionTarget(target),
  });
}

async function* streamOf(chunk: Buffer): AsyncIterable<Buffer> { yield chunk; }

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

async function inspectBaselineWithNewClient(target: OneRoleBaselineTarget): Promise<OneRoleBaselineDatabaseState> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try { await client.connect(); return await inspectOneRoleBaselineDatabase(client); }
  finally { await client.end().catch(() => {}); }
}

function assertDatabaseContract(state: OneRoleBaselineDatabaseState, target: OneRoleBaselineTarget,
  manifestSha256: string): void {
  assertOneRoleBaselinePostflight({ state, target, mode: "apply", manifestSha256 });
  assert.equal(state.marker?.baselineId, ONE_ROLE_BASELINE_ID);
  assert.equal(state.marker?.transformVersion, ONE_ROLE_TRANSFORM_VERSION);
  assert.equal(state.marker?.sourceMigrationCount, ONE_ROLE_SOURCE_COUNT);
  assert.equal(state.userName, ONE_ROLE_CANONICAL_ROLE);
  assert.equal(state.databaseOwner, ONE_ROLE_CANONICAL_ROLE);
  assert.equal(state.publicWrongOwnerCount, 0);
  assert.equal(state.rlsNotForcedCount, 0);
  assert.equal(state.unsafeSecurityDefinerCount, 0);
}

function localTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({
    connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`,
    host: "127.0.0.1", port, database: "tianxing", user: ONE_ROLE_CANONICAL_ROLE, ssl: false,
  });
}

async function createIsolatedAppDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tianxing-doc01-http-next-"));
  const excluded = new Set([".git", ".next", "node_modules"]);
  try {
    for (const entry of await readdir(process.cwd())) {
      if (excluded.has(entry) || entry.startsWith(".env") ||
          [".DS_Store", ".idea", ".kition", ".pnpm-store"].includes(entry)) continue;
      await cp(resolve(entry), join(directory, entry), { recursive: true });
    }
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    return directory;
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new HarnessError("next_workspace");
  }
}

function startNextDev(directory: string, port: number, connectionString: string): ChildProcess {
  const child = spawn(process.execPath, [
    resolve("node_modules/next/dist/bin/next"), "dev", "--webpack",
    "--hostname", "127.0.0.1", "--port", String(port),
  ], {
    cwd: directory,
    env: {
      PATH: `/opt/homebrew/opt/node@22/bin:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
      NEXT_TELEMETRY_DISABLED: "1", APP_ENV: "development", NODE_ENV: "development",
      APP_RUNTIME_MODE: "local-synthetic", AUTH_MODE: "database-test",
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
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { logs.stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { logs.stderr += chunk; });
  DEV_LOGS.set(child, logs);
  return child;
}

function assertNoSensitiveDevLogs(child: ChildProcess, values: readonly string[]): void {
  const logs = DEV_LOGS.get(child);
  if (!logs) throw new HarnessError("dev_logs");
  const combined = `${logs.stdout}\n${logs.stderr}`;
  assert.equal(values.some((value) => value !== "" && combined.includes(value)), false);
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  child.stdout?.resume(); child.stderr?.resume();
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new HarnessError("next_dev");
    try { if ((await fetch(`${baseUrl}/api/v1/auth/me`)).status === 401) return; } catch {}
    await delay(500);
  }
  throw new HarnessError("next_readiness");
}

async function stopNextDev(child: ChildProcess | undefined): Promise<boolean> {
  if (!child || child.exitCode !== null) return true;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise<boolean>((resolveStopped) => child.once("close", () => resolveStopped(true))),
    delay(10_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolveStopped) => child.once("close", () => resolveStopped()));
  }
  return child.exitCode !== null;
}

async function removeDirectory(directory: string): Promise<boolean> {
  if (!directory) return true;
  try { await rm(directory, { recursive: true, force: true }); return true; }
  catch { return false; }
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await runDocker([
      "exec", containerName, "/bin/sh", "/usr/local/bin/tianxing-postgres-healthcheck",
    ], "postgres_readiness", undefined, true);
    if (result.exitCode === 0) return;
    await delay(250);
  }
  throw new HarnessError("postgres_readiness");
}

function readLoopbackPort(output: string): number {
  const port = Number(/^127\.0\.0\.1:([0-9]+)\s*$/.exec(output)?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new HarnessError("postgres_port");
  return port;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer(); server.unref();
    server.once("error", () => reject(new HarnessError("next_port")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(new HarnessError("next_port")) : resolvePort(port));
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class HarnessError extends Error {
  constructor(stage: string) {
    super(`DOC-01 Dev HTTP harness failed at ${stage}.`);
    this.name = "HarnessError";
  }
}

async function runDocker(arguments_: readonly string[], stage: string, input?: string,
  allowFailure = false): Promise<Readonly<{ exitCode: number; stdout: string }>> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("docker", arguments_, { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.resume();
    child.once("error", () => reject(new HarnessError(stage)));
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !allowFailure) reject(new HarnessError(stage));
      else resolveRun(Object.freeze({ exitCode, stdout }));
    });
    child.stdin.end(input);
  });
}
