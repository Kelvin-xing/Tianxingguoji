import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
  type Response as PlaywrightResponse,
  type Route,
} from "playwright-core";
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
const DATA_REVIEWER = principal("data_reviewer");
const ADMIN = principal("admin");
const CONTRACTOR = principal("contractor");
const LEFT_STUDENT = NEON_TEST_STUDENTS[0]!;
const RIGHT_STUDENT = NEON_TEST_STUDENTS[1]!;

const LOGIN_STAGES = Object.freeze([
  "login_page_render", "login_form_ready", "login_submit_response", "login_redirect",
  "login_session_response", "login_workspace_render",
] as const);
type LoginStage = (typeof LOGIN_STAGES)[number];
type LoginActor = "founder" | "advisor" | "data_reviewer" | "admin" | "contractor";

const STAGES = Object.freeze([
  "runtime_preflight", "postgres_setup", "baseline_seed", "identity_provision",
  "next_dev", "canonical_origin", "chrome_launch", ...LOGIN_STAGES,
  "fixture_prepare", "founder_entry", "queue_ready", "search_post_only",
  "candidate_validation", "candidate_idempotency", "candidate_create",
  "detail_manual_choice", "merge_idempotency", "merge_stale", "founder_merge_submit",
  "founder_merge_authoritative_refresh", "founder_merge_feedback",
  "authoritative_refresh", "two_uuid_resolution", "relogin_persistence",
  "candidate_conflict", "corrective_undo", "advisor_students_navigation", "advisor_students_ready",
  "advisor_entry", "advisor_review_detail",
  "advisor_review_state", "data_reviewer_queue", "data_reviewer_review_detail",
  "data_reviewer_review_state", "admin_students_navigation", "admin_students_ready",
  "admin_entry_hidden", "admin_direct_denied", "contractor_students_navigation",
  "contractor_students_denied", "contractor_entry_hidden", "contractor_direct_denied",
  "keyboard_focus", "desktop_viewport", "mobile_viewport", "browser_log_safety",
  "cleanup", "complete",
] as const);
type BrowserStage = (typeof STAGES)[number];

interface GateEvidence {
  baseline_generated_files: number | null;
  founder_entry: boolean;
  advisor_entry: boolean;
  data_reviewer_queue: boolean;
  search_post_only: boolean;
  search_masked: boolean;
  no_auto_choice: boolean;
  manual_pair_selected: boolean;
  candidate_validation_zero_post: boolean;
  candidate_retry_same_key: boolean;
  candidate_change_rotates_key: boolean;
  candidate_double_post_count: number | null;
  merge_retry_same_key: boolean;
  merge_change_rotates_key: boolean;
  merge_double_post_count: number | null;
  founder_merge_submit: FounderMergeSubmitEvidence;
  founder_merge_authoritative_refresh: FounderMergeRefreshEvidence;
  founder_merge_feedback: FounderMergeFeedbackEvidence;
  stale_visible_and_recovered: boolean;
  founder_merged: boolean;
  authoritative_list_detail: boolean;
  two_uuid_same_authority: boolean;
  relogin_persisted: boolean;
  conflict_visible: boolean;
  corrected_authority: boolean;
  advisor_review_only: boolean;
  data_reviewer_review_only: boolean;
  advisor_review_state: ReviewOnlyEvidence;
  data_reviewer_review_state: ReviewOnlyEvidence;
  advisor_students_entry: StudentsEntryEvidence;
  admin_students_entry: StudentsEntryEvidence;
  contractor_students_entry: StudentsEntryEvidence;
  admin_entry_hidden: boolean;
  contractor_entry_hidden: boolean;
  admin_direct_403_count: number;
  contractor_direct_403_count: number;
  keyboard_focus: boolean;
  desktop: ViewportEvidence | null;
  mobile: ViewportEvidence | null;
  page_errors: number;
  sensitive_log_matches: number;
}

type SafeMergeResponseCode =
  | "NONE"
  | "STALE_VERSION"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "FORBIDDEN"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "OTHER";

interface FounderMergeSubmitEvidence {
  merge_button_count: number | null;
  merge_button_enabled: boolean | null;
  request_started: boolean;
  response_received: boolean;
  response_status: number | null;
  response_json_parseable: boolean;
  response_safe_code: SafeMergeResponseCode | null;
  real_merge_post_count: number;
}

interface FounderMergeRefreshEvidence {
  request_started: boolean;
  response_received: boolean;
  response_status: number | null;
}

interface FounderMergeFeedbackEvidence {
  success_notice_count: number | null;
  success_notice_visible: boolean | null;
  active_status_count: number | null;
}

interface ReviewOnlyEvidence {
  entry_or_queue_reachable: boolean;
  detail_request_started: boolean;
  detail_response_received: boolean;
  detail_response_status: number | null;
  review_heading_count: number | null;
  authoritative_state: "pending_or_active" | "corrected" | null;
  generic_notice_count: number | null;
  generic_notice_visible: boolean | null;
  corrected_notice_count: number | null;
  corrected_notice_visible: boolean | null;
  merge_button_count: number | null;
  correction_button_count: number | null;
}

interface StudentsEntryEvidence {
  navigation_status: number | null;
  students_request_started: boolean;
  students_response_received: boolean;
  students_response_status: number | null;
  access_request_started: boolean;
  access_response_received: boolean;
  access_response_status: number | null;
  shell_heading_count: number | null;
  page_state: "ready" | "denied" | null;
  ready_status_count: number | null;
  loading_count: number | null;
  unauthenticated_count: number | null;
  denied_count: number | null;
  unavailable_count: number | null;
  entry_count: number | null;
  entry_visible: boolean | null;
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
  form_controls: number | null;
  submit_status: number | null;
  redirect_pathname: "/today" | "other" | null;
  auth_me_status: number | null;
  workspace_heading_count: number | null;
}

interface ViewportEvidence {
  page_horizontal_overflow: number;
  out_of_bounds_controls: number;
  overlapping_controls: number;
  clipped_text: number;
}

interface BrowserApiResult {
  readonly status: number | null;
  readonly jsonParseable: boolean;
  readonly code: "FORBIDDEN" | "CONFLICT" | "STALE_VERSION" | "OTHER" | null;
  readonly data: unknown;
}

const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

