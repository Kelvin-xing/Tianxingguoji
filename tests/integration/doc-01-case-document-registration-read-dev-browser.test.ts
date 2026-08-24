import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { chromium, type BrowserContext, type Page } from "playwright-core";
import { Client } from "pg";

import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  verifyCommittedOneRoleBaseline,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
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
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  type OneRoleBaselineDatabaseState,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";

const DOCKER = "/opt/homebrew/bin/docker";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const FOUNDER = principal("founder");
const ADVISOR = principal("advisor");
const ADMIN = principal("admin");
const DATA_REVIEWER = principal("data_reviewer");
const CONTRACTOR = principal("contractor");

type Actor = "founder" | "advisor" | "admin" | "data_reviewer" | "contractor";
type Stage =
  | "runtime_preflight" | "postgres_setup" | "baseline_seed" | "identity_provision"
  | "next_dev" | "canonical_origin" | "chrome_launch" | "login"
  | "founder_case_fixture" | "case_panel_ready" | "client_validation_zero_post"
  | "registration_idempotency" | "authoritative_detail_refresh" | "directory_persistence"
  | "awaiting_upload_truthful" | "refresh_persistence" | "relogin_persistence"
  | "advisor_registration" | "conflict_feedback" | "denied_roles"
  | "desktop_viewport" | "mobile_viewport" | "browser_log_safety"
  | "cleanup" | "complete";

interface Evidence {
  baseline_generated_files: number | null;
  loading_state_visible: boolean;
  empty_state_visible: boolean;
  client_validation_zero_post: boolean;
  uncertain_retry_same_key: boolean;
  changed_command_new_key: boolean;
  synchronous_double_post_count: number | null;
  receipt_exact: boolean;
  authoritative_detail_refresh: boolean;
  directory_persistence: boolean;
  refresh_persistence: boolean;
  relogin_persistence: boolean;
  awaiting_upload_truthful: boolean;
  advisor_registration: boolean;
  conflict_visible: boolean;
  denied_roles: boolean;
  desktop_viewport: ViewportEvidence | null;
  mobile_viewport: ViewportEvidence | null;
  page_errors: number;
  sensitive_log_matches: number;
}

interface CleanupEvidence {
  context_closed: boolean;
  dev_stopped: boolean;
  app_removed: boolean;
  profile_removed: boolean;
  container_removed: boolean;
  volume_removed: boolean;
}

interface ViewportEvidence {
  readonly horizontal_overflow: number;
  readonly out_of_bounds_controls: number;
  readonly overlapping_controls: number;
  readonly clipped_text: number;
}

interface CaseFixture {
  readonly status: number | null;
  readonly exact: boolean;
  readonly caseId: string | null;
}

interface WriteEvidence {
  readonly status: number | null;
  readonly jsonParseable: boolean;
  readonly exactAck: boolean;
  readonly id: string | null;
  readonly version: number | null;
}

const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

