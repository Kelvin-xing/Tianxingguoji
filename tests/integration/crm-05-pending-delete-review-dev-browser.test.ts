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
  type Request as PlaywrightRequest,
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
const PENDING_REASON = "record.lifecycle.pending_delete_requested";
const FOUNDER = principal("founder");
const ADVISOR = principal("advisor");
const ADMIN = principal("admin");
const DATA_REVIEWER = principal("data_reviewer");
const CONTRACTOR = principal("contractor");

type LoginActor = "founder" | "advisor" | "admin" | "data_reviewer" | "contractor";
const LOGIN_STAGES = Object.freeze([
  "login_page_render", "login_form_ready", "login_submit_response", "login_redirect",
  "login_session_response", "login_workspace_render",
] as const);
type LoginStage = (typeof LOGIN_STAGES)[number];

const STAGES = Object.freeze([
  "runtime_preflight", "postgres_setup", "baseline_seed", "identity_provision",
  "next_dev", "canonical_origin", "chrome_launch", ...LOGIN_STAGES,
  "fixture_prepare", "founder_capabilities", "founder_detail_ready", "keyboard_focus",
  "fixed_confirmation", "validation_zero_post", "uncertain_retry_same_key",
  "founder_request_submit", "founder_receipt_contract", "founder_student_refresh",
  "founder_guardians_refresh", "founder_access_refresh", "founder_authoritative_refresh",
  "founder_pending_ui_snapshot", "founder_pending_ui", "founder_success_feedback",
  "advisor_capabilities", "advisor_detail_ready",
  "guardian_stale_seed", "guardian_stale_feedback", "guardian_changed_version",
  "guardian_double_submit", "advisor_student_request", "advisor_relogin_persistence",
  "unassigned_advisor_denial", "founder_queue_entry", "founder_queue_ready",
  "queue_filter_order", "founder_relogin_persistence", "pending_student_restrictions",
  "pending_guardian_restrictions", "pending_direct_student_profile",
  "pending_direct_guardian_profile", "pending_direct_attach", "pending_direct_handoff",
  "pending_direct_case_create", "pending_direct_duplicate_candidate_create", "purge_absent",
  "admin_hidden_denied",
  "data_reviewer_login_contract", "data_reviewer_students_navigation",
  "data_reviewer_students_readiness", "data_reviewer_detail_readiness",
  "data_reviewer_request_entry_hidden", "data_reviewer_queue_entry_hidden",
  "data_reviewer_student_request_direct", "data_reviewer_queue_direct",
  "contractor_login_contract", "contractor_students_navigation",
  "contractor_students_readiness", "contractor_detail_readiness",
  "contractor_request_entry_hidden", "contractor_queue_entry_hidden",
  "contractor_student_request_direct", "contractor_queue_direct",
  "desktop_viewport", "mobile_viewport", "browser_log_safety", "cleanup", "complete",
] as const);
type BrowserStage = (typeof STAGES)[number];

