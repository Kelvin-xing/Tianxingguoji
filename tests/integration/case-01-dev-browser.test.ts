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
const FOUNDER = NEON_TEST_PRINCIPALS.find(({ role }) => role === "founder")!;
const ADVISOR = NEON_TEST_PRINCIPALS.find(({ role }) => role === "advisor")!;
const ADMIN = NEON_TEST_PRINCIPALS.find(({ role }) => role === "admin")!;

const LOGIN_STAGES = Object.freeze([
  "login_page_render", "login_form_ready", "login_submit_response", "login_redirect",
  "login_session_response", "login_workspace_render",
] as const);
type LoginStage = (typeof LOGIN_STAGES)[number];
type LoginActor = "founder" | "advisor" | "admin";

const STAGES = Object.freeze([
  "runtime_preflight", "postgres_setup", "baseline_seed", "identity_provision",
  "next_dev", "canonical_origin", "chrome_launch", ...LOGIN_STAGES, "founder_entry",
  "client_validation", "idempotency_retry", "founder_create", "list_persistence",
  "detail_refresh", "relogin_persistence", "conflict", "advisor_entry",
  "advisor_create", "admin_hidden_entry", "admin_direct_403",
  "desktop_viewport", "mobile_viewport", "browser_log_safety", "cleanup", "complete",
] as const);
type BrowserStage = (typeof STAGES)[number];

