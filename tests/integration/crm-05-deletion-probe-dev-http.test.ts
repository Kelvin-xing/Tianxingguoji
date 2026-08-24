import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Client } from "pg";

import {
  ONE_ROLE_CANONICAL_ROLE,
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
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const ADVISOR = NEON_TEST_PRINCIPALS.find(({ role }) => role === "advisor")!;
const STUDENT = NEON_TEST_STUDENTS[0]!;
const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

test("CRM-05 Advisor Guardian deletion works through PostgreSQL 17 and real Next Dev HTTP", {
  timeout: 300_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-crm05-deletion-pg17-${suffix}`;
  const secretVolumeName = `tianxing-crm05-deletion-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const advisorPassword = randomBytes(32).toString("base64url");
  const appDirectory = await createIsolatedAppDirectory();
  let containerStarted = false;
  let secretVolumeCreated = false;
  let devServer: ChildProcess | undefined;
  let safeEvidence: Readonly<Record<string, unknown>> | undefined;

  try {
    await runDocker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_missing");
    await runDocker(["volume", "create", secretVolumeName], "postgres_secret_volume_create");
    secretVolumeCreated = true;
    await runDocker([
      "run", "--rm", "--interactive", "--pull=never", "--volume",
      `${secretVolumeName}:/run/secrets`, POSTGRES_IMAGE, "/bin/sh", "-c",
      "umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password",
    ], "postgres_secret_volume_populate", applicationPassword);
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", containerName,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env", "POSTGRES_DB=tianxing", "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/local_postgres_password",
      "--volume", `${secretVolumeName}:/run/secrets:ro`,
      "--volume", `${resolve("infra/local/postgres/init")}:/docker-entrypoint-initdb.d:ro`,
      "--volume", `${resolve("infra/local/postgres/healthcheck.sh")}:/usr/local/bin/tianxing-postgres-healthcheck:ro`,
      "--publish", "127.0.0.1::5432", POSTGRES_IMAGE,
    ], "postgres_container_start");
    containerStarted = true;
    await waitForPostgres(containerName);
    const port = readLoopbackPort((await runDocker(
      ["port", containerName, "5432/tcp"], "postgres_port_inspection")).stdout);
    const target = localTarget(port, applicationPassword);
    assert.equal((await readPostgresVersion(target)).split(".")[0], "17");

    const build = await verifyCommittedOneRoleBaseline();
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply",
      target,
      build,
      dependencies: {
        inspect: () => inspectBaselineWithNewClient(target),
        openExecutionConnection: async () => {
          const client = new Client(createOneRoleBaselineClientConfig(target));
          await client.connect();
          return Object.freeze({ client, close: () => client.end() });
        },
      },
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.postflight_state, "installed");
    assert.equal(baseline.generated_files, baseline.source_migrations + 1);

    const seed = await seedNeonTestRelease1(target, "apply");
    assert.equal(seed.status, "pass");
    assert.equal(await provision(target, ADVISOR.email, advisorPassword), "created");

    const portForHttp = await reserveLoopbackPort();
    devServer = startNextDev(appDirectory, portForHttp, target.connectionString);
    const baseUrl = `http://127.0.0.1:${portForHttp}`;
    await waitForNextDev(baseUrl, devServer);
    const advisorCookie = await login(baseUrl, ADVISOR.email, advisorPassword);

    const access = await getJson(baseUrl, "/api/v1/auth/me", advisorCookie);
    assert.equal(access.response.status, 200);
    assert.equal(access.body.data?.role, "advisor");
    assert.equal(requiredArray(access.body.data?.capabilities).includes("students.deletion.request"), true);

    const caseCreate = await postJson(baseUrl, "/api/v1/cases", advisorCookie, {
      student_id: STUDENT.id,
      intake_year: 2027,
      admission_type: "transfer",
      primary_role_binding_id: ADVISOR.roleBindingId,
      manifest_id: NEON_TEST_MANIFEST_ID,
    }, "crm05-deletion-probe-case");
    assert.equal(caseCreate.response.status, 200);
    const caseReceipt = requiredRecord(caseCreate.body.data);
    assert.deepEqual(Object.keys(caseReceipt).sort(), ["id", "record_version"]);
    assert.equal(caseReceipt.record_version, 2);
    const caseAuthority = await getJson(
      baseUrl,
      `/api/v1/cases/${requiredString(caseReceipt, "id")}`,
      advisorCookie,
    );
    assert.equal(caseAuthority.response.status, 200);
    const caseDetail = requiredRecord(caseAuthority.body.data?.case);
    assert.equal(caseDetail.studentId, STUDENT.id);
    assert.equal(caseDetail.stage, "background_collection");
    assert.equal(caseDetail.workflowStatus, "active");
    assert.equal(caseDetail.recordVersion, 2);

    const before = await getJson(baseUrl, `/api/v1/students/${STUDENT.id}`, advisorCookie);
    assert.equal(before.response.status, 200);
    const studentBefore = requiredRecord(before.body.data?.student);
    const guardianBefore = requiredRecord(requiredArray(studentBefore.guardians)
      .find((value) => requiredRecord(value).id === STUDENT.guardianId));
    assert.equal(guardianBefore.status, "active");
    const previousVersion = requiredNumber(guardianBefore, "recordVersion");

    const relationshipsBefore = await getJson(baseUrl,
      `/api/v1/students/${STUDENT.id}/guardians`, advisorCookie);
    assertCurrentRelationships(relationshipsBefore, STUDENT.id, STUDENT.guardianId);
    const countsBefore = await inspectDeletionState(target);

    const deletion = await postJson(baseUrl,
      `/api/v1/guardians/${STUDENT.guardianId}/deletion-requests`, advisorCookie, {
        expected_record_version: previousVersion,
        reason_code: "record.lifecycle.pending_delete_requested",
      }, "crm05-deletion-probe-guardian");
    if (deletion.response.status !== 200) {
      const failure = readDeletionReviewPostgresFailure(devServer);
      throw new HarnessError(`guardian_deletion_status_${deletion.response.status}` +
        `_stage_${failure?.stage ?? "NONE"}_postgres_${failure?.postgresCode ?? "NULL"}`);
    }
    assertDeletionReceipt(deletion, previousVersion + 1);

    const after = await getJson(baseUrl, `/api/v1/students/${STUDENT.id}`, advisorCookie);
    assert.equal(after.response.status, 200);
    const studentAfter = requiredRecord(after.body.data?.student);
    const guardianAfter = requiredRecord(requiredArray(studentAfter.guardians)
      .find((value) => requiredRecord(value).id === STUDENT.guardianId));
    assert.equal(guardianAfter.status, "pending_delete");
    assert.equal(guardianAfter.recordVersion, previousVersion + 1);
    assertCurrentRelationships(await getJson(baseUrl,
      `/api/v1/students/${STUDENT.id}/guardians`, advisorCookie), STUDENT.id, STUDENT.guardianId);

    const countsAfter = await inspectDeletionState(target);
    assert.deepEqual({
      guardianStatus: countsAfter.guardianStatus,
      guardianVersionDelta: countsAfter.guardianRecordVersion - countsBefore.guardianRecordVersion,
      currentRelationshipDelta: countsAfter.currentRelationshipCount - countsBefore.currentRelationshipCount,
      receiptDelta: countsAfter.receiptCount - countsBefore.receiptCount,
      auditDelta: countsAfter.auditCount - countsBefore.auditCount,
      outboxDelta: countsAfter.outboxCount - countsBefore.outboxCount,
      privateMatches: countsAfter.privateMatches,
    }, {
      guardianStatus: "pending_delete",
      guardianVersionDelta: 1,
      currentRelationshipDelta: 0,
      receiptDelta: 1,
      auditDelta: 1,
      outboxDelta: 1,
      privateMatches: 0,
    });
    assertNoSensitiveDevLogs(devServer, [advisorPassword, target.connectionString,
      STUDENT.guardianName, STUDENT.guardianEmail ?? ""]);
    safeEvidence = Object.freeze({
      postgres_major: 17,
      baseline: "installed",
      seed: "release1-synthetic",
      auth_me: 200,
      student_read: 200,
      relationships_read: 200,
      guardian_deletion: 200,
      pending_authoritative_reads: 200,
      receipt_delta: 1,
      audit_delta: 1,
      outbox_delta: 1,
      private_matches: 0,
    });
  } catch (error) {
    if (error instanceof HarnessError || error instanceof assert.AssertionError) throw error;
    throw new HarnessError("unexpected_failure");
  } finally {
    await stopNextDev(devServer);
    await rm(appDirectory, { recursive: true, force: true });
    if (containerStarted) await runDocker(["rm", "--force", containerName], "postgres_container_cleanup");
    if (secretVolumeCreated) {
      await runDocker(["volume", "rm", "--force", secretVolumeName], "postgres_secret_cleanup");
    }
  }

  process.stdout.write(`${JSON.stringify(safeEvidence)}\n`);
});