interface GateEvidence {
  baseline_generated_files: number | null;
  founder_request_entry: boolean;
  founder_review_entry: boolean;
  advisor_request_entry: boolean;
  advisor_review_entry_hidden: boolean;
  fixed_reason_exact: boolean;
  free_text_absent: boolean;
  keyboard_focus_returned: boolean;
  validation_zero_post: boolean;
  retry_same_key: boolean;
  retry_attempts: number;
  founder_authoritative_refresh: boolean;
  founder_success: FounderSuccessEvidence;
  changed_version_rotates_key: boolean;
  double_submit_post_count: number | null;
  advisor_guardian_requested: boolean;
  advisor_student_requested: boolean;
  advisor_relogin_persisted: boolean;
  unassigned_advisor_denied: boolean;
  queue_safe_shape: boolean;
  queue_canonical_order: boolean;
  queue_filter_student: boolean;
  queue_filter_guardian: boolean;
  founder_relogin_persisted: boolean;
  pending_student_commands_hidden: boolean;
  pending_guardian_commands_hidden: boolean;
  pending_direct_guard_count: number;
  pending_direct_guards: PendingDirectGuardsEvidence;
  denied_role_ui_hidden_count: number;
  denied_role_direct_403_count: number;
  denied_roles: DeniedRolesEvidence;
  purge_commands_absent: boolean;
  purge_route_absent: boolean;
  desktop: ViewportEvidence | null;
  mobile: ViewportEvidence | null;
  page_errors: number;
  sensitive_log_matches: number;
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

interface FounderSuccessEvidence {
  post_request_started: boolean;
  post_response_received: boolean;
  post_status: number | null;
  post_json_parseable: boolean;
  receipt_exact_five_keys: boolean;
  receipt_status: "pending_delete" | "OTHER" | null;
  receipt_record_version_positive: boolean;
  refresh_request_started: boolean;
  refresh_response_received: boolean;
  refresh_status: number | null;
  guardians_request_started: boolean;
  guardians_response_received: boolean;
  guardians_status: number | null;
  access_request_started: boolean;
  access_response_received: boolean;
  access_status: number | null;
  unavailable_count: number | null;
  forbidden_count: number | null;
  not_found_count: number | null;
  loading_count: number | null;
  pending_status_count: number | null;
  pending_notice_count: number | null;
  request_button_count: number | null;
  success_feedback_count: number | null;
  success_feedback_visible: boolean | null;
}

type DirectGuardSafeCode =
  | "CONFLICT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "VALIDATION_FAILED"
  | "OTHER"
  | null;

interface DirectGuardEvidence {
  fetch_completed: boolean;
  json_parseable: boolean;
  status: number | null;
  code: DirectGuardSafeCode;
  pii_echo: boolean | null;
}

interface PendingDirectGuardsEvidence {
  student_profile: DirectGuardEvidence;
  guardian_profile: DirectGuardEvidence;
  attach: DirectGuardEvidence;
  handoff: DirectGuardEvidence;
  case_create: DirectGuardEvidence;
  duplicate_candidate_create: DirectGuardEvidence;
}

interface HttpObservationEvidence {
  request_started: boolean;
  response_received: boolean;
  status: number | null;
}

interface RoleContractEvidence {
  fetch_completed: boolean;
  json_parseable: boolean;
  status: number | null;
  role_exact: boolean;
}

interface StudentsReadinessEvidence {
  navigation_status: number | null;
  pathname_exact: boolean;
  students: HttpObservationEvidence;
  access: HttpObservationEvidence;
  heading_count: number | null;
  ready_count: number | null;
  loading_count: number | null;
  unauthenticated_count: number | null;
  denied_count: number | null;
  unavailable_count: number | null;
}

interface DetailReadinessEvidence {
  navigation_status: number | null;
  pathname_exact: boolean;
  student: HttpObservationEvidence;
  guardians: HttpObservationEvidence;
  access: HttpObservationEvidence;
  heading_count: number | null;
  loading_count: number | null;
  unauthenticated_count: number | null;
  denied_count: number | null;
  not_found_count: number | null;
  unavailable_count: number | null;
}

interface EntryEvidence {
  count: number | null;
  visible_count: number | null;
}

interface DeniedRoleEvidence {
  login: RoleContractEvidence;
  students: StudentsReadinessEvidence;
  detail: DetailReadinessEvidence;
  request_entry: EntryEvidence;
  queue_entry: EntryEvidence;
  student_request_direct: DirectGuardEvidence;
  queue_direct: DirectGuardEvidence;
}

interface DeniedRolesEvidence {
  data_reviewer: DeniedRoleEvidence;
  contractor: DeniedRoleEvidence;
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
  page_horizontal_overflow: number;
  out_of_bounds_controls: number;
  overlapping_controls: number;
  clipped_text: number;
}

type SafeCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STALE_VERSION"
  | "VALIDATION_FAILED"
  | "SERVICE_UNAVAILABLE"
  | "OTHER"
  | null;

interface BrowserApiResult {
  readonly status: number | null;
  readonly jsonParseable: boolean;
  readonly code: SafeCode;
  readonly data: unknown;
}

interface StudentFixture {
  readonly studentId: string;
  readonly guardianId: string;
  readonly studentName: string;
  readonly guardianName: string;
  readonly guardianEmail: string;
}

const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

test("CRM-05 pending deletion requests and review work through a real local browser", {
  timeout: 600_000,
}, async () => {
  let stage: BrowserStage = "runtime_preflight";
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-crm05-browser-pg17-${suffix}`;
  const volumeName = `tianxing-crm05-browser-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const passwords = new Map(NEON_TEST_PRINCIPALS.map((entry) => [
    entry.role,
    randomBytes(32).toString("base64url"),
  ]));
  const evidence: GateEvidence = {
    baseline_generated_files: null,
    founder_request_entry: false,
    founder_review_entry: false,
    advisor_request_entry: false,
    advisor_review_entry_hidden: false,
    fixed_reason_exact: false,
    free_text_absent: false,
    keyboard_focus_returned: false,
    validation_zero_post: false,
    retry_same_key: false,
    retry_attempts: 0,
    founder_authoritative_refresh: false,
    founder_success: emptyFounderSuccessEvidence(),
    changed_version_rotates_key: false,
    double_submit_post_count: null,
    advisor_guardian_requested: false,
    advisor_student_requested: false,
    advisor_relogin_persisted: false,
    unassigned_advisor_denied: false,
    queue_safe_shape: false,
    queue_canonical_order: false,
    queue_filter_student: false,
    queue_filter_guardian: false,
    founder_relogin_persisted: false,
    pending_student_commands_hidden: false,
    pending_guardian_commands_hidden: false,
    pending_direct_guard_count: 0,
    pending_direct_guards: emptyPendingDirectGuardsEvidence(),
    denied_role_ui_hidden_count: 0,
    denied_role_direct_403_count: 0,
    denied_roles: emptyDeniedRolesEvidence(),
    purge_commands_absent: false,
    purge_route_absent: false,
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
  const loginEvidence = emptyLoginEvidence();
  let containerStarted = false;
  let volumeCreated = false;
  let appDirectory = "";
  let profileDirectory = "";
  let devServer: ChildProcess | undefined;
  let context: BrowserContext | undefined;
  let failureStage: BrowserStage | null = null;
  let founderTarget: StudentFixture | null = null;
  let advisorTarget: StudentFixture | null = null;
  let unassignedTarget: StudentFixture | null = null;

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
    assert.equal(evidence.baseline_generated_files, 33);
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply", target, build, dependencies: baselineDependencies(target),
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.baseline_id, ONE_ROLE_BASELINE_ID);
    assert.equal((await seedNeonTestRelease1(target, "apply")).status, "pass");

    stage = "identity_provision";
    for (const entry of [FOUNDER, ADVISOR, ADMIN, DATA_REVIEWER, CONTRACTOR]) {
      assert.equal(await provision(target, entry.email, passwords.get(entry.role)!), "created");
    }

    stage = "next_dev";
    appDirectory = await createIsolatedAppDirectory();
    profileDirectory = await mkdtemp(join(tmpdir(), "tianxing-crm05-chrome-"));
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
    founderTarget = await createStudentFixture(page, "founder", "shared");
    advisorTarget = await createStudentFixture(page, "advisor", "advisor");
    unassignedTarget = await createStudentFixture(page, "unassigned", "shared");
    await assignAdvisor(page, advisorTarget.studentId, "crm05-browser-advisor-case");

    stage = "founder_capabilities";
    await openStudents(page, baseUrl, "ready");
    const founderQueueEntry = page.getByRole("link", { name: "查看待刪除審查", exact: true });
    evidence.founder_review_entry = await visibleCount(founderQueueEntry) === 1;
    assert.equal(evidence.founder_review_entry, true);

    stage = "founder_detail_ready";
    await openStudentDetail(page, baseUrl, founderTarget.studentId, founderTarget.studentName);
    let studentSection = sectionWithHeading(page, "學生基本資料");
    let founderRequest = studentSection.getByRole("button", { name: "申請待刪除審查", exact: true });
    await founderRequest.waitFor({ state: "visible" });
    evidence.founder_request_entry = await founderRequest.count() === 1;
    assert.equal(evidence.founder_request_entry, true);

    stage = "keyboard_focus";
    await founderRequest.focus();
    await founderRequest.press("Enter");
    const confirmation = page.getByRole("checkbox", {
      name: "我已確認要將這筆資料送交待刪除審查，並理解資料目前不會被刪除。",
      exact: true,
    });
    await confirmation.waitFor({ state: "visible" });
    assert.equal(await confirmation.evaluate((element) => element === document.activeElement), true);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    founderRequest = sectionWithHeading(page, "學生基本資料")
      .getByRole("button", { name: "申請待刪除審查", exact: true });
    await founderRequest.waitFor({ state: "visible" });
    evidence.keyboard_focus_returned = await founderRequest.evaluate((element) => element === document.activeElement);
    assert.equal(evidence.keyboard_focus_returned, true);

    stage = "fixed_confirmation";
    await founderRequest.click();
    const confirmationForm = page.locator("form").filter({
      has: page.getByRole("heading", { name: "確認申請待刪除審查", exact: true }),
    });
    evidence.free_text_absent = await confirmationForm.getByRole("textbox").count() === 0;
    assert.equal(evidence.free_text_absent, true);
    const founderPath = `/api/v1/students/${founderTarget.studentId}/deletion-requests`;
    const founderRequests: PlaywrightRequest[] = [];
    const collectFounderRequest = (request: PlaywrightRequest) => {
      if (isRequestPath(request, "POST", founderPath)) founderRequests.push(request);
    };
    page.on("request", collectFounderRequest);

    stage = "validation_zero_post";
    await page.getByRole("button", { name: "確認送交審查", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "請先勾選確認選項。" }).waitFor({ state: "visible" });
    evidence.validation_zero_post = founderRequests.length === 0;
    assert.equal(evidence.validation_zero_post, true);
    await confirmation.check();

    stage = "uncertain_retry_same_key";
    const abortedKeys: string[] = [];
    const abortFounder = async (route: Route) => {
      const request = route.request();
      if (!isRequestPath(request, "POST", founderPath)) {
        await route.continue();
        return;
      }
      abortedKeys.push(request.headers()["idempotency-key"] ?? "");
      await route.abort("timedout");
    };
    await page.route(`**${founderPath}`, abortFounder);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestStarted = page.waitForRequest((request) => isRequestPath(request, "POST", founderPath));
      await page.getByRole("button", { name: "確認送交審查", exact: true }).click();
      await requestStarted;
      await page.getByRole("alert").filter({ hasText: "相同申請不會重複建立" }).waitFor({ state: "visible" });
    }
    await page.unroute(`**${founderPath}`, abortFounder);
    evidence.retry_attempts = abortedKeys.length;
    evidence.retry_same_key = abortedKeys.length === 2 && abortedKeys[0] !== "" && abortedKeys[0] === abortedKeys[1];
    assert.equal(evidence.retry_same_key, true);

    stage = "founder_request_submit";
    const founderSuccess = evidence.founder_success;
    const founderSuccessRequestObserver = (request: PlaywrightRequest) => {
      if (isRequestPath(request, "POST", founderPath)) founderSuccess.post_request_started = true;
      const studentPath = `/api/v1/students/${founderTarget!.studentId}`;
      if (isRequestPath(request, "GET", studentPath)) {
        founderSuccess.refresh_request_started = true;
      }
      if (isRequestPath(request, "GET", `${studentPath}/guardians`)) {
        founderSuccess.guardians_request_started = true;
      }
      if (isRequestPath(request, "GET", "/api/v1/auth/me")) founderSuccess.access_request_started = true;
    };
    const founderSuccessResponseObserver = (response: {
      request(): { method(): string };
      url(): string;
      status(): number;
    }) => {
      if (isResponsePath(response, "POST", founderPath)) {
        founderSuccess.post_response_received = true;
        founderSuccess.post_status = response.status();
      }
      const studentPath = `/api/v1/students/${founderTarget!.studentId}`;
      if (isResponsePath(response, "GET", studentPath)) {
        founderSuccess.refresh_response_received = true;
        founderSuccess.refresh_status = response.status();
      }
      if (isResponsePath(response, "GET", `${studentPath}/guardians`)) {
        founderSuccess.guardians_response_received = true;
        founderSuccess.guardians_status = response.status();
      }
      if (isResponsePath(response, "GET", "/api/v1/auth/me")) {
        founderSuccess.access_response_received = true;
        founderSuccess.access_status = response.status();
      }
    };
    page.on("request", founderSuccessRequestObserver);
    page.on("response", founderSuccessResponseObserver);
    const founderPost = page.waitForResponse((response) => isResponsePath(response, "POST", founderPath));
    const studentDetailPath = `/api/v1/students/${founderTarget.studentId}`;
    const founderStudentRefresh = page.waitForResponse((response) =>
      isResponsePath(response, "GET", studentDetailPath));
    const founderGuardiansRefresh = page.waitForResponse((response) =>
      isResponsePath(response, "GET", `${studentDetailPath}/guardians`));
    const founderAccessRefresh = page.waitForResponse((response) =>
      isResponsePath(response, "GET", "/api/v1/auth/me"));
    await page.getByRole("button", { name: "確認送交審查", exact: true }).click();
    const founderPostResponse = await founderPost;
    assert.equal(founderSuccess.post_request_started, true);
    assert.equal(founderSuccess.post_response_received, true);
    assert.equal(founderSuccess.post_status, 200);
    const successfulFounderRequest = founderRequests.at(-1);
    const founderPayload = successfulFounderRequest?.postDataJSON() as Record<string, unknown> | undefined;
    evidence.fixed_reason_exact = founderPayload !== undefined &&
      Object.keys(founderPayload).sort().join(",") === "expected_record_version,reason_code" &&
      founderPayload.reason_code === PENDING_REASON;
    evidence.retry_same_key = evidence.retry_same_key &&
      successfulFounderRequest?.headers()["idempotency-key"] === abortedKeys[0];
    assert.equal(evidence.fixed_reason_exact, true);
    assert.equal(evidence.retry_same_key, true);

    stage = "founder_receipt_contract";
    const receipt = await readSafeDeletionReceipt(founderPostResponse, "student", founderTarget.studentId);
    founderSuccess.post_json_parseable = receipt.jsonParseable;
    founderSuccess.receipt_exact_five_keys = receipt.exactFiveKeys;
    founderSuccess.receipt_status = receipt.status;
    founderSuccess.receipt_record_version_positive = receipt.recordVersionPositive;
    assert.equal(founderSuccess.post_json_parseable, true);
    assert.equal(founderSuccess.receipt_exact_five_keys, true);
    assert.equal(founderSuccess.receipt_status, "pending_delete");
    assert.equal(founderSuccess.receipt_record_version_positive, true);

    const refreshResults = await Promise.allSettled([
      founderStudentRefresh,
      founderGuardiansRefresh,
      founderAccessRefresh,
    ]);
    stage = "founder_student_refresh";
    assert.equal(refreshResults[0]?.status, "fulfilled");
    assert.equal(founderSuccess.refresh_request_started, true);
    assert.equal(founderSuccess.refresh_response_received, true);
    assert.equal(founderSuccess.refresh_status, 200);

    stage = "founder_guardians_refresh";
    assert.equal(refreshResults[1]?.status, "fulfilled");
    assert.equal(founderSuccess.guardians_request_started, true);
    assert.equal(founderSuccess.guardians_response_received, true);
    assert.equal(founderSuccess.guardians_status, 200);

    stage = "founder_access_refresh";
    assert.equal(refreshResults[2]?.status, "fulfilled");
    assert.equal(founderSuccess.access_request_started, true);
    assert.equal(founderSuccess.access_response_received, true);
    assert.equal(founderSuccess.access_status, 200);

    stage = "founder_authoritative_refresh";
    evidence.founder_authoritative_refresh = true;

    stage = "founder_pending_ui_snapshot";
    founderSuccess.unavailable_count = await page.getByText("學生服務暫時不可用", { exact: true }).count();
    founderSuccess.forbidden_count = await page.getByText("無法查看學生資料", { exact: true }).count();
    founderSuccess.not_found_count = await page.getByText("找不到學生資料", { exact: true }).count();
    founderSuccess.loading_count = await page.getByText("正在載入學生資料", { exact: true }).count();
    const pendingNotice = page.getByRole("status").filter({
      has: page.getByText(
        "這筆學生資料正在進行待刪除審查。資料與歷史仍會保留，但建立案件、編輯資料和管理監護人關係已受限制。",
        { exact: true },
      ),
    });
    founderSuccess.pending_status_count = await page.getByText("待刪除審查", { exact: true }).count();
    founderSuccess.pending_notice_count = await pendingNotice.count();
    founderSuccess.request_button_count = await sectionWithHeading(page, "學生基本資料")
      .getByRole("button", { name: "申請待刪除審查", exact: true }).count();
    assert.equal(founderSuccess.unavailable_count, 0);
    assert.equal(founderSuccess.forbidden_count, 0);
    assert.equal(founderSuccess.not_found_count, 0);
    assert.equal(founderSuccess.loading_count, 0);

    stage = "founder_pending_ui";
    await pendingNotice.waitFor({ state: "visible" });
    assert.equal(founderSuccess.pending_status_count, 1);
    assert.equal(founderSuccess.pending_notice_count, 1);
    assert.equal(founderSuccess.request_button_count, 0);

    stage = "founder_success_feedback";
    const successFeedback = page.getByRole("status").filter({ hasText: "學生已送交待刪除審查。" });
    await successFeedback.waitFor({ state: "visible" });
    founderSuccess.success_feedback_count = await successFeedback.count();
    founderSuccess.success_feedback_visible = await successFeedback.isVisible();
    assert.equal(founderSuccess.success_feedback_count, 1);
    assert.equal(founderSuccess.success_feedback_visible, true);
    page.off("request", founderSuccessRequestObserver);
    page.off("response", founderSuccessResponseObserver);
    page.off("request", collectFounderRequest);

    await logout(page);
    await login(page, baseUrl, ADVISOR.email, passwords.get("advisor")!, "advisor", loginEvidence, (value) => { stage = value; });
    stage = "advisor_capabilities";
    await openStudents(page, baseUrl, "ready");
    evidence.advisor_review_entry_hidden = await page.getByRole("link", { name: "查看待刪除審查", exact: true }).count() === 0;
    assert.equal(evidence.advisor_review_entry_hidden, true);

    stage = "advisor_detail_ready";
    await openStudentDetail(page, baseUrl, advisorTarget.studentId, advisorTarget.studentName);
    let guardianArticle = articleWithText(page, advisorTarget.guardianName);
    let guardianRequest = guardianArticle.getByRole("button", { name: "申請待刪除審查", exact: true });
    await guardianRequest.waitFor({ state: "visible" });
    evidence.advisor_request_entry = await guardianRequest.count() === 1;
    assert.equal(evidence.advisor_request_entry, true);
    await guardianRequest.click();
    await confirmation.check();

    stage = "guardian_stale_seed";
    const guardianUpdate = await api(page, `/api/v1/guardians/${advisorTarget.guardianId}`, "PATCH", {
      display_name: advisorTarget.guardianName,
      email: advisorTarget.guardianEmail,
      phone: null,
      expected_record_version: 1,
    }, "crm05-browser-guardian-version-seed");
    assert.equal(guardianUpdate.status, 200);
    assert.equal(exactProfileAck(guardianUpdate.data, "guardian", advisorTarget.guardianId, 2), true);
    const guardianPath = `/api/v1/guardians/${advisorTarget.guardianId}/deletion-requests`;
    const guardianRequests: PlaywrightRequest[] = [];
    const collectGuardianRequest = (request: PlaywrightRequest) => {
      if (isRequestPath(request, "POST", guardianPath)) guardianRequests.push(request);
    };
    page.on("request", collectGuardianRequest);

    stage = "guardian_stale_feedback";
    const staleResponse = page.waitForResponse((response) => isResponsePath(response, "POST", guardianPath));
    await page.getByRole("button", { name: "確認送交審查", exact: true }).click();
    assert.equal((await staleResponse).status(), 409);
    await page.getByRole("alert").filter({ hasText: "資料已被其他操作更新" }).waitFor({ state: "visible" });
    assert.equal(guardianRequests.length, 1);

    stage = "guardian_changed_version";
    const guardianRefresh = page.waitForResponse((response) => isResponsePath(response, "GET", `/api/v1/students/${advisorTarget!.studentId}`));
    await page.getByRole("button", { name: "重新載入最新資料", exact: true }).click();
    assert.equal((await guardianRefresh).status(), 200);
    guardianArticle = articleWithText(page, advisorTarget.guardianName);
    guardianRequest = guardianArticle.getByRole("button", { name: "申請待刪除審查", exact: true });
    await guardianRequest.waitFor({ state: "visible" });
    await guardianRequest.click();
    await confirmation.check();

    stage = "guardian_double_submit";
    const successfulGuardianPost = page.waitForResponse((response) => isResponsePath(response, "POST", guardianPath));
    const authoritativeGuardianRefresh = page.waitForResponse((response) =>
      isResponsePath(response, "GET", `/api/v1/students/${advisorTarget!.studentId}`));
    const guardianSubmit = page.getByRole("button", { name: "確認送交審查", exact: true });
    const guardianSubmitHandle = await guardianSubmit.elementHandle();
    assert.notEqual(guardianSubmitHandle, null);
    await page.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    }, guardianSubmitHandle);
    assert.equal((await successfulGuardianPost).status(), 200);
    assert.equal((await authoritativeGuardianRefresh).status(), 200);
    evidence.double_submit_post_count = guardianRequests.length - 1;
    const staleKey = guardianRequests[0]?.headers()["idempotency-key"] ?? "";
    const freshKey = guardianRequests[1]?.headers()["idempotency-key"] ?? "";
    evidence.changed_version_rotates_key = staleKey !== "" && freshKey !== "" && staleKey !== freshKey;
    assert.equal(evidence.double_submit_post_count, 1);
    assert.equal(evidence.changed_version_rotates_key, true);
    guardianArticle = articleWithText(page, advisorTarget.guardianName);
    await guardianArticle.getByText("待刪除審查", { exact: true }).waitFor({ state: "visible" });
    evidence.advisor_guardian_requested = true;
    page.off("request", collectGuardianRequest);

    stage = "advisor_student_request";
    studentSection = sectionWithHeading(page, "學生基本資料");
    const advisorStudentRequest = studentSection.getByRole("button", { name: "申請待刪除審查", exact: true });
    await advisorStudentRequest.click();
    await confirmation.check();
    const advisorStudentPath = `/api/v1/students/${advisorTarget.studentId}/deletion-requests`;
    const advisorStudentPost = page.waitForResponse((response) => isResponsePath(response, "POST", advisorStudentPath));
    await page.getByRole("button", { name: "確認送交審查", exact: true }).click();
    assert.equal((await advisorStudentPost).status(), 200);
    await page.getByRole("status").filter({ hasText: "這筆學生資料正在進行待刪除審查" }).waitFor({ state: "visible" });
    evidence.advisor_student_requested = true;

    stage = "advisor_relogin_persistence";
    await logout(page);
    await login(page, baseUrl, ADVISOR.email, passwords.get("advisor")!, "advisor", loginEvidence, (value) => { stage = value; });
    await openStudentDetail(page, baseUrl, advisorTarget.studentId, advisorTarget.studentName);
    const persistedStudentNotice = page.getByRole("status").filter({ hasText: "這筆學生資料正在進行待刪除審查" });
    const persistedGuardianNotice = articleWithText(page, advisorTarget.guardianName)
      .getByRole("status").filter({ hasText: "這筆監護人資料仍會保留" });
    await persistedStudentNotice.waitFor({ state: "visible" });
    await persistedGuardianNotice.waitFor({ state: "visible" });
    evidence.advisor_relogin_persisted = true;

    stage = "unassigned_advisor_denial";
    const unassignedDenied = await api(page, `/api/v1/students/${unassignedTarget.studentId}/deletion-requests`, "POST", {
      expected_record_version: 1,
      reason_code: PENDING_REASON,
    }, "crm05-browser-unassigned-advisor");
    const advisorQueueDenied = await api(page, "/api/v1/crm/deletion-requests", "GET");
    evidence.unassigned_advisor_denied = unassignedDenied.status === 404 && unassignedDenied.code === "NOT_FOUND" &&
      advisorQueueDenied.status === 403 && advisorQueueDenied.code === "FORBIDDEN";
    assert.equal(evidence.unassigned_advisor_denied, true);

    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!, "founder", loginEvidence, (value) => { stage = value; });
    stage = "founder_queue_entry";
    await openStudents(page, baseUrl, "ready");
    const queueEntry = page.getByRole("link", { name: "查看待刪除審查", exact: true });
    await queueEntry.waitFor({ state: "visible" });
    await queueEntry.click();

    stage = "founder_queue_ready";
    await page.waitForURL((url) => url.pathname === "/students/deletion-requests");
    await queueHeading(page).waitFor({ state: "visible" });
    const allQueue = await api(page, "/api/v1/crm/deletion-requests", "GET");
    assert.equal(allQueue.status, 200);
    const queueItems = array(allQueue.data).map(record);
    evidence.queue_safe_shape = queueItems.length >= 3 && queueItems.length <= 100 && queueItems.every(exactQueueItem);
    evidence.queue_canonical_order = isCanonicalQueueOrder(queueItems);
    assert.equal(evidence.queue_safe_shape, true);
    assert.equal(evidence.queue_canonical_order, true);

    stage = "queue_filter_order";
    const filter = page.getByRole("combobox", { name: "資料類型", exact: true });
    const studentQueueResponse = page.waitForResponse((response) =>
      isResponsePath(response, "GET", "/api/v1/crm/deletion-requests") &&
      new URL(response.url()).searchParams.get("entity_type") === "student");
    await filter.selectOption("student");
    assert.equal((await studentQueueResponse).status(), 200);
    await page.getByText("共 2 筆", { exact: true }).waitFor({ state: "visible" });
    evidence.queue_filter_student = true;
    const guardianQueueResponse = page.waitForResponse((response) =>
      isResponsePath(response, "GET", "/api/v1/crm/deletion-requests") &&
      new URL(response.url()).searchParams.get("entity_type") === "guardian");
    await filter.selectOption("guardian");
    assert.equal((await guardianQueueResponse).status(), 200);
    await page.getByText("共 1 筆", { exact: true }).waitFor({ state: "visible" });
    evidence.queue_filter_guardian = true;

    stage = "founder_relogin_persistence";
    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!, "founder", loginEvidence, (value) => { stage = value; });
    await openStudentDetail(page, baseUrl, founderTarget.studentId, founderTarget.studentName);
    await page.getByRole("status").filter({ hasText: "這筆學生資料正在進行待刪除審查" }).waitFor({ state: "visible" });
    evidence.founder_relogin_persisted = true;

    stage = "pending_student_restrictions";
    evidence.pending_student_commands_hidden = await commandsAbsent(page, [
      "申請待刪除審查", "編輯學生資料", "建立案件", "管理監護人關係",
      "確認合併決定", "確認更正",
    ]);
    assert.equal(evidence.pending_student_commands_hidden, true);

    stage = "pending_guardian_restrictions";
    await logout(page);
    await login(page, baseUrl, ADVISOR.email, passwords.get("advisor")!, "advisor", loginEvidence, (value) => { stage = value; });
    stage = "pending_guardian_restrictions";
    await openStudentDetail(page, baseUrl, advisorTarget.studentId, advisorTarget.studentName);
    guardianArticle = articleWithText(page, advisorTarget.guardianName);
    evidence.pending_guardian_commands_hidden =
      await guardianArticle.getByRole("button", { name: "編輯監護人資料", exact: true }).count() === 0 &&
      await guardianArticle.getByRole("button", { name: "申請待刪除審查", exact: true }).count() === 0;
    assert.equal(evidence.pending_guardian_commands_hidden, true);
    await page.goto(`${baseUrl}/students/${advisorTarget.studentId}/guardians`, { waitUntil: "domcontentloaded" });
    await page.getByRole("status").filter({ hasText: "關聯監護人和交接主要聯絡人已受限制" }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("heading", { name: "關聯現有監護人", exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "主要聯絡人交接", exact: true }).count(), 0);

    const directGuardSensitiveValues = [
      advisorTarget.studentId,
      advisorTarget.guardianId,
      advisorTarget.studentName,
      advisorTarget.guardianName,
      advisorTarget.guardianEmail,
      unassignedTarget.studentId,
      unassignedTarget.guardianId,
    ];

    stage = "pending_direct_student_profile";
    evidence.pending_direct_guards.student_profile = await directGuard(
      page,
      `/api/v1/students/${advisorTarget.studentId}`,
      "PATCH",
      {
      display_name: advisorTarget.studentName,
      date_of_birth: null,
      contact_email: null,
      contact_phone: null,
      expected_record_version: 2,
      },
      "crm05-browser-pending-student-profile",
      directGuardSensitiveValues,
    );
    assertDirectGuard(evidence.pending_direct_guards.student_profile, 409, "CONFLICT");
    evidence.pending_direct_guard_count += 1;

    stage = "pending_direct_guardian_profile";
    evidence.pending_direct_guards.guardian_profile = await directGuard(
      page,
      `/api/v1/guardians/${advisorTarget.guardianId}`,
      "PATCH",
      {
      display_name: advisorTarget.guardianName,
      email: advisorTarget.guardianEmail,
      phone: null,
      expected_record_version: 3,
      },
      "crm05-browser-pending-guardian-profile",
      directGuardSensitiveValues,
    );
    assertDirectGuard(evidence.pending_direct_guards.guardian_profile, 409, "CONFLICT");
    evidence.pending_direct_guard_count += 1;

    stage = "pending_direct_attach";
    evidence.pending_direct_guards.attach = await directGuard(
      page,
      `/api/v1/students/${advisorTarget.studentId}/guardians`,
      "POST",
      {
      guardian_id: unassignedTarget.guardianId,
      relationship_type: "other_guardian",
      is_legal_guardian: true,
      is_emergency_contact: false,
      is_billing_contact: false,
      notification_consent: false,
      },
      "crm05-browser-pending-attach",
      directGuardSensitiveValues,
    );
    assertDirectGuard(evidence.pending_direct_guards.attach, 404, "NOT_FOUND");
    evidence.pending_direct_guard_count += 1;

    stage = "pending_direct_handoff";
    evidence.pending_direct_guards.handoff = await directGuard(
      page,
      `/api/v1/students/${advisorTarget.studentId}/guardians/primary-handoffs`,
      "POST",
      {
      successor_guardian_id: unassignedTarget.guardianId,
      expected_primary_record_version: 1,
      },
      "crm05-browser-pending-handoff",
      directGuardSensitiveValues,
    );
    assertDirectGuard(evidence.pending_direct_guards.handoff, 404, "NOT_FOUND");
    evidence.pending_direct_guard_count += 1;

    stage = "pending_direct_case_create";
    evidence.pending_direct_guards.case_create = await directGuard(
      page,
      "/api/v1/cases",
      "POST",
      {
      student_id: advisorTarget.studentId,
      intake_year: 2034,
      admission_type: "transfer",
      primary_role_binding_id: ADVISOR.roleBindingId,
      manifest_id: NEON_TEST_MANIFEST_ID,
      },
      "crm05-browser-pending-case",
      directGuardSensitiveValues,
    );
    assertDirectGuard(evidence.pending_direct_guards.case_create, 404, "NOT_FOUND");
    evidence.pending_direct_guard_count += 1;

    stage = "pending_direct_duplicate_candidate_create";
    evidence.pending_direct_guards.duplicate_candidate_create = await directGuard(
      page,
      "/api/v1/crm/duplicate-candidates",
      "POST",
      {
      entity_type: "student",
      left_record_id: advisorTarget.studentId,
      right_record_id: unassignedTarget.studentId,
      },
      "crm05-browser-pending-duplicate",
      directGuardSensitiveValues,
    );
    assertDirectGuard(evidence.pending_direct_guards.duplicate_candidate_create, 404, "NOT_FOUND");
    evidence.pending_direct_guard_count += 1;
    assert.equal(evidence.pending_direct_guard_count, 6);

    stage = "purge_absent";
    evidence.purge_commands_absent = await commandsAbsent(page, [
      "永久刪除", "核准永久刪除", "復原", "取消申請",
    ]);
    const purge = await api(page, `/api/v1/students/${advisorTarget.studentId}/purge`, "POST", {});
    evidence.purge_route_absent = purge.status === 404;
    assert.equal(evidence.purge_commands_absent, true);
    assert.equal(evidence.purge_route_absent, true);

    await logout(page);
    await login(page, baseUrl, ADMIN.email, passwords.get("admin")!, "admin", loginEvidence, (value) => { stage = value; });
    stage = "admin_hidden_denied";
    await openStudents(page, baseUrl, "ready");
    const adminQueueHidden = await page.getByRole("link", { name: "查看待刪除審查", exact: true }).count() === 0;
    const adminDetailNavigation = await page.goto(`${baseUrl}/students/${unassignedTarget.studentId}`, { waitUntil: "domcontentloaded" });
    assert.equal(adminDetailNavigation?.status(), 200);
    await page.getByRole("heading", { name: unassignedTarget.studentName, exact: true, level: 2 }).waitFor({ state: "visible" });
    const adminRequestHidden = await page.getByRole("button", { name: "申請待刪除審查", exact: true }).count() === 0;
    if (adminQueueHidden && adminRequestHidden) evidence.denied_role_ui_hidden_count += 1;
    const adminDeniedRequest = await api(page, `/api/v1/students/${unassignedTarget.studentId}/deletion-requests`, "POST", {
      expected_record_version: 1,
      reason_code: PENDING_REASON,
    }, "crm05-browser-denied-admin");
    const adminDeniedQueue = await api(page, "/api/v1/crm/deletion-requests", "GET");
    if (adminDeniedRequest.status === 403 && adminDeniedRequest.code === "FORBIDDEN") evidence.denied_role_direct_403_count += 1;
    if (adminDeniedQueue.status === 403 && adminDeniedQueue.code === "FORBIDDEN") evidence.denied_role_direct_403_count += 1;

    const deniedRoleSensitiveValues = [
      unassignedTarget.studentId,
      unassignedTarget.guardianId,
      unassignedTarget.studentName,
      unassignedTarget.guardianName,
      unassignedTarget.guardianEmail,
    ];
    await inspectDeniedRole({
      page,
      baseUrl,
      actor: DATA_REVIEWER,
      password: passwords.get("data_reviewer")!,
      target: unassignedTarget,
      expectedRead: "denied",
      loginEvidence,
      evidence: evidence.denied_roles.data_reviewer,
      sensitiveValues: deniedRoleSensitiveValues,
      setStage: (value) => { stage = value; },
    });
    evidence.denied_role_ui_hidden_count += 1;
    evidence.denied_role_direct_403_count += 2;

    await inspectDeniedRole({
      page,
      baseUrl,
      actor: CONTRACTOR,
      password: passwords.get("contractor")!,
      target: unassignedTarget,
      expectedRead: "denied",
      loginEvidence,
      evidence: evidence.denied_roles.contractor,
      sensitiveValues: deniedRoleSensitiveValues,
      setStage: (value) => { stage = value; },
    });
    evidence.denied_role_ui_hidden_count += 1;
    evidence.denied_role_direct_403_count += 2;
    assert.equal(evidence.denied_role_ui_hidden_count, 3);
    assert.equal(evidence.denied_role_direct_403_count, 6);

    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!, "founder", loginEvidence, (value) => { stage = value; });
    stage = "desktop_viewport";
    await page.goto(`${baseUrl}/students/deletion-requests`, { waitUntil: "domcontentloaded" });
    await queueHeading(page).waitFor({ state: "visible" });
    evidence.desktop = await assertViewport(page);

    stage = "mobile_viewport";
    await page.setViewportSize({ width: 390, height: 844 });
    evidence.mobile = await assertViewport(page);
    await openStudentDetail(page, baseUrl, founderTarget.studentId, founderTarget.studentName);
    assert.deepEqual(await assertViewport(page), zeroViewport());

    stage = "browser_log_safety";
    const fixtures = [founderTarget, advisorTarget, unassignedTarget];
    const forbidden = [
      ...fixtures.flatMap((fixture) => [fixture.studentName, fixture.guardianName, fixture.guardianEmail]),
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
    cleanup.container_removed = containerStarted
      ? (await runDocker(["rm", "--force", containerName], stage, undefined, true)).exitCode === 0
      : true;
    cleanup.volume_removed = volumeCreated
      ? (await runDocker(["volume", "rm", "--force", volumeName], stage, undefined, true)).exitCode === 0
      : true;
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
  await Promise.all([
    emailField.waitFor({ state: "visible" }),
    passwordField.waitFor({ state: "visible" }),
    submitButton.waitFor({ state: "visible" }),
  ]);
  evidence.form_controls = await emailField.count() + await passwordField.count() + await submitButton.count();
  assert.equal(evidence.form_controls, 3);
  await emailField.fill(email);
  await passwordField.fill(password);
  const loginResponse = page.waitForResponse((response) => isResponsePath(response, "POST", "/api/v1/auth/login"));
  const authResponse = page.waitForResponse((response) => isResponsePath(response, "GET", "/api/v1/auth/me"));

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

function emptyFounderSuccessEvidence(): FounderSuccessEvidence {
  return {
    post_request_started: false,
    post_response_received: false,
    post_status: null,
    post_json_parseable: false,
    receipt_exact_five_keys: false,
    receipt_status: null,
    receipt_record_version_positive: false,
    refresh_request_started: false,
    refresh_response_received: false,
    refresh_status: null,
    guardians_request_started: false,
    guardians_response_received: false,
    guardians_status: null,
    access_request_started: false,
    access_response_received: false,
    access_status: null,
    unavailable_count: null,
    forbidden_count: null,
    not_found_count: null,
    loading_count: null,
    pending_status_count: null,
    pending_notice_count: null,
    request_button_count: null,
    success_feedback_count: null,
    success_feedback_visible: null,
  };
}

function emptyPendingDirectGuardsEvidence(): PendingDirectGuardsEvidence {
  return {
    student_profile: emptyDirectGuardEvidence(),
    guardian_profile: emptyDirectGuardEvidence(),
    attach: emptyDirectGuardEvidence(),
    handoff: emptyDirectGuardEvidence(),
    case_create: emptyDirectGuardEvidence(),
    duplicate_candidate_create: emptyDirectGuardEvidence(),
  };
}

function emptyDeniedRolesEvidence(): DeniedRolesEvidence {
  return {
    data_reviewer: emptyDeniedRoleEvidence(),
    contractor: emptyDeniedRoleEvidence(),
  };
}

function emptyDeniedRoleEvidence(): DeniedRoleEvidence {
  return {
    login: {
      fetch_completed: false,
      json_parseable: false,
      status: null,
      role_exact: false,
    },
    students: {
      navigation_status: null,
      pathname_exact: false,
      students: emptyHttpObservationEvidence(),
      access: emptyHttpObservationEvidence(),
      heading_count: null,
      ready_count: null,
      loading_count: null,
      unauthenticated_count: null,
      denied_count: null,
      unavailable_count: null,
    },
    detail: {
      navigation_status: null,
      pathname_exact: false,
      student: emptyHttpObservationEvidence(),
      guardians: emptyHttpObservationEvidence(),
      access: emptyHttpObservationEvidence(),
      heading_count: null,
      loading_count: null,
      unauthenticated_count: null,
      denied_count: null,
      not_found_count: null,
      unavailable_count: null,
    },
    request_entry: { count: null, visible_count: null },
    queue_entry: { count: null, visible_count: null },
    student_request_direct: emptyDirectGuardEvidence(),
    queue_direct: emptyDirectGuardEvidence(),
  };
}

function emptyHttpObservationEvidence(): HttpObservationEvidence {
  return {
    request_started: false,
    response_received: false,
    status: null,
  };
}

function emptyDirectGuardEvidence(): DirectGuardEvidence {
  return {
    fetch_completed: false,
    json_parseable: false,
    status: null,
    code: null,
    pii_echo: null,
  };
}

async function readSafeDeletionReceipt(
  response: { json(): Promise<unknown> },
  expectedEntityType: "student" | "guardian",
  expectedEntityId: string,
): Promise<Readonly<{
  jsonParseable: boolean;
  exactFiveKeys: boolean;
  status: "pending_delete" | "OTHER" | null;
  recordVersionPositive: boolean;
}>> {
  try {
    const payload = await response.json();
    if (!isRecord(payload) || !isRecord(payload.data)) {
      return Object.freeze({
        jsonParseable: true,
        exactFiveKeys: false,
        status: null,
        recordVersionPositive: false,
      });
    }
    const receipt = payload.data;
    const exactFiveKeys = Object.keys(receipt).sort().join(",") ===
      "deletion_requested_at,entity_id,entity_type,record_version,status" &&
      receipt.entity_type === expectedEntityType && receipt.entity_id === expectedEntityId &&
      typeof receipt.deletion_requested_at === "string";
    return Object.freeze({
      jsonParseable: true,
      exactFiveKeys,
      status: receipt.status === "pending_delete" ? "pending_delete" : "OTHER",
      recordVersionPositive: Number.isInteger(receipt.record_version) &&
        (receipt.record_version as number) > 0,
    });
  } catch {
    return Object.freeze({
      jsonParseable: false,
      exactFiveKeys: false,
      status: null,
      recordVersionPositive: false,
    });
  }
}

function safePath<T extends "/login" | "/today">(url: string, expected: T): T | "other" {
  return new URL(url).pathname === expected ? expected : "other";
}

async function createStudentFixture(page: Page, label: string, contactGroup: string): Promise<StudentFixture> {
  const studentName = `CRM05 Browser ${label} Student`;
  const guardianName = `CRM05 Browser ${label} Guardian`;
  const guardianEmail = `crm05-browser-${label}-guardian@example.invalid`;
  const result = await api(page, "/api/v1/students", "POST", {
    student: {
      display_name: studentName,
      date_of_birth: "2014-05-16",
      contact_email: `crm05-browser-${contactGroup}-student@example.invalid`,
      contact_phone: null,
    },
    primary_guardian: {
      display_name: guardianName,
      email: guardianEmail,
      phone: null,
      relationship_type: "other_guardian",
      is_legal_guardian: true,
    },
  }, `crm05-browser-create-${label}`);
  assert.equal(result.status, 201);
  assert.equal(result.jsonParseable, true);
  const data = record(result.data);
  const student = exactRecord(data.student, ["display_name", "id"]);
  const guardian = exactRecord(data.primary_guardian, ["display_name", "id"]);
  exactRecord(data.relationship, ["id", "relationship_type"]);
  assert.equal(student.display_name, studentName);
  assert.equal(guardian.display_name, guardianName);
  return Object.freeze({
    studentId: stringField(student, "id"),
    guardianId: stringField(guardian, "id"),
    studentName,
    guardianName,
    guardianEmail,
  });
}

async function assignAdvisor(page: Page, studentId: string, key: string): Promise<void> {
  const result = await api(page, "/api/v1/cases", "POST", {
    student_id: studentId,
    intake_year: 2033,
    admission_type: "transfer",
    primary_role_binding_id: ADVISOR.roleBindingId,
    manifest_id: NEON_TEST_MANIFEST_ID,
  }, key);
  assert.equal(result.status, 200);
  const created = record(record(result.data).case);
  assert.equal(created.studentId, studentId);
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
        const payload = await response.json() as {
          readonly data?: unknown;
          readonly error?: { readonly code?: unknown };
        };
        const rawCode = payload.error?.code;
        const allowed = [
          "FORBIDDEN", "NOT_FOUND", "CONFLICT", "STALE_VERSION",
          "VALIDATION_FAILED", "SERVICE_UNAVAILABLE",
        ];
        const code = typeof rawCode === "string"
          ? allowed.includes(rawCode) ? rawCode as Exclude<SafeCode, "OTHER" | null> : "OTHER"
          : null;
        return { status: response.status, jsonParseable: true, code, data: payload.data ?? null };
      } catch {
        return { status: response.status, jsonParseable: false, code: null, data: null };
      }
    } catch {
      return { status: null, jsonParseable: false, code: null, data: null };
    }
  }, { path, method, body, idempotencyKey });
}

