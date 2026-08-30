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
const CONTRACTOR = principal("contractor");
const ADMIN = principal("admin");

type Actor = "founder" | "advisor" | "contractor" | "admin";
type Stage =
  | "runtime_preflight" | "postgres_setup" | "baseline_seed" | "identity_provision"
  | "next_dev" | "canonical_origin" | "chrome_launch" | "login"
  | "advisor_case_fixture" | "case_panel_ready" | "client_validation"
  | "create_idempotency" | "create_authoritative_refresh" | "task_list_detail"
  | "detail_refresh" | "relogin_persistence" | "stale_recovery"
  | "advisor_transition_controls_ready" | "advisor_transition_submit"
  | "advisor_transition_receipt_contract" | "advisor_transition_authoritative_refresh"
  | "advisor_transition_feedback" | "founder_read_only" | "contractor_redaction"
  | "denied_roles" | "desktop_viewport" | "mobile_viewport"
  | "browser_log_safety" | "cleanup" | "complete";

interface Evidence {
  validation_required: boolean;
  validation_invalid: boolean;
  validation_matches_invalid: boolean;
  validation_post_count: number | null;
  validation_zero_post: boolean;
  uncertain_retry_same_key: boolean;
  changed_command_new_key: boolean;
  synchronous_double_post_count: number | null;
  create_receipt_exact: boolean;
  authoritative_refresh_status: number | null;
  list_persisted: boolean;
  detail_persisted: boolean;
  relogin_persisted: boolean;
  stale_visible: boolean;
  advisor_transition: AdvisorTransitionEvidence;
  advisor_transitioned: boolean;
  founder_approved: boolean;
  contractor_audience_redacted: boolean;
  admin_direct_status: number | null;
  denied_entries_hidden: boolean;
  desktop_metrics: ViewportEvidence | null;
  mobile_metrics: ViewportEvidence | null;
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

interface CaseFixtureEvidence {
  readonly response_status: number | null;
  readonly json_parseable: boolean;
  readonly exact_case_dto: boolean;
}

interface TaskWriteEvidence {
  readonly status: number | null;
  readonly json_parseable: boolean;
  readonly exact_ack: boolean;
  readonly safe_code: "NONE" | "STALE_VERSION" | "CONFLICT" | "FORBIDDEN" | "OTHER";
}

type TransitionSafeCode =
  | "NONE" | "STALE_VERSION" | "CONFLICT" | "VALIDATION_FAILED"
  | "FORBIDDEN" | "SERVICE_UNAVAILABLE" | "INTERNAL_ERROR" | "OTHER";

interface AdvisorTransitionEvidence {
  action_selected_completed: boolean;
  reason_required: boolean;
  reason_filled: boolean;
  confirmation_count: number;
  confirmation_checked: boolean;
  submit_count: number;
  submit_enabled: boolean;
  post_request_started: boolean;
  post_response_received: boolean;
  post_status: number | null;
  post_json_parseable: boolean;
  post_exact_ack: boolean;
  post_safe_code: TransitionSafeCode;
  get_request_started: boolean;
  get_response_received: boolean;
  get_status: number | null;
  get_exact_detail: boolean;
  get_state_completed: boolean;
  get_version_matches_ack: boolean;
  get_available_transitions_authoritative: boolean;
  feedback_count: number;
  feedback_visible: boolean;
}

const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

test("TASK-01 works through a real local browser and disposable PostgreSQL 17", {
  timeout: 600_000,
}, async () => {
  let stage: Stage = "runtime_preflight";
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-task01-browser-pg17-${suffix}`;
  const volumeName = `tianxing-task01-browser-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const actors = [FOUNDER, ADVISOR, CONTRACTOR, ADMIN] as const;
  const passwords = new Map<Actor, string>(actors.map((actor) => [actor.role, randomBytes(32).toString("base64url")]));
  const evidence: Evidence = {
    validation_required: false,
    validation_invalid: false,
    validation_matches_invalid: false,
    validation_post_count: null,
    validation_zero_post: false,
    uncertain_retry_same_key: false,
    changed_command_new_key: false,
    synchronous_double_post_count: null,
    create_receipt_exact: false,
    authoritative_refresh_status: null,
    list_persisted: false,
    detail_persisted: false,
    relogin_persisted: false,
    stale_visible: false,
    advisor_transition: emptyAdvisorTransitionEvidence(),
    advisor_transitioned: false,
    founder_approved: false,
    contractor_audience_redacted: false,
    admin_direct_status: null,
    denied_entries_hidden: false,
    desktop_metrics: null,
    mobile_metrics: null,
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
  let failureDetail: string | null = null;

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
    const baseline = await executeOneRoleBaselineRun({ mode: "apply", target, build, dependencies: baselineDependencies(target) });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.baseline_id, ONE_ROLE_BASELINE_ID);
    assert.equal((await seedNeonTestRelease1(target, "apply")).status, "pass");

    stage = "identity_provision";
    for (const actor of actors) {
      assert.equal(await provision(target, actor.email, passwords.get(actor.role)!), "created");
    }

    stage = "next_dev";
    appDirectory = await createIsolatedAppDirectory();
    profileDirectory = await mkdtemp(join(tmpdir(), "tianxing-task01-chrome-"));
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
    await login(page, baseUrl, ADVISOR.email, passwords.get("advisor")!);

    stage = "advisor_case_fixture";
    const fixture = await createCaseFixture(page, ADVISOR.roleBindingId, 2041);
    assert.deepEqual(fixture.evidence, { response_status: 200, json_parseable: true, exact_case_dto: true });
    assert.notEqual(fixture.caseId, null);
    const caseId = fixture.caseId!;

    stage = "case_panel_ready";
    await openCaseTasks(page, baseUrl, caseId);
    const titleInput = page.getByRole("textbox", { name: "任務標題", exact: true });
    const briefInput = page.getByRole("textbox", { name: "工作內容", exact: true });
    const dueInput = page.getByLabel("到期時間（香港時間）", { exact: true });
    const assigneeSelect = page.getByRole("combobox", { name: "負責人", exact: true });
    const createButton = page.getByRole("button", { name: "建立任務", exact: true });
    for (const control of [titleInput, briefInput, dueInput, assigneeSelect, createButton]) {
      await control.waitFor({ state: "visible" });
      assert.equal(await control.count(), 1);
    }

    stage = "client_validation";
    let validationPosts = 0;
    const validationObserver = (request: { method(): string; url(): string }) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/tasks") validationPosts += 1;
    };
    page.on("request", validationObserver);
    try {
      await createButton.click();
      const nativeValidation = await titleInput.evaluate((input) => {
        const control = input as HTMLInputElement;
        return {
          required: control.required,
          invalid: !control.validity.valid,
          matchesInvalid: control.matches(":invalid"),
        };
      });
      evidence.validation_required = nativeValidation.required;
      evidence.validation_invalid = nativeValidation.invalid;
      evidence.validation_matches_invalid = nativeValidation.matchesInvalid;
      evidence.validation_post_count = validationPosts;
    } finally {
      page.off("request", validationObserver);
    }
    assert.equal(evidence.validation_required, true);
    assert.equal(evidence.validation_invalid, true);
    assert.equal(evidence.validation_matches_invalid, true);
    evidence.validation_zero_post = validationPosts === 0;
    assert.equal(evidence.validation_zero_post, true);

    await fillTaskDraft(page, ADVISOR.userId, "TASK-01 synthetic work", "Synthetic browser acceptance work item.");
    stage = "create_idempotency";
    const keys: string[] = [];
    let createPosts = 0;
    let successfulCreateExactAck = false;
    let authoritativeRefreshStatus: number | null = null;
    const refreshPromise = observeResponse(page, "GET", `/api/v1/tasks?case_id=${caseId}`, (status) => { authoritativeRefreshStatus = status; });
    await page.route("**/api/v1/tasks", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      createPosts += 1;
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (createPosts <= 2) return route.abort("timedout");
      const response = await route.fetch();
      const responseBody = await response.text();
      successfulCreateExactAck = (await safeTaskWriteEvidence(response.status(), responseBody)).exact_ack;
      await route.fulfill({
        status: response.status(),
        headers: {
          "content-type": response.headers()["content-type"] ?? "application/json",
          "x-request-id": response.headers()["x-request-id"] ?? "",
        },
        body: responseBody,
      });
    });
    await createButton.click();
    await unavailableNotice(page);
    await createButton.click();
    await unavailableNotice(page);
    evidence.uncertain_retry_same_key = keys[0] !== "" && keys[0] === keys[1];
    assert.equal(evidence.uncertain_retry_same_key, true);