test("DOC-01 works through a real local browser and disposable PostgreSQL 17", {
  timeout: 600_000,
}, async () => {
  let stage: Stage = "runtime_preflight";
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-doc01-browser-pg17-${suffix}`;
  const volumeName = `tianxing-doc01-browser-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const actors = [FOUNDER, ADVISOR, ADMIN, DATA_REVIEWER, CONTRACTOR] as const;
  const passwords = new Map<Actor, string>(actors.map((actor) => [actor.role, randomBytes(32).toString("base64url")]));
  const evidence: Evidence = {
    baseline_generated_files: null,
    loading_state_visible: false,
    empty_state_visible: false,
    client_validation_zero_post: false,
    uncertain_retry_same_key: false,
    changed_command_new_key: false,
    synchronous_double_post_count: null,
    receipt_exact: false,
    authoritative_detail_refresh: false,
    directory_persistence: false,
    refresh_persistence: false,
    relogin_persistence: false,
    awaiting_upload_truthful: false,
    advisor_registration: false,
    conflict_visible: false,
    denied_roles: false,
    desktop_viewport: null,
    mobile_viewport: null,
    page_errors: 0,
    sensitive_log_matches: 0,
  };
  const cleanup: CleanupEvidence = {
    context_closed: false,
    dev_stopped: false,
    app_removed: false,
    profile_removed: false,
    container_removed: false,
    volume_removed: false,
  };
  let containerStarted = false;
  let volumeCreated = false;
  let appDirectory = "";
  let profileDirectory = "";
  let devServer: ChildProcess | undefined;
  let context: BrowserContext | undefined;
  let failureStage: Stage | null = null;

  try {
    await Promise.all([access(DOCKER), access(CHROME)]);
    await runDocker(["image", "inspect", POSTGRES_IMAGE], stage);

    stage = "postgres_setup";
    await runDocker(["volume", "create", volumeName], stage);
    volumeCreated = true;
    await runDocker([
      "run", "--rm", "--interactive", "--pull=never",
      "--volume", `${volumeName}:/run/secrets`, POSTGRES_IMAGE,
      "/bin/sh", "-c", "umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password",
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
    evidence.baseline_generated_files = build.files.length;
    assert.equal(build.files.length, 36);
    const baseline = await executeOneRoleBaselineRun({ mode: "apply", target, build, dependencies: baselineDependencies(target) });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.baseline_id, ONE_ROLE_BASELINE_ID);
    assert.equal((await seedNeonTestRelease1(target, "apply")).status, "pass");

    stage = "identity_provision";
    for (const actor of actors) assert.equal(await provision(target, actor.email, passwords.get(actor.role)!), "created");

    stage = "next_dev";
    appDirectory = await createIsolatedAppDirectory();
    profileDirectory = await mkdtemp(join(tmpdir(), "tianxing-doc01-chrome-"));
    const httpPort = await reserveLoopbackPort();
    devServer = startNextDev(appDirectory, httpPort, target.connectionString);
    const listenUrl = `http://127.0.0.1:${httpPort}`;
    await waitForNextDev(listenUrl, devServer);

    stage = "canonical_origin";
    const baseUrl = await discoverCanonicalBaseUrl(listenUrl, httpPort);

    stage = "chrome_launch";
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: CHROME,
      headless: true,
      baseURL: baseUrl,
      viewport: { width: 1440, height: 1000 },
    });
    context.setDefaultTimeout(30_000);
    const page = context.pages()[0] ?? await context.newPage();
    const browserMessages: string[] = [];
    page.on("pageerror", () => { evidence.page_errors += 1; });
    page.on("console", (message) => { browserMessages.push(message.text()); });

    stage = "login";
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!);

    stage = "founder_case_fixture";
    const founderCase = await createCaseFixture(page, ADVISOR.roleBindingId, 2046);
    assert.equal(founderCase.status, 200);
    assert.equal(founderCase.exact, true);
    assert.notEqual(founderCase.caseId, null);

    stage = "case_panel_ready";
    evidence.loading_state_visible = await openCaseDocumentsWithLoadingEvidence(page, baseUrl, founderCase.caseId!);
    assert.equal(evidence.loading_state_visible, true);
    const emptyState = page.getByText("本案目前沒有文件", { exact: true });
    await emptyState.waitFor({ state: "visible" });
    evidence.empty_state_visible = await emptyState.count() === 1;
    assert.equal(evidence.empty_state_visible, true);
    const nameInput = page.getByRole("textbox", { name: "文件名稱", exact: true });
    const classification = page.getByRole("combobox", { name: "文件分類", exact: true });
    const submit = page.getByRole("button", { name: "登記文件", exact: true });
    for (const control of [nameInput, classification, submit]) {
      await control.waitFor({ state: "visible" });
      assert.equal(await control.count(), 1);
    }
    assert.equal(await page.locator('input[type="file"]').count(), 0);
    assert.equal(await page.getByRole("button", { name: /上載|上傳/ }).count(), 0);

    stage = "client_validation_zero_post";
    let validationPosts = 0;
    const validationObserver = (request: { method(): string; url(): string }) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === `/api/v1/cases/${founderCase.caseId}/documents`) validationPosts += 1;
    };
    page.on("request", validationObserver);
    try {
      await submit.click();
      const invalid = await nameInput.evaluate((input) => {
        const control = input as HTMLInputElement;
        return control.required && !control.validity.valid && control.matches(":invalid");
      });
      assert.equal(invalid, true);
      evidence.client_validation_zero_post = validationPosts === 0;
    } finally {
      page.off("request", validationObserver);
    }
    assert.equal(evidence.client_validation_zero_post, true);

    stage = "registration_idempotency";
    await nameInput.fill("Synthetic Document Alpha");
    const keys: string[] = [];
    let posts = 0;
    let writeEvidence: WriteEvidence = { status: null, jsonParseable: false, exactAck: false, id: null, version: null };
    let detailStatus: number | null = null;
    const detailObserver = (response: { request(): { method(): string }; url(): string; status(): number }) => {
      const url = new URL(response.url());
      if (response.request().method() === "GET" && /^\/api\/v1\/cases\/[0-9a-f-]+\/documents\/[0-9a-f-]+$/i.test(url.pathname)) detailStatus = response.status();
    };
    page.on("response", detailObserver);
    await page.route(`**/api/v1/cases/${founderCase.caseId}/documents`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts += 1;
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (posts <= 2) return route.abort("timedout");
      const response = await route.fetch();
      writeEvidence = safeWriteEvidence(response.status(), await response.text());
      await route.fulfill({ response });
    });
    await submit.click();
    await unavailableNotice(page);
    await submit.click();
    await unavailableNotice(page);
    evidence.uncertain_retry_same_key = keys[0] !== "" && keys[0] === keys[1];
    assert.equal(evidence.uncertain_retry_same_key, true);
    await nameInput.fill("Synthetic Document Beta");
    const beforeDouble = posts;
    await submit.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await page.getByRole("status").filter({ hasText: "文件已登記，案件文件已重新載入。" }).waitFor({ state: "visible" });
    evidence.changed_command_new_key = keys[2] !== "" && keys[2] !== keys[1];
    evidence.synchronous_double_post_count = posts - beforeDouble;
    evidence.receipt_exact = writeEvidence.status === 201 && writeEvidence.exactAck;
    assert.equal(evidence.changed_command_new_key, true);
    assert.equal(evidence.synchronous_double_post_count, 1);
    assert.equal(evidence.receipt_exact, true);
    await page.unroute(`**/api/v1/cases/${founderCase.caseId}/documents`);
    page.off("response", detailObserver);

    stage = "authoritative_detail_refresh";
    evidence.authoritative_detail_refresh = detailStatus === 200 && writeEvidence.id !== null && writeEvidence.version === 1;
    assert.equal(evidence.authoritative_detail_refresh, true);

    stage = "awaiting_upload_truthful";
    const awaiting = page.getByText("等待上載", { exact: true });
    await awaiting.first().waitFor({ state: "visible" });
    evidence.awaiting_upload_truthful = await awaiting.count() >= 1 && await page.getByText("Clean", { exact: true }).count() === 0;
    assert.equal(evidence.awaiting_upload_truthful, true);

    stage = "desktop_viewport";
    evidence.desktop_viewport = await viewportEvidence(page);
    assert.deepEqual(evidence.desktop_viewport, zeroViewport());

    stage = "directory_persistence";
    await openDocumentsDirectory(page, baseUrl);
    const documentLink = page.getByText("Synthetic Document Beta", { exact: true });
    await documentLink.waitFor({ state: "visible" });
    evidence.directory_persistence = await documentLink.count() === 1;
    assert.equal(evidence.directory_persistence, true);

    stage = "refresh_persistence";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Synthetic Document Beta", { exact: true }).waitFor({ state: "visible" });
    evidence.refresh_persistence = true;

    stage = "relogin_persistence";
    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!);
    await openDocumentsDirectory(page, baseUrl);
    await page.getByText("Synthetic Document Beta", { exact: true }).waitFor({ state: "visible" });
    evidence.relogin_persistence = true;

    stage = "advisor_registration";
    await logout(page);
    await login(page, baseUrl, ADVISOR.email, passwords.get("advisor")!);
    const advisorCase = await createCaseFixture(page, ADVISOR.roleBindingId, 2047);
    assert.equal(advisorCase.status, 200);
    assert.equal(advisorCase.exact, true);
    await openCaseDocuments(page, baseUrl, advisorCase.caseId!);
    await page.getByRole("textbox", { name: "文件名稱", exact: true }).fill("Synthetic Advisor Document");
    await page.getByRole("button", { name: "登記文件", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "文件已登記，案件文件已重新載入。" }).waitFor({ state: "visible" });
    evidence.advisor_registration = true;

    stage = "conflict_feedback";
    evidence.conflict_visible = await exerciseConflictFeedback(page, advisorCase.caseId!);
    assert.equal(evidence.conflict_visible, true);

    stage = "mobile_viewport";
    await page.setViewportSize({ width: 390, height: 844 });
    evidence.mobile_viewport = await viewportEvidence(page);
    assert.deepEqual(evidence.mobile_viewport, zeroViewport());

    stage = "denied_roles";
    await page.setViewportSize({ width: 1440, height: 1000 });
    const denied = [];
    for (const actor of [ADMIN, DATA_REVIEWER, CONTRACTOR] as const) {
      await logout(page);
      await login(page, baseUrl, actor.email, passwords.get(actor.role)!);
      denied.push(await inspectDeniedRole(page, baseUrl, founderCase.caseId!));
    }
    evidence.denied_roles = denied.every((item) => item.entryHidden && item.status === 403 && item.forbidden && !item.privateEcho);
    assert.equal(evidence.denied_roles, true);

    stage = "browser_log_safety";
    const sensitiveValues = [
      ...actors.map((actor) => actor.email),
      ...passwords.values(), applicationPassword, "postgresql://", "tx_session=",
      "Synthetic Document Alpha", "Synthetic Document Beta", "Synthetic Advisor Document",
    ];
    evidence.sensitive_log_matches = browserMessages.filter((message) => sensitiveValues.some((value) => message.includes(value))).length;
    assert.equal(evidence.page_errors, 0);
    assert.equal(evidence.sensitive_log_matches, 0);
    assertNoSensitiveDevLogs(devServer, sensitiveValues);
    stage = "complete";
  } catch {
    failureStage = stage;
  } finally {
    cleanup.context_closed = await closeContext(context);
    cleanup.dev_stopped = await stopNextDev(devServer);
    cleanup.app_removed = await removeDirectory(appDirectory);
    cleanup.profile_removed = await removeDirectory(profileDirectory);
    cleanup.container_removed = !containerStarted || (await runDocker(["rm", "--force", containerName], "cleanup", undefined, true)).exitCode === 0;
    cleanup.volume_removed = !volumeCreated || (await runDocker(["volume", "rm", "--force", volumeName], "cleanup", undefined, true)).exitCode === 0;
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
  if (failureStage !== null || !cleanupComplete) throw new BrowserGateError(failureStage ?? "cleanup");
});