async function directGuard(
  page: Page,
  path: string,
  method: "GET" | "POST" | "PATCH",
  body: unknown | undefined,
  idempotencyKey: string | undefined,
  sensitiveValues: readonly string[],
): Promise<DirectGuardEvidence> {
  return page.evaluate(async (input): Promise<DirectGuardEvidence> => {
    try {
      const response = await fetch(input.path, {
        method: input.method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
          ...(input.idempotencyKey === undefined ? {} : { "idempotency-key": input.idempotencyKey }),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      });
      const responseText = await response.text();
      const piiEcho = input.sensitiveValues.some((value) =>
        value !== "" && responseText.includes(value));
      try {
        const payload = JSON.parse(responseText) as unknown;
        const payloadRecord = typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : null;
        const errorValue = payloadRecord?.error;
        const errorRecord = typeof errorValue === "object" && errorValue !== null && !Array.isArray(errorValue)
          ? errorValue as Record<string, unknown>
          : null;
        const rawCode = errorRecord?.code;
        const allowed = ["CONFLICT", "NOT_FOUND", "FORBIDDEN", "VALIDATION_FAILED"];
        const code: DirectGuardSafeCode = typeof rawCode === "string"
          ? allowed.includes(rawCode)
            ? rawCode as Exclude<DirectGuardSafeCode, "OTHER" | null>
            : "OTHER"
          : "OTHER";
        return {
          fetch_completed: true,
          json_parseable: true,
          status: response.status,
          code,
          pii_echo: piiEcho,
        };
      } catch {
        return {
          fetch_completed: true,
          json_parseable: false,
          status: response.status,
          code: null,
          pii_echo: piiEcho,
        };
      }
    } catch {
      return {
        fetch_completed: false,
        json_parseable: false,
        status: null,
        code: null,
        pii_echo: null,
      };
    }
  }, { path, method, body, idempotencyKey, sensitiveValues });
}

