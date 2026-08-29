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
  ONE_ROLE_SOURCE_COUNT,
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
  "detail_refresh", "workflow_controls", "pause_validation", "pause_retry",
  "pause_submit", "pause_authoritative_refresh", "pause_feedback",
  "paused_persistence", "relogin_persistence", "resume_submit",
  "resume_authoritative_refresh", "resume_feedback", "workflow_stale_seed",
  "workflow_stale_recovery", "conflict", "advisor_entry",
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
  create_receipt_exact: boolean;
  create_authoritative_get: boolean;
  founder_created: boolean;
  advisor_created: boolean;
  list_persisted: boolean;
  detail_refreshed: boolean;
  relogin_persisted: boolean;
  workflow_entry: boolean;
  founder_assessment_read_only: boolean;
  founder_assessment_full_15: boolean;
  advisor_assessment_full_editable_15: boolean;
  legacy_target_writes_absent: boolean;
  school_targets_read_only: boolean;
  paused_task_create_absent: boolean;
  paused_lists_readable: boolean;
  pause_validation_zero_post: boolean;
  pause_retry_same_key: boolean;
  pause_reason_rotated_key: boolean;
  pause_double_post_count: number | null;
  pause_receipt_exact: boolean;
  pause_authoritative_get: boolean;
  pause_success_visible: boolean;
  paused_reload_persisted: boolean;
  paused_relogin_persisted: boolean;
  resume_reason_absent: boolean;
  resume_receipt_exact: boolean;
  resume_authoritative_get: boolean;
  resume_success_visible: boolean;
  workflow_stale_visible: boolean;
  workflow_stale_recovered: boolean;
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