function principal(role: Actor) {
  const value = NEON_TEST_PRINCIPALS.find((candidate) => candidate.role === role);
  if (!value) throw new Error("Synthetic principal contract is incomplete.");
  return value as typeof value & { readonly role: Actor };
}

async function login(page: Page, baseUrl: string, email: string, password: string): Promise<void> {
  const navigation = await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  const emailInput = page.getByRole("textbox", { name: "測試帳號電郵", exact: true });
  const passwordInput = page.getByLabel("密碼", { exact: true });
  const submit = page.getByRole("button", { name: "登入測試工作台", exact: true });
  await emailInput.waitFor({ state: "visible" });
  await passwordInput.waitFor({ state: "visible" });
  await submit.waitFor({ state: "visible" });
  await emailInput.fill(email);
  await passwordInput.fill(password);
  const submitResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/auth/login");
  const accessResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me"));
  await submit.click();
  assert.equal((await submitResponse).status(), 303);
  await page.waitForURL((url) => url.pathname === "/today");
  assert.equal((await accessResponse).status(), 200);
  await page.getByRole("heading", { name: "今日工作", exact: true, level: 2 }).waitFor({ state: "visible" });
}

async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "帳戶選單", exact: true }).click();
  await page.getByRole("menuitem", { name: "登出", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/login");
}

async function createCaseFixture(page: Page, bindingId: string, intakeYear: number): Promise<CaseFixture> {
  return page.evaluate(async ({ binding, manifest, student, year }) => {
    const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    try {
      const response = await fetch("/api/v1/cases", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `doc01-case-${crypto.randomUUID()}` },
        body: JSON.stringify({ student_id: student, intake_year: year, admission_type: "transfer", primary_role_binding_id: binding, manifest_id: manifest }),
      });
      const root = await response.json() as unknown;
      if (!object(root) || !object(root.data) || !exact(root.data, ["id", "record_version"]) ||
          !uuid(root.data.id) || root.data.record_version !== 2) {
        return { status: response.status, exact: false, caseId: null };
      }
      const caseId = root.data.id;
      const authorityResponse = await fetch(`/api/v1/cases/${caseId}`);
      const authorityRoot = await authorityResponse.json() as unknown;
      if (authorityResponse.status !== 200 || !object(authorityRoot) || !object(authorityRoot.data) ||
          !exact(authorityRoot.data, ["case"]) || !object(authorityRoot.data.case)) {
        return { status: response.status, exact: false, caseId: null };
      }
      const record = authorityRoot.data.case;
      const keys = [
        "id", "caseNumber", "studentId", "studentName", "intakeYear", "admissionType",
        "stage", "workflowStatus", "recordVersion", "availableWorkflowActions", "updatedAt",
        "primaryRole", "assessmentId", "assessmentStatus", "manifestId",
        "primaryBindingLabel", "primaryUserId",
      ];
      const valid = exact(record, keys) && record.id === caseId && record.studentId === student &&
        record.intakeYear === year && record.admissionType === "transfer" &&
        record.stage === "background_collection" && record.workflowStatus === "active" &&
        record.recordVersion === root.data.record_version && record.manifestId === manifest;
      return { status: response.status, exact: valid, caseId: valid ? caseId : null };
    } catch {
      return { status: null, exact: false, caseId: null };
    }
  }, { binding: bindingId, manifest: NEON_TEST_MANIFEST_ID, student: NEON_TEST_STUDENTS[0]!.id, year: intakeYear });
}