function assertDirectGuard(
  evidence: DirectGuardEvidence,
  expectedStatus: 404 | 409,
  expectedCode: "CONFLICT" | "NOT_FOUND",
): void {
  assert.equal(evidence.fetch_completed, true);
  assert.equal(evidence.json_parseable, true);
  assert.equal(evidence.status, expectedStatus);
  assert.equal(evidence.code, expectedCode);
  assert.equal(evidence.pii_echo, false);
}

async function inspectDeniedRole({
  page,
  baseUrl,
  actor,
  password,
  target,
  expectedRead,
  loginEvidence,
  evidence,
  sensitiveValues,
  setStage,
}: {
  readonly page: Page;
  readonly baseUrl: string;
  readonly actor: ReturnType<typeof principal>;
  readonly password: string;
  readonly target: StudentFixture;
  readonly expectedRead: "ready" | "denied";
  readonly loginEvidence: LoginEvidence;
  readonly evidence: DeniedRoleEvidence;
  readonly sensitiveValues: readonly string[];
  readonly setStage: (stage: BrowserStage) => void;
}): Promise<void> {
  assert.equal(actor.role === "data_reviewer" || actor.role === "contractor", true);
  const stages = actor.role === "data_reviewer"
    ? {
        login: "data_reviewer_login_contract",
        studentsNavigation: "data_reviewer_students_navigation",
        studentsReadiness: "data_reviewer_students_readiness",
        detailReadiness: "data_reviewer_detail_readiness",
        requestEntry: "data_reviewer_request_entry_hidden",
        queueEntry: "data_reviewer_queue_entry_hidden",
        studentDirect: "data_reviewer_student_request_direct",
        queueDirect: "data_reviewer_queue_direct",
      } as const
    : {
        login: "contractor_login_contract",
        studentsNavigation: "contractor_students_navigation",
        studentsReadiness: "contractor_students_readiness",
        detailReadiness: "contractor_detail_readiness",
        requestEntry: "contractor_request_entry_hidden",
        queueEntry: "contractor_queue_entry_hidden",
        studentDirect: "contractor_student_request_direct",
        queueDirect: "contractor_queue_direct",
      } as const;

  setStage(stages.login);
  await logout(page);
  await login(page, baseUrl, actor.email, password, actor.role, loginEvidence, () => {});
  evidence.login = await readRoleContract(page, actor.role);
  assert.equal(evidence.login.fetch_completed, true);
  assert.equal(evidence.login.json_parseable, true);
  assert.equal(evidence.login.status, 200);
  assert.equal(evidence.login.role_exact, true);

  const studentsObservation = observeHttp(page, "GET", "/api/v1/students", evidence.students.students);
  const studentsAccessObservation = observeHttp(page, "GET", "/api/v1/auth/me", evidence.students.access);
  try {
    setStage(stages.studentsNavigation);
    const navigation = await page.goto(`${baseUrl}/students`, { waitUntil: "domcontentloaded" });
    evidence.students.navigation_status = navigation?.status() ?? null;
    evidence.students.pathname_exact = new URL(page.url()).pathname === "/students";
    assert.equal(evidence.students.navigation_status, 200);
    assert.equal(evidence.students.pathname_exact, true);

    setStage(stages.studentsReadiness);
    const heading = page.getByRole("heading", { name: "學生與監護人", exact: true, level: 2 });
    await heading.waitFor({ state: "visible" });
    await studentsObservation.settled;
    await studentsAccessObservation.settled;
    const readyState = page.getByText(/^顯示 \d+ \/ \d+ 位學生$/);
    const deniedState = page.getByText("無法查看學生資料", { exact: true });
    if (expectedRead === "ready") {
      await readyState.waitFor({ state: "visible" });
    } else {
      await deniedState.waitFor({ state: "visible" });
    }
    evidence.students.heading_count = await heading.count();
    evidence.students.ready_count = await visibleCount(readyState);
    evidence.students.loading_count = await page.getByText("正在載入學生", { exact: true }).count();
    evidence.students.unauthenticated_count = await page.getByText("工作階段已失效", { exact: true }).count();
    evidence.students.denied_count = await visibleCount(deniedState);
    evidence.students.unavailable_count = await page.getByText("學生服務暫時不可用", { exact: true }).count();
    assert.equal(evidence.students.students.request_started, true);
    assert.equal(evidence.students.students.response_received, true);
    assert.equal(evidence.students.students.status, expectedRead === "ready" ? 200 : 403);
    assert.equal(evidence.students.access.request_started, true);
    assert.equal(evidence.students.access.response_received, true);
    assert.equal(evidence.students.access.status, 200);
    assert.equal(evidence.students.heading_count, 1);
    assert.equal(evidence.students.ready_count, expectedRead === "ready" ? 1 : 0);
    assert.equal(evidence.students.loading_count, 0);
    assert.equal(evidence.students.unauthenticated_count, 0);
    assert.equal(evidence.students.denied_count, expectedRead === "denied" ? 1 : 0);
    assert.equal(evidence.students.unavailable_count, 0);
  } finally {
    studentsObservation.dispose();
    studentsAccessObservation.dispose();
  }

  const studentPagePath = `/students/${target.studentId}`;
  const studentApiPath = `/api/v1/students/${target.studentId}`;
  const detailStudentObservation = observeHttp(page, "GET", studentApiPath, evidence.detail.student);
  const detailGuardiansObservation = observeHttp(page, "GET", `${studentApiPath}/guardians`, evidence.detail.guardians);
  const detailAccessObservation = observeHttp(page, "GET", "/api/v1/auth/me", evidence.detail.access);
  try {
    setStage(stages.detailReadiness);
    const navigation = await page.goto(`${baseUrl}${studentPagePath}`, { waitUntil: "domcontentloaded" });
    evidence.detail.navigation_status = navigation?.status() ?? null;
    evidence.detail.pathname_exact = new URL(page.url()).pathname === studentPagePath;
    assert.equal(evidence.detail.navigation_status, 200);
    assert.equal(evidence.detail.pathname_exact, true);
    const heading = page.getByRole("heading", { name: target.studentName, exact: true, level: 2 });
    const deniedState = page.getByText("無法查看學生資料", { exact: true });
    if (expectedRead === "ready") {
      await heading.waitFor({ state: "visible" });
    } else {
      await deniedState.waitFor({ state: "visible" });
    }
    await detailStudentObservation.settled;
    await detailGuardiansObservation.settled;
    await detailAccessObservation.settled;
    evidence.detail.heading_count = await visibleCount(heading);
    evidence.detail.loading_count = await page.getByText("正在載入學生資料", { exact: true }).count();
    evidence.detail.unauthenticated_count = await page.getByText("工作階段已失效", { exact: true }).count();
    evidence.detail.denied_count = await visibleCount(deniedState);
    evidence.detail.not_found_count = await page.getByText("找不到學生資料", { exact: true }).count();
    evidence.detail.unavailable_count = await page.getByText("學生服務暫時不可用", { exact: true }).count();
    for (const observation of [evidence.detail.student, evidence.detail.guardians]) {
      assert.equal(observation.request_started, true);
      assert.equal(observation.response_received, true);
      assert.equal(observation.status, expectedRead === "ready" ? 200 : 403);
    }
    assert.equal(evidence.detail.access.request_started, true);
    assert.equal(evidence.detail.access.response_received, true);
    assert.equal(evidence.detail.access.status, 200);
    assert.equal(evidence.detail.heading_count, expectedRead === "ready" ? 1 : 0);
    assert.equal(evidence.detail.loading_count, 0);
    assert.equal(evidence.detail.unauthenticated_count, 0);
    assert.equal(evidence.detail.denied_count, expectedRead === "denied" ? 1 : 0);
    assert.equal(evidence.detail.not_found_count, 0);
    assert.equal(evidence.detail.unavailable_count, 0);
  } finally {
    detailStudentObservation.dispose();
    detailGuardiansObservation.dispose();
    detailAccessObservation.dispose();
  }

  setStage(stages.requestEntry);
  const requestEntry = page.getByRole("button", { name: "申請待刪除審查", exact: true });
  evidence.request_entry.count = await requestEntry.count();
  evidence.request_entry.visible_count = await visibleCount(requestEntry);
  assert.equal(evidence.request_entry.count, 0);
  assert.equal(evidence.request_entry.visible_count, 0);

  setStage(stages.queueEntry);
  const queueNavigation = await page.goto(`${baseUrl}/students`, { waitUntil: "domcontentloaded" });
  assert.equal(queueNavigation?.status(), 200);
  await page.getByRole("heading", { name: "學生與監護人", exact: true, level: 2 }).waitFor({ state: "visible" });
  if (expectedRead === "ready") {
    await page.getByText(/^顯示 \d+ \/ \d+ 位學生$/).waitFor({ state: "visible" });
  } else {
    await page.getByText("無法查看學生資料", { exact: true }).waitFor({ state: "visible" });
  }
  const queueEntry = page.getByRole("link", { name: "查看待刪除審查", exact: true });
  evidence.queue_entry.count = await queueEntry.count();
  evidence.queue_entry.visible_count = await visibleCount(queueEntry);
  assert.equal(evidence.queue_entry.count, 0);
  assert.equal(evidence.queue_entry.visible_count, 0);

  setStage(stages.studentDirect);
  evidence.student_request_direct = await directGuard(
    page,
    `/api/v1/students/${target.studentId}/deletion-requests`,
    "POST",
    { expected_record_version: 1, reason_code: PENDING_REASON },
    `crm05-browser-denied-${actor.role}`,
    sensitiveValues,
  );
  assertDeniedDirectGuard(evidence.student_request_direct);

  setStage(stages.queueDirect);
  evidence.queue_direct = await directGuard(
    page,
    "/api/v1/crm/deletion-requests",
    "GET",
    undefined,
    undefined,
    sensitiveValues,
  );
  assertDeniedDirectGuard(evidence.queue_direct);
}