    await titleInput.fill("TASK-01 changed synthetic work");
    const beforeDouble = createPosts;
    await createButton.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await page.getByRole("status").filter({ hasText: "任務已建立，案件任務已重新載入。" }).waitFor({ state: "visible" });
    await refreshPromise;
    evidence.changed_command_new_key = keys[2] !== "" && keys[2] !== keys[1];
    evidence.synchronous_double_post_count = createPosts - beforeDouble;
    evidence.create_receipt_exact = successfulCreateExactAck;
    evidence.authoritative_refresh_status = authoritativeRefreshStatus;
    assert.equal(evidence.changed_command_new_key, true);
    assert.equal(evidence.synchronous_double_post_count, 1);
    assert.equal(evidence.create_receipt_exact, true);
    assert.equal(evidence.authoritative_refresh_status, 200);
    await page.unroute("**/api/v1/tasks");

    stage = "create_authoritative_refresh";
    const taskLink = page.getByRole("link", { name: "TASK-01 changed synthetic work", exact: true });
    await taskLink.waitFor({ state: "visible" });
    const taskPath = safeTaskPath(await taskLink.getAttribute("href"));
    assert.notEqual(taskPath, null);

    stage = "desktop_viewport";
    evidence.desktop_metrics = await viewportEvidence(page);
    assert.deepEqual(evidence.desktop_metrics, zeroViewport());