async function openCaseDocuments(page: Page, baseUrl: string, caseId: string): Promise<void> {
  const list = page.waitForResponse((response) => isGetPath(response, `/api/v1/cases/${caseId}/documents`));
  const access = page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me"));
  const navigation = await page.goto(`${baseUrl}/cases/${caseId}`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  assert.equal((await list).status(), 200);
  assert.equal((await access).status(), 200);
  await page.getByRole("heading", { name: "案件文件", exact: true, level: 3 }).waitFor({ state: "visible" });
}

async function openCaseDocumentsWithLoadingEvidence(page: Page, baseUrl: string, caseId: string): Promise<boolean> {
  let releaseList!: () => void;
  const held = new Promise<void>((resolveHeld) => { releaseList = resolveHeld; });
  const routePattern = `**/api/v1/cases/${caseId}/documents`;
  await page.route(routePattern, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await held;
    return route.continue();
  });
  const list = page.waitForResponse((response) => isGetPath(response, `/api/v1/cases/${caseId}/documents`));
  const access = page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me"));
  const navigation = page.goto(`${baseUrl}/cases/${caseId}`, { waitUntil: "domcontentloaded" });
  try {
    const loading = page.getByText("正在載入案件文件", { exact: true });
    await loading.waitFor({ state: "visible" });
    const visible = await loading.count() === 1;
    releaseList();
    assert.equal((await navigation)?.status(), 200);
    assert.equal((await list).status(), 200);
    assert.equal((await access).status(), 200);
    await page.getByRole("heading", { name: "案件文件", exact: true, level: 3 }).waitFor({ state: "visible" });
    await loading.waitFor({ state: "hidden" });
    return visible;
  } finally {
    releaseList();
    await Promise.allSettled([navigation, list, access]);
    await page.unroute(routePattern);
  }
}