async function readRoleContract(page: Page, expectedRole: LoginActor): Promise<RoleContractEvidence> {
  return page.evaluate(async (role): Promise<RoleContractEvidence> => {
    try {
      const response = await fetch("/api/v1/auth/me", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      try {
        const payload = await response.json() as unknown;
        const payloadRecord = typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : null;
        const dataValue = payloadRecord?.data;
        const dataRecord = typeof dataValue === "object" && dataValue !== null && !Array.isArray(dataValue)
          ? dataValue as Record<string, unknown>
          : null;
        return {
          fetch_completed: true,
          json_parseable: true,
          status: response.status,
          role_exact: dataRecord?.role === role,
        };
      } catch {
        return {
          fetch_completed: true,
          json_parseable: false,
          status: response.status,
          role_exact: false,
        };
      }
    } catch {
      return {
        fetch_completed: false,
        json_parseable: false,
        status: null,
        role_exact: false,
      };
    }
  }, expectedRole);
}

function observeHttp(
  page: Page,
  method: "GET",
  path: string,
  evidence: HttpObservationEvidence,
): Readonly<{ settled: Promise<void>; dispose(): void }> {
  const onRequest = (request: PlaywrightRequest) => {
    if (isRequestPath(request, method, path)) evidence.request_started = true;
  };
  page.on("request", onRequest);
  const settled = page.waitForResponse((response) => isResponsePath(response, method, path))
    .then((response) => {
      evidence.response_received = true;
      evidence.status = response.status();
    });
  void settled.catch(() => {});
  return Object.freeze({
    settled,
    dispose: () => { page.off("request", onRequest); },
  });
}

function assertDeniedDirectGuard(evidence: DirectGuardEvidence): void {
  assert.equal(evidence.fetch_completed, true);
  assert.equal(evidence.json_parseable, true);
  assert.equal(evidence.status, 403);
  assert.equal(evidence.code, "FORBIDDEN");
  assert.equal(evidence.pii_echo, false);
}

async function openStudents(page: Page, baseUrl: string, expected: "ready" | "denied"): Promise<void> {
  const navigation = await page.goto(`${baseUrl}/students`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  const heading = page.getByRole("heading", { name: "學生與監護人", exact: true, level: 2 });
  await heading.waitFor({ state: "visible" });
  if (expected === "ready") {
    await page.getByText(/^顯示 \d+ \/ \d+ 位學生$/).waitFor({ state: "visible" });
    assert.equal(await page.getByText("正在載入學生", { exact: true }).count(), 0);
    assert.equal(await page.getByText("無法查看學生資料", { exact: true }).count(), 0);
  } else {
    await page.getByText("無法查看學生資料", { exact: true }).waitFor({ state: "visible" });
  }
}

async function openStudentDetail(page: Page, baseUrl: string, studentId: string, studentName: string): Promise<void> {
  const response = page.waitForResponse((candidate) => isResponsePath(candidate, "GET", `/api/v1/students/${studentId}`));
  const navigation = await page.goto(`${baseUrl}/students/${studentId}`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  assert.equal((await response).status(), 200);
  const heading = page.getByRole("heading", { name: studentName, exact: true, level: 2 });
  await heading.waitFor({ state: "visible" });
  assert.equal(await heading.count(), 1);
}

function sectionWithHeading(page: Page, name: string): Locator {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name, exact: true }),
  });
}