interface ApiEnvelope {
  readonly data?: Record<string, unknown>;
  readonly error?: Readonly<{ code?: unknown }>;
}

interface DeletionStateRow extends Record<string, unknown> {
  guardian_status: string;
  guardian_record_version: number | string;
  current_relationship_count: number | string;
  receipt_count: number | string;
  audit_count: number | string;
  outbox_count: number | string;
  private_matches: number | string;
}

async function inspectDeletionState(target: OneRoleBaselineTarget) {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [ADVISOR.userId]);
    const result = await client.query<DeletionStateRow>(`SELECT
      guardian.status AS guardian_status,
      guardian.record_version AS guardian_record_version,
      (SELECT count(*)::int FROM crm_student_guardian_relationships AS relationship
        WHERE relationship.student_id=$2 AND relationship.guardian_id=$3
          AND relationship.ends_at IS NULL) AS current_relationship_count,
      (SELECT count(*)::int FROM shared_idempotency_records AS receipt
        WHERE receipt.actor_user_id=$1 AND receipt.operation='crm.request_guardian_pending_delete')
        AS receipt_count,
      (SELECT count(*)::int FROM audit_events AS audit
        WHERE audit.actor_user_id=$1 AND audit.event_type='crm.guardian_pending_delete_requested')
        AS audit_count,
      (SELECT count(*)::int FROM audit_outbox AS outbox
        WHERE outbox.event_type='crm.guardian_pending_delete_requested') AS outbox_count,
      ((SELECT count(*) FROM audit_events AS audit
        WHERE audit.metadata::text LIKE '%' || $4 || '%'
           OR audit.metadata::text LIKE '%' || $5 || '%') +
       (SELECT count(*) FROM audit_outbox AS outbox
        WHERE outbox.payload::text LIKE '%' || $4 || '%'
           OR outbox.payload::text LIKE '%' || $5 || '%'))::int AS private_matches
      FROM crm_guardians AS guardian WHERE guardian.id=$3`, [
        ADVISOR.userId, STUDENT.id, STUDENT.guardianId, STUDENT.guardianName,
        STUDENT.guardianEmail ?? "unavailable.invalid",
      ]);
    const row = result.rows[0];
    if (!row) throw new HarnessError("deletion_state_inspection");
    return Object.freeze({
      guardianStatus: row.guardian_status,
      guardianRecordVersion: integer(row.guardian_record_version),
      currentRelationshipCount: integer(row.current_relationship_count),
      receiptCount: integer(row.receipt_count),
      auditCount: integer(row.audit_count),
      outboxCount: integer(row.outbox_count),
      privateMatches: integer(row.private_matches),
    });
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("deletion_state_inspection");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
}