    stage = "task_list_detail";
    await openTasks(page, baseUrl);
    evidence.list_persisted = await page.locator(`a[href="${taskPath}"]`).count() === 1;
    assert.equal(evidence.list_persisted, true);
    await page.goto(`${baseUrl}${taskPath}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "TASK-01 changed synthetic work", exact: true, level: 2 }).waitFor({ state: "visible" });
    evidence.detail_persisted = true;

    stage = "detail_refresh";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "TASK-01 changed synthetic work", exact: true, level: 2 }).waitFor({ state: "visible" });

    stage = "relogin_persistence";
    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!);
    await page.goto(`${baseUrl}${taskPath}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "TASK-01 changed synthetic work", exact: true, level: 2 }).waitFor({ state: "visible" });
    evidence.relogin_persisted = true;

    stage = "stale_recovery";
    await logout(page);
    await login(page, baseUrl, ADVISOR.email, passwords.get("advisor")!);
    await page.goto(`${baseUrl}${taskPath}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "TASK-01 changed synthetic work", exact: true, level: 2 }).waitFor({ state: "visible" });
    const taskId = taskPath!.slice("/tasks/".length);
    const seeded = await directTransition(page, taskId, "accepted", 1, "", null);
    assert.equal(seeded.status, 200);
    assert.equal(seeded.exact_ack, true);
    await chooseTransition(page, "accepted", false);
    await page.getByRole("alert").filter({ hasText: "任務已有較新版本，已重新載入最新內容。" }).waitFor({ state: "visible" });
    evidence.stale_visible = true;

    await completeAdvisorTask(page, taskId, evidence.advisor_transition, (next) => { stage = next; });
    evidence.advisor_transitioned = true;

    stage = "founder_read_only";
    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!);
    await page.goto(`${baseUrl}${taskPath}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "TASK-01 changed synthetic work", exact: true, level: 2 }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("combobox", { name: "操作", exact: true }).count(), 0);
    assert.equal(await page.getByText("批准完成", { exact: true }).count(), 0);

    stage = "contractor_redaction";
    await createContractorTask(page, baseUrl, caseId, CONTRACTOR.userId);
    await logout(page);
    await login(page, baseUrl, CONTRACTOR.email, passwords.get("contractor")!, "/tasks");
    await openTasks(page, baseUrl);
    await page.getByRole("status").filter({ hasText: "不包含案件或學生資料" }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("link", { name: /^案件 / }).count(), 0);
    evidence.contractor_audience_redacted = true;

    stage = "mobile_viewport";
    await page.setViewportSize({ width: 390, height: 844 });
    evidence.mobile_metrics = await viewportEvidence(page);
    assert.deepEqual(evidence.mobile_metrics, zeroViewport());

    stage = "denied_roles";
    await page.setViewportSize({ width: 1440, height: 1000 });
    const adminDenied = await inspectDeniedActor(page, baseUrl, ADMIN.email, passwords.get("admin")!, caseId);
    evidence.admin_direct_status = adminDenied.directStatus;
    evidence.denied_entries_hidden = adminDenied.entriesHidden;
    assert.deepEqual(adminDenied, { entriesHidden: true, directStatus: 403, forbidden: true, privateEcho: false });

    stage = "browser_log_safety";
    const sensitiveValues = [
      ...NEON_TEST_STUDENTS.flatMap((student) => [student.displayName, student.contactEmail ?? ""]),
      ...actors.map((actor) => actor.email),
      ...passwords.values(), applicationPassword, "postgresql://", "tx_session=",
    ].filter(Boolean);
    evidence.sensitive_log_matches = browserMessages.filter((message) => sensitiveValues.some((value) => message.includes(value))).length;
    assert.equal(evidence.page_errors, 0);
    assert.equal(evidence.sensitive_log_matches, 0);
    assertNoSensitiveDevLogs(devServer, sensitiveValues);
    stage = "complete";
  } catch (error) {
    failureStage = stage;
    failureDetail = error instanceof Error
      ? `${error.name}: ${error.message.split(/\r?\n/, 1)[0]}`
      : "Unknown browser gate failure";
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
    failure_detail: failureDetail,
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

async function login(
  page: Page,
  baseUrl: string,
  email: string,
  password: string,
  destination: "/today" | "/tasks" = "/today",
  headingOverride?: string | null,
): Promise<void> {
  const navigation = await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  const emailInput = page.getByRole("textbox", { name: "帳戶電郵", exact: true });
  const passwordInput = page.getByLabel("密碼", { exact: true });
  const submit = page.getByRole("button", { name: "登入工作台", exact: true });
  await emailInput.waitFor({ state: "visible" });
  await passwordInput.waitFor({ state: "visible" });
  await submit.waitFor({ state: "visible" });
  await emailInput.fill(email);
  await passwordInput.fill(password);
  const submitResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/auth/login");
  const accessResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me"));
  await submit.click();
  assert.equal((await submitResponse).status(), 303);
  await page.waitForURL((url) => url.pathname === destination);
  assert.equal((await accessResponse).status(), 200);
  if (headingOverride !== null) {
    const heading = headingOverride ?? (destination === "/today" ? "今日工作" : "任務");
    await page.getByRole("heading", { name: heading, exact: true }).first().waitFor({ state: "visible" });
  }
}

async function logout(page: Page): Promise<void> {
  const response = await page.goto("/api/v1/auth/logout", { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "帳戶電郵", exact: true }).waitFor({ state: "visible" });
}

async function createCaseFixture(
  page: Page,
  bindingId: string,
  intakeYear: number,
): Promise<{ readonly caseId: string | null; readonly evidence: CaseFixtureEvidence }> {
  return page.evaluate(async ({ binding, manifest, student, year }) => {
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
      Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    const uuid = (value: unknown): value is string =>
      typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    const evidence: { response_status: number | null; json_parseable: boolean; exact_case_dto: boolean } = {
      response_status: null,
      json_parseable: false,
      exact_case_dto: false,
    };
    try {
      const response = await fetch("/api/v1/cases", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `task01-case-${crypto.randomUUID()}` },
        body: JSON.stringify({
          student_id: student,
          intake_year: year,
          admission_type: "transfer",
          primary_advisor_role_binding_id: binding,
          signed_at: "2041-01-15T08:00:00+08:00",
        }),
      });
      evidence.response_status = response.status;
      let envelope: unknown;
      try {
        envelope = JSON.parse(await response.text());
        evidence.json_parseable = true;
      } catch {
        return { caseId: null, evidence };
      }
      if (!object(envelope) || !exactKeys(envelope, ["api_version", "request_id", "data"])) return { caseId: null, evidence };
      if (!object(envelope.data) || !exactKeys(envelope.data, [
        "assessment_manifest", "assessment_url", "case_id", "record_version", "stage", "workflow_status",
      ]) || !uuid(envelope.data.case_id) || envelope.data.record_version !== 2 ||
          envelope.data.stage !== "background_collection" || envelope.data.workflow_status !== "active" ||
          !object(envelope.data.assessment_manifest) || typeof envelope.data.assessment_url !== "string") {
        return { caseId: null, evidence };
      }
      const caseId = envelope.data.case_id;
      const authorityResponse = await fetch(`/api/v1/cases/${caseId}`);
      const authorityRoot = await authorityResponse.json() as unknown;
      if (authorityResponse.status !== 200 || !object(authorityRoot) ||
          !exactKeys(authorityRoot, ["api_version", "request_id", "data"]) ||
          !object(authorityRoot.data) || !exactKeys(authorityRoot.data, ["case"]) ||
          !object(authorityRoot.data.case)) return { caseId: null, evidence };
      const record = authorityRoot.data.case;
      const caseKeys = [
        "id", "caseNumber", "studentId", "studentName", "intakeYear", "admissionType",
        "stage", "workflowStatus", "recordVersion", "availableWorkflowActions", "updatedAt",
        "primaryRole", "assessmentId", "assessmentStatus", "manifestId",
        "primaryBindingLabel", "primaryUserId",
      ];
      evidence.exact_case_dto =
        exactKeys(record, caseKeys) && record.id === caseId &&
        typeof record.caseNumber === "string" && record.caseNumber.trim() !== "" &&
        record.studentId === student && uuid(record.assessmentId) &&
        record.intakeYear === year && record.admissionType === "transfer" &&
        record.stage === "background_collection" && record.workflowStatus === "active" &&
        record.manifestId === envelope.data.assessment_manifest.id &&
        record.recordVersion === envelope.data.record_version &&
        envelope.data.assessment_url === `/cases/${caseId}/assessment`;
      return { caseId: evidence.exact_case_dto ? caseId : null, evidence };
    } catch {
      return { caseId: null, evidence };
    }
  }, { binding: bindingId, manifest: NEON_TEST_MANIFEST_ID, student: NEON_TEST_STUDENTS[0]!.id, year: intakeYear });
}