function articleWithText(page: Page, text: string): Locator {
  return page.locator("article").filter({ has: page.getByText(text, { exact: true }) });
}

function queueHeading(page: Page): Locator {
  return page.getByRole("heading", { name: "待刪除審查", exact: true, level: 2 });
}

async function visibleCount(locator: Locator): Promise<number> {
  const count = await locator.count();
  if (count === 0) return 0;
  return await locator.isVisible() ? count : 0;
}

async function commandsAbsent(page: Page, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if (await page.getByRole("button", { name, exact: true }).count() !== 0) return false;
    if (await page.getByRole("link", { name, exact: true }).count() !== 0) return false;
  }
  return true;
}

function isRequestPath(request: { method(): string; url(): string }, method: string, path: string): boolean {
  return request.method() === method && new URL(request.url()).pathname === path;
}

function isResponsePath(
  response: { request(): { method(): string }; url(): string },
  method: string,
  path: string,
): boolean {
  return response.request().method() === method && new URL(response.url()).pathname === path;
}

function exactProfileAck(value: unknown, key: "student" | "guardian", id: string, version: number): boolean {
  if (!isRecord(value)) return false;
  try {
    const data = exactRecord(value, [key]);
    const acknowledgement = exactRecord(data[key], ["id", "record_version", "updated_at"]);
    return acknowledgement.id === id && acknowledgement.record_version === version &&
      typeof acknowledgement.updated_at === "string";
  } catch {
    return false;
  }
}