function assertDeletionReceipt(result: Readonly<{ response: Response; body: ApiEnvelope }>, version: number) {
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data).sort(), ["deletion_requested_at", "entity_id", "entity_type",
    "record_version", "status"]);
  assert.equal(data.entity_type, "guardian");
  assert.equal(data.entity_id, STUDENT.guardianId);
  assert.equal(data.status, "pending_delete");
  assert.equal(data.record_version, version);
  assert.equal(new Date(requiredString(data, "deletion_requested_at")).toISOString(),
    data.deletion_requested_at);
}

function assertCurrentRelationships(result: Readonly<{ response: Response; body: ApiEnvelope }>,
  studentId: string, guardianId: string) {
  assert.equal(result.response.status, 200);
  const data = requiredRecord(result.body.data);
  assert.deepEqual(Object.keys(data).sort(), ["relationships", "student"]);
  assert.equal(requiredRecord(data.student).id, studentId);
  const relationship = requiredArray(data.relationships).map(requiredRecord)
    .find((item) => requiredRecord(item.guardian).id === guardianId);
  assert.ok(relationship);
  assert.equal(relationship.is_primary_contact, true);
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(new URL(requiredHeader(response, "location")).pathname, "/today");
  const setCookie = requiredHeader(response, "set-cookie");
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; SameSite=Lax/i);
  assert.doesNotMatch(setCookie, /; Secure/i);
  return setCookie.split(";", 1)[0]!;
}

async function getJson(baseUrl: string, path: string, cookie: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}

async function postJson(baseUrl: string, path: string, cookie: string, body: unknown,
  idempotencyKey: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  return Object.freeze({ response, body: await response.json() as ApiEnvelope });
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("http_response_shape");
  return value as Record<string, unknown>;
}
function requiredArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new HarnessError("http_response_shape");
  return value;
}
function requiredNumber(value: unknown, field: string): number {
  const result = requiredRecord(value)[field];
  if (!Number.isSafeInteger(result)) throw new HarnessError("http_response_shape");
  return result as number;
}
function requiredString(value: unknown, field: string): string {
  const result = requiredRecord(value)[field];
  if (typeof result !== "string" || !result) throw new HarnessError("http_response_shape");
  return result;
}
function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new HarnessError(`missing_${name}_header`);
  return value;
}
function integer(value: number | string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new HarnessError("database_count_shape");
  return result;
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
  return Object.freeze({ connectionString: target.connectionString, loginUser: target.user,
    databaseName: target.database, connectionTimeoutMs: 5_000, statementTimeoutMs: 10_000, ssl: false });
}

function localTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({
    connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`,
    host: "127.0.0.1", port, database: "tianxing", user: ONE_ROLE_CANONICAL_ROLE, ssl: false,
  });
}
async function inspectBaselineWithNewClient(target: OneRoleBaselineTarget) {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try { await client.connect(); return await inspectOneRoleBaselineDatabase(client); }
  catch { throw new HarnessError("baseline_inspection"); }
  finally { await client.end().catch(() => {}); }
}
async function readPostgresVersion(target: OneRoleBaselineTarget): Promise<string> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    const result = await client.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version");
    const version = result.rows[0]?.version;
    if (!version) throw new HarnessError("postgres_version_inspection");
    return version;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("postgres_version_inspection");
  } finally { await client.end().catch(() => {}); }
}

async function createIsolatedAppDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tianxing-crm05-deletion-next-dev-"));
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
    throw new HarnessError("next_workspace_setup");
  }
}

function startNextDev(directory: string, port: number, connectionString: string): ChildProcess {
  const child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"),
    "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG, NEXT_TELEMETRY_DISABLED: "1", APP_ENV: "development",
      NODE_ENV: "development", APP_RUNTIME_MODE: "local-synthetic", AUTH_MODE: "database-test",
      LOCAL_SYNTHETIC_DATABASE_URL: connectionString,
      LOCAL_SYNTHETIC_LOCALSTACK_ENDPOINT: "http://127.0.0.1:4566",
      LOCAL_SYNTHETIC_AWS_REGION: "ap-east-1",
      LOCAL_SYNTHETIC_S3_BUCKET: "tianxing-local-documents",
      LOCAL_SYNTHETIC_SQS_QUEUE: "tianxing-local-document-scan",
      LOCAL_SYNTHETIC_SQS_DLQ: "tianxing-local-document-scan-dlq",
      LOCAL_SYNTHETIC_CLAMAV_HOST: "127.0.0.1", LOCAL_SYNTHETIC_CLAMAV_PORT: "3310",
      LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: "2000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { logs.stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { logs.stderr += chunk; });
  DEV_LOGS.set(child, logs);
  return child;
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  child.stdout?.resume(); child.stderr?.resume();
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new HarnessError("next_dev_early_exit");
    try { if ((await fetch(`${baseUrl}/api/v1/auth/me`)).status === 401) return; } catch {}
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

function readDeletionReviewPostgresFailure(child: ChildProcess) {
  const logs = DEV_LOGS.get(child);
  if (!logs) throw new HarnessError("next_log_capture");
  const matches = `${logs.stdout}\n${logs.stderr}`.matchAll(
    /(?:^|\n)event=deletion_review_postgres_failure stage=(receipt_claim|actor_reauthorization|target_lock|advisor_scope|target_update|effects_append|receipt_complete|transaction_boundary) postgres_code=(08003|08006|23503|23505|23514|40001|40P01|42501|42601|42703|42883|42P01|55P03|57014|57P01|OTHER|NULL)(?:\n|$)/g,
  );
  let result: Readonly<{ stage: string; postgresCode: string }> | null = null;
  for (const match of matches) result = Object.freeze({ stage: match[1]!, postgresCode: match[2]! });
  return result;
}
function assertNoSensitiveDevLogs(child: ChildProcess, forbidden: readonly string[]): void {
  const logs = DEV_LOGS.get(child);
  if (!logs) throw new HarnessError("next_log_capture");
  const combined = `${logs.stdout}\n${logs.stderr}`;
  for (const value of forbidden) if (value && combined.includes(value)) throw new HarnessError("next_log_privacy");
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer(); server.unref();
    server.once("error", () => reject(new HarnessError("next_port_reservation")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error || port < 1 ? reject(new HarnessError("next_port_reservation")) : resolvePort(port));
    });
  });
}
async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = await runDocker(["exec", containerName, "/bin/sh",
      "/usr/local/bin/tianxing-postgres-healthcheck"], "postgres_readiness", undefined, process.env, true);
    if (probe.exitCode === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new HarnessError("postgres_readiness_timeout");
}
function readLoopbackPort(output: string): number {
  const match = /^127\.0\.0\.1:([0-9]+)\s*$/.exec(output); const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new HarnessError("postgres_port_inspection");
  return port;
}
async function runDocker(arguments_: readonly string[], failureStage: string, input?: string,
  environment: NodeJS.ProcessEnv = process.env, allowFailure = false) {
  return new Promise<Readonly<{ exitCode: number; stdout: string }>>((resolveRun, reject) => {
    const child = spawn("docker", arguments_, { cwd: process.cwd(), env: environment,
      stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
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

class HarnessError extends Error {
  readonly code = "CRM05_DELETION_PROBE_FAILED" as const;
  readonly stage: string;
  constructor(stage: string) {
    super(`CRM-05 deletion probe failed at ${stage}.`);
    this.name = "HarnessError";
    this.stage = stage;
  }
}