async function openCaseTasks(page: Page, baseUrl: string, caseId: string): Promise<void> {
  const listResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/tasks") && new URL(response.url()).searchParams.get("case_id") === caseId);
  const accessResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me"));
  const navigation = await page.goto(`${baseUrl}/cases/${caseId}`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  assert.equal((await listResponse).status(), 200);
  assert.equal((await accessResponse).status(), 200);
  await page.getByRole("heading", { name: "案件任務", exact: true, level: 3 }).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("textbox", { name: "任務標題", exact: true }).count(), 0);
  const optionsResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/tasks/options") && new URL(response.url()).searchParams.get("case_id") === caseId);
  await page.getByRole("button", { name: "新增任務", exact: true }).click();
  assert.equal((await optionsResponse).status(), 200);
  await page.getByRole("textbox", { name: "任務標題", exact: true }).waitFor({ state: "visible" });
}

async function openTasks(page: Page, baseUrl: string): Promise<void> {
  const listResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/tasks") && new URL(response.url()).search === "");
  const accessResponse = page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me"));
  const navigation = await page.goto(`${baseUrl}/tasks`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  assert.equal((await listResponse).status(), 200);
  assert.equal((await accessResponse).status(), 200);
  await page.getByRole("heading", { name: "任務", exact: true, level: 2 }).waitFor({ state: "visible" });
  await page.getByText("正在載入任務", { exact: true }).waitFor({ state: "hidden" });
}

async function fillTaskDraft(page: Page, assigneeId: string, title: string, brief: string): Promise<void> {
  await page.getByRole("textbox", { name: "任務標題", exact: true }).fill(title);
  await page.getByRole("textbox", { name: "工作內容", exact: true }).fill(brief);
  await page.getByLabel("到期時間（香港時間）", { exact: true }).fill("2041-09-01T10:00");
  await page.getByRole("combobox", { name: "負責人", exact: true }).selectOption(assigneeId);
}

async function unavailableNotice(page: Page): Promise<void> {
  await page.getByRole("alert").filter({ hasText: "結果暫時無法確認" }).waitFor({ state: "visible" });
}

async function createContractorTask(page: Page, baseUrl: string, caseId: string, contractorId: string): Promise<void> {
  await openCaseTasks(page, baseUrl, caseId);
  await fillTaskDraft(page, contractorId, "TASK-01 contractor projection", "Synthetic contractor task-only projection.");
  await page.getByRole("button", { name: "建立任務", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "任務已建立，案件任務已重新載入。" }).waitFor({ state: "visible" });
}

async function completeAdvisorTask(
  page: Page,
  taskId: string,
  evidence: AdvisorTransitionEvidence,
  setStage: (stage: Stage) => void,
): Promise<void> {
  const transitionPath = `/api/v1/tasks/${taskId}/transitions`;
  const detailPath = `/api/v1/tasks/${taskId}`;
  setStage("advisor_transition_controls_ready");
  const action = page.getByRole("combobox", { name: "操作", exact: true });
  await action.waitFor({ state: "visible" });
  await action.selectOption("completed");
  const reason = page.getByRole("textbox", { name: "原因", exact: true });
  const confirmation = page.getByRole("checkbox", {
    name: "我確認執行「標記完成」，並保留任務的既有處理紀錄。",
    exact: true,
  });
  const submit = page.getByRole("button", { name: "確認更新", exact: true });
  await reason.waitFor({ state: "visible" });
  await confirmation.waitFor({ state: "visible" });
  await submit.waitFor({ state: "visible" });
  evidence.action_selected_completed = await action.inputValue() === "completed";
  evidence.reason_required = await reason.evaluate((control) => (control as HTMLTextAreaElement).required);
  await reason.fill("Synthetic workflow confirmation.");
  evidence.reason_filled = (await reason.inputValue()).length > 0;
  evidence.confirmation_count = await confirmation.count();
  await confirmation.check();
  evidence.confirmation_checked = await confirmation.isChecked();
  evidence.submit_count = await submit.count();
  evidence.submit_enabled = await submit.isEnabled();
  assert.equal(evidence.action_selected_completed, true);
  assert.equal(evidence.reason_required, false);
  assert.equal(evidence.reason_filled, true);
  assert.equal(evidence.confirmation_count, 1);
  assert.equal(evidence.confirmation_checked, true);
  assert.equal(evidence.submit_count, 1);
  assert.equal(evidence.submit_enabled, true);

  const requestObserver = (request: { method(): string; url(): string }) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === transitionPath) evidence.post_request_started = true;
    if (request.method() === "GET" && pathname === detailPath) evidence.get_request_started = true;
  };
  page.on("request", requestObserver);
  const postPromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === transitionPath)
    .then(async (response) => {
      evidence.post_response_received = true;
      evidence.post_status = response.status();
      let value: unknown;
      try {
        value = JSON.parse(await response.text());
        evidence.post_json_parseable = true;
      } catch {
        return null;
      }
      const decoded = decodeTransitionReceipt(value, taskId, 3);
      evidence.post_exact_ack = decoded.exact;
      evidence.post_safe_code = decoded.code;
      return decoded.version;
    })
    .catch(() => null);
  const getPromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === detailPath)
    .then(async (response) => {
      evidence.get_response_received = true;
      evidence.get_status = response.status();
      let value: unknown;
      try { value = JSON.parse(await response.text()); } catch { return null; }
      return value;
    })
    .catch(() => null);

  try {
    setStage("advisor_transition_submit");
    await submit.click();

    setStage("advisor_transition_receipt_contract");
    const ackVersion = await postPromise;
    assert.equal(evidence.post_request_started, true);
    assert.equal(evidence.post_response_received, true);
    assert.equal(evidence.post_status, 200);
    assert.equal(evidence.post_json_parseable, true);
    assert.equal(evidence.post_exact_ack, true);
    assert.equal(evidence.post_safe_code, "NONE");
    assert.equal(ackVersion, 3);

    setStage("advisor_transition_authoritative_refresh");
    const detail = decodeCompletedTaskDetail(await getPromise, taskId, ackVersion);
    evidence.get_exact_detail = detail.exact;
    evidence.get_state_completed = detail.stateCompleted;
    evidence.get_version_matches_ack = detail.versionMatches;
    evidence.get_available_transitions_authoritative = detail.transitionsAuthoritative;
    assert.equal(evidence.get_request_started, true);
    assert.equal(evidence.get_response_received, true);
    assert.equal(evidence.get_status, 200);
    assert.equal(evidence.get_exact_detail, true);
    assert.equal(evidence.get_state_completed, true);
    assert.equal(evidence.get_version_matches_ack, true);
    assert.equal(evidence.get_available_transitions_authoritative, true);

    setStage("advisor_transition_feedback");
    const feedback = page.getByRole("status").filter({ hasText: "任務已更新，內容已重新載入。" });
    await feedback.waitFor({ state: "visible" });
    evidence.feedback_count = await feedback.count();
    evidence.feedback_visible = await feedback.isVisible();
    assert.equal(evidence.feedback_count, 1);
    assert.equal(evidence.feedback_visible, true);
  } finally {
    page.off("request", requestObserver);
    await Promise.allSettled([postPromise, getPromise]);
  }
}