function exactQueueItem(value: Record<string, unknown>): boolean {
  try {
    exactRecord(value, [
      "deletion_requested_at", "display_label", "entity_id", "entity_type", "record_version", "status",
    ]);
    return (value.entity_type === "student" || value.entity_type === "guardian") &&
      value.status === "pending_delete" && typeof value.entity_id === "string" &&
      typeof value.display_label === "string" && typeof value.deletion_requested_at === "string" &&
      Number.isInteger(value.record_version) && (value.record_version as number) > 0;
  } catch {
    return false;
  }
}

function isCanonicalQueueOrder(items: readonly Record<string, unknown>[]): boolean {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!;
    const current = items[index]!;
    const previousTime = stringField(previous, "deletion_requested_at");
    const currentTime = stringField(current, "deletion_requested_at");
    if (previousTime < currentTime) return false;
    if (previousTime === currentTime && stringField(previous, "entity_id") > stringField(current, "entity_id")) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(isRecord(value), true);
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.equal(Array.isArray(value), true);
  return value as unknown[];
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = record(value);
  assert.deepEqual(Object.keys(result).sort(), [...keys].sort());
  return result;
}

function stringField(value: Record<string, unknown>, field: string): string {
  assert.equal(typeof value[field], "string");
  return value[field] as string;
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
    const clipped = [...main.querySelectorAll("h1,h2,h3,h4,p,label,button,a,strong,small")]
      .filter(visible).filter((element) => {
        const item = element as HTMLElement;
        return !item.classList.contains("truncate") && item.scrollWidth > item.clientWidth + 1 &&
          getComputedStyle(item).overflowX === "hidden";
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
  const directory = await mkdtemp(join(tmpdir(), "tianxing-crm05-browser-next-"));
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
  try {
    await context.close();
    return true;
  } catch {
    return false;
  }
}

async function removeDirectory(directory: string): Promise<boolean> {
  if (!directory) return true;
  try {
    await rm(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
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
    super(`CRM-05 browser gate failed at ${stage}.`);
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
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
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