interface GateEvidence {
  founder_entry: boolean;
  advisor_entry: boolean;
  admin_entry_hidden: boolean;
  validation_zero_post: boolean;
  uncertain_retry_same_key: boolean;
  changed_field_new_key: boolean;
  synchronous_double_post_count: number | null;
  founder_created: boolean;
  advisor_created: boolean;
  list_persisted: boolean;
  detail_refreshed: boolean;
  relogin_persisted: boolean;
  conflict_visible: boolean;
  admin_direct_status: number | null;
  admin_direct_forbidden: boolean;
  admin_error_private_echo: boolean | null;
  desktop_overflow: number | null;
  desktop_out_of_bounds: number | null;
  mobile_overflow: number | null;
  mobile_out_of_bounds: number | null;
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

interface LoginEvidence {
  actor: LoginActor | null;
  page_status: number | null;
  page_pathname: "/login" | "other" | null;
  email_field_count: number | null;
  password_field_count: number | null;
  submit_button_count: number | null;
  submit_status: number | null;
  redirect_pathname: "/today" | "other" | null;
  auth_me_status: number | null;
  workspace_heading_count: number | null;
}

const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

test("CASE-01 works through a real local browser and disposable PostgreSQL 17", {
  timeout: 360_000,
}, async () => {
  let stage: BrowserStage = "runtime_preflight";
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-case01-browser-pg17-${suffix}`;
  const volumeName = `tianxing-case01-browser-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const passwords = new Map([FOUNDER, ADVISOR, ADMIN].map((principal) => [
    principal.role,
    randomBytes(32).toString("base64url"),
  ]));
  const evidence: GateEvidence = {
    founder_entry: false,
    advisor_entry: false,
    admin_entry_hidden: false,
    validation_zero_post: false,
    uncertain_retry_same_key: false,
    changed_field_new_key: false,
    synchronous_double_post_count: null,
    founder_created: false,
    advisor_created: false,
    list_persisted: false,
    detail_refreshed: false,
    relogin_persisted: false,
    conflict_visible: false,
    admin_direct_status: null,
    admin_direct_forbidden: false,
    admin_error_private_echo: null,
    desktop_overflow: null,
    desktop_out_of_bounds: null,
    mobile_overflow: null,
    mobile_out_of_bounds: null,
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
  const loginEvidence: LoginEvidence = emptyLoginEvidence();
  let containerStarted = false;
  let volumeCreated = false;
  let appDirectory = "";
  let profileDirectory = "";
  let devServer: ChildProcess | undefined;
  let context: BrowserContext | undefined;
  let failureStage: BrowserStage | null = null;

  try {
    assert.equal(STAGES.includes(stage), true);
    await Promise.all([access(DOCKER), access(CHROME)]);
    await runDocker(["image", "inspect", POSTGRES_IMAGE], "runtime_preflight");

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
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply", target, build, dependencies: baselineDependencies(target),
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.baseline_id, ONE_ROLE_BASELINE_ID);
    assert.equal((await seedNeonTestRelease1(target, "apply")).status, "pass");

    stage = "identity_provision";
    for (const principal of [FOUNDER, ADVISOR, ADMIN]) {
      assert.equal(await provision(target, principal.email, passwords.get(principal.role)!), "created");
    }

    stage = "next_dev";
    appDirectory = await createIsolatedAppDirectory();
    profileDirectory = await mkdtemp(join(tmpdir(), "tianxing-case01-chrome-"));
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
    page.on("pageerror", () => { evidence.page_errors += 1; });
    const browserMessages: string[] = [];
    page.on("console", (message) => { browserMessages.push(message.text()); });

    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!, "founder", loginEvidence, (value) => { stage = value; });

    stage = "founder_entry";
    await openCases(page, baseUrl);
    const founderCreateLink = page.getByRole("link", { name: "建立案件", exact: true });
    await founderCreateLink.waitFor({ state: "visible" });
    evidence.founder_entry = await founderCreateLink.count() === 1;
    assert.equal(evidence.founder_entry, true);
    await openCreateForm(page, founderCreateLink);

    stage = "client_validation";
    let validationPosts = 0;
    const countValidationPost = (request: { method(): string; url(): string }) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/cases") validationPosts += 1;
    };
    page.on("request", countValidationPost);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "請先選擇一名學生。" }).waitFor({ state: "visible" });
    page.off("request", countValidationPost);
    evidence.validation_zero_post = validationPosts === 0;
    assert.equal(evidence.validation_zero_post, true);
    await fillCaseWizard(page, {
      studentId: NEON_TEST_STUDENTS[0]!.id,
      intakeYear: "2027",
      admissionType: "transfer",
      bindingId: FOUNDER.roleBindingId,
    });

    stage = "idempotency_retry";
    const observedKeys: string[] = [];
    let postCount = 0;
    await page.route("**/api/v1/cases", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      postCount += 1;
      observedKeys.push(route.request().headers()["idempotency-key"] ?? "");
      if (postCount <= 2) await route.abort("timedout");
      else await route.continue();
    });
    const createButton = page.getByRole("button", { name: "建立案件", exact: true });
    await createButton.click();
    await waitUntil(() => postCount === 1);
    await unavailableAlert(page);
    await createButton.click();
    await waitUntil(() => postCount === 2);
    await unavailableAlert(page);
    evidence.uncertain_retry_same_key = observedKeys[0] !== "" && observedKeys[0] === observedKeys[1];
    assert.equal(evidence.uncertain_retry_same_key, true);

    await page.getByRole("button", { name: "上一步", exact: true }).click();
    await page.getByRole("button", { name: "上一步", exact: true }).click();
    await page.getByRole("spinbutton", { name: "入學年度", exact: true }).fill("2028");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    const beforeDouble = postCount;
    await createButton.evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await page.waitForURL((url) => /^\/cases\/[0-9a-f-]+$/i.test(url.pathname));
    const founderCasePath = new URL(page.url()).pathname;
    evidence.changed_field_new_key = observedKeys[2] !== "" && observedKeys[2] !== observedKeys[1];
    evidence.synchronous_double_post_count = postCount - beforeDouble;
    evidence.founder_created = /^\/cases\/[0-9a-f-]+$/i.test(founderCasePath);
    assert.equal(evidence.changed_field_new_key, true);
    assert.equal(evidence.synchronous_double_post_count, 1);
    assert.equal(evidence.founder_created, true);
    await page.unroute("**/api/v1/cases");
    await page.getByRole("heading", { name: "案件身份", exact: true, level: 3 }).waitFor({ state: "visible" });

    stage = "desktop_viewport";
    const desktop = await viewportEvidence(page);
    evidence.desktop_overflow = desktop.overflow;
    evidence.desktop_out_of_bounds = desktop.outOfBounds;
    assert.deepEqual(desktop, { overflow: 0, outOfBounds: 0 });

    stage = "list_persistence";
    await openCases(page, baseUrl);
    const founderCaseLink = page.locator(`a[href="${founderCasePath}"]`).first();
    await founderCaseLink.waitFor({ state: "visible" });
    evidence.list_persisted = await founderCaseLink.count() >= 1;
    assert.equal(evidence.list_persisted, true);

    stage = "detail_refresh";
    await page.goto(`${baseUrl}${founderCasePath}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "案件身份", exact: true, level: 3 }).waitFor({ state: "visible" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "案件身份", exact: true, level: 3 }).waitFor({ state: "visible" });
    evidence.detail_refreshed = true;

    stage = "relogin_persistence";
    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!, "founder", loginEvidence, (value) => { stage = value; });
    stage = "relogin_persistence";
    await page.goto(`${baseUrl}${founderCasePath}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "案件身份", exact: true, level: 3 }).waitFor({ state: "visible" });
    evidence.relogin_persisted = true;

    stage = "conflict";
    await openCreateFormDirect(page, baseUrl);
    await fillCaseWizard(page, {
      studentId: NEON_TEST_STUDENTS[0]!.id,
      intakeYear: "2028",
      admissionType: "transfer",
      bindingId: FOUNDER.roleBindingId,
    });
    await page.getByRole("button", { name: "建立案件", exact: true }).click();
    const conflict = page.getByRole("alert").filter({ hasText: "已有相同入學設定的進行中案件" });
    await conflict.waitFor({ state: "visible" });
    evidence.conflict_visible = await conflict.count() === 1;
    assert.equal(evidence.conflict_visible, true);

    await logout(page);
    await login(page, baseUrl, ADVISOR.email, passwords.get("advisor")!, "advisor", loginEvidence, (value) => { stage = value; });
    stage = "advisor_entry";
    await openCases(page, baseUrl);
    const advisorCreateLink = page.getByRole("link", { name: "建立案件", exact: true });
    await advisorCreateLink.waitFor({ state: "visible" });
    evidence.advisor_entry = await advisorCreateLink.count() === 1;
    assert.equal(evidence.advisor_entry, true);

    stage = "advisor_create";
    await openCreateForm(page, advisorCreateLink);
    await fillCaseWizard(page, {
      studentId: NEON_TEST_STUDENTS[1]!.id,
      intakeYear: "2029",
      admissionType: "s1_admission",
      bindingId: ADVISOR.roleBindingId,
    });
    await page.getByRole("button", { name: "建立案件", exact: true }).click();
    await page.waitForURL((url) => /^\/cases\/[0-9a-f-]+$/i.test(url.pathname));
    await page.getByRole("heading", { name: "案件身份", exact: true, level: 3 }).waitFor({ state: "visible" });
    evidence.advisor_created = true;

    stage = "mobile_viewport";
    await page.setViewportSize({ width: 390, height: 844 });
    await openCases(page, baseUrl);
    const mobile = await viewportEvidence(page);
    evidence.mobile_overflow = mobile.overflow;
    evidence.mobile_out_of_bounds = mobile.outOfBounds;
    assert.deepEqual(mobile, { overflow: 0, outOfBounds: 0 });

    await logout(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, baseUrl, ADMIN.email, passwords.get("admin")!, "admin", loginEvidence, (value) => { stage = value; });

    stage = "admin_hidden_entry";
    await page.goto(`${baseUrl}/cases`, { waitUntil: "domcontentloaded" });
    await page.getByText("無法查看案件", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("link", { name: "建立案件", exact: true }).count(), 0);
    await page.goto(`${baseUrl}/cases/new`, { waitUntil: "domcontentloaded" });
    await page.getByText("無法建立案件", { exact: true }).waitFor({ state: "visible" });
    evidence.admin_entry_hidden = await page.getByRole("button", { name: "建立案件", exact: true }).count() === 0;
    assert.equal(evidence.admin_entry_hidden, true);

    stage = "admin_direct_403";
    const direct = await page.evaluate(async (payload) => {
      const response = await fetch("/api/v1/cases", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `admin-denied-${crypto.randomUUID()}` },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      let code: "FORBIDDEN" | "OTHER" = "OTHER";
      try {
        const value = JSON.parse(text) as { error?: { code?: unknown } };
        if (value.error?.code === "FORBIDDEN") code = "FORBIDDEN";
      } catch {}
      return {
        status: response.status,
        code,
        privateEcho: Object.values(payload).some((value) => text.includes(String(value))),
      };
    }, {
      student_id: NEON_TEST_STUDENTS[0]!.id,
      intake_year: 2030,
      admission_type: "transfer",
      primary_role_binding_id: FOUNDER.roleBindingId,
      manifest_id: NEON_TEST_MANIFEST_ID,
    });
    evidence.admin_direct_status = direct.status;
    evidence.admin_direct_forbidden = direct.code === "FORBIDDEN";
    evidence.admin_error_private_echo = direct.privateEcho;
    assert.equal(evidence.admin_direct_status, 403);
    assert.equal(evidence.admin_direct_forbidden, true);
    assert.equal(evidence.admin_error_private_echo, false);

    stage = "browser_log_safety";
    const forbiddenLogValues = [
      ...NEON_TEST_STUDENTS.flatMap((student) => [student.displayName, student.contactEmail ?? ""]),
      ...[FOUNDER, ADVISOR, ADMIN].map(({ email }) => email),
      ...passwords.values(), applicationPassword, "postgresql://", "tx_session=",
    ].filter(Boolean);
    evidence.sensitive_log_matches = browserMessages.filter((message) =>
      forbiddenLogValues.some((value) => message.includes(value))).length;
    assert.equal(evidence.page_errors, 0);
    assert.equal(evidence.sensitive_log_matches, 0);
    assertNoSensitiveDevLogs(devServer, forbiddenLogValues);
    stage = "complete";
  } catch {
    failureStage = stage;
  } finally {
    stage = "cleanup";
    cleanup.context_closed = await closeContext(context);
    cleanup.dev_stopped = await stopNextDev(devServer);
    cleanup.app_removed = await removeDirectory(appDirectory);
    cleanup.profile_removed = await removeDirectory(profileDirectory);
    cleanup.container_removed = !containerStarted || (await runDocker(["rm", "--force", containerName], stage, undefined, true)).exitCode === 0;
    cleanup.volume_removed = !volumeCreated || (await runDocker(["volume", "rm", "--force", volumeName], stage, undefined, true)).exitCode === 0;
  }

  const cleanupComplete = Object.values(cleanup).every(Boolean);
  process.stdout.write(`${JSON.stringify({
    status: failureStage === null && cleanupComplete ? "pass" : "failed",
    stage: failureStage ?? (cleanupComplete ? "complete" : "cleanup"),
    evidence,
    login: loginEvidence,
    cleanup,
    local_dev: failureStage === null && cleanupComplete ? "pass" : "failed",
    vercel_test: "not_run_unverified",
    aws_production: "not_run_unverified",
  })}\n`);
  if (failureStage !== null || !cleanupComplete) throw new BrowserGateError(failureStage ?? "cleanup");
});