async function openDocumentsDirectory(page: Page, baseUrl: string): Promise<void> {
  const list = page.waitForResponse((response) => isGetPath(response, "/api/v1/documents"));
  const access = page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me"));
  const navigation = await page.goto(`${baseUrl}/documents`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  assert.equal((await list).status(), 200);
  assert.equal((await access).status(), 200);
  await page.getByRole("heading", { name: "文件目錄", exact: true, level: 3 }).waitFor({ state: "visible" });
}

async function unavailableNotice(page: Page): Promise<void> {
  await page.getByRole("alert").filter({ hasText: "結果暫時無法確認" }).waitFor({ state: "visible" });
}

function safeWriteEvidence(status: number, text: string): WriteEvidence {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { status, jsonParseable: false, exactAck: false, id: null, version: null }; }
  if (!isObject(value) || !isObject(value.data) || !hasExactKeys(value.data, ["id", "record_version"])) return { status, jsonParseable: true, exactAck: false, id: null, version: null };
  const id = isUuid(value.data.id) ? value.data.id : null;
  const valid = id !== null && value.data.record_version === 1;
  return { status, jsonParseable: true, exactAck: valid, id: valid ? id : null, version: valid ? 1 : null };
}

async function exerciseConflictFeedback(page: Page, caseId: string): Promise<boolean> {
  const nameInput = page.getByRole("textbox", { name: "文件名稱", exact: true });
  const submit = page.getByRole("button", { name: "登記文件", exact: true });
  await nameInput.fill("Synthetic UI conflict value");
  let capturedKey = "";
  const routePattern = `**/api/v1/cases/${caseId}/documents`;
  await page.route(routePattern, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    capturedKey = route.request().headers()["idempotency-key"] ?? "";
    return route.abort("timedout");
  });
  await submit.click();
  await unavailableNotice(page);
  await page.unroute(routePattern);
  assert.notEqual(capturedKey, "");
  const seed = await page.evaluate(async ({ id, key }) => {
    const privateValue = "Synthetic conflicting server value";
    try {
      const response = await fetch(`/api/v1/cases/${id}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ display_name: privateValue, classification: "identity_and_case_evidence" }),
      });
      const text = await response.text();
      return { status: response.status, privateEcho: text.includes(privateValue) };
    } catch { return { status: null, privateEcho: false }; }
  }, { id: caseId, key: capturedKey });
  assert.equal(seed.status, 201);
  assert.equal(seed.privateEcho, false);
  const conflictResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/cases/${caseId}/documents`);
  await submit.click();
  const response = await conflictResponse;
  const feedback = page.getByRole("alert").filter({ hasText: "目前案件狀態或本次登記內容有衝突" });
  await feedback.waitFor({ state: "visible" });
  return response.status() === 409 && await feedback.count() === 1;
}

async function inspectDeniedRole(page: Page, baseUrl: string, caseId: string) {
  const navigation = await page.goto(`${baseUrl}/documents`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  await page.getByText("無法查看文件", { exact: true }).waitFor({ state: "visible" });
  const entryHidden = await page.getByRole("link", { name: "文件", exact: true }).count() === 0;
  const result = await page.evaluate(async ({ id }) => {
    const privateValue = "Synthetic denied private value";
    try {
      const response = await fetch(`/api/v1/cases/${id}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `doc01-denied-${crypto.randomUUID()}` },
        body: JSON.stringify({ display_name: privateValue, classification: "identity_and_case_evidence" }),
      });
      const text = await response.text();
      let forbidden = false;
      try { forbidden = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code === "FORBIDDEN"; } catch {}
      return { status: response.status, forbidden, privateEcho: text.includes(privateValue) };
    } catch { return { status: null, forbidden: false, privateEcho: false }; }
  }, { id: caseId });
  return { entryHidden, ...result };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isGetPath(response: { request(): { method(): string }; url(): string }, pathname: string): boolean {
  return response.request().method() === "GET" && new URL(response.url()).pathname === pathname;
}

function zeroViewport(): ViewportEvidence {
  return { horizontal_overflow: 0, out_of_bounds_controls: 0, overlapping_controls: 0, clipped_text: 0 };
}

async function viewportEvidence(page: Page): Promise<ViewportEvidence> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const visible = [...document.querySelectorAll<HTMLElement>("a,button,input,select,textarea")].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const outOfBounds = visible.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > root.clientWidth + 1;
    }).length;
    let overlapping = 0;
    for (let left = 0; left < visible.length; left += 1) {
      const first = visible[left]!.getBoundingClientRect();
      for (let right = left + 1; right < visible.length; right += 1) {
        if (visible[left]!.contains(visible[right]!) || visible[right]!.contains(visible[left]!)) continue;
        const second = visible[right]!.getBoundingClientRect();
        if (Math.min(first.right, second.right) - Math.max(first.left, second.left) > 2 && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 2) overlapping += 1;
      }
    }
    return {
      horizontal_overflow: Math.max(0, root.scrollWidth - root.clientWidth),
      out_of_bounds_controls: outOfBounds,
      overlapping_controls: overlapping,
      clipped_text: visible.filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "hidden").length,
    };
  });
}

async function discoverCanonicalBaseUrl(listenUrl: string, port: number): Promise<string> {
  const response = await fetch(`${listenUrl}/api/auth/login`, { redirect: "manual" });
  const location = response.headers.get("location");
  assert.equal(response.status, 307);
  assert.notEqual(location, null);
  const target = new URL(location!, listenUrl);
  assert.equal(target.pathname, "/api/v1/auth/login");
  assert.equal(target.protocol, "http:");
  assert.equal(["localhost", "127.0.0.1", "::1", "[::1]"].includes(target.hostname.toLowerCase()), true);
  assert.equal(target.port, String(port));
  assert.equal(target.username, "");
  assert.equal(target.password, "");
  assert.equal(target.search, "");
  assert.equal(target.hash, "");
  return target.origin;
}

async function createIsolatedAppDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tianxing-doc01-browser-next-"));
  const excluded = new Set([".git", ".next", "node_modules"]);
  try {
    for (const entry of await readdir(process.cwd())) {
      if (excluded.has(entry) || entry.startsWith(".env") || [".DS_Store", ".idea", ".kition", ".pnpm-store"].includes(entry)) continue;
      await cp(resolve(entry), join(directory, entry), { recursive: true });
    }
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    return directory;
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new BrowserGateError("next_dev");
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
  assert.notEqual(logs, undefined);
  const combined = `${logs!.stdout}\n${logs!.stderr}`;
  assert.equal(forbidden.some((value) => value !== "" && combined.includes(value)), false);
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  child.stdout?.resume();
  child.stderr?.resume();
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new BrowserGateError("next_dev");
    try { if ((await fetch(`${baseUrl}/api/v1/auth/me`)).status === 401) return; } catch {}
    await delay(500);
  }
  throw new BrowserGateError("next_dev");
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

async function closeContext(context: BrowserContext | undefined): Promise<boolean> {
  if (!context) return true;
  try { await context.close(); return true; } catch { return false; }
}

async function removeDirectory(directory: string): Promise<boolean> {
  if (!directory) return true;
  try { await rm(directory, { recursive: true, force: true }); return true; } catch { return false; }
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

function localTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({
    connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`,
    host: "127.0.0.1", port, database: "tianxing", user: ONE_ROLE_CANONICAL_ROLE, ssl: false,
  });
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await runDocker(["exec", containerName, "/bin/sh", "/usr/local/bin/tianxing-postgres-healthcheck"], "postgres_setup", undefined, true);
    if (result.exitCode === 0) return;
    await delay(250);
  }
  throw new BrowserGateError("postgres_setup");
}

function readLoopbackPort(output: string): number {
  const port = Number(/^127\.0\.0\.1:([0-9]+)\s*$/.exec(output)?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new BrowserGateError("postgres_setup");
  return port;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => reject(new BrowserGateError("next_dev")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(new BrowserGateError("next_dev")) : resolvePort(port));
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class BrowserGateError extends Error {
  readonly stage: Stage;
  constructor(stage: Stage) {
    super(`DOC-01 browser gate failed at ${stage}.`);
    this.name = "BrowserGateError";
    this.stage = stage;
  }
}

async function runDocker(
  arguments_: readonly string[],
  stage: Stage,
  input?: string,
  allowFailure = false,
): Promise<Readonly<{ exitCode: number; stdout: string }>> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(DOCKER, arguments_, { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.resume();
    child.once("error", () => reject(new BrowserGateError(stage)));
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !allowFailure) reject(new BrowserGateError(stage));
      else resolveRun(Object.freeze({ exitCode, stdout }));
    });
    child.stdin.end(input);
  });
}