function emptyAdvisorTransitionEvidence(): AdvisorTransitionEvidence {
  return {
    action_selected_completed: false,
    reason_required: false,
    reason_filled: false,
    confirmation_count: 0,
    confirmation_checked: false,
    submit_count: 0,
    submit_enabled: false,
    post_request_started: false,
    post_response_received: false,
    post_status: null,
    post_json_parseable: false,
    post_exact_ack: false,
    post_safe_code: "OTHER",
    get_request_started: false,
    get_response_received: false,
    get_status: null,
    get_exact_detail: false,
    get_state_completed: false,
    get_version_matches_ack: false,
    get_available_transitions_authoritative: false,
    feedback_count: 0,
    feedback_visible: false,
  };
}

function decodeTransitionReceipt(
  value: unknown,
  taskId: string,
  expectedVersion: number,
): { readonly exact: boolean; readonly version: number | null; readonly code: TransitionSafeCode } {
  if (!isObject(value)) return { exact: false, version: null, code: "OTHER" };
  const rawCode = isObject(value.error) && typeof value.error.code === "string" ? value.error.code : "NONE";
  const allowed: readonly TransitionSafeCode[] = [
    "NONE", "STALE_VERSION", "CONFLICT", "VALIDATION_FAILED", "FORBIDDEN",
    "SERVICE_UNAVAILABLE", "INTERNAL_ERROR", "OTHER",
  ];
  const code = allowed.includes(rawCode as TransitionSafeCode) ? rawCode as TransitionSafeCode : "OTHER";
  const data = value.data;
  const exact = isObject(data) && hasExactKeys(data, ["id", "record_version"]) &&
    data.id === taskId && data.record_version === expectedVersion;
  return { exact, version: exact ? expectedVersion : null, code };
}