test.skip("CASE-01 legacy browser harness is superseded by the current Advisor-led Case contract", {
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
    create_receipt_exact: false,
    create_authoritative_get: false,
    founder_created: false,
    advisor_created: false,
    list_persisted: false,
    detail_refreshed: false,
    relogin_persisted: false,
    workflow_entry: false,
    founder_assessment_read_only: false,
    founder_assessment_full_15: false,
    advisor_assessment_full_editable_15: false,
    legacy_target_writes_absent: false,
    school_targets_read_only: false,
    paused_task_create_absent: false,
    paused_lists_readable: false,
    pause_validation_zero_post: false,
    pause_retry_same_key: false,
    pause_reason_rotated_key: false,
    pause_double_post_count: null,
    pause_receipt_exact: false,
    pause_authoritative_get: false,
    pause_success_visible: false,
    paused_reload_persisted: false,
    paused_relogin_persisted: false,
    resume_reason_absent: false,
    resume_receipt_exact: false,
    resume_authoritative_get: false,
    resume_success_visible: false,
    workflow_stale_visible: false,
    workflow_stale_recovered: false,
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
    assert.equal(build.files.length, ONE_ROLE_SOURCE_COUNT + 1);
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
      bindingId: ADVISOR.roleBindingId,
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
    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/cases");
    const createAuthorityResponse = page.waitForResponse((response) =>
      response.request().method() === "GET" && /^\/api\/v1\/cases\/[0-9a-f-]+$/i.test(new URL(response.url()).pathname));
    await createButton.evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    const createReceipt = await exactCaseReceipt(await createResponse);
    const createdAuthority = await exactCaseAuthority(await createAuthorityResponse, createReceipt.id);
    await page.waitForURL((url) => /^\/cases\/[0-9a-f-]+$/i.test(url.pathname));
    const founderCasePath = new URL(page.url()).pathname;
    const founderCaseId = founderCasePath.split("/").at(-1)!;
    evidence.changed_field_new_key = observedKeys[2] !== "" && observedKeys[2] !== observedKeys[1];
    evidence.synchronous_double_post_count = postCount - beforeDouble;
    evidence.create_receipt_exact = createReceipt.id === founderCaseId;
    evidence.create_authoritative_get = createdAuthority.id === createReceipt.id &&
      createdAuthority.recordVersion === createReceipt.recordVersion &&
      createdAuthority.stage === "background_collection" && createdAuthority.workflowStatus === "active";
    evidence.founder_created = /^\/cases\/[0-9a-f-]+$/i.test(founderCasePath);
    assert.equal(evidence.changed_field_new_key, true);
    assert.equal(evidence.synchronous_double_post_count, 1);
    assert.equal(evidence.create_receipt_exact, true);
    assert.equal(evidence.create_authoritative_get, true);
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

    const workflowPath = `/api/v1/cases/${founderCaseId}/workflow-actions`;
    const caseApiPath = `/api/v1/cases/${founderCaseId}`;
    const workflowSection = page.locator('section[aria-labelledby="case-workflow-command-title"]');

    stage = "workflow_controls";
    await workflowSection.getByRole("heading", { name: "案件流程", exact: true, level: 3 }).waitFor({ state: "visible" });
    const pauseReason = workflowSection.getByRole("textbox", { name: "暫停原因", exact: true });
    const pauseButton = workflowSection.getByRole("button", { name: "暫停案件", exact: true });
    evidence.workflow_entry = await pauseButton.count() === 1;
    assert.equal(await pauseReason.count(), 0);
    await pauseButton.click();
    await pauseReason.waitFor({ state: "visible" });
    const confirmPauseButton = workflowSection.getByRole("button", { name: "確認暫停", exact: true });
    const assessmentReadOnly = page.getByText(
      "你目前可以查看評估，但沒有編輯權限。",
      { exact: true },
    );
    await assessmentReadOnly.waitFor({ state: "visible" });
    const founderAssessment = page.locator('section[aria-labelledby="assessment-editor-title"]');
    await founderAssessment.getByText(/15 項資料/).waitFor({ state: "visible" });
    evidence.founder_assessment_read_only = await assessmentReadOnly.count() === 1;
    evidence.founder_assessment_full_15 =
      await founderAssessment.getByText(/15 項資料/).count() === 1 &&
      await founderAssessment.getByRole("button", { name: "儲存", exact: true }).count() === 0;
    await page.getByRole("heading", { name: "學校目標", exact: true, level: 3 }).waitFor({ state: "visible" });
    evidence.legacy_target_writes_absent =
      await page.getByRole("button", { name: "建立候選目標", exact: true }).count() === 0 &&
      await page.getByRole("button", { name: /推進|回退|結果/ }).count() === 0;
    evidence.school_targets_read_only =
      await page.getByText("只讀", { exact: true }).count() >= 1 &&
      await page.getByText("此處只顯示現有目標；新增與流程變更由已核准的選校流程處理。", { exact: true }).count() === 1;
    assert.equal(evidence.workflow_entry, true);
    assert.equal(evidence.founder_assessment_read_only, true);
    assert.equal(evidence.founder_assessment_full_15, true);
    assert.equal(evidence.legacy_target_writes_absent, true);
    assert.equal(evidence.school_targets_read_only, true);
    assert.equal(await workflowSection.getByRole("button", { name: /推進|回退/ }).count(), 0);

    stage = "pause_validation";
    let validationWorkflowPosts = 0;
    const countWorkflowValidation = (request: { method(): string; url(): string }) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === workflowPath) {
        validationWorkflowPosts += 1;
      }
    };
    page.on("request", countWorkflowValidation);
    await pauseReason.fill(" ");
    assert.equal(await confirmPauseButton.isDisabled(), true);
    await confirmPauseButton.evaluate((button) => (button as HTMLButtonElement).click());
    page.off("request", countWorkflowValidation);
    evidence.pause_validation_zero_post = validationWorkflowPosts === 0;
    assert.equal(evidence.pause_validation_zero_post, true);

    stage = "pause_retry";
    const workflowKeys: string[] = [];
    let workflowPostCount = 0;
    await page.route(`**${workflowPath}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      workflowPostCount += 1;
      workflowKeys.push(route.request().headers()["idempotency-key"] ?? "");
      if (workflowPostCount <= 2) await route.abort("timedout");
      else await route.continue();
    });
    await pauseReason.fill("等待監護人補充資料");
    await confirmPauseButton.click();
    await waitUntil(() => workflowPostCount === 1);
    await workflowUnavailableAlert(page);
    await confirmPauseButton.click();
    await waitUntil(() => workflowPostCount === 2);
    await workflowUnavailableAlert(page);
    evidence.pause_retry_same_key = workflowKeys[0] !== "" && workflowKeys[0] === workflowKeys[1];
    assert.equal(evidence.pause_retry_same_key, true);

    await pauseReason.fill("等待監護人補充更新資料");
    const beforePauseDouble = workflowPostCount;
    const pauseResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === workflowPath);
    const pauseAuthorityResponse = page.waitForResponse((response) => isGetPath(response, caseApiPath));
    stage = "pause_submit";
    await confirmPauseButton.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    const pauseReceipt = await exactCaseReceipt(await pauseResponse, founderCaseId);
    evidence.pause_receipt_exact = true;
    const pausedAuthority = await exactCaseAuthority(await pauseAuthorityResponse, founderCaseId);
    stage = "pause_authoritative_refresh";
    evidence.pause_authoritative_get = pausedAuthority.recordVersion === pauseReceipt.recordVersion &&
      pausedAuthority.workflowStatus === "paused" &&
      pausedAuthority.availableWorkflowActions.length === 1 &&
      pausedAuthority.availableWorkflowActions[0] === "resume";
    evidence.pause_reason_rotated_key = workflowKeys[2] !== "" && workflowKeys[2] !== workflowKeys[1];
    evidence.pause_double_post_count = workflowPostCount - beforePauseDouble;
    assert.equal(evidence.pause_authoritative_get, true);
    assert.equal(evidence.pause_reason_rotated_key, true);
    assert.equal(evidence.pause_double_post_count, 1);
    await page.unroute(`**${workflowPath}`);

    stage = "pause_feedback";
    const pauseSuccess = workflowSection.getByRole("status").filter({ hasText: "案件已暫停，內容已重新載入。" });
    await pauseSuccess.waitFor({ state: "visible" });
    evidence.pause_success_visible = await pauseSuccess.count() === 1;
    assert.equal(evidence.pause_success_visible, true);

    stage = "paused_persistence";
    await page.reload({ waitUntil: "domcontentloaded" });
    await workflowSection.getByRole("button", { name: "恢復案件", exact: true }).waitFor({ state: "visible" });
    evidence.paused_reload_persisted = await workflowSection.getByText("已暫停", { exact: true }).count() >= 1;
    await page.getByRole("heading", { name: "案件任務", exact: true, level: 3 }).waitFor({ state: "visible" });
    evidence.paused_task_create_absent = await page.getByRole("button", { name: "建立任務", exact: true }).count() === 0;
    evidence.paused_lists_readable =
      await page.getByRole("heading", { name: "學校目標", exact: true, level: 3 }).count() === 1 &&
      await page.getByRole("heading", { name: "案件任務", exact: true, level: 3 }).count() === 1;
    const caseTasksToggle = page.getByRole("button", { name: "查看任務", exact: true });
    await caseTasksToggle.waitFor({ state: "visible" });
    await caseTasksToggle.click();
    await page.getByText("案件暫停期間不能建立臨時任務；現有任務仍可查看。", { exact: true }).waitFor({ state: "visible" });
    assert.equal(evidence.paused_reload_persisted, true);
    assert.equal(evidence.paused_task_create_absent, true);
    assert.equal(evidence.paused_lists_readable, true);

    stage = "relogin_persistence";
    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!, "founder", loginEvidence, (value) => { stage = value; });
    stage = "relogin_persistence";
    await page.goto(`${baseUrl}${founderCasePath}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "案件身份", exact: true, level: 3 }).waitFor({ state: "visible" });
    await workflowSection.getByRole("button", { name: "恢復案件", exact: true }).waitFor({ state: "visible" });
    evidence.paused_relogin_persisted = await workflowSection.getByText("已暫停", { exact: true }).count() >= 1;
    evidence.relogin_persisted = evidence.paused_relogin_persisted;
    assert.equal(evidence.relogin_persisted, true);

    const resumeButton = workflowSection.getByRole("button", { name: "恢復案件", exact: true });
    evidence.resume_reason_absent = await workflowSection.getByRole("textbox", { name: "恢復原因", exact: true }).count() === 0 &&
      await workflowSection.getByRole("textbox", { name: "暫停原因", exact: true }).count() === 0;
    assert.equal(evidence.resume_reason_absent, true);
    const resumeResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === workflowPath);
    const resumeAuthorityResponse = page.waitForResponse((response) => isGetPath(response, caseApiPath));
    stage = "resume_submit";
    await resumeButton.click();
    const resumeReceipt = await exactCaseReceipt(await resumeResponse, founderCaseId);
    evidence.resume_receipt_exact = true;
    const resumedAuthority = await exactCaseAuthority(await resumeAuthorityResponse, founderCaseId);
    stage = "resume_authoritative_refresh";
    evidence.resume_authoritative_get = resumedAuthority.recordVersion === resumeReceipt.recordVersion &&
      resumedAuthority.workflowStatus === "active" && resumedAuthority.availableWorkflowActions.includes("pause");
    assert.equal(evidence.resume_authoritative_get, true);
    stage = "resume_feedback";
    const resumeSuccess = workflowSection.getByRole("status").filter({ hasText: "案件已恢復，內容已重新載入。" });
    await resumeSuccess.waitFor({ state: "visible" });
    evidence.resume_success_visible = await resumeSuccess.count() === 1;
    assert.equal(evidence.resume_success_visible, true);

    stage = "workflow_stale_seed";
    const staleSeed = await directWorkflowAction(page, {
      caseId: founderCaseId,
      action: "pause",
      expectedRecordVersion: resumedAuthority.recordVersion,
      reason: "建立陳舊版本驗收狀態",
    });
    assert.equal(staleSeed.status, 200);
    assert.equal(staleSeed.receiptExact, true);
    const staleResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === workflowPath);
    const staleAuthorityResponse = page.waitForResponse((response) => isGetPath(response, caseApiPath));
    const stalePauseButton = workflowSection.getByRole("button", { name: "暫停案件", exact: true });
    await stalePauseButton.click();
    await workflowSection.getByRole("textbox", { name: "暫停原因", exact: true }).fill("提交陳舊版本以重新載入");
    await workflowSection.getByRole("button", { name: "確認暫停", exact: true }).click();
    const staleResult = await safeApiError(await staleResponse);
    const staleAuthority = await exactCaseAuthority(await staleAuthorityResponse, founderCaseId);
    stage = "workflow_stale_recovery";
    const staleAlert = workflowSection.getByRole("alert").filter({ hasText: "案件已被其他人更新，已重新載入目前版本。" });
    await staleAlert.waitFor({ state: "visible" });
    evidence.workflow_stale_visible = staleResult.status === 409 && staleResult.code === "STALE_VERSION" &&
      await staleAlert.count() === 1;
    evidence.workflow_stale_recovered = staleAuthority.workflowStatus === "paused" &&
      await workflowSection.getByRole("button", { name: "恢復案件", exact: true }).count() === 1;
    assert.equal(evidence.workflow_stale_visible, true);
    assert.equal(evidence.workflow_stale_recovered, true);

    stage = "conflict";
    await openCreateFormDirect(page, baseUrl);
    await fillCaseWizard(page, {
      studentId: NEON_TEST_STUDENTS[0]!.id,
      intakeYear: "2028",
      admissionType: "transfer",
      bindingId: ADVISOR.roleBindingId,
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
    const advisorAssessment = page.locator('section[aria-labelledby="assessment-editor-title"]');
    await advisorAssessment.getByText(/15 項資料/).waitFor({ state: "visible" });
    evidence.advisor_assessment_full_editable_15 =
      await advisorAssessment.getByText(/15 項資料/).count() === 1 &&
      await advisorAssessment.getByRole("button", { name: "儲存全部修改", exact: true }).count() === 1 &&
      await advisorAssessment.getByRole("button", { name: "完成背景收集", exact: true }).count() === 1;
    assert.equal(evidence.advisor_assessment_full_editable_15, true);
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
  await page.getByRole("combobox", { name: "主要顧問", exact: true }).selectOption(input.bindingId);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("combobox", { name: "評估表版本", exact: true }).selectOption(NEON_TEST_MANIFEST_ID);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("heading", { name: "檢查並建立", exact: true, level: 3 }).waitFor({ state: "visible" });
}

async function unavailableAlert(page: Page): Promise<void> {
  await page.getByRole("alert").filter({ hasText: "案件服務暫時不可用" }).waitFor({ state: "visible" });
}

async function workflowUnavailableAlert(page: Page): Promise<void> {
  await page.getByRole("alert").filter({ hasText: "案件流程服務暫時不可用" }).waitFor({ state: "visible" });
}

async function exactCaseReceipt(
  response: { status(): number; json(): Promise<unknown> },
  expectedId?: string,
): Promise<Readonly<{ id: string; recordVersion: number }>> {
  assert.equal(response.status(), 200);
  const root = safeRecord(await response.json());
  const data = safeRecord(root.data);
  assert.deepEqual(Object.keys(data).sort(), ["id", "record_version"]);
  assert.equal(typeof data.id, "string");
  assert.match(data.id as string, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  if (expectedId) assert.equal(data.id, expectedId);
  assert.equal(Number.isSafeInteger(data.record_version) && Number(data.record_version) > 0, true);
  return Object.freeze({ id: data.id as string, recordVersion: data.record_version as number });
}

async function exactCaseAuthority(
  response: { status(): number; json(): Promise<unknown> },
  expectedId: string,
): Promise<Readonly<{
  id: string;
  stage: string;
  workflowStatus: string;
  recordVersion: number;
  availableWorkflowActions: readonly string[];
}>> {
  assert.equal(response.status(), 200);
  const root = safeRecord(await response.json());
  const data = safeRecord(root.data);
  assert.deepEqual(Object.keys(data), ["case"]);
  const item = safeRecord(data.case);
  assert.deepEqual(Object.keys(item).sort(), [
    "admissionType", "assessmentId", "assessmentStatus", "availableWorkflowActions",
    "caseNumber", "id", "intakeYear", "manifestId", "primaryBindingLabel",
    "primaryRole", "primaryUserId", "recordVersion", "stage", "studentId",
    "studentName", "updatedAt", "workflowStatus",
  ].sort());
  assert.equal(item.id, expectedId);
  assert.equal(Number.isSafeInteger(item.recordVersion) && Number(item.recordVersion) > 0, true);
  assert.equal(["signed", "background_collection", "school_selection_confirmed", "application_in_progress", "closed"].includes(String(item.stage)), true);
  assert.equal(["active", "paused", "termination_pending", "closed"].includes(String(item.workflowStatus)), true);
  assert.equal(item.primaryRole, "advisor");
  assert.equal(Array.isArray(item.availableWorkflowActions), true);
  const actions = item.availableWorkflowActions as readonly unknown[];
  assert.equal(actions.every((action) => ["pause", "resume"].includes(String(action))), true);
  assert.deepEqual(actions, ["pause", "resume"].filter((action) => actions.includes(action)));
  return Object.freeze({
    id: item.id as string,
    stage: item.stage as string,
    workflowStatus: item.workflowStatus as string,
    recordVersion: item.recordVersion as number,
    availableWorkflowActions: Object.freeze(actions.map(String)),
  });
}

async function directWorkflowAction(page: Page, input: {
  readonly caseId: string;
  readonly action: "pause" | "resume";
  readonly expectedRecordVersion: number;
  readonly reason: string | null;
}): Promise<Readonly<{ status: number; receiptExact: boolean }>> {
  const result = await page.evaluate(async (command) => {
    const response = await fetch(`/api/v1/cases/${command.caseId}/workflow-actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `case-flow-seed-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        action: command.action,
        expected_record_version: command.expectedRecordVersion,
        reason: command.reason,
      }),
    });
    return { status: response.status, body: await response.json() as unknown };
  }, input);
  const root = safeRecord(result.body);
  const data = safeRecord(root.data);
  const receiptExact = Object.keys(data).sort().join(",") === "id,record_version" &&
    data.id === input.caseId && Number.isSafeInteger(data.record_version) && Number(data.record_version) > 0;
  return Object.freeze({ status: result.status, receiptExact });
}

async function safeApiError(
  response: { status(): number; json(): Promise<unknown> },
): Promise<Readonly<{ status: number; code: "STALE_VERSION" | "OTHER" }>> {
  const root = safeRecord(await response.json());
  const error = safeRecord(root.error);
  return Object.freeze({
    status: response.status(),
    code: error.code === "STALE_VERSION" ? "STALE_VERSION" : "OTHER",
  });
}

function safeRecord(value: unknown): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Readonly<Record<string, unknown>>;
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
  const workspaceHeading = page.getByRole("heading", { name: /^今日工作/ });
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