async function openCases(page: Page, baseUrl: string): Promise<void> {
  const accessResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me"));
  const casesResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/cases"));
  const navigation = await page.goto(`${baseUrl}/cases`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  assert.equal((await accessResponse).status(), 200);
  assert.equal((await casesResponse).status(), 200);
  await page.getByRole("heading", { name: "案件", exact: true, level: 2 }).waitFor({ state: "visible" });
  await page.getByText("正在載入案件", { exact: true }).waitFor({ state: "hidden" });
}

async function openCreateForm(page: Page, entry: ReturnType<Page["getByRole"]>): Promise<void> {
  const accessResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me"));
  const optionsResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/cases/options"));
  await entry.click();
  await page.waitForURL((url) => url.pathname === "/cases/new");
  assert.equal((await accessResponse).status(), 200);
  assert.equal((await optionsResponse).status(), 200);
  await assertCreateControls(page);
}

async function openCreateFormDirect(page: Page, baseUrl: string): Promise<void> {
  const accessResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me"));
  const optionsResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/cases/options"));
  const navigation = await page.goto(`${baseUrl}/cases/new`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  assert.equal((await accessResponse).status(), 200);
  assert.equal((await optionsResponse).status(), 200);
  await assertCreateControls(page);
}

async function assertCreateControls(page: Page): Promise<void> {
  await page.getByRole("heading", { name: "建立案件", exact: true, level: 2 }).waitFor({ state: "visible" });
  const student = page.getByRole("combobox", { name: "學生", exact: true });
  await student.waitFor({ state: "visible" });
  assert.equal(await student.count(), 1);
  assert.equal(await page.getByRole("button", { name: "下一步", exact: true }).count(), 1);
}

async function fillCaseWizard(page: Page, input: {
  studentId: string;
  intakeYear: string;
  admissionType: "s1_admission" | "transfer";
  bindingId: string;
}): Promise<void> {
  await page.getByRole("combobox", { name: "學生", exact: true }).selectOption(input.studentId);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("spinbutton", { name: "入學年度", exact: true }).fill(input.intakeYear);
  await page.getByRole("combobox", { name: "申請類型", exact: true }).selectOption(input.admissionType);
  await page.getByRole("combobox", { name: "主要負責人", exact: true }).selectOption(input.bindingId);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("combobox", { name: "評估表版本", exact: true }).selectOption(NEON_TEST_MANIFEST_ID);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("heading", { name: "檢查並建立", exact: true, level: 3 }).waitFor({ state: "visible" });
}

async function unavailableAlert(page: Page): Promise<void> {
  await page.getByRole("alert").filter({ hasText: "案件服務暫時不可用" }).waitFor({ state: "visible" });
}

async function login(
  page: Page,
  baseUrl: string,
  email: string,
  password: string,
  actor: LoginActor,
  evidence: LoginEvidence,
  setStage: (stage: LoginStage) => void,
): Promise<void> {
  Object.assign(evidence, emptyLoginEvidence(), { actor });
  setStage("login_page_render");
  const navigation = await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  evidence.page_status = navigation?.status() ?? null;
  evidence.page_pathname = safeLoginPathname(page.url(), "/login");
  assert.equal(evidence.page_status, 200);
  assert.equal(evidence.page_pathname, "/login");

  setStage("login_form_ready");
  const emailField = page.getByRole("textbox", { name: "測試帳號電郵", exact: true });
  const passwordField = page.getByLabel("密碼", { exact: true });
  const submitButton = page.getByRole("button", { name: "登入測試工作台", exact: true });
  await emailField.waitFor({ state: "visible" });
  await passwordField.waitFor({ state: "visible" });
  await submitButton.waitFor({ state: "visible" });
  evidence.email_field_count = await emailField.count();
  evidence.password_field_count = await passwordField.count();
  evidence.submit_button_count = await submitButton.count();
  assert.equal(evidence.email_field_count, 1);
  assert.equal(evidence.password_field_count, 1);
  assert.equal(evidence.submit_button_count, 1);
  await emailField.fill(email);
  await passwordField.fill(password);
  const submitResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/auth/login");
  const authResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me"));

  setStage("login_submit_response");
  await submitButton.click();
  evidence.submit_status = (await submitResponse).status();
  assert.equal(evidence.submit_status, 303);

  setStage("login_redirect");
  await page.waitForURL((url) => url.pathname === "/today");
  evidence.redirect_pathname = safeLoginPathname(page.url(), "/today");
  assert.equal(evidence.redirect_pathname, "/today");

  setStage("login_session_response");
  evidence.auth_me_status = (await authResponse).status();
  assert.equal(evidence.auth_me_status, 200);

  setStage("login_workspace_render");
  const workspaceHeading = page.getByRole("heading", { name: "今日工作", exact: true, level: 2 });
  await workspaceHeading.waitFor({ state: "visible" });
  evidence.workspace_heading_count = await workspaceHeading.count();
  assert.equal(evidence.workspace_heading_count, 1);
}

function emptyLoginEvidence(): LoginEvidence {
  return {
    actor: null,
    page_status: null,
    page_pathname: null,
    email_field_count: null,
    password_field_count: null,
    submit_button_count: null,
    submit_status: null,
    redirect_pathname: null,
    auth_me_status: null,
    workspace_heading_count: null,
  };
}

function safeLoginPathname<T extends "/login" | "/today">(url: string, expected: T): T | "other" {
  return new URL(url).pathname === expected ? expected : "other";
}

async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "帳戶選單", exact: true }).click();
  await page.getByRole("menuitem", { name: "登出", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/login");
  await page.getByRole("textbox", { name: "測試帳號電郵", exact: true }).waitFor({ state: "visible" });
}

async function viewportEvidence(page: Page): Promise<{ overflow: number; outOfBounds: number }> {
  return page.evaluate(() => {
    const overflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const controls = [...document.querySelectorAll<HTMLElement>("a,button,input,select")].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    });
    const outOfBounds = controls.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > document.documentElement.clientWidth + 1;
    }).length;
    return { overflow, outOfBounds };
  });
}

function isGetPath(response: { request(): { method(): string }; url(): string }, pathname: string): boolean {
  return response.request().method() === "GET" && new URL(response.url()).pathname === pathname;
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
  const directory = await mkdtemp(join(tmpdir(), "tianxing-case01-browser-next-"));
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
    try {
      if ((await fetch(`${baseUrl}/api/v1/auth/me`)).status === 401) return;
    } catch {}
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
    const result = await runDocker([
      "exec", containerName, "/bin/sh", "/usr/local/bin/tianxing-postgres-healthcheck",
    ], "postgres_setup", undefined, true);
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(50);
  }
  throw new BrowserGateError("idempotency_retry");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class BrowserGateError extends Error {
  readonly stage: BrowserStage;
  constructor(stage: BrowserStage) {
    super(`CASE-01 browser gate failed at ${stage}.`);
    this.name = "BrowserGateError";
    this.stage = stage;
  }
}

async function runDocker(
  arguments_: readonly string[],
  stage: BrowserStage,
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