function decodeCompletedTaskDetail(
  value: unknown,
  taskId: string,
  ackVersion: number | null,
): {
  readonly exact: boolean;
  readonly stateCompleted: boolean;
  readonly versionMatches: boolean;
  readonly transitionsAuthoritative: boolean;
} {
  if (!isObject(value) || !isObject(value.data) || !hasExactKeys(value.data, ["audience", "task"]) || value.data.audience !== "case_workspace" || !isObject(value.data.task)) {
    return { exact: false, stateCompleted: false, versionMatches: false, transitionsAuthoritative: false };
  }
  const task = value.data.task;
  const transitions = task.available_transitions;
  const exactTransitionArray = Array.isArray(transitions) && transitions.every((item) =>
    isObject(item) && hasExactKeys(item, ["to", "requires_reason", "requires_assignee"]) &&
    typeof item.to === "string" && typeof item.requires_reason === "boolean" && typeof item.requires_assignee === "boolean");
  const assignee = task.assignee;
  const currentAssignment = task.current_assignment;
  const exactCurrentAssignment = currentAssignment === null ||
    (isObject(currentAssignment) && hasExactKeys(currentAssignment, [
      "id", "assignee_user_id", "assignee_role", "status",
    ]) && isUuid(currentAssignment.id) && isUuid(currentAssignment.assignee_user_id) &&
      (currentAssignment.assignee_role === "advisor" || currentAssignment.assignee_role === "contractor") &&
      typeof currentAssignment.status === "string" && currentAssignment.status.trim() !== "");
  const allowedActions = task.allowed_actions;
  const exactAllowedActions = Array.isArray(allowedActions) && allowedActions.every((action) =>
    action === "accept" || action === "reject" || action === "reassign" ||
    action === "complete" || action === "cancel");
  const exact = hasExactKeys(task, [
    "id", "case_id", "case_number", "title", "task_brief", "due_at", "state",
    "assignee", "record_version", "updated_at", "available_transitions", "task_kind",
    "school_target_id", "is_overdue", "current_assignment", "allowed_actions",
  ]) && task.id === taskId && isUuid(task.case_id) &&
    typeof task.case_number === "string" && task.case_number.trim() !== "" &&
    typeof task.title === "string" && task.title.trim() !== "" &&
    typeof task.task_brief === "string" && task.task_brief.trim() !== "" &&
    isIsoInstant(task.due_at) && task.state === "completed" &&
    isObject(assignee) && hasExactKeys(assignee, ["id", "role", "label"]) && isUuid(assignee.id) &&
    (assignee.role === "advisor" || assignee.role === "contractor") &&
    typeof assignee.label === "string" && assignee.label.trim() !== "" &&
    Number.isSafeInteger(task.record_version) && Number(task.record_version) > 0 &&
    isIsoInstant(task.updated_at) && exactTransitionArray && task.task_kind === "manual" &&
    task.school_target_id === null && typeof task.is_overdue === "boolean" &&
    exactCurrentAssignment && exactAllowedActions;
  return {
    exact,
    stateCompleted: task.state === "completed",
    versionMatches: ackVersion !== null && task.record_version === ackVersion,
    transitionsAuthoritative: exactTransitionArray && transitions.length === 0,
  };
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

async function chooseTransition(page: Page, to: "accepted" | "completed", withReason: boolean): Promise<void> {
  const labels = { accepted: "接受任務", completed: "標記完成" } as const;
  const action = page.getByRole("combobox", { name: "操作", exact: true });
  await action.waitFor({ state: "visible" });
  await action.selectOption(to);
  if (withReason) await page.getByRole("textbox", { name: "原因", exact: true }).fill("Synthetic workflow confirmation.");
  await page.getByRole("checkbox", {
    name: `我確認執行「${labels[to]}」，並保留任務的既有處理紀錄。`,
    exact: true,
  }).check();
  await page.getByRole("button", { name: "確認更新", exact: true }).click();
}

async function directTransition(
  page: Page,
  taskId: string,
  to: string,
  expectedVersion: number,
  reason: string,
  nextAssigneeId: string | null,
): Promise<TaskWriteEvidence> {
  return page.evaluate(async ({ id, next, taskReason, toState, version }) => {
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
      Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    try {
      const response = await fetch(`/api/v1/tasks/${id}/transitions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `task01-transition-${crypto.randomUUID()}` },
        body: JSON.stringify({ to: toState, expected_record_version: version, reason: taskReason, next_assignee_user_id: next }),
      });
      const text = await response.text();
      let value: unknown;
      try { value = JSON.parse(text); } catch {
        return { status: response.status, json_parseable: false, exact_ack: false, safe_code: "OTHER" as const };
      }
      if (!object(value)) return { status: response.status, json_parseable: true, exact_ack: false, safe_code: "OTHER" as const };
      const data = value.data;
      const exactAck = response.ok && object(data) && exactKeys(data, ["id", "record_version"]) && data.id === id && Number.isSafeInteger(data.record_version) && Number(data.record_version) > version;
      const code = object(value.error) && typeof value.error.code === "string" ? value.error.code : "NONE";
      const safeCode = code === "STALE_VERSION" || code === "CONFLICT" || code === "FORBIDDEN" ? code : code === "NONE" ? "NONE" : "OTHER";
      return { status: response.status, json_parseable: true, exact_ack: exactAck, safe_code: safeCode };
    } catch {
      return { status: null, json_parseable: false, exact_ack: false, safe_code: "OTHER" as const };
    }
  }, { id: taskId, next: nextAssigneeId, taskReason: reason, toState: to, version: expectedVersion });
}

async function inspectDeniedActor(page: Page, baseUrl: string, email: string, password: string, caseId: string) {
  await logout(page);
  await login(page, baseUrl, email, password, "/today", null);
  const navigation = await page.goto(`${baseUrl}/tasks`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  await page.getByText("目前帳號無法查看此工作區", { exact: true }).waitFor({ state: "visible" });
  const entriesHidden = await page.locator('a[href^="/tasks/"]').count() === 0;
  const direct = await page.evaluate(async (payload) => {
    try {
      const response = await fetch("/api/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `task01-denied-${crypto.randomUUID()}` },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      let code = "OTHER";
      try {
        const value = JSON.parse(text) as { error?: { code?: unknown } };
        if (value.error?.code === "FORBIDDEN") code = "FORBIDDEN";
      } catch {}
      return { status: response.status, forbidden: code === "FORBIDDEN", privateEcho: text.includes(payload.title) || text.includes(payload.task_brief) };
    } catch {
      return { status: null, forbidden: false, privateEcho: false };
    }
  }, {
    case_id: caseId,
    title: "Synthetic denied command",
    task_brief: "Synthetic denied task body.",
    due_at: "2041-09-01T02:00:00.000Z",
    assignee_user_id: ADVISOR.userId,
  });
  return { entriesHidden, directStatus: direct.status, forbidden: direct.forbidden, privateEcho: direct.privateEcho };
}

async function safeTaskWriteEvidence(status: number, text: string): Promise<TaskWriteEvidence> {
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    return { status, json_parseable: false, exact_ack: false, safe_code: "OTHER" };
  }
  if (!isObject(value)) return { status, json_parseable: true, exact_ack: false, safe_code: "OTHER" };
  const data = value.data;
  const exactAck = status >= 200 && status < 300 && isObject(data) && hasExactKeys(data, ["id", "record_version"]) && isUuid(data.id) && data.record_version === 1;
  const code = isObject(value.error) && typeof value.error.code === "string" ? value.error.code : "NONE";
  const safeCode = code === "STALE_VERSION" || code === "CONFLICT" || code === "FORBIDDEN" ? code : code === "NONE" ? "NONE" : "OTHER";
  return { status, json_parseable: true, exact_ack: exactAck, safe_code: safeCode };
}

function observeResponse(page: Page, method: string, pathWithQuery: string, record: (status: number) => void): Promise<void> {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === method && `${url.pathname}${url.search}` === pathWithQuery;
  }).then((response) => { record(response.status()); });
}

function safeTaskPath(value: string | null): string | null {
  return typeof value === "string" && /^\/tasks\/[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ? value : null;
}

function isGetPath(response: { request(): { method(): string }; url(): string }, pathname: string): boolean {
  return response.request().method() === "GET" && new URL(response.url()).pathname === pathname;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
    const clippedText = visible.filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "hidden").length;
    return {
      horizontal_overflow: Math.max(0, root.scrollWidth - root.clientWidth),
      out_of_bounds_controls: outOfBounds,
      overlapping_controls: overlapping,
      clipped_text: clippedText,
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
  const directory = await mkdtemp(join(tmpdir(), "tianxing-task01-browser-next-"));
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
  try {
    await client.connect();
    return await inspectOneRoleBaselineDatabase(client);
  } finally {
    await client.end().catch(() => {});
  }
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class BrowserGateError extends Error {
  readonly stage: Stage;

  constructor(stage: Stage) {
    super(`TASK-01 browser gate failed at ${stage}.`);
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