test("CRM-04 duplicate review, merge, and correction work through a real local browser", {
  timeout: 600_000,
}, async () => {
  let stage: BrowserStage = "runtime_preflight";
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-crm04-browser-pg17-${suffix}`;
  const volumeName = `tianxing-crm04-browser-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const passwords = new Map(NEON_TEST_PRINCIPALS.map((entry) => [
    entry.role,
    randomBytes(32).toString("base64url"),
  ]));
  const fixture = Object.freeze({
    leftName: "CRM04 Browser Left Synthetic",
    rightName: "CRM04 Browser Right Synthetic",
    updatedLeftName: "CRM04 Browser Left Revised",
    sharedEmail: "crm04-browser-shared@example.invalid",
  });
  const evidence: GateEvidence = {
    baseline_generated_files: null,
    founder_entry: false,
    advisor_entry: false,
    data_reviewer_queue: false,
    search_post_only: false,
    search_masked: false,
    no_auto_choice: false,
    manual_pair_selected: false,
    candidate_validation_zero_post: false,
    candidate_retry_same_key: false,
    candidate_change_rotates_key: false,
    candidate_double_post_count: null,
    merge_retry_same_key: false,
    merge_change_rotates_key: false,
    merge_double_post_count: null,
    founder_merge_submit: {
      merge_button_count: null,
      merge_button_enabled: null,
      request_started: false,
      response_received: false,
      response_status: null,
      response_json_parseable: false,
      response_safe_code: null,
      real_merge_post_count: 0,
    },
    founder_merge_authoritative_refresh: {
      request_started: false,
      response_received: false,
      response_status: null,
    },
    founder_merge_feedback: {
      success_notice_count: null,
      success_notice_visible: null,
      active_status_count: null,
    },
    stale_visible_and_recovered: false,
    founder_merged: false,
    authoritative_list_detail: false,
    two_uuid_same_authority: false,
    relogin_persisted: false,
    conflict_visible: false,
    corrected_authority: false,
    advisor_review_only: false,
    data_reviewer_review_only: false,
    advisor_review_state: emptyReviewOnlyEvidence(),
    data_reviewer_review_state: emptyReviewOnlyEvidence(),
    advisor_students_entry: emptyStudentsEntryEvidence(),
    admin_students_entry: emptyStudentsEntryEvidence(),
    contractor_students_entry: emptyStudentsEntryEvidence(),
    admin_entry_hidden: false,
    contractor_entry_hidden: false,
    admin_direct_403_count: 0,
    contractor_direct_403_count: 0,
    keyboard_focus: false,
    desktop: null,
    mobile: null,
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
  let candidateId = "";
  let mergeId = "";

  try {
    assert.equal((STAGES as readonly string[]).includes(stage), true);
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
    assert.equal(evidence.baseline_generated_files, 32);
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply", target, build, dependencies: baselineDependencies(target),
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.baseline_id, ONE_ROLE_BASELINE_ID);
    assert.equal((await seedNeonTestRelease1(target, "apply")).status, "pass");

    stage = "identity_provision";
    for (const entry of [FOUNDER, ADVISOR, DATA_REVIEWER, ADMIN, CONTRACTOR]) {
      assert.equal(await provision(target, entry.email, passwords.get(entry.role)!), "created");
    }

    stage = "next_dev";
    appDirectory = await createIsolatedAppDirectory();
    profileDirectory = await mkdtemp(join(tmpdir(), "tianxing-crm04-chrome-"));
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

    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!, "founder", loginEvidence, (value) => { stage = value; });

    stage = "fixture_prepare";
    await prepareStudent(page, LEFT_STUDENT.id, 1, fixture.leftName, fixture.sharedEmail, "crm04-browser-left");
    await prepareStudent(page, RIGHT_STUDENT.id, 1, fixture.rightName, fixture.sharedEmail, "crm04-browser-right");
    await assignAdvisor(page, LEFT_STUDENT.id, 2028, "transfer", "crm04-browser-case-left");
    await assignAdvisor(page, RIGHT_STUDENT.id, 2029, "s1_admission", "crm04-browser-case-right");

    stage = "founder_entry";
    await page.goto(`${baseUrl}/students`, { waitUntil: "domcontentloaded" });
    const entry = page.getByRole("link", { name: "審查疑似重複資料", exact: true });
    await entry.waitFor({ state: "visible" });
    evidence.founder_entry = await entry.count() === 1;
    assert.equal(evidence.founder_entry, true);
    await entry.click();

    stage = "queue_ready";
    await page.waitForURL((url) => url.pathname === "/students/duplicates");
    await queueHeading(page).waitFor({ state: "visible" });

    stage = "search_post_only";
    let searchPosts = 0;
    let searchUsedGet = false;
    let searchIncludedKey = false;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path !== "/api/v1/crm/duplicate-records/search") return;
      if (request.method() === "POST") searchPosts += 1;
      else searchUsedGet = true;
      if (request.headers()["idempotency-key"]) searchIncludedKey = true;
    });
    await searchPicker(page, "資料一", "crm04-browser-shared");
    await searchPicker(page, "資料二", "crm04-browser-shared");
    evidence.search_post_only = searchPosts === 2 && !searchUsedGet && !searchIncludedKey;
    assert.equal(evidence.search_post_only, true);
    evidence.search_masked = await page.getByText(fixture.sharedEmail, { exact: true }).count() === 0;
    assert.equal(evidence.search_masked, true);

    stage = "candidate_validation";
    const createButton = page.getByRole("button", { name: "建立審查候選", exact: true });
    let candidatePostCount = 0;
    const countCandidatePosts = (request: { method(): string; url(): string }) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/crm/duplicate-candidates") {
        candidatePostCount += 1;
      }
    };
    page.on("request", countCandidatePosts);
    await createButton.click();
    await page.getByRole("alert").filter({ hasText: "請明確選擇兩筆不同的資料" }).waitFor({ state: "visible" });
    evidence.candidate_validation_zero_post = candidatePostCount === 0;
    assert.equal(evidence.candidate_validation_zero_post, true);

    stage = "candidate_idempotency";
    const leftRadios = page.getByRole("radiogroup", { name: "資料一查找結果", exact: true }).getByRole("radio");
    const rightRadios = page.getByRole("radiogroup", { name: "資料二查找結果", exact: true }).getByRole("radio");
    evidence.no_auto_choice = await checkedCount(leftRadios) === 0 && await checkedCount(rightRadios) === 0;
    assert.equal(evidence.no_auto_choice, true);
    await leftRadios.nth(0).check({ force: true });
    await rightRadios.nth(1).check({ force: true });
    evidence.manual_pair_selected = await checkedCount(leftRadios) === 1 && await checkedCount(rightRadios) === 1;
    assert.equal(evidence.manual_pair_selected, true);
    const candidateKeys: string[] = [];
    let abortedCandidateAttempts = 0;
    const candidateRoute = async (route: Route) => {
      candidateKeys.push(route.request().headers()["idempotency-key"] ?? "");
      abortedCandidateAttempts += 1;
      await route.abort("timedout");
    };
    await page.route("**/api/v1/crm/duplicate-candidates", candidateRoute);
    await createButton.click();
    await unavailableAlert(page, "重試不會重複建立候選");
    await createButton.click();
    await unavailableAlert(page, "重試不會重複建立候選");
    await page.unroute("**/api/v1/crm/duplicate-candidates", candidateRoute);
    evidence.candidate_retry_same_key = abortedCandidateAttempts === 2 && candidateKeys[0] !== "" && candidateKeys[0] === candidateKeys[1];
    assert.equal(evidence.candidate_retry_same_key, true);

    await page.getByRole("combobox", { name: "資料類型", exact: true }).first().selectOption("guardian");
    await page.getByRole("combobox", { name: "資料類型", exact: true }).first().selectOption("student");
    await searchPicker(page, "資料一", "crm04-browser-shared");
    await searchPicker(page, "資料二", "crm04-browser-shared");
    const swappedLeft = page.getByRole("radiogroup", { name: "資料一查找結果", exact: true }).getByRole("radio");
    const swappedRight = page.getByRole("radiogroup", { name: "資料二查找結果", exact: true }).getByRole("radio");
    await swappedLeft.nth(1).check({ force: true });
    await swappedRight.nth(0).check({ force: true });

    stage = "candidate_create";
    const candidateResponse = page.waitForResponse((response) => isMethodPath(response, "POST", "/api/v1/crm/duplicate-candidates"));
    let realCandidatePosts = 0;
    const realCandidateObserver = (request: { method(): string; url(): string; headers(): Record<string, string> }) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/v1/crm/duplicate-candidates") return;
      realCandidatePosts += 1;
      candidateKeys.push(request.headers()["idempotency-key"] ?? "");
    };
    page.on("request", realCandidateObserver);
    await createButton.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
    assert.equal((await candidateResponse).status(), 201);
    await page.waitForURL((url) => /^\/students\/duplicates\/[0-9a-f-]+$/i.test(url.pathname));
    candidateId = page.url().split("/").at(-1) ?? "";
    assert.match(candidateId, /^[0-9a-f-]{36}$/i);
    evidence.candidate_double_post_count = realCandidatePosts;
    evidence.candidate_change_rotates_key = candidateKeys[2] !== "" && candidateKeys[2] !== candidateKeys[1];
    assert.equal(evidence.candidate_double_post_count, 1);
    assert.equal(evidence.candidate_change_rotates_key, true);
    page.off("request", countCandidatePosts);
    page.off("request", realCandidateObserver);

    stage = "detail_manual_choice";
    await reviewHeading(page).waitFor({ state: "visible" });
    const decisionSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "合併決定", exact: true }) });
    const decisionRadios = decisionSection.getByRole("radio");
    evidence.no_auto_choice = evidence.no_auto_choice && await checkedCount(decisionRadios) === 0;
    assert.equal(evidence.no_auto_choice, true);
    await fillMergeDecision(page, 0);

    stage = "keyboard_focus";
    const confirmation = page.getByRole("checkbox", { name: /我確認來源資料的 UUID/ });
    await confirmation.focus();
    await page.keyboard.press("Space");
    evidence.keyboard_focus = await confirmation.isChecked();
    assert.equal(evidence.keyboard_focus, true);

    stage = "merge_idempotency";
    const mergeButton = page.getByRole("button", { name: "確認合併決定", exact: true });
    const mergeKeys: string[] = [];
    let abortedMergeAttempts = 0;
    const mergeRoute = async (route: Route) => {
      mergeKeys.push(route.request().headers()["idempotency-key"] ?? "");
      abortedMergeAttempts += 1;
      await route.abort("timedout");
    };
    await page.route("**/api/v1/crm/duplicate-candidates/*/merges", mergeRoute);
    await mergeButton.click();
    await unavailableAlert(page, "不確定結果的重試不會重複寫入");
    await mergeButton.click();
    await unavailableAlert(page, "不確定結果的重試不會重複寫入");
    await page.unroute("**/api/v1/crm/duplicate-candidates/*/merges", mergeRoute);
    evidence.merge_retry_same_key = abortedMergeAttempts === 2 && mergeKeys[0] !== "" && mergeKeys[0] === mergeKeys[1];
    assert.equal(evidence.merge_retry_same_key, true);

    const nameChoices = page.getByRole("group", { name: "姓名", exact: true }).getByRole("radio");
    await nameChoices.nth(1).check({ force: true });
    await confirmation.check();
    const staleSeed = await prepareStudent(page, LEFT_STUDENT.id, 2, fixture.updatedLeftName, fixture.sharedEmail, "crm04-browser-stale");
    assert.equal(staleSeed, true);

    stage = "merge_stale";
    const staleResponse = page.waitForResponse((response) => isMergeResponse(response, candidateId));
    const staleKeyPromise = page.waitForRequest((request) => isMergeRequest(request, candidateId));
    await mergeButton.click();
    assert.equal((await staleResponse).status(), 409);
    mergeKeys.push((await staleKeyPromise).headers()["idempotency-key"] ?? "");
    await page.getByRole("alert").filter({ hasText: "資料已被其他操作更新" }).waitFor({ state: "visible" });
    evidence.merge_change_rotates_key = mergeKeys[2] !== "" && mergeKeys[2] !== mergeKeys[1];
    assert.equal(evidence.merge_change_rotates_key, true);
    await page.getByRole("button", { name: "重新載入最新資料", exact: true }).click();
    await reviewHeading(page).waitFor({ state: "visible" });
    evidence.stale_visible_and_recovered = true;

    await fillMergeDecision(page, 0);
    await confirmation.check();

    stage = "founder_merge_submit";
    evidence.founder_merge_submit.merge_button_count = await mergeButton.count();
    evidence.founder_merge_submit.merge_button_enabled = await mergeButton.isEnabled();
    assert.equal(evidence.founder_merge_submit.merge_button_count, 1);
    assert.equal(evidence.founder_merge_submit.merge_button_enabled, true);
    const detailPath = `/api/v1/crm/duplicate-candidates/${candidateId}`;
    const mergeRequestObserver = (request: { method(): string; url(): string }) => {
      if (!isMergeRequest(request, candidateId)) return;
      evidence.founder_merge_submit.request_started = true;
      evidence.founder_merge_submit.real_merge_post_count += 1;
    };
    const mergeResponseObserver = (response: { request(): { method(): string }; url(): string; status(): number }) => {
      if (!isMergeResponse(response, candidateId)) return;
      evidence.founder_merge_submit.response_received = true;
      evidence.founder_merge_submit.response_status = response.status();
    };
    const refreshRequestObserver = (request: { method(): string; url(): string }) => {
      if (request.method() === "GET" && new URL(request.url()).pathname === detailPath) {
        evidence.founder_merge_authoritative_refresh.request_started = true;
      }
    };
    const refreshResponseObserver = (response: { request(): { method(): string }; url(): string; status(): number }) => {
      if (isMethodPath(response, "GET", detailPath)) {
        evidence.founder_merge_authoritative_refresh.response_received = true;
        evidence.founder_merge_authoritative_refresh.response_status = response.status();
      }
    };
    page.on("request", mergeRequestObserver);
    page.on("response", mergeResponseObserver);
    page.on("request", refreshRequestObserver);
    page.on("response", refreshResponseObserver);
    const mergedResponse = page.waitForResponse((response) => isMergeResponse(response, candidateId));
    const refreshedResponse = page.waitForResponse((response) => isMethodPath(response, "GET", detailPath));
    await mergeButton.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
    const mergeResponse = await mergedResponse;
    evidence.founder_merge_submit.response_status = mergeResponse.status();
    const safeResponse = await readSafeMergeResponse(mergeResponse);
    evidence.founder_merge_submit.response_json_parseable = safeResponse.parseable;
    evidence.founder_merge_submit.response_safe_code = safeResponse.code;
    assert.equal(evidence.founder_merge_submit.request_started, true);
    assert.equal(evidence.founder_merge_submit.response_received, true);
    assert.equal(evidence.founder_merge_submit.response_status, 200);
    assert.equal(evidence.founder_merge_submit.response_json_parseable, true);
    assert.equal(evidence.founder_merge_submit.response_safe_code, "NONE");
    assert.equal(evidence.founder_merge_submit.real_merge_post_count, 1);

    stage = "founder_merge_authoritative_refresh";
    const refreshResponse = await refreshedResponse;
    evidence.founder_merge_authoritative_refresh.response_status = refreshResponse.status();
    assert.equal(evidence.founder_merge_authoritative_refresh.request_started, true);
    assert.equal(evidence.founder_merge_authoritative_refresh.response_received, true);
    assert.equal(evidence.founder_merge_authoritative_refresh.response_status, 200);

    stage = "founder_merge_feedback";
    const successNotice = page.getByRole("status").filter({ hasText: "合併決定已保存" });
    await successNotice.waitFor({ state: "visible" });
    evidence.founder_merge_feedback.success_notice_count = await successNotice.count();
    evidence.founder_merge_feedback.success_notice_visible = await successNotice.isVisible();
    evidence.founder_merge_feedback.active_status_count = await page.getByText("目前有效", { exact: true }).count();
    evidence.merge_double_post_count = evidence.founder_merge_submit.real_merge_post_count;
    evidence.founder_merged = evidence.founder_merge_feedback.active_status_count === 1;
    assert.equal(evidence.founder_merge_feedback.success_notice_count, 1);
    assert.equal(evidence.founder_merge_feedback.success_notice_visible, true);
    assert.equal(evidence.merge_double_post_count, 1);
    assert.equal(evidence.founder_merged, true);
    page.off("request", mergeRequestObserver);
    page.off("response", mergeResponseObserver);
    page.off("request", refreshRequestObserver);
    page.off("response", refreshResponseObserver);

    const mergeDetail = await api(page, `/api/v1/crm/duplicate-candidates/${candidateId}`, "GET");
    const mergeRecord = record(record(mergeDetail.data).merge);
    mergeId = stringField(mergeRecord, "id");

    stage = "authoritative_refresh";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "目前合併結果", exact: true }).waitFor({ state: "visible" });
    await page.goto(`${baseUrl}/students/duplicates`, { waitUntil: "domcontentloaded" });
    await queueHeading(page).waitFor({ state: "visible" });
    await page.getByRole("combobox", { name: "處理狀態", exact: true }).selectOption("merged");
    const candidateLink = page.getByRole("link", { name: "查看比較", exact: true });
    await candidateLink.waitFor({ state: "visible" });
    evidence.authoritative_list_detail = await candidateLink.count() >= 1;
    assert.equal(evidence.authoritative_list_detail, true);
    await page.goto(`${baseUrl}/students/duplicates/${candidateId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "目前合併結果", exact: true }).waitFor({ state: "visible" });

    stage = "two_uuid_resolution";
    evidence.two_uuid_same_authority = await twoUuidResolution(page, LEFT_STUDENT.id, RIGHT_STUDENT.id);
    assert.equal(evidence.two_uuid_same_authority, true);

    stage = "relogin_persistence";
    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!, "founder", loginEvidence, (value) => { stage = value; });
    stage = "relogin_persistence";
    await page.goto(`${baseUrl}/students/duplicates/${candidateId}`, { waitUntil: "domcontentloaded" });
    await page.getByText("目前有效", { exact: true }).waitFor({ state: "visible" });
    evidence.relogin_persisted = true;

    stage = "candidate_conflict";
    await page.goto(`${baseUrl}/students/duplicates`, { waitUntil: "domcontentloaded" });
    await queueHeading(page).waitFor({ state: "visible" });
    await searchPicker(page, "資料一", "crm04-browser-shared");
    await searchPicker(page, "資料二", "crm04-browser-shared");
    const conflictLeft = page.getByRole("radiogroup", { name: "資料一查找結果", exact: true }).getByRole("radio");
    const conflictRight = page.getByRole("radiogroup", { name: "資料二查找結果", exact: true }).getByRole("radio");
    await conflictLeft.nth(0).check({ force: true });
    await conflictRight.nth(1).check({ force: true });
    await page.getByRole("button", { name: "建立審查候選", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "這組資料已有待處理或已完成的決定" }).waitFor({ state: "visible" });
    evidence.conflict_visible = true;

    stage = "corrective_undo";
    await page.goto(`${baseUrl}/students/duplicates/${candidateId}`, { waitUntil: "domcontentloaded" });
    const correctionCheckbox = page.getByRole("checkbox", { name: /我確認要更正目前合併決定/ });
    await correctionCheckbox.check();
    const correctionButton = page.getByRole("button", { name: "確認更正", exact: true });
    const correctionKeys: string[] = [];
    const correctionRoute = async (route: Route) => {
      correctionKeys.push(route.request().headers()["idempotency-key"] ?? "");
      await route.abort("timedout");
    };
    await page.route("**/api/v1/crm/duplicate-merges/*/corrections", correctionRoute);
    await correctionButton.click();
    await unavailableAlert(page, "不確定結果的重試不會重複寫入");
    await correctionButton.click();
    await unavailableAlert(page, "不確定結果的重試不會重複寫入");
    await page.unroute("**/api/v1/crm/duplicate-merges/*/corrections", correctionRoute);
    assert.equal(correctionKeys[0] !== "" && correctionKeys[0] === correctionKeys[1], true);
    const correctionResponse = page.waitForResponse((response) => isMethodPath(response, "POST", `/api/v1/crm/duplicate-merges/${mergeId}/corrections`));
    await correctionButton.click();
    assert.equal((await correctionResponse).status(), 200);
    await page.getByRole("status").filter({ hasText: "更正已保存" }).waitFor({ state: "visible" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("已更正", { exact: true }).first().waitFor({ state: "visible" });
    const corrected = await api(page, `/api/v1/crm/duplicate-candidates/${candidateId}`, "GET");
    const correctedMerge = record(record(corrected.data).merge);
    evidence.corrected_authority = corrected.status === 200 && correctedMerge.status === "corrected" && correctedMerge.record_version === 2 && typeof correctedMerge.correction_id === "string";
    assert.equal(evidence.corrected_authority, true);

    stage = "advisor_students_navigation";
    await logout(page);
    await login(page, baseUrl, ADVISOR.email, passwords.get("advisor")!, "advisor", loginEvidence, (value) => { stage = value; });
    stage = "advisor_students_navigation";
    evidence.advisor_entry = await visibleDuplicateEntry(
      page,
      baseUrl,
      evidence.advisor_students_entry,
      "ready",
      (phase) => {
        stage = phase === "navigation" ? "advisor_students_navigation" :
          phase === "readiness" ? "advisor_students_ready" : "advisor_entry";
      },
    );
    evidence.advisor_review_state.entry_or_queue_reachable = evidence.advisor_entry;
    assert.equal(evidence.advisor_entry, true);
    evidence.advisor_review_only = await assertReviewOnly(
      page,
      baseUrl,
      candidateId,
      evidence.advisor_review_state,
      (phase) => { stage = phase === "detail" ? "advisor_review_detail" : "advisor_review_state"; },
    );
    assert.equal(evidence.advisor_entry && evidence.advisor_review_only, true);

    stage = "data_reviewer_queue";
    await logout(page);
    await login(page, baseUrl, DATA_REVIEWER.email, passwords.get("data_reviewer")!, "data_reviewer", loginEvidence, (value) => { stage = value; });
    stage = "data_reviewer_queue";
    evidence.data_reviewer_queue = await canOpenQueue(page, baseUrl);
    evidence.data_reviewer_review_state.entry_or_queue_reachable = evidence.data_reviewer_queue;
    assert.equal(evidence.data_reviewer_queue, true);
    evidence.data_reviewer_review_only = await assertReviewOnly(
      page,
      baseUrl,
      candidateId,
      evidence.data_reviewer_review_state,
      (phase) => { stage = phase === "detail" ? "data_reviewer_review_detail" : "data_reviewer_review_state"; },
    );
    assert.equal(evidence.data_reviewer_queue && evidence.data_reviewer_review_only, true);

    stage = "admin_students_navigation";
    await logout(page);
    await login(page, baseUrl, ADMIN.email, passwords.get("admin")!, "admin", loginEvidence, (value) => { stage = value; });
    stage = "admin_students_navigation";
    evidence.admin_entry_hidden = !(await visibleDuplicateEntry(
      page,
      baseUrl,
      evidence.admin_students_entry,
      "ready",
      (phase) => {
        stage = phase === "navigation" ? "admin_students_navigation" :
          phase === "readiness" ? "admin_students_ready" : "admin_entry_hidden";
      },
    ));
    stage = "admin_direct_denied";
    evidence.admin_direct_403_count = await assertDirectDenied(page, candidateId, mergeId);
    assert.equal(evidence.admin_entry_hidden, true);
    assert.equal(evidence.admin_direct_403_count, 6);

    stage = "contractor_students_navigation";
    await logout(page);
    await login(page, baseUrl, CONTRACTOR.email, passwords.get("contractor")!, "contractor", loginEvidence, (value) => { stage = value; });
    stage = "contractor_students_navigation";
    evidence.contractor_entry_hidden = !(await visibleDuplicateEntry(
      page,
      baseUrl,
      evidence.contractor_students_entry,
      "denied",
      (phase) => {
        stage = phase === "navigation" ? "contractor_students_navigation" :
          phase === "readiness" ? "contractor_students_denied" : "contractor_entry_hidden";
      },
    ));
    stage = "contractor_direct_denied";
    evidence.contractor_direct_403_count = await assertDirectDenied(page, candidateId, mergeId);
    assert.equal(evidence.contractor_entry_hidden, true);
    assert.equal(evidence.contractor_direct_403_count, 6);

    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!, "founder", loginEvidence, (value) => { stage = value; });
    stage = "desktop_viewport";
    await page.goto(`${baseUrl}/students/duplicates`, { waitUntil: "domcontentloaded" });
    await queueHeading(page).waitFor({ state: "visible" });
    evidence.desktop = await assertViewport(page);

    stage = "mobile_viewport";
    await page.setViewportSize({ width: 390, height: 844 });
    evidence.mobile = await assertViewport(page);
    await page.goto(`${baseUrl}/students/duplicates/${candidateId}`, { waitUntil: "domcontentloaded" });
    await reviewHeading(page).waitFor({ state: "visible" });
    const mobileDetail = await assertViewport(page);
    assert.deepEqual(mobileDetail, zeroViewport());

    stage = "browser_log_safety";
    const forbidden = [
      fixture.leftName, fixture.rightName, fixture.updatedLeftName, fixture.sharedEmail,
      ...NEON_TEST_PRINCIPALS.map((entry) => entry.email),
      ...passwords.values(), applicationPassword, "postgresql://", "tx_session=",
    ];
    evidence.sensitive_log_matches = [...browserMessages, ...(devServer ? devLogLines(devServer) : [])]
      .filter((message) => forbidden.some((value) => value !== "" && message.includes(value))).length;
    assert.equal(evidence.page_errors, 0);
    assert.equal(evidence.sensitive_log_matches, 0);
    stage = "complete";
  } catch {
    failureStage = stage;
  } finally {
    stage = "cleanup";
    cleanup.context_closed = await closeContext(context);
    cleanup.dev_stopped = await stopNextDev(devServer);
    cleanup.app_removed = await removeDirectory(appDirectory);
    cleanup.profile_removed = await removeDirectory(profileDirectory);
    if (containerStarted) cleanup.container_removed = (await runDocker(["rm", "--force", containerName], stage, undefined, true)).exitCode === 0;
    else cleanup.container_removed = true;
    if (volumeCreated) cleanup.volume_removed = (await runDocker(["volume", "rm", "--force", volumeName], stage, undefined, true)).exitCode === 0;
    else cleanup.volume_removed = true;
  }

  const cleanupPassed = Object.values(cleanup).every(Boolean);
  if (failureStage !== null || !cleanupPassed) {
    process.stdout.write(`${JSON.stringify(Object.freeze({
      status: "failed",
      stage: failureStage ?? "cleanup",
      evidence: Object.freeze({ ...evidence }),
      login: Object.freeze({ ...loginEvidence }),
      cleanup: Object.freeze({ ...cleanup }),
    }))}\n`);
    throw new BrowserGateError(failureStage ?? "cleanup");
  }
  process.stdout.write(`${JSON.stringify(Object.freeze({
    status: "pass",
    stage: "complete",
    runtime: Object.freeze({
      postgres_major: 17,
      baseline_generated_files: evidence.baseline_generated_files,
      seed: "release1_synthetic",
      browser_driver: "playwright-core-1.55.0",
      browser_binary: "system_chrome",
    }),
    evidence: Object.freeze({ ...evidence }),
    cleanup: Object.freeze({ ...cleanup }),
  }))}\n`);
});

function principal(role: LoginActor) {
  const value = NEON_TEST_PRINCIPALS.find((entry) => entry.role === role);
  if (!value) throw new Error("Missing synthetic principal.");
  return value;
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
  evidence.page_pathname = safePath(page.url(), "/login");
  assert.equal(evidence.page_status, 200);
  assert.equal(evidence.page_pathname, "/login");

  setStage("login_form_ready");
  const emailField = page.getByRole("textbox", { name: "測試帳號電郵", exact: true });
  const passwordField = page.getByLabel("密碼", { exact: true });
  const submitButton = page.getByRole("button", { name: "登入測試工作台", exact: true });
  await emailField.waitFor({ state: "visible" });
  await passwordField.waitFor({ state: "visible" });
  await submitButton.waitFor({ state: "visible" });
  evidence.form_controls = await emailField.count() + await passwordField.count() + await submitButton.count();
  assert.equal(evidence.form_controls, 3);
  await emailField.fill(email);
  await passwordField.fill(password);
  const loginResponse = page.waitForResponse((response) =>
    isMethodPath(response, "POST", "/api/v1/auth/login"));
  const authResponse = page.waitForResponse((response) =>
    isMethodPath(response, "GET", "/api/v1/auth/me"));

  setStage("login_submit_response");
  await submitButton.click();
  evidence.submit_status = (await loginResponse).status();
  assert.equal(evidence.submit_status, 303);

  setStage("login_redirect");
  await page.waitForURL((url) => url.pathname === "/today");
  evidence.redirect_pathname = safePath(page.url(), "/today");
  assert.equal(evidence.redirect_pathname, "/today");

  setStage("login_session_response");
  evidence.auth_me_status = (await authResponse).status();
  assert.equal(evidence.auth_me_status, 200);

  setStage("login_workspace_render");
  const heading = page.getByRole("heading", { name: "今日工作", exact: true, level: 2 });
  await heading.waitFor({ state: "visible" });
  evidence.workspace_heading_count = await heading.count();
  assert.equal(evidence.workspace_heading_count, 1);
}

async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "帳戶選單", exact: true }).click();
  await page.getByRole("menuitem", { name: "登出", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/login");
  await page.getByRole("textbox", { name: "測試帳號電郵", exact: true }).waitFor({ state: "visible" });
}

function emptyLoginEvidence(): LoginEvidence {
  return {
    actor: null,
    page_status: null,
    page_pathname: null,
    form_controls: null,
    submit_status: null,
    redirect_pathname: null,
    auth_me_status: null,
    workspace_heading_count: null,
  };
}

function safePath<T extends "/login" | "/today">(url: string, expected: T): T | "other" {
  return new URL(url).pathname === expected ? expected : "other";
}

async function prepareStudent(
  page: Page,
  studentId: string,
  expectedVersion: number,
  displayName: string,
  email: string,
  key: string,
): Promise<boolean> {
  const result = await api(page, `/api/v1/students/${studentId}`, "PATCH", {
    display_name: displayName,
    date_of_birth: "2013-04-05",
    contact_email: email,
    contact_phone: null,
    expected_record_version: expectedVersion,
  }, key);
  const acknowledgement = record(result.data).student;
  return result.status === 200 && result.jsonParseable && isRecord(acknowledgement) &&
    acknowledgement.id === studentId && acknowledgement.record_version === expectedVersion + 1 &&
    typeof acknowledgement.updated_at === "string";
}

async function assignAdvisor(
  page: Page,
  studentId: string,
  intakeYear: number,
  admissionType: "transfer" | "s1_admission",
  key: string,
): Promise<void> {
  const result = await api(page, "/api/v1/cases", "POST", {
    student_id: studentId,
    intake_year: intakeYear,
    admission_type: admissionType,
    primary_role_binding_id: ADVISOR.roleBindingId,
    manifest_id: NEON_TEST_MANIFEST_ID,
  }, key);
  const createdCase = record(record(result.data).case);
  assert.equal(result.status, 200);
  assert.equal(createdCase.studentId, studentId);
  assert.equal(createdCase.intakeYear, intakeYear);
}

async function api(
  page: Page,
  path: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
  idempotencyKey?: string,
): Promise<BrowserApiResult> {
  return page.evaluate(async (input): Promise<BrowserApiResult> => {
    try {
      const headers: Record<string, string> = {};
      if (input.body !== undefined) headers["content-type"] = "application/json";
      if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
      const response = await fetch(input.path, {
        method: input.method,
        credentials: "same-origin",
        cache: "no-store",
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      });
      try {
        const payload = await response.json() as { readonly data?: unknown; readonly error?: { readonly code?: unknown } };
        const rawCode = payload.error?.code;
        const code = rawCode === "FORBIDDEN" || rawCode === "CONFLICT" || rawCode === "STALE_VERSION"
          ? rawCode : typeof rawCode === "string" ? "OTHER" : null;
        return { status: response.status, jsonParseable: true, code, data: payload.data ?? null };
      } catch {
        return { status: response.status, jsonParseable: false, code: null, data: null };
      }
    } catch {
      return { status: null, jsonParseable: false, code: null, data: null };
    }
  }, { path, method, body, idempotencyKey });
}

function queueHeading(page: Page): Locator {
  return page.getByRole("heading", { name: "疑似重複資料審查", exact: true, level: 2 });
}

function reviewHeading(page: Page): Locator {
  return page.getByRole("heading", { name: "人工比較資料", exact: true, level: 2 });
}

async function searchPicker(page: Page, title: "資料一" | "資料二", query: string): Promise<void> {
  const picker = page.getByRole("group", { name: title, exact: true });
  const response = page.waitForResponse((candidate) =>
    isMethodPath(candidate, "POST", "/api/v1/crm/duplicate-records/search"));
  await picker.getByRole("searchbox", { name: "查找學生", exact: true }).fill(query);
  await picker.getByRole("button", { name: "查找", exact: true }).click();
  assert.equal((await response).status(), 200);
  const group = page.getByRole("radiogroup", { name: `${title}查找結果`, exact: true });
  await group.waitFor({ state: "visible" });
  assert.equal(await group.getByRole("radio").count(), 2);
}

async function checkedCount(locator: Locator): Promise<number> {
  let count = 0;
  for (let index = 0; index < await locator.count(); index += 1) {
    if (await locator.nth(index).isChecked()) count += 1;
  }
  return count;
}

async function fillMergeDecision(page: Page, optionIndex: 0 | 1): Promise<void> {
  const canonical = page.getByRole("group", { name: "選擇主要資料", exact: true }).getByRole("radio");
  const source = page.getByRole("group", { name: "選擇來源資料", exact: true }).getByRole("radio");
  await canonical.nth(optionIndex).check({ force: true });
  await source.nth(optionIndex === 0 ? 1 : 0).check({ force: true });
  for (const field of ["姓名", "出生日期", "Email", "電話"] as const) {
    await page.getByRole("group", { name: field, exact: true }).getByRole("radio").nth(optionIndex).check({ force: true });
  }
}

async function unavailableAlert(page: Page, text: string): Promise<void> {
  await page.getByRole("alert").filter({ hasText: text }).waitFor({ state: "visible" });
}

async function twoUuidResolution(page: Page, leftId: string, rightId: string): Promise<boolean> {
  return page.evaluate(async ({ leftId: left, rightId: right }) => {
    try {
      const [leftResponse, rightResponse] = await Promise.all([
        fetch(`/api/v1/students/${left}`, { credentials: "same-origin", cache: "no-store" }),
        fetch(`/api/v1/students/${right}`, { credentials: "same-origin", cache: "no-store" }),
      ]);
      const [leftPayload, rightPayload] = await Promise.all([leftResponse.json(), rightResponse.json()]) as [
        { data?: { student?: { id?: unknown } } }, { data?: { student?: { id?: unknown } } },
      ];
      return leftResponse.status === 200 && rightResponse.status === 200 &&
        typeof leftPayload.data?.student?.id === "string" &&
        leftPayload.data.student.id === rightPayload.data?.student?.id;
    } catch {
      return false;
    }
  }, { leftId, rightId });
}

async function visibleDuplicateEntry(
  page: Page,
  baseUrl: string,
  evidence: StudentsEntryEvidence,
  expectedState: "ready" | "denied",
  setStage: (phase: "navigation" | "readiness" | "entry") => void,
): Promise<boolean> {
  const studentsPath = "/api/v1/students";
  const accessPath = "/api/v1/auth/me";
  const requestObserver = (request: { method(): string; url(): string }) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") return;
    if (path === studentsPath) evidence.students_request_started = true;
    if (path === accessPath) evidence.access_request_started = true;
  };
  const responseObserver = (response: { request(): { method(): string }; url(): string; status(): number }) => {
    const path = new URL(response.url()).pathname;
    if (response.request().method() !== "GET") return;
    if (path === studentsPath) {
      evidence.students_response_received = true;
      evidence.students_response_status = response.status();
    }
    if (path === accessPath) {
      evidence.access_response_received = true;
      evidence.access_response_status = response.status();
    }
  };
  page.on("request", requestObserver);
  page.on("response", responseObserver);
  try {
    setStage("navigation");
    const studentsResponse = page.waitForResponse((response) => isMethodPath(response, "GET", studentsPath));
    const accessResponse = page.waitForResponse((response) => isMethodPath(response, "GET", accessPath));
    const navigation = await page.goto(`${baseUrl}/students`, { waitUntil: "domcontentloaded" });
    evidence.navigation_status = navigation?.status() ?? null;
    assert.equal(evidence.navigation_status, 200);
    evidence.students_response_status = (await studentsResponse).status();
    evidence.access_response_status = (await accessResponse).status();
    assert.equal(evidence.students_request_started, true);
    assert.equal(evidence.students_response_received, true);
    assert.equal(evidence.access_request_started, true);
    assert.equal(evidence.access_response_received, true);
    assert.equal(evidence.access_response_status, 200);

    const heading = page.getByRole("heading", { name: "學生與監護人", exact: true, level: 2 });
    await heading.waitFor({ state: "visible" });
    evidence.shell_heading_count = await heading.count();
    assert.equal(evidence.shell_heading_count, 1);

    setStage("readiness");
    const readyStatus = page.getByText(/^顯示 \d+ \/ \d+ 位學生$/);
    const loading = page.getByText("正在載入學生", { exact: true });
    const unauthenticated = page.getByText("工作階段已失效", { exact: true });
    const denied = page.getByText("無法查看學生資料", { exact: true });
    const unavailable = page.getByText("學生服務暫時不可用", { exact: true });
    if (expectedState === "ready") {
      await readyStatus.waitFor({ state: "visible" });
      evidence.page_state = "ready";
    } else {
      await denied.waitFor({ state: "visible" });
      evidence.page_state = "denied";
    }
    evidence.ready_status_count = await readyStatus.count();
    evidence.loading_count = await loading.count();
    evidence.unauthenticated_count = await unauthenticated.count();
    evidence.denied_count = await denied.count();
    evidence.unavailable_count = await unavailable.count();
    assert.equal(evidence.loading_count, 0);
    assert.equal(evidence.unauthenticated_count, 0);
    assert.equal(evidence.unavailable_count, 0);
    if (expectedState === "ready") {
      assert.equal(evidence.students_response_status, 200);
      assert.equal(evidence.ready_status_count, 1);
      assert.equal(evidence.denied_count, 0);
    } else {
      assert.equal(evidence.students_response_status, 403);
      assert.equal(evidence.ready_status_count, 0);
      assert.equal(evidence.denied_count, 1);
    }

    setStage("entry");
    const entry = page.getByRole("link", { name: "審查疑似重複資料", exact: true });
    evidence.entry_count = await entry.count();
    evidence.entry_visible = evidence.entry_count === 1 ? await entry.isVisible() : false;
    if (expectedState === "denied") {
      assert.equal(evidence.entry_count, 0);
      assert.equal(evidence.entry_visible, false);
    }
    return evidence.entry_count === 1 && evidence.entry_visible === true;
  } finally {
    page.off("request", requestObserver);
    page.off("response", responseObserver);
  }
}

function emptyStudentsEntryEvidence(): StudentsEntryEvidence {
  return {
    navigation_status: null,
    students_request_started: false,
    students_response_received: false,
    students_response_status: null,
    access_request_started: false,
    access_response_received: false,
    access_response_status: null,
    shell_heading_count: null,
    page_state: null,
    ready_status_count: null,
    loading_count: null,
    unauthenticated_count: null,
    denied_count: null,
    unavailable_count: null,
    entry_count: null,
    entry_visible: null,
  };
}

async function canOpenQueue(page: Page, baseUrl: string): Promise<boolean> {
  const response = page.waitForResponse((candidate) =>
    candidate.request().method() === "GET" &&
    new URL(candidate.url()).pathname === "/api/v1/crm/duplicate-candidates");
  const navigation = await page.goto(`${baseUrl}/students/duplicates`, { waitUntil: "domcontentloaded" });
  if (navigation?.status() !== 200 || (await response).status() !== 200) return false;
  await queueHeading(page).waitFor({ state: "visible" });
  return true;
}

async function assertReviewOnly(
  page: Page,
  baseUrl: string,
  candidateId: string,
  evidence: ReviewOnlyEvidence,
  setStage: (phase: "detail" | "state") => void,
): Promise<boolean> {
  setStage("detail");
  const detailPath = `/api/v1/crm/duplicate-candidates/${candidateId}`;
  const requestObserver = (request: { method(): string; url(): string }) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === detailPath) {
      evidence.detail_request_started = true;
    }
  };
  const responseObserver = (response: { request(): { method(): string }; url(): string; status(): number }) => {
    if (isMethodPath(response, "GET", detailPath)) {
      evidence.detail_response_received = true;
      evidence.detail_response_status = response.status();
    }
  };
  page.on("request", requestObserver);
  page.on("response", responseObserver);
  try {
    const responsePromise = page.waitForResponse((response) => isMethodPath(response, "GET", detailPath));
    const navigation = await page.goto(`${baseUrl}${detailPath.replace("/api/v1/crm/duplicate-candidates", "/students/duplicates")}`, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(navigation?.status(), 200);
    evidence.detail_response_status = (await responsePromise).status();
    assert.equal(evidence.detail_request_started, true);
    assert.equal(evidence.detail_response_received, true);
    assert.equal(evidence.detail_response_status, 200);
    const heading = reviewHeading(page);
    await heading.waitFor({ state: "visible" });
    evidence.review_heading_count = await heading.count();
    assert.equal(evidence.review_heading_count, 1);

    setStage("state");
    const genericText = "你可以查看並比較資料，但目前沒有合併或更正權限。服務端仍會獨立驗證每項操作。";
    const correctedText = "這項合併決定已透過更正紀錄撤回，來源資料已恢復為獨立資料；既有歷史沒有被刪除。";
    const genericNotice = page.getByRole("status").filter({
      has: page.getByText(genericText, { exact: true }),
    });
    const correctedNotice = page.getByRole("status").filter({
      has: page.getByText(correctedText, { exact: true }),
    });
    await genericNotice.or(correctedNotice).first().waitFor({ state: "visible" });
    evidence.generic_notice_count = await genericNotice.count();
    evidence.generic_notice_visible = await genericNotice.isVisible().catch(() => false);
    evidence.corrected_notice_count = await correctedNotice.count();
    evidence.corrected_notice_visible = await correctedNotice.isVisible().catch(() => false);
    const genericReady = evidence.generic_notice_count === 1 && evidence.generic_notice_visible === true;
    const correctedReady = evidence.corrected_notice_count === 1 && evidence.corrected_notice_visible === true;
    assert.equal(Number(genericReady) + Number(correctedReady), 1);
    evidence.authoritative_state = correctedReady ? "corrected" : "pending_or_active";
    evidence.merge_button_count = await page.getByRole("button", { name: "確認合併決定", exact: true }).count();
    evidence.correction_button_count = await page.getByRole("button", { name: "確認更正", exact: true }).count();
    assert.equal(evidence.merge_button_count, 0);
    assert.equal(evidence.correction_button_count, 0);
    return true;
  } finally {
    page.off("request", requestObserver);
    page.off("response", responseObserver);
  }
}

function emptyReviewOnlyEvidence(): ReviewOnlyEvidence {
  return {
    entry_or_queue_reachable: false,
    detail_request_started: false,
    detail_response_received: false,
    detail_response_status: null,
    review_heading_count: null,
    authoritative_state: null,
    generic_notice_count: null,
    generic_notice_visible: null,
    corrected_notice_count: null,
    corrected_notice_visible: null,
    merge_button_count: null,
    correction_button_count: null,
  };
}

async function assertDirectDenied(page: Page, candidateId: string, mergeId: string): Promise<number> {
  const bodies = [
    { path: "/api/v1/crm/duplicate-records/search", method: "POST" as const,
      body: { entity_type: "student", query: "CRM04" }, key: undefined },
    { path: "/api/v1/crm/duplicate-candidates?entity_type=student&status=merged", method: "GET" as const,
      body: undefined, key: undefined },
    { path: "/api/v1/crm/duplicate-candidates", method: "POST" as const,
      body: { entity_type: "student", left_record_id: LEFT_STUDENT.id, right_record_id: RIGHT_STUDENT.id }, key: "crm04-denied-candidate" },
    { path: `/api/v1/crm/duplicate-candidates/${candidateId}`, method: "GET" as const,
      body: undefined, key: undefined },
    { path: `/api/v1/crm/duplicate-candidates/${candidateId}/merges`, method: "POST" as const,
      body: { source_record_id: LEFT_STUDENT.id, canonical_record_id: RIGHT_STUDENT.id,
        expected_candidate_record_version: 1, expected_source_record_version: 1,
        expected_canonical_record_version: 1, field_selections: [], reason_code: "duplicate.confirmed" }, key: "crm04-denied-merge" },
    { path: `/api/v1/crm/duplicate-merges/${mergeId}/corrections`, method: "POST" as const,
      body: { expected_merge_record_version: 2, reason_code: "duplicate.merge.corrected" }, key: "crm04-denied-correction" },
  ];
  let denied = 0;
  for (const request of bodies) {
    const result = await api(page, request.path, request.method, request.body, request.key);
    if (result.status === 403 && result.code === "FORBIDDEN") denied += 1;
  }
  return denied;
}

async function assertViewport(page: Page): Promise<ViewportEvidence> {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const main = document.querySelector("main") ?? document.body;
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
    };
    const controls = [...main.querySelectorAll("a,button,input,select")].filter(visible);
    const outOfBounds = controls.filter((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left < -1 || bounds.right > window.innerWidth + 1;
    }).length;
    let overlap = 0;
    for (let left = 0; left < controls.length; left += 1) {
      const a = controls[left]!.getBoundingClientRect();
      for (let right = left + 1; right < controls.length; right += 1) {
        const b = controls[right]!.getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) overlap += 1;
      }
    }
    const clipped = [...main.querySelectorAll("h1,h2,h3,p,label,button,a,strong,small")]
      .filter(visible).filter((element) => {
        const value = element as HTMLElement;
        return !value.classList.contains("truncate") && value.scrollWidth > value.clientWidth + 1 &&
          getComputedStyle(value).overflowX === "hidden";
      }).length;
    return {
      page_horizontal_overflow: Math.max(0, root.scrollWidth - window.innerWidth),
      out_of_bounds_controls: outOfBounds,
      overlapping_controls: overlap,
      clipped_text: clipped,
    };
  });
  assert.deepEqual(result, zeroViewport());
  return result;
}

function zeroViewport(): ViewportEvidence {
  return { page_horizontal_overflow: 0, out_of_bounds_controls: 0, overlapping_controls: 0, clipped_text: 0 };
}

function isMethodPath(
  value: { request(): { method(): string }; url(): string },
  method: string,
  path: string,
): boolean {
  return value.request().method() === method && new URL(value.url()).pathname === path;
}

function isMergeRequest(value: { method(): string; url(): string }, candidateId: string): boolean {
  return value.method() === "POST" &&
    new URL(value.url()).pathname === `/api/v1/crm/duplicate-candidates/${candidateId}/merges`;
}

function isMergeResponse(value: { request(): { method(): string }; url(): string }, candidateId: string): boolean {
  return isMethodPath(value, "POST", `/api/v1/crm/duplicate-candidates/${candidateId}/merges`);
}

async function readSafeMergeResponse(response: PlaywrightResponse): Promise<Readonly<{
  parseable: boolean;
  code: SafeMergeResponseCode;
}>> {
  try {
    const payload = await response.json() as unknown;
    if (response.status() < 400) return Object.freeze({ parseable: true, code: "NONE" });
    if (!isRecord(payload) || !isRecord(payload.error) || typeof payload.error.code !== "string") {
      return Object.freeze({ parseable: true, code: "OTHER" });
    }
    const code = payload.error.code;
    if (code === "STALE_VERSION" || code === "CONFLICT" || code === "VALIDATION_FAILED" ||
      code === "FORBIDDEN" || code === "SERVICE_UNAVAILABLE" || code === "INTERNAL_ERROR") {
      return Object.freeze({ parseable: true, code });
    }
    return Object.freeze({ parseable: true, code: "OTHER" });
  } catch {
    return Object.freeze({ parseable: false, code: "OTHER" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(isRecord(value), true);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  assert.equal(typeof value[field], "string");
  return value[field] as string;
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
  const directory = await mkdtemp(join(tmpdir(), "tianxing-crm04-browser-next-"));
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

function devLogLines(child: ChildProcess): readonly string[] {
  const logs = DEV_LOGS.get(child);
  return logs ? `${logs.stdout}\n${logs.stderr}`.split("\n") : [];
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
  readonly stage: BrowserStage;

  constructor(stage: BrowserStage) {
    super(`CRM-04 browser gate failed at ${stage}.`);
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
    const child = spawn(DOCKER, arguments_, {
      cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
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
