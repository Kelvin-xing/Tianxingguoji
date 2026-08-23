import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
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
  type OneRoleBaselineDatabaseState,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";

const DOCKER = "/opt/homebrew/bin/docker";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const ADVISOR = NEON_TEST_PRINCIPALS.find(({ role }) => role === "advisor")!;
const ADMIN = NEON_TEST_PRINCIPALS.find(({ role }) => role === "admin")!;
const FOUNDER = NEON_TEST_PRINCIPALS.find(({ role }) => role === "founder")!;
const SHARED_GUARDIAN = NEON_TEST_STUDENTS[1]!;

const BROWSER_STAGES = Object.freeze([
  "runtime_preflight",
  "postgres_setup",
  "baseline_seed",
  "identity_provision",
  "next_dev",
  "canonical_origin_discovery",
  "chrome_launch",
  "login_server_render",
  "login_browser_render",
  "login_field_fill",
  "login_submit_response",
  "login_redirect",
  "login_session_response",
  "login_workspace_render",
  "login_workspace_settled",
  "advisor_list_navigation",
  "advisor_list_shell",
  "advisor_list_data",
  "advisor_create_entry",
  "create_form_navigation",
  "create_form_shell",
  "create_form_access",
  "create_form_ready",
  "client_validation_fill",
  "client_validation_submit",
  "client_validation_feedback",
  "client_validation_no_post",
  "idempotency_retry",
  "advisor_create",
  "detail_persistence",
  "logout_session",
  "relogin_persistence",
  "admin_login",
  "admin_hidden_entry",
  "admin_direct_transport",
  "admin_direct_status",
  "admin_direct_privacy",
  "desktop_viewport",
  "mobile_viewport",
  "browser_log_safety",
  "cleanup",
  "complete",
] as const);

type BrowserStage = (typeof BROWSER_STAGES)[number];
type LoginErrorEnum =
  | "none"
  | "server_render_failed"
  | "browser_render_failed"
  | "field_fill_failed"
  | "submit_response_failed"
  | "redirect_failed"
  | "session_response_failed"
  | "workspace_render_failed"
  | "workspace_settled_failed";

interface LoginEvidence {
  status: number | null;
  location_pathname: string | null;
  final_pathname: string | null;
  error_enum: LoginErrorEnum;
  cookie_present: boolean;
  auth_me_status: number | null;
}

interface LoginRenderEvidence {
  readonly server: {
    status: number | null;
    content_type_html: boolean;
    database_test_presentation: boolean;
    configuration_unavailable_absent: boolean;
  };
  readonly browser: {
    navigation_status: number | null;
    final_pathname: string | null;
    email_label_count: number | null;
    password_label_count: number | null;
    submit_button_count: number | null;
    role_select_count: number | null;
    workspace_heading_count: number | null;
    session_checking_count: number | null;
    returning_to_login_count: number | null;
    workspace_settled: boolean;
  };
}

interface AdvisorEntryEvidence {
  navigation_status: number | null;
  final_pathname: string | null;
  students_request_started: boolean;
  students_response_received: boolean;
  students_response_status: number | null;
  access_request_started: boolean;
  access_response_received: boolean;
  access_response_status: number | null;
  heading_count: number | null;
  create_link_count: number | null;
  loading_state_count: number | null;
  unauthenticated_state_count: number | null;
  denied_state_count: number | null;
  unavailable_state_count: number | null;
}

interface ClientValidationEvidence {
  pathname_is_students_new: boolean;
  shell_heading_count: number | null;
  capability_request_started: boolean;
  capability_response_received: boolean;
  capability_response_status: number | null;
  loading_state_count: number | null;
  unauthenticated_state_count: number | null;
  denied_state_count: number | null;
  error_state_count: number | null;
  student_input_count: number | null;
  guardian_input_count: number | null;
  submit_button_count: number | null;
  student_value_nonempty: boolean;
  guardian_value_nonempty: boolean;
  validation_alert_count: number | null;
  validation_alert_visible: boolean;
  validation_post_count: number | null;
  posts_zero: boolean;
}

interface AdminDirectEvidence {
  fetch_completed: boolean;
  json_parseable: boolean;
  status: number | null;
  code: "FORBIDDEN" | "OTHER" | null;
  student_echoed: boolean | null;
  guardian_email_echoed: boolean | null;
}

interface SessionDiagnosticEvidence {
  cookie_stored: boolean;
  value_nonempty: boolean;
  value_length_valid: boolean;
  http_only: boolean;
  secure_false: boolean;
  same_site_lax: boolean;
  path_root: boolean;
  cookie_header_present: boolean;
  session_cookie_name_present: boolean;
  login_location_origin_matches_base: boolean;
  final_page_origin_matches_base: boolean;
  auth_request_origin_matches_base: boolean;
  final_page_origin_matches_auth_request: boolean;
  session_cookie_applicable_to_auth_request_url: boolean;
  stored_cookie_domain_matches_auth_request_hostname: boolean;
  auth_request_resource_type_fetch: boolean;
}

interface CanonicalOriginEvidence {
  response_status_307: boolean;
  location_present: boolean;
  location_parseable: boolean;
  pathname_exact: boolean;
  protocol_http: boolean;
  hostname_loopback: boolean;
  port_matches: boolean;
  credentials_absent: boolean;
  search_absent: boolean;
  hash_absent: boolean;
}

type StoredSessionCookieEvidence = Pick<SessionDiagnosticEvidence,
  | "cookie_stored"
  | "value_nonempty"
  | "value_length_valid"
  | "http_only"
  | "secure_false"
  | "same_site_lax"
  | "path_root">;

type SessionRequestCookieEvidence = Pick<SessionDiagnosticEvidence,
  "cookie_header_present" | "session_cookie_name_present">;

type SessionUrlDiagnosticEvidence = Pick<SessionDiagnosticEvidence,
  | "auth_request_origin_matches_base"
  | "final_page_origin_matches_auth_request"
  | "session_cookie_applicable_to_auth_request_url"
  | "stored_cookie_domain_matches_auth_request_hostname"
  | "auth_request_resource_type_fetch">;

interface CleanupEvidence {
  context_closed: boolean;
  dev_stopped: boolean;
  app_directory_removed: boolean;
  profile_removed: boolean;
  container_removed: boolean;
  volume_removed: boolean;
}

interface ViewportEvidence {
  readonly label: string;
  readonly page_horizontal_overflow: number;
  readonly out_of_bounds_controls: number;
  readonly overlapping_controls: number;
  readonly clipped_text: number;
}

interface GateFailureEvidence {
  readonly status: "failed";
  readonly stage: BrowserStage;
  readonly login: Readonly<LoginEvidence> | null;
  readonly login_render: Readonly<LoginRenderEvidence> | null;
  readonly canonical_origin: Readonly<CanonicalOriginEvidence>;
  readonly session_diagnostic: Readonly<SessionDiagnosticEvidence>;
  readonly advisor_entry: Readonly<AdvisorEntryEvidence> | null;
  readonly client_validation: Readonly<ClientValidationEvidence> | null;
  readonly admin_direct: Readonly<AdminDirectEvidence> | null;
  readonly cleanup: Readonly<CleanupEvidence>;
}

class SafeBrowserGateFailure extends Error {
  constructor(evidence: GateFailureEvidence) {
    super(JSON.stringify(evidence));
    this.name = "SafeBrowserGateFailure";
    this.stack = this.message;
  }
}

const CRM02_BROWSER_STAGES = Object.freeze([
  "runtime_preflight",
  "postgres_setup",
  "baseline_seed",
  "identity_provision",
  "next_dev",
  "canonical_origin_discovery",
  "chrome_launch",
  "advisor_login_server_render",
  "advisor_login_browser_render",
  "advisor_login_session",
  "workspace_shell_desktop_navigation",
  "workspace_shell_notifications",
  "workspace_shell_language",
  "workspace_shell_account_menu",
  "workspace_shell_mobile_navigation",
  "crm01_student_create",
  "advisor_detail_entry",
  "current_relationship_read",
  "management_navigation",
  "search_validation",
  "guardian_search",
  "explicit_candidate_selection",
  "idempotency_and_double_submit",
  "attach_command",
  "attach_authority_refresh",
  "attach_feedback",
  "attach_persistence",
  "stale_concurrency_setup",
  "stale_handoff",
  "stale_recovery",
  "reattach_previous_primary",
  "primary_handoff",
  "closed_history_aggregate",
  "advisor_relogin_persistence",
  "founder_read_only",
  "founder_direct_forbidden",
  "admin_read_only",
  "admin_direct_forbidden",
  "desktop_viewport",
  "mobile_viewport",
  "browser_log_safety",
  "cleanup",
  "complete",
] as const);

type Crm02BrowserStage = (typeof CRM02_BROWSER_STAGES)[number];

interface Crm02BrowserEvidence {
  workspace_desktop_navigation: boolean;
  workspace_mobile_navigation: boolean;
  workspace_notifications: boolean;
  workspace_language: boolean;
  workspace_account_menu: boolean;
  student_created: boolean;
  advisor_management_entry_visible: boolean;
  current_get_status: number | null;
  current_primary_visible: boolean;
  validation_posts_zero: boolean;
  search_status: number | null;
  masked_candidate_visible: boolean;
  candidate_explicitly_selected: boolean;
  same_retry_key: boolean;
  changed_field_rotated_key: boolean;
  double_submit_single_request: boolean;
  attach_status: number | null;
  attach_refresh_status: number | null;
  attach_success_visible: boolean;
  attach_refresh_persisted: boolean;
  attach_relogin_persisted: boolean;
  stale_status: number | null;
  stale_code: "STALE_VERSION" | "OTHER" | null;
  stale_recovered: boolean;
  handoff_status: number | null;
  new_primary_visible: boolean;
  closed_history_minimum_met: boolean;
  founder_current_readable: boolean;
  founder_controls_hidden: boolean;
  founder_direct_forbidden: boolean;
  admin_current_readable: boolean;
  admin_controls_hidden: boolean;
  admin_direct_forbidden: boolean;
  desktop_viewport_passed: boolean;
  mobile_viewport_passed: boolean;
  page_errors: number;
  sensitive_log_matches: number;
}

class SafeCrm02BrowserGateFailure extends Error {
  constructor(input: {
    readonly stage: Crm02BrowserStage;
    readonly evidence: Readonly<Crm02BrowserEvidence>;
    readonly cleanup: Readonly<CleanupEvidence>;
  }) {
    super(JSON.stringify(Object.freeze({ status: "failed", ...input })));
    this.name = "SafeCrm02BrowserGateFailure";
    this.stack = this.message;
  }
}

const CRM03_BROWSER_STAGES = Object.freeze([
  "runtime_preflight",
  "postgres_setup",
  "baseline_seed",
  "identity_provision",
  "next_dev",
  "canonical_origin_discovery",
  "chrome_launch",
  "advisor_login",
  "crm01_student_create",
  "advisor_assignment",
  "profile_entries",
  "keyboard_focus",
  "student_validation",
  "student_idempotency",
  "student_conflict_seed",
  "student_conflict_submit",
  "student_conflict_feedback",
  "student_update",
  "student_refresh",
  "guardian_validation",
  "guardian_stale_setup",
  "guardian_stale_feedback",
  "guardian_stale_recovery",
  "guardian_update",
  "relogin_persistence",
  "founder_allowed",
  "admin_login_contract",
  "admin_detail_requests",
  "admin_detail_ready",
  "admin_entries_hidden",
  "admin_direct_denied",
  "desktop_viewport",
  "mobile_editor_ready",
  "mobile_viewport_measurement",
  "mobile_viewport_assertion",
  "browser_log_safety",
  "cleanup",
  "complete",
] as const);

type Crm03BrowserStage = (typeof CRM03_BROWSER_STAGES)[number];

interface Crm03ViewportCategoryCounts {
  readonly input_count: number;
  readonly button_count: number;
  readonly link_count: number;
  readonly select_count: number;
}

interface Crm03ClippedCategoryCounts {
  readonly heading_count: number;
  readonly paragraph_count: number;
  readonly label_count: number;
  readonly button_count: number;
  readonly link_count: number;
  readonly strong_count: number;
  readonly small_count: number;
}

interface Crm03FixedControlMatches {
  readonly cancel: boolean;
  readonly save_guardian_profile: boolean;
  readonly edit_guardian_profile: boolean;
  readonly create_case: boolean;
  readonly manage_guardian_relationships: boolean;
}

interface Crm03FixedTitleMatches {
  readonly student_profile: boolean;
  readonly guardian_relationships: boolean;
  readonly edit_guardian_profile: boolean;
}

interface Crm03MobileViewportEvidence {
  readonly page_horizontal_overflow: number | null;
  readonly out_of_bounds_controls: number | null;
  readonly overlapping_controls: number | null;
  readonly clipped_text: number | null;
  readonly out_of_bounds_categories: Crm03ViewportCategoryCounts;
  readonly out_of_bounds_fixed_controls: Crm03FixedControlMatches;
  readonly overlapping_categories: Crm03ViewportCategoryCounts;
  readonly overlapping_fixed_controls: Crm03FixedControlMatches;
  readonly clipped_categories: Crm03ClippedCategoryCounts;
  readonly clipped_fixed_controls: Crm03FixedControlMatches;
  readonly clipped_fixed_titles: Crm03FixedTitleMatches;
}

interface Crm03BrowserEvidence {
  advisor_entries_visible: boolean;
  advisor_assignment_fetch_completed: boolean;
  advisor_assignment_json_parseable: boolean;
  advisor_assignment_status: number | null;
  advisor_assignment_exact_case_dto: boolean;
  founder_entries_visible: boolean;
  admin_entries_hidden: boolean;
  admin_auth_status: number | null;
  admin_auth_json_parseable: boolean;
  admin_auth_role_exact_admin: boolean;
  admin_auth_profiles_manage_capability_present: boolean | null;
  admin_student_request_started: boolean;
  admin_student_response_received: boolean;
  admin_student_response_status: number | null;
  admin_guardian_request_started: boolean;
  admin_guardian_response_received: boolean;
  admin_guardian_response_status: number | null;
  admin_detail_student_heading_count: number | null;
  admin_detail_denied_count: number | null;
  admin_student_edit_button_count: number | null;
  admin_student_edit_button_visible_count: number | null;
  admin_guardian_edit_button_count: number | null;
  admin_guardian_edit_button_visible_count: number | null;
  keyboard_cancel_restores_focus: boolean;
  student_validation_zero_patch: boolean;
  guardian_validation_zero_patch: boolean;
  synchronous_double_patch_count: number | null;
  uncertain_retry_same_key: boolean;
  changed_field_rotated_key: boolean;
  student_conflict_seed_fetch_completed: boolean;
  student_conflict_seed_json_parseable: boolean;
  student_conflict_seed_status: number | null;
  student_conflict_seed_ack_exact: boolean;
  student_conflict_submit_status: number | null;
  student_conflict_submit_code: "CONFLICT" | "STALE_VERSION" | "OTHER" | null;
  student_conflict_alert_count: number | null;
  student_conflict_alert_visible: boolean;
  student_patch_status: number | null;
  student_ack_exact: boolean;
  student_authoritative_get_status: number | null;
  student_refresh_persisted: boolean;
  guardian_stale_status: number | null;
  guardian_stale_visible: boolean;
  guardian_stale_recovered: boolean;
  guardian_patch_status: number | null;
  guardian_ack_exact: boolean;
  guardian_authoritative_get_status: number | null;
  relogin_persisted: boolean;
  admin_student_status: number | null;
  admin_guardian_status: number | null;
  admin_forbidden_codes: boolean;
  admin_private_echo: boolean | null;
  desktop_viewport_passed: boolean;
  mobile_viewport_passed: boolean;
  mobile_viewport: Crm03MobileViewportEvidence;
  page_errors: number;
  sensitive_log_matches: number;
}

class SafeCrm03BrowserGateFailure extends Error {
  constructor(input: {
    readonly stage: Crm03BrowserStage;
    readonly evidence: Readonly<Crm03BrowserEvidence>;
    readonly cleanup: Readonly<CleanupEvidence>;
  }) {
    super(JSON.stringify(Object.freeze({ status: "failed", ...input })));
    this.name = "SafeCrm03BrowserGateFailure";
    this.stack = this.message;
  }
}

test("CRM-01 works through the real local browser and disposable PostgreSQL 17", {
  timeout: 300_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-crm01-browser-pg17-${suffix}`;
  const secretVolumeName = `tianxing-crm01-browser-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const advisorPassword = randomBytes(32).toString("base64url");
  const adminPassword = randomBytes(32).toString("base64url");
  const appDirectory = await mkdtemp(join(tmpdir(), "tianxing-crm01-browser-app-"));
  const profileDirectory = await mkdtemp(join(tmpdir(), "tianxing-crm01-browser-profile-"));
  const loginEvidence: LoginEvidence = {
    status: null,
    location_pathname: null,
    final_pathname: null,
    error_enum: "none",
    cookie_present: false,
    auth_me_status: null,
  };
  const loginRenderEvidence: LoginRenderEvidence = {
    server: {
      status: null,
      content_type_html: false,
      database_test_presentation: false,
      configuration_unavailable_absent: false,
    },
    browser: {
      navigation_status: null,
      final_pathname: null,
      email_label_count: null,
      password_label_count: null,
      submit_button_count: null,
      role_select_count: null,
      workspace_heading_count: null,
      session_checking_count: null,
      returning_to_login_count: null,
      workspace_settled: false,
    },
  };
  const advisorEntryEvidence: AdvisorEntryEvidence = {
    navigation_status: null,
    final_pathname: null,
    students_request_started: false,
    students_response_received: false,
    students_response_status: null,
    access_request_started: false,
    access_response_received: false,
    access_response_status: null,
    heading_count: null,
    create_link_count: null,
    loading_state_count: null,
    unauthenticated_state_count: null,
    denied_state_count: null,
    unavailable_state_count: null,
  };
  const clientValidationEvidence: ClientValidationEvidence = {
    pathname_is_students_new: false,
    shell_heading_count: null,
    capability_request_started: false,
    capability_response_received: false,
    capability_response_status: null,
    loading_state_count: null,
    unauthenticated_state_count: null,
    denied_state_count: null,
    error_state_count: null,
    student_input_count: null,
    guardian_input_count: null,
    submit_button_count: null,
    student_value_nonempty: false,
    guardian_value_nonempty: false,
    validation_alert_count: null,
    validation_alert_visible: false,
    validation_post_count: null,
    posts_zero: false,
  };
  const adminDirectEvidence: AdminDirectEvidence = {
    fetch_completed: false,
    json_parseable: false,
    status: null,
    code: null,
    student_echoed: null,
    guardian_email_echoed: null,
  };
  const sessionDiagnosticEvidence: SessionDiagnosticEvidence = {
    cookie_stored: false,
    value_nonempty: false,
    value_length_valid: false,
    http_only: false,
    secure_false: false,
    same_site_lax: false,
    path_root: false,
    cookie_header_present: false,
    session_cookie_name_present: false,
    login_location_origin_matches_base: false,
    final_page_origin_matches_base: false,
    auth_request_origin_matches_base: false,
    final_page_origin_matches_auth_request: false,
    session_cookie_applicable_to_auth_request_url: false,
    stored_cookie_domain_matches_auth_request_hostname: false,
    auth_request_resource_type_fetch: false,
  };
  const canonicalOriginEvidence: CanonicalOriginEvidence = {
    response_status_307: false,
    location_present: false,
    location_parseable: false,
    pathname_exact: false,
    protocol_http: false,
    hostname_loopback: false,
    port_matches: false,
    credentials_absent: false,
    search_absent: false,
    hash_absent: false,
  };
  const cleanupEvidence: CleanupEvidence = {
    context_closed: false,
    dev_stopped: false,
    app_directory_removed: false,
    profile_removed: false,
    container_removed: false,
    volume_removed: false,
  };

  let stage: BrowserStage = "runtime_preflight";
  let containerStarted = false;
  let secretVolumeCreated = false;
  let devServer: ChildProcess | undefined;
  let context: BrowserContext | undefined;
  let failure: GateFailureEvidence | undefined;
  let safeSuccessEvidence: Readonly<Record<string, unknown>> | undefined;

  try {
    await access(DOCKER, constants.X_OK);
    await access(CHROME, constants.X_OK);

    stage = "postgres_setup";
    await runDocker(["image", "inspect", POSTGRES_IMAGE]);
    await runDocker(["volume", "create", secretVolumeName]);
    secretVolumeCreated = true;
    await runDocker([
      "run", "--rm", "--interactive", "--pull=never",
      "--volume", `${secretVolumeName}:/run/secrets`,
      POSTGRES_IMAGE, "/bin/sh", "-c",
      "umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password",
    ], applicationPassword);
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", containerName,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env", "POSTGRES_DB=tianxing",
      "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/local_postgres_password",
      "--volume", `${secretVolumeName}:/run/secrets:ro`,
      "--volume", `${resolve("infra/local/postgres/init")}:/docker-entrypoint-initdb.d:ro`,
      "--volume", `${resolve("infra/local/postgres/healthcheck.sh")}:/usr/local/bin/tianxing-postgres-healthcheck:ro`,
      "--publish", "127.0.0.1::5432",
      POSTGRES_IMAGE,
    ]);
    containerStarted = true;
    await waitForPostgres(containerName);
    const databasePort = readLoopbackPort((await runDocker(
      ["port", containerName, "5432/tcp"],
    )).stdout);
    const target = localTarget(databasePort, applicationPassword);

    stage = "baseline_seed";
    const build = await verifyCommittedOneRoleBaseline();
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply",
      target,
      build,
      dependencies: baselineDependencies(target),
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.generated_files, 31);
    const seed = await seedNeonTestRelease1(target, "apply");
    assert.equal(seed.status, "pass");
    assert.equal(seed.baseline.id, ONE_ROLE_BASELINE_ID);

    stage = "identity_provision";
    assert.equal(await provision(target, ADVISOR.email, advisorPassword), "created");
    assert.equal(await provision(target, ADMIN.email, adminPassword), "created");

    stage = "next_dev";
    await populateIsolatedApp(appDirectory);
    const nextPort = await reserveLoopbackPort();
    devServer = startNextDev(appDirectory, nextPort, target.connectionString);
    const listenUrl = `http://127.0.0.1:${nextPort}`;
    await waitForNextDev(listenUrl, devServer);

    stage = "canonical_origin_discovery";
    const canonicalBaseUrl = await discoverCanonicalBaseUrl(
      listenUrl,
      nextPort,
      canonicalOriginEvidence,
    );

    stage = "chrome_launch";
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: CHROME,
      headless: true,
      viewport: { width: 1440, height: 900 },
      locale: "zh-HK",
      args: ["--disable-background-networking", "--no-first-run", "--no-default-browser-check"],
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(15_000);
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => consoleMessages.push(`${message.type()}:${message.text()}`));
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await loginAdvisor({
      page,
      context,
      baseUrl: canonicalBaseUrl,
      email: ADVISOR.email,
      password: advisorPassword,
      evidence: loginEvidence,
      renderEvidence: loginRenderEvidence,
      sessionDiagnosticEvidence,
      setStage: (nextStage) => { stage = nextStage; },
    });

    stage = "advisor_list_navigation";
    const observeAdvisorRequest = (request: PlaywrightRequest) => {
      if (request.method() !== "GET") return;
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/v1/students") {
        advisorEntryEvidence.students_request_started = true;
      }
      if (pathname === "/api/v1/auth/me") {
        advisorEntryEvidence.access_request_started = true;
      }
    };
    const observeAdvisorResponse = (response: PlaywrightResponse) => {
      if (response.request().method() !== "GET") return;
      const pathname = new URL(response.url()).pathname;
      if (pathname === "/api/v1/students") {
        advisorEntryEvidence.students_response_received = true;
        advisorEntryEvidence.students_response_status = response.status();
      }
      if (pathname === "/api/v1/auth/me") {
        advisorEntryEvidence.access_response_received = true;
        advisorEntryEvidence.access_response_status = response.status();
      }
    };
    page.on("request", observeAdvisorRequest);
    page.on("response", observeAdvisorResponse);
    const studentsNavigation = await page.goto(`${canonicalBaseUrl}/students`, {
      waitUntil: "domcontentloaded",
    });
    advisorEntryEvidence.navigation_status = studentsNavigation?.status() ?? null;
    advisorEntryEvidence.final_pathname = new URL(page.url()).pathname;
    assert.equal(advisorEntryEvidence.navigation_status, 200);
    assert.equal(advisorEntryEvidence.final_pathname, "/students");

    stage = "advisor_list_shell";
    const heading = page.getByRole("heading", { name: "學生名單", exact: true });
    advisorEntryEvidence.heading_count = await heading.count();
    await heading.waitFor({ state: "visible" });
    advisorEntryEvidence.heading_count = await heading.count();
    assert.equal(advisorEntryEvidence.heading_count, 1);

    stage = "advisor_list_data";
    const loadingState = page.getByText("正在載入學生", { exact: true });
    const unauthenticatedState = page.getByText("工作階段已失效", { exact: true });
    const deniedState = page.getByText("無法查看學生資料", { exact: true });
    const unavailableState = page.getByText("學生服務暫時不可用", { exact: true });
    advisorEntryEvidence.loading_state_count = await loadingState.count();
    await loadingState.waitFor({ state: "hidden" });
    advisorEntryEvidence.loading_state_count = await loadingState.count();
    advisorEntryEvidence.unauthenticated_state_count = await unauthenticatedState.count();
    advisorEntryEvidence.denied_state_count = await deniedState.count();
    advisorEntryEvidence.unavailable_state_count = await unavailableState.count();
    assert.equal(advisorEntryEvidence.students_request_started, true);
    assert.equal(advisorEntryEvidence.students_response_received, true);
    assert.equal(advisorEntryEvidence.students_response_status, 200);
    assert.equal(advisorEntryEvidence.access_request_started, true);
    assert.equal(advisorEntryEvidence.access_response_received, true);
    assert.equal(advisorEntryEvidence.access_response_status, 200);
    assert.equal(advisorEntryEvidence.loading_state_count, 0);
    assert.equal(advisorEntryEvidence.unauthenticated_state_count, 0);
    assert.equal(advisorEntryEvidence.denied_state_count, 0);
    assert.equal(advisorEntryEvidence.unavailable_state_count, 0);

    stage = "advisor_create_entry";
    const createLink = page.getByRole("link", { name: "新增學生", exact: true });
    advisorEntryEvidence.create_link_count = await createLink.count();
    await createLink.waitFor({ state: "visible" });
    advisorEntryEvidence.create_link_count = await createLink.count();
    assert.equal(advisorEntryEvidence.create_link_count, 1);
    page.off("request", observeAdvisorRequest);
    page.off("response", observeAdvisorResponse);

    stage = "desktop_viewport";
    const desktopList = await assertViewport(page, "advisor-list-desktop");

    const observeCreateFormAccessRequest = (request: PlaywrightRequest) => {
      if (request.method() === "GET" &&
          new URL(request.url()).pathname === "/api/v1/auth/me") {
        clientValidationEvidence.capability_request_started = true;
      }
    };
    const observeCreateFormAccessResponse = (response: PlaywrightResponse) => {
      if (response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/api/v1/auth/me") {
        clientValidationEvidence.capability_response_received = true;
        clientValidationEvidence.capability_response_status = response.status();
      }
    };
    page.on("request", observeCreateFormAccessRequest);
    page.on("response", observeCreateFormAccessResponse);

    stage = "create_form_navigation";
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/students/new"),
      page.getByRole("link", { name: "新增學生", exact: true }).click(),
    ]);
    clientValidationEvidence.pathname_is_students_new =
      new URL(page.url()).pathname === "/students/new";
    assert.equal(clientValidationEvidence.pathname_is_students_new, true);

    stage = "create_form_shell";
    const createFormHeading = page.getByRole("heading", {
      name: "新增學生與主要監護人",
      exact: true,
      level: 2,
    });
    await createFormHeading.waitFor({ state: "visible" });
    clientValidationEvidence.shell_heading_count = await createFormHeading.count();
    assert.equal(clientValidationEvidence.shell_heading_count, 1);

    stage = "create_form_access";
    const accessLoadingState = page.getByText("正在確認建立權限", { exact: true });
    const accessUnauthenticatedState = page.getByText("工作階段已失效", {
      exact: true,
    });
    const accessDeniedState = page.getByText("無法建立學生資料", { exact: true });
    const accessErrorState = page.getByText("暫時無法確認權限", { exact: true });
    await accessLoadingState.waitFor({ state: "hidden" });
    clientValidationEvidence.loading_state_count = await accessLoadingState.count();
    clientValidationEvidence.unauthenticated_state_count =
      await accessUnauthenticatedState.count();
    clientValidationEvidence.denied_state_count = await accessDeniedState.count();
    clientValidationEvidence.error_state_count = await accessErrorState.count();
    assert.equal(clientValidationEvidence.capability_request_started, true);
    assert.equal(clientValidationEvidence.capability_response_received, true);
    assert.equal(clientValidationEvidence.capability_response_status, 200);
    assert.equal(clientValidationEvidence.loading_state_count, 0);
    assert.equal(clientValidationEvidence.unauthenticated_state_count, 0);
    assert.equal(clientValidationEvidence.denied_state_count, 0);
    assert.equal(clientValidationEvidence.error_state_count, 0);
    page.off("request", observeCreateFormAccessRequest);
    page.off("response", observeCreateFormAccessResponse);

    stage = "create_form_ready";
    const studentInput = page.getByRole("textbox", {
      name: "學生姓名",
      exact: true,
    });
    const guardianInput = page.getByRole("textbox", {
      name: "監護人姓名",
      exact: true,
    });
    const createStudentButton = page.getByRole("button", {
      name: "建立學生",
      exact: true,
    });
    clientValidationEvidence.student_input_count = await studentInput.count();
    clientValidationEvidence.guardian_input_count = await guardianInput.count();
    clientValidationEvidence.submit_button_count = await createStudentButton.count();
    assert.equal(clientValidationEvidence.student_input_count, 1);
    assert.equal(clientValidationEvidence.guardian_input_count, 1);
    assert.equal(clientValidationEvidence.submit_button_count, 1);
    await studentInput.waitFor({ state: "visible" });
    await guardianInput.waitFor({ state: "visible" });
    await createStudentButton.waitFor({ state: "visible" });

    stage = "client_validation_fill";
    await studentInput.fill("CRM01 Validation Student");
    await guardianInput.fill("CRM01 Validation Guardian");
    clientValidationEvidence.student_value_nonempty =
      (await studentInput.inputValue()).length > 0;
    clientValidationEvidence.guardian_value_nonempty =
      (await guardianInput.inputValue()).length > 0;
    assert.equal(clientValidationEvidence.student_value_nonempty, true);
    assert.equal(clientValidationEvidence.guardian_value_nonempty, true);

    let validationPosts = 0;
    const validationObserver = async (route: Route) => {
      if (route.request().method() === "POST") validationPosts += 1;
      await route.continue();
    };

    stage = "client_validation_submit";
    await page.route("**/api/v1/students", validationObserver);
    await createStudentButton.click();

    stage = "client_validation_feedback";
    const validationAlert = page.getByRole("alert")
      .filter({ hasText: "監護人 Email 和電話至少填寫一項" });
    await validationAlert.waitFor({ state: "visible" });
    clientValidationEvidence.validation_alert_count = await validationAlert.count();
    clientValidationEvidence.validation_alert_visible = await validationAlert.isVisible();
    assert.equal(clientValidationEvidence.validation_alert_count, 1);
    assert.equal(clientValidationEvidence.validation_alert_visible, true);

    stage = "client_validation_no_post";
    clientValidationEvidence.validation_post_count = validationPosts;
    clientValidationEvidence.posts_zero = validationPosts === 0;
    try {
      assert.equal(clientValidationEvidence.validation_post_count, 0);
      assert.equal(clientValidationEvidence.posts_zero, true);
    } finally {
      await page.unroute("**/api/v1/students", validationObserver);
    }

    stage = "idempotency_retry";
    await page.reload();
    await page.getByRole("button", { name: "建立學生", exact: true }).waitFor();
    await fillValidDraft(page, {
      studentName: "CRM01 Retry Probe Student",
      guardianName: "CRM01 Retry Probe Guardian",
      guardianEmail: "crm01-retry-probe@example.invalid",
    });
    const observedKeys: string[] = [];
    const retryInterceptor = async (route: Route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.continue();
        return;
      }
      observedKeys.push(request.headers()["idempotency-key"] ?? "");
      await route.abort("failed");
    };
    await page.route("**/api/v1/students", retryInterceptor);
    await submitAndWaitUnavailable(page, 1, observedKeys);
    await submitAndWaitUnavailable(page, 2, observedKeys);
    assert.match(observedKeys[0] ?? "", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    assert.equal(observedKeys[0], observedKeys[1]);
    await page.getByRole("textbox", { name: "學生姓名", exact: true })
      .fill("CRM01 Retry Probe Student Changed");
    await submitAndWaitUnavailable(page, 3, observedKeys);
    assert.notEqual(observedKeys[1], observedKeys[2]);
    await page.unroute("**/api/v1/students", retryInterceptor);
    observedKeys.fill("[redacted]");

    await page.reload();
    await page.getByRole("button", { name: "建立學生", exact: true }).waitFor();
    const runToken = randomBytes(5).toString("hex");
    const studentName = `CRM01 Browser Student ${runToken}`;
    const guardianName = `CRM01 Browser Guardian ${runToken}`;
    const guardianEmail = `crm01-browser-${runToken}@example.invalid`;
    await fillValidDraft(page, { studentName, guardianName, guardianEmail });

    stage = "desktop_viewport";
    const desktopForm = await assertViewport(page, "advisor-create-desktop");

    stage = "advisor_create";
    await Promise.all([
      page.waitForURL(/\/students\/[0-9a-f-]{36}$/i),
      page.getByRole("button", { name: "建立學生", exact: true }).click(),
    ]);
    const detailUrl = page.url();
    const studentId = new URL(detailUrl).pathname.split("/").at(-1);
    assert.match(studentId ?? "", /^[0-9a-f-]{36}$/i);
    await page.getByRole("heading", { name: studentName, exact: true }).waitFor();
    await page.getByText(guardianName, { exact: true }).waitFor();

    stage = "desktop_viewport";
    const desktopDetail = await assertViewport(page, "advisor-detail-desktop");

    stage = "detail_persistence";
    await page.reload();
    await page.getByRole("heading", { name: studentName, exact: true }).waitFor();
    await page.getByText(guardianName, { exact: true }).waitFor();
    await page.goto(`${canonicalBaseUrl}/students`);
    await page.getByText(studentName, { exact: true }).waitFor();

    stage = "mobile_viewport";
    const mobileList = await withViewport(page, { width: 390, height: 844 }, () =>
      assertViewport(page, "advisor-list-mobile"));
    await page.goto(detailUrl);
    await page.getByRole("heading", { name: studentName, exact: true }).waitFor();
    const mobileDetail = await withViewport(page, { width: 390, height: 844 }, () =>
      assertViewport(page, "advisor-detail-mobile"));
    await page.setViewportSize({ width: 1440, height: 900 });

    stage = "logout_session";
    await logout(page);
    const expired = await context.request.get(`${canonicalBaseUrl}/api/v1/auth/me`);
    assert.equal(expired.status(), 401);

    stage = "relogin_persistence";
    await loginWithoutEvidence(page, canonicalBaseUrl, ADVISOR.email, advisorPassword);
    await page.goto(detailUrl);
    await page.getByRole("heading", { name: studentName, exact: true }).waitFor();
    await page.getByText(guardianName, { exact: true }).waitFor();

    stage = "admin_login";
    await logout(page);
    await loginWithoutEvidence(page, canonicalBaseUrl, ADMIN.email, adminPassword);

    stage = "admin_hidden_entry";
    await page.goto(`${canonicalBaseUrl}/students`);
    await page.getByRole("heading", { name: "學生名單", exact: true }).waitFor();
    await page.getByText(studentName, { exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "新增學生", exact: true }).count(), 0);
    await page.goto(`${canonicalBaseUrl}/students/new`);
    await page.getByText("無法建立學生資料", { exact: true }).waitFor();

    stage = "admin_direct_transport";
    const adminPayload = {
      student: {
        display_name: "CRM01 Admin Forbidden Student",
        date_of_birth: null,
        contact_email: null,
        contact_phone: null,
      },
      primary_guardian: {
        display_name: "CRM01 Admin Forbidden Guardian",
        email: "crm01-admin-forbidden@example.invalid",
        phone: null,
        relationship_type: "father",
        is_legal_guardian: true,
      },
    };
    const adminDirectResult: AdminDirectEvidence = await page.evaluate(async ({
      payload,
      idempotencyKey,
    }) => {
      let response: Response;
      try {
        response = await fetch("/api/v1/students", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(payload),
        });
      } catch {
        return {
          fetch_completed: false,
          json_parseable: false,
          status: null,
          code: null,
          student_echoed: null,
          guardian_email_echoed: null,
        };
      }

      let body: unknown;
      try {
        body = await response.json() as unknown;
      } catch {
        return {
          fetch_completed: true,
          json_parseable: false,
          status: response.status,
          code: null,
          student_echoed: null,
          guardian_email_echoed: null,
        };
      }

      const error = body !== null && typeof body === "object" && "error" in body
        ? (body as { readonly error?: unknown }).error
        : undefined;
      const rawCode = error !== null && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      const code: AdminDirectEvidence["code"] = rawCode === "FORBIDDEN"
        ? "FORBIDDEN"
        : typeof rawCode === "string" ? "OTHER" : null;
      const serialized = JSON.stringify(body) ?? "";
      return {
        fetch_completed: true,
        json_parseable: true,
        status: response.status,
        code,
        student_echoed: serialized.includes(payload.student.display_name),
        guardian_email_echoed: serialized.includes(payload.primary_guardian.email),
      };
    }, {
      payload: adminPayload,
      idempotencyKey: `crm01-admin-${randomBytes(8).toString("hex")}`,
    });
    Object.assign(adminDirectEvidence, adminDirectResult);
    assert.equal(adminDirectEvidence.fetch_completed, true);
    assert.equal(adminDirectEvidence.json_parseable, true);

    stage = "admin_direct_status";
    assert.equal(adminDirectEvidence.status, 403);
    assert.equal(adminDirectEvidence.code, "FORBIDDEN");

    stage = "admin_direct_privacy";
    assert.equal(adminDirectEvidence.student_echoed, false);
    assert.equal(adminDirectEvidence.guardian_email_echoed, false);

    stage = "browser_log_safety";
    const sensitiveMarkers = [
      applicationPassword,
      advisorPassword,
      adminPassword,
      ADVISOR.email,
      ADMIN.email,
      studentName,
      guardianName,
      guardianEmail,
      target.connectionString,
    ];
    const fixedSensitiveMarkers = [
      "postgresql://",
      "database_url",
      "tx_session=",
      "set-cookie",
    ];
    const browserLogs = [...consoleMessages, ...pageErrors];
    const sensitiveLogMatches = browserLogs.filter((entry) => {
      const normalized = entry.toLowerCase();
      return sensitiveMarkers.some((marker) => entry.includes(marker)) ||
        fixedSensitiveMarkers.some((marker) => normalized.includes(marker));
    }).length;
    assert.equal(sensitiveLogMatches, 0);
    assert.equal(pageErrors.length, 0);

    stage = "complete";
    safeSuccessEvidence = Object.freeze({
      status: "pass",
      stage,
      runtime: Object.freeze({
        postgres_major: 17,
        baseline_generated_files: baseline.generated_files,
        seed: "release1_synthetic",
        browser_driver: "playwright-core-1.55.0",
        browser_binary: "system_chrome",
      }),
      login: Object.freeze({ ...loginEvidence }),
      login_render: freezeLoginRenderEvidence(loginRenderEvidence),
      canonical_origin: Object.freeze({ ...canonicalOriginEvidence }),
      session_diagnostic: Object.freeze({ ...sessionDiagnosticEvidence }),
      advisor_entry: Object.freeze({ ...advisorEntryEvidence }),
      client_validation: Object.freeze({ ...clientValidationEvidence }),
      admin_direct: Object.freeze({ ...adminDirectEvidence }),
      advisor: Object.freeze({
        capability_entry_visible: true,
        client_validation_blocked_request: clientValidationEvidence.posts_zero,
        created: true,
        list_detail_refresh_persisted: true,
        logout_invalidated_session: true,
        relogin_persisted: true,
      }),
      admin: Object.freeze({
        capability_entry_hidden: true,
        direct_post_status: adminDirectEvidence.status,
      }),
      idempotency: Object.freeze({
        same_retry_key: true,
        changed_field_rotated_key: true,
      }),
      viewport: Object.freeze({
        desktop: Object.freeze([desktopList, desktopForm, desktopDetail]),
        mobile: Object.freeze([mobileList, mobileDetail]),
      }),
      browser_safety: Object.freeze({
        console_messages: consoleMessages.length,
        page_errors: pageErrors.length,
        sensitive_log_matches: sensitiveLogMatches,
      }),
    });
  } catch {
    failure = Object.freeze({
      status: "failed",
      stage: safeStage(stage),
      login: isLoginStage(stage) ? Object.freeze({ ...loginEvidence }) : null,
      login_render: isLoginStage(stage)
        ? freezeLoginRenderEvidence(loginRenderEvidence)
        : null,
      canonical_origin: Object.freeze({ ...canonicalOriginEvidence }),
      session_diagnostic: Object.freeze({ ...sessionDiagnosticEvidence }),
      advisor_entry: isAdvisorEntryStage(stage)
        ? Object.freeze({ ...advisorEntryEvidence })
        : null,
      client_validation: isClientValidationStage(stage)
        ? Object.freeze({ ...clientValidationEvidence })
        : null,
      admin_direct: isAdminDirectStage(stage)
        ? Object.freeze({ ...adminDirectEvidence })
        : null,
      cleanup: Object.freeze({ ...cleanupEvidence }),
    });
  } finally {
    stage = "cleanup";
    cleanupEvidence.context_closed = await closeBrowser(context);
    cleanupEvidence.dev_stopped = await stopNextDev(devServer);
    cleanupEvidence.app_directory_removed = await removeDirectory(appDirectory);
    cleanupEvidence.profile_removed = await removeDirectory(profileDirectory);
    cleanupEvidence.container_removed = containerStarted
      ? await removeDockerResource(["rm", "--force", containerName])
      : true;
    cleanupEvidence.volume_removed = secretVolumeCreated
      ? await removeDockerResource(["volume", "rm", "--force", secretVolumeName])
      : true;
  }

  const cleanupPassed = Object.values(cleanupEvidence).every(Boolean);
  if (!cleanupPassed) {
    failure = Object.freeze({
      status: "failed",
      stage: "cleanup",
      login: null,
      login_render: null,
      canonical_origin: Object.freeze({ ...canonicalOriginEvidence }),
      session_diagnostic: Object.freeze({ ...sessionDiagnosticEvidence }),
      advisor_entry: null,
      client_validation: null,
      admin_direct: null,
      cleanup: Object.freeze({ ...cleanupEvidence }),
    });
  }
  if (failure) {
    throw new SafeBrowserGateFailure(Object.freeze({
      ...failure,
      cleanup: Object.freeze({ ...cleanupEvidence }),
    }));
  }

  process.stdout.write(`${JSON.stringify(Object.freeze({
    ...safeSuccessEvidence,
    cleanup: Object.freeze({ ...cleanupEvidence }),
  }))}\n`);
});

test("CRM-02 works through the real local browser and disposable PostgreSQL 17", {
  timeout: 300_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-crm02-browser-pg17-${suffix}`;
  const secretVolumeName = `tianxing-crm02-browser-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const advisorPassword = randomBytes(32).toString("base64url");
  const founderPassword = randomBytes(32).toString("base64url");
  const adminPassword = randomBytes(32).toString("base64url");
  const appDirectory = await mkdtemp(join(tmpdir(), "tianxing-crm02-browser-app-"));
  const profileDirectory = await mkdtemp(join(tmpdir(), "tianxing-crm02-browser-profile-"));
  const evidence: Crm02BrowserEvidence = {
    workspace_desktop_navigation: false,
    workspace_mobile_navigation: false,
    workspace_notifications: false,
    workspace_language: false,
    workspace_account_menu: false,
    student_created: false,
    advisor_management_entry_visible: false,
    current_get_status: null,
    current_primary_visible: false,
    validation_posts_zero: false,
    search_status: null,
    masked_candidate_visible: false,
    candidate_explicitly_selected: false,
    same_retry_key: false,
    changed_field_rotated_key: false,
    double_submit_single_request: false,
    attach_status: null,
    attach_refresh_status: null,
    attach_success_visible: false,
    attach_refresh_persisted: false,
    attach_relogin_persisted: false,
    stale_status: null,
    stale_code: null,
    stale_recovered: false,
    handoff_status: null,
    new_primary_visible: false,
    closed_history_minimum_met: false,
    founder_current_readable: false,
    founder_controls_hidden: false,
    founder_direct_forbidden: false,
    admin_current_readable: false,
    admin_controls_hidden: false,
    admin_direct_forbidden: false,
    desktop_viewport_passed: false,
    mobile_viewport_passed: false,
    page_errors: 0,
    sensitive_log_matches: 0,
  };
  const cleanupEvidence: CleanupEvidence = {
    context_closed: false,
    dev_stopped: false,
    app_directory_removed: false,
    profile_removed: false,
    container_removed: false,
    volume_removed: false,
  };
  const canonicalOriginEvidence: CanonicalOriginEvidence = {
    response_status_307: false,
    location_present: false,
    location_parseable: false,
    pathname_exact: false,
    protocol_http: false,
    hostname_loopback: false,
    port_matches: false,
    credentials_absent: false,
    search_absent: false,
    hash_absent: false,
  };

  let stage: Crm02BrowserStage = "runtime_preflight";
  let containerStarted = false;
  let secretVolumeCreated = false;
  let devServer: ChildProcess | undefined;
  let context: BrowserContext | undefined;
  let failureStage: Crm02BrowserStage | undefined;
  let baselineGeneratedFiles = 0;

  try {
    await access(DOCKER, constants.X_OK);
    await access(CHROME, constants.X_OK);

    stage = "postgres_setup";
    await runDocker(["image", "inspect", POSTGRES_IMAGE]);
    await runDocker(["volume", "create", secretVolumeName]);
    secretVolumeCreated = true;
    await runDocker([
      "run", "--rm", "--interactive", "--pull=never",
      "--volume", `${secretVolumeName}:/run/secrets`,
      POSTGRES_IMAGE, "/bin/sh", "-c",
      "umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password",
    ], applicationPassword);
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", containerName,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env", "POSTGRES_DB=tianxing",
      "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/local_postgres_password",
      "--volume", `${secretVolumeName}:/run/secrets:ro`,
      "--volume", `${resolve("infra/local/postgres/init")}:/docker-entrypoint-initdb.d:ro`,
      "--volume", `${resolve("infra/local/postgres/healthcheck.sh")}:/usr/local/bin/tianxing-postgres-healthcheck:ro`,
      "--publish", "127.0.0.1::5432",
      POSTGRES_IMAGE,
    ]);
    containerStarted = true;
    await waitForPostgres(containerName);
    const databasePort = readLoopbackPort((await runDocker(["port", containerName, "5432/tcp"])).stdout);
    const target = localTarget(databasePort, applicationPassword);

    stage = "baseline_seed";
    const build = await verifyCommittedOneRoleBaseline();
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply",
      target,
      build,
      dependencies: baselineDependencies(target),
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.generated_files, 31);
    baselineGeneratedFiles = baseline.generated_files;
    const seed = await seedNeonTestRelease1(target, "apply");
    assert.equal(seed.status, "pass");
    assert.equal(seed.baseline.id, ONE_ROLE_BASELINE_ID);

    stage = "identity_provision";
    assert.equal(await provision(target, ADVISOR.email, advisorPassword), "created");
    assert.equal(await provision(target, FOUNDER.email, founderPassword), "created");
    assert.equal(await provision(target, ADMIN.email, adminPassword), "created");

    stage = "next_dev";
    await populateIsolatedApp(appDirectory);
    const nextPort = await reserveLoopbackPort();
    devServer = startNextDev(appDirectory, nextPort, target.connectionString);
    const listenUrl = `http://127.0.0.1:${nextPort}`;
    await waitForNextDev(listenUrl, devServer);

    stage = "canonical_origin_discovery";
    const canonicalBaseUrl = await discoverCanonicalBaseUrl(listenUrl, nextPort, canonicalOriginEvidence);

    stage = "chrome_launch";
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: CHROME,
      headless: true,
      viewport: { width: 1440, height: 900 },
      locale: "zh-HK",
      args: ["--disable-background-networking", "--no-first-run", "--no-default-browser-check"],
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(15_000);
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => consoleMessages.push(`${message.type()}:${message.text()}`));
    page.on("pageerror", (error) => pageErrors.push(error.message));

    stage = "advisor_login_server_render";
    await loginAndWaitForWorkspace(
      page,
      canonicalBaseUrl,
      ADVISOR.email,
      advisorPassword,
      (nextStage) => { stage = nextStage; },
    );

    stage = "workspace_shell_desktop_navigation";
    const workspaceSidebar = page.locator("aside.app-sidebar");
    await workspaceSidebar.waitFor({ state: "visible" });
    await workspaceSidebar.getByRole("button", { name: "收合導航", exact: true }).click();
    await workspaceSidebar.waitFor({ state: "hidden" });
    await page.locator("button.desktop-navigation-button").click();
    await workspaceSidebar.waitFor({ state: "visible" });
    evidence.workspace_desktop_navigation = true;

    stage = "workspace_shell_notifications";
    const notificationButton = page.getByRole("button", { name: "通知", exact: true });
    await notificationButton.click();
    const notificationPanel = page.locator("#workspace-notifications");
    await notificationPanel.waitFor({ state: "visible" });
    await notificationPanel.getByText("通知服務暫時不可用，請稍後再試。", { exact: true })
      .waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.id === "workspace-notifications");
    await assertViewport(page, "ui-shell-notifications-desktop");
    await page.keyboard.press("Escape");
    await notificationPanel.waitFor({ state: "hidden" });
    assert.equal(await notificationButton.evaluate((element) => element === document.activeElement), true);
    await notificationButton.click();
    await notificationPanel.waitFor({ state: "visible" });
    await page.getByRole("heading", { name: "今日工作", exact: true, level: 2 }).click();
    await notificationPanel.waitFor({ state: "hidden" });
    evidence.workspace_notifications = true;

    stage = "workspace_shell_language";
    await page.getByRole("button", { name: "English", exact: true }).click();
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    await page.getByRole("heading", { name: "Today's Work", exact: true, level: 1 })
      .waitFor({ state: "visible" });
    await workspaceSidebar.getByRole("link", { name: "Today's Work", exact: true })
      .waitFor({ state: "visible" });
    await page.getByRole("button", { name: "中文", exact: true }).click();
    assert.equal(await page.locator("html").getAttribute("lang"), "zh-TW");
    evidence.workspace_language = true;

    stage = "workspace_shell_account_menu";
    const accountButton = page.getByRole("button", { name: "帳戶選單", exact: true });
    await accountButton.click();
    const accountMenu = page.getByRole("menu", { name: "帳戶選單", exact: true });
    await accountMenu.waitFor({ state: "visible" });
    const accountLogout = accountMenu.getByRole("menuitem", { name: "登出", exact: true });
    await accountLogout.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.id === "workspace-logout");
    await assertViewport(page, "ui-shell-account-desktop");
    await page.keyboard.press("Escape");
    await accountMenu.waitFor({ state: "hidden" });
    assert.equal(await accountButton.evaluate((element) => element === document.activeElement), true);
    evidence.workspace_account_menu = true;

    stage = "workspace_shell_mobile_navigation";
    await workspaceSidebar.getByRole("button", { name: "收合導航", exact: true }).click();
    await workspaceSidebar.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("button.mobile-navigation-button").click();
    await workspaceSidebar.waitFor({ state: "visible" });
    await assertViewport(page, "ui-shell-navigation-mobile");
    await workspaceSidebar.getByRole("button", { name: "收合導航", exact: true }).click();
    await workspaceSidebar.waitFor({ state: "hidden" });
    await notificationButton.click();
    await notificationPanel.waitFor({ state: "visible" });
    await assertViewport(page, "ui-shell-notifications-mobile");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "English", exact: true }).click();
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    await page.getByRole("button", { name: "中文", exact: true }).click();
    await accountButton.click();
    await accountMenu.waitFor({ state: "visible" });
    await assertViewport(page, "ui-shell-account-mobile");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("button.desktop-navigation-button").click();
    await workspaceSidebar.waitFor({ state: "visible" });
    evidence.workspace_mobile_navigation = true;

    stage = "crm01_student_create";
    await page.goto(`${canonicalBaseUrl}/students/new`);
    await page.getByRole("button", { name: "建立學生", exact: true }).waitFor({ state: "visible" });
    const token = randomBytes(5).toString("hex");
    const studentName = `CRM02 Browser Student ${token}`;
    const primaryGuardianName = `CRM02 Primary Guardian ${token}`;
    const primaryGuardianEmail = `crm02-primary-${token}@example.invalid`;
    await fillValidDraft(page, {
      studentName,
      guardianName: primaryGuardianName,
      guardianEmail: primaryGuardianEmail,
    });
    await Promise.all([
      page.waitForURL(/\/students\/[0-9a-f-]{36}$/i),
      page.getByRole("button", { name: "建立學生", exact: true }).click(),
    ]);
    const detailUrl = page.url();
    const studentId = new URL(detailUrl).pathname.split("/").at(-1) ?? "";
    assert.match(studentId, /^[0-9a-f-]{36}$/i);
    evidence.student_created = true;

    stage = "advisor_detail_entry";
    const currentResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/api/v1/students/${studentId}/guardians`);
    await page.reload({ waitUntil: "domcontentloaded" });
    const currentResponse = await currentResponsePromise;
    evidence.current_get_status = currentResponse.status();
    assert.equal(evidence.current_get_status, 200);
    const initialCurrent = readCurrentRelationshipResponse(await currentResponse.json(), studentId);
    const initialPrimary = initialCurrent.relationships.find(({ is_primary_contact }) => is_primary_contact);
    assert.ok(initialPrimary);
    assert.equal(initialPrimary.relationship_type, "father");
    await page.getByRole("heading", { name: studentName, exact: true }).waitFor({ state: "visible" });
    const detailRelationshipsSection = page.locator('section[aria-labelledby="student-guardian-heading"]');
    const detailPrimaryCard = relationshipArticle(page, detailRelationshipsSection, primaryGuardianName);
    await detailPrimaryCard.waitFor({ state: "visible" });
    evidence.current_primary_visible =
      await detailPrimaryCard.count() === 1 &&
      await detailPrimaryCard.getByText("主要聯絡人", { exact: true }).count() === 1;
    assert.equal(evidence.current_primary_visible, true);
    assert.equal(await page.getByText(primaryGuardianEmail, { exact: true }).count(), 0);
    const manageLink = page.getByRole("link", { name: "管理監護人關係", exact: true });
    await manageLink.waitFor({ state: "visible" });
    evidence.advisor_management_entry_visible = await manageLink.count() === 1;
    assert.equal(evidence.advisor_management_entry_visible, true);

    stage = "desktop_viewport";
    await assertViewport(page, "crm02-advisor-detail-desktop");

    stage = "management_navigation";
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/students/${studentId}/guardians`),
      manageLink.click(),
    ]);
    const managementUrl = page.url();
    await page.getByRole("heading", { name: "監護人關係管理", exact: true, level: 2 }).waitFor({ state: "visible" });
    const currentRelationshipsSection = page.locator('section[aria-labelledby="current-relationships-heading"]');
    const attachSection = page.locator('section[aria-labelledby="attach-guardian-heading"]');
    const handoffSection = page.locator('section[aria-labelledby="handoff-primary-heading"]');
    const managementPrimaryCard = relationshipArticle(page, currentRelationshipsSection, primaryGuardianName);
    await managementPrimaryCard.waitFor({ state: "visible" });

    stage = "current_relationship_read";
    assert.equal(await managementPrimaryCard.count(), 1);
    assert.equal(await managementPrimaryCard.getByText("主要聯絡人", { exact: true }).count(), 1);

    stage = "search_validation";
    let validationPosts = 0;
    const searchPath = `/api/v1/students/${studentId}/guardians/search`;
    const searchValidationObserver = async (route: Route) => {
      if (route.request().method() === "POST" && new URL(route.request().url()).pathname === searchPath) {
        validationPosts += 1;
      }
      await route.continue();
    };
    await page.route("**/api/v1/students/*/guardians/search", searchValidationObserver);
    await attachSection.getByLabel("姓名或聯絡線索", { exact: true }).fill("x");
    await attachSection.getByRole("button", { name: "搜尋", exact: true }).click();
    await attachSection.getByRole("alert").getByText("請輸入 2 至 100 個字元後再搜尋。", { exact: true })
      .waitFor({ state: "visible" });
    evidence.validation_posts_zero = validationPosts === 0;
    assert.equal(evidence.validation_posts_zero, true);
    await page.unroute("**/api/v1/students/*/guardians/search", searchValidationObserver);

    stage = "guardian_search";
    await attachSection.getByLabel("姓名或聯絡線索", { exact: true }).fill(SHARED_GUARDIAN.guardianName);
    const searchResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === searchPath);
    await attachSection.getByRole("button", { name: "搜尋", exact: true }).click();
    const searchResponse = await searchResponsePromise;
    evidence.search_status = searchResponse.status();
    assert.equal(evidence.search_status, 200);
    const candidates = readGuardianSearchResponse(await searchResponse.json());
    const sharedCandidate = candidates.find(({ display_name }) => display_name === SHARED_GUARDIAN.guardianName);
    assert.ok(sharedCandidate);
    assert.equal(sharedCandidate.email_hint?.includes("*") ?? false, true);
    assert.equal(JSON.stringify(candidates).includes(SHARED_GUARDIAN.guardianEmail ?? ""), false);
    const sharedCandidateLabel = attachSection.locator("label").filter({
      has: page.getByText(SHARED_GUARDIAN.guardianName, { exact: true }),
    });
    await sharedCandidateLabel.waitFor({ state: "visible" });
    assert.equal(await page.getByText(SHARED_GUARDIAN.guardianEmail ?? "", { exact: true }).count(), 0);
    evidence.masked_candidate_visible = true;

    stage = "explicit_candidate_selection";
    const candidateRadio = sharedCandidateLabel.getByRole("radio");
    assert.equal(await candidateRadio.count(), 1);
    assert.equal(await candidateRadio.isChecked(), false);
    await candidateRadio.focus();
    await page.keyboard.press("Space");
    evidence.candidate_explicitly_selected = await candidateRadio.isChecked();
    assert.equal(evidence.candidate_explicitly_selected, true);
    await attachSection.getByRole("combobox", { name: "與學生關係", exact: true }).selectOption("mother");
    assert.equal(await attachSection.getByRole("checkbox", { name: "法定監護人", exact: true }).isChecked(), true);
    for (const label of ["緊急聯絡人", "帳務聯絡人", "接收通知"] as const) {
      assert.equal(await attachSection.getByRole("checkbox", { name: label, exact: true }).isChecked(), false);
    }

    stage = "idempotency_and_double_submit";
    const attachPath = `/api/v1/students/${studentId}/guardians`;
    const observedKeys: string[] = [];
    const attachRetryInterceptor = async (route: Route) => {
      const request = route.request();
      if (request.method() === "POST" && new URL(request.url()).pathname === attachPath) {
        observedKeys.push(request.headers()["idempotency-key"] ?? "");
        await route.abort("failed");
        return;
      }
      await route.continue();
    };
    await page.route("**/api/v1/students/*/guardians", attachRetryInterceptor);
    const attachButton = attachSection.getByRole("button", { name: "確認關聯為次要監護人", exact: true });
    await attachButton.evaluate((element) => {
      const button = element as HTMLButtonElement;
      button.click();
      button.click();
    });
    await waitUntil(() => observedKeys.length === 1);
    await attachSection.getByRole("alert")
      .filter({ hasText: "關聯結果暫時無法確認，請稍後重試；重試不會重複建立關係。" })
      .waitFor({ state: "visible" });
    evidence.double_submit_single_request = observedKeys.length === 1;
    await attachButton.click();
    await waitUntil(() => observedKeys.length === 2);
    await attachSection.getByRole("alert")
      .filter({ hasText: "關聯結果暫時無法確認，請稍後重試；重試不會重複建立關係。" })
      .waitFor({ state: "visible" });
    evidence.same_retry_key = observedKeys[0] === observedKeys[1] && observedKeys[0] !== "";
    await attachSection.getByRole("checkbox", { name: "接收通知", exact: true }).check();
    await attachButton.click();
    await waitUntil(() => observedKeys.length === 3);
    await attachSection.getByRole("alert")
      .filter({ hasText: "關聯結果暫時無法確認，請稍後重試；重試不會重複建立關係。" })
      .waitFor({ state: "visible" });
    evidence.changed_field_rotated_key = observedKeys[2] !== observedKeys[1] && observedKeys[2] !== "";
    assert.equal(evidence.double_submit_single_request, true);
    assert.equal(evidence.same_retry_key, true);
    assert.equal(evidence.changed_field_rotated_key, true);
    await page.unroute("**/api/v1/students/*/guardians", attachRetryInterceptor);
    observedKeys.fill("[redacted]");

    stage = "attach_command";
    const attachResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === attachPath);
    const attachRefreshPromise = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === attachPath);
    await attachButton.click();
    const attachResponse = await attachResponsePromise;
    evidence.attach_status = attachResponse.status();
    assert.equal(evidence.attach_status, 201);
    const attachedRelationship = readGuardianCommandResponse(await attachResponse.json());
    assert.equal(attachedRelationship.guardian_id, sharedCandidate.id);

    stage = "attach_authority_refresh";
    const attachRefresh = await attachRefreshPromise;
    evidence.attach_refresh_status = attachRefresh.status();
    assert.equal(evidence.attach_refresh_status, 200);

    stage = "attach_feedback";
    await attachSection.getByRole("status")
      .getByText("已關聯次要監護人，列表已重新載入。", { exact: true })
      .waitFor({ state: "visible" });
    evidence.attach_success_visible = true;
    const attachedCard = relationshipArticle(page, currentRelationshipsSection, SHARED_GUARDIAN.guardianName);
    await attachedCard.waitFor({ state: "visible" });
    assert.equal(await attachedCard.getByText("次要聯絡人", { exact: true }).count(), 1);

    stage = "attach_persistence";
    await page.reload({ waitUntil: "domcontentloaded" });
    const persistedAttachedCard = relationshipArticle(page, currentRelationshipsSection, SHARED_GUARDIAN.guardianName);
    await persistedAttachedCard.waitFor({ state: "visible" });
    evidence.attach_refresh_persisted =
      await persistedAttachedCard.count() === 1 &&
      await persistedAttachedCard.getByText("次要聯絡人", { exact: true }).count() === 1;
    assert.equal(evidence.attach_refresh_persisted, true);

    stage = "desktop_viewport";
    await assertViewport(page, "crm02-management-desktop");

    stage = "mobile_viewport";
    await withViewport(page, { width: 390, height: 844 }, () => assertViewport(page, "crm02-management-mobile"));
    evidence.mobile_viewport_passed = true;
    await page.setViewportSize({ width: 1440, height: 900 });

    stage = "stale_concurrency_setup";
    const currentBeforeStale = await readCurrentViaBrowser(page, studentId);
    const primaryBeforeStale = currentBeforeStale.relationships.find(({ is_primary_contact }) => is_primary_contact);
    assert.ok(primaryBeforeStale);
    const concurrentHandoff = await performBrowserMutation(page, {
      path: `/api/v1/students/${studentId}/guardians/primary-handoffs`,
      idempotencyKey: `crm02-concurrent-${randomBytes(8).toString("hex")}`,
      body: {
        successor_guardian_id: sharedCandidate.id,
        expected_primary_record_version: primaryBeforeStale.record_version,
      },
    });
    assert.equal(concurrentHandoff.status, 200);

    stage = "stale_handoff";
    await handoffSection.getByRole("combobox", { name: "新的主要聯絡人", exact: true }).selectOption({ label: SHARED_GUARDIAN.guardianName });
    await handoffSection.getByRole("checkbox", { name: "我已核對交接對象，並確認保留既有歷史與所有監護人資料。", exact: true }).check();
    const staleResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/v1/students/${studentId}/guardians/primary-handoffs`);
    await handoffSection.getByRole("button", { name: "確認交接主要聯絡人", exact: true }).click();
    const staleResponse = await staleResponsePromise;
    evidence.stale_status = staleResponse.status();
    const staleCode = readSafeErrorCode(await staleResponse.json());
    evidence.stale_code = staleCode === "STALE_VERSION" ? "STALE_VERSION" : "OTHER";
    assert.equal(evidence.stale_status, 409);
    assert.equal(evidence.stale_code, "STALE_VERSION");

    stage = "stale_recovery";
    await handoffSection.getByRole("alert")
      .filter({ hasText: "主要聯絡人資料已更新，請依最新列表重新選擇。" })
      .waitFor({ state: "visible" });
    const recoveredPrimaryCard = relationshipArticle(page, currentRelationshipsSection, SHARED_GUARDIAN.guardianName);
    await recoveredPrimaryCard.waitFor({ state: "visible" });
    evidence.stale_recovered =
      await recoveredPrimaryCard.count() === 1 &&
      await recoveredPrimaryCard.getByText("主要聯絡人", { exact: true }).count() === 1;
    assert.equal(evidence.stale_recovered, true);

    stage = "reattach_previous_primary";
    const previousPrimaryCandidate = await searchAndSelectGuardian(page, primaryGuardianName);
    assert.equal(previousPrimaryCandidate.email_hint?.includes("*") ?? false, true);
    assert.equal(JSON.stringify(previousPrimaryCandidate).includes(primaryGuardianEmail), false);
    const reattachResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === attachPath);
    await attachSection.getByRole("button", { name: "確認關聯為次要監護人", exact: true }).click();
    assert.equal((await reattachResponsePromise).status(), 201);
    const reattachedPreviousPrimaryCard = relationshipArticle(page, currentRelationshipsSection, primaryGuardianName);
    await reattachedPreviousPrimaryCard.waitFor({ state: "visible" });
    assert.equal(await reattachedPreviousPrimaryCard.getByText("次要聯絡人", { exact: true }).count(), 1);

    stage = "primary_handoff";
    await handoffSection.getByRole("combobox", { name: "新的主要聯絡人", exact: true }).selectOption({ label: primaryGuardianName });
    await handoffSection.getByRole("checkbox", { name: "我已核對交接對象，並確認保留既有歷史與所有監護人資料。", exact: true }).check();
    const handoffResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/v1/students/${studentId}/guardians/primary-handoffs`);
    await handoffSection.getByRole("button", { name: "確認交接主要聯絡人", exact: true }).click();
    const handoffResponse = await handoffResponsePromise;
    evidence.handoff_status = handoffResponse.status();
    assert.equal(evidence.handoff_status, 200);
    await handoffSection.getByRole("status")
      .getByText("主要聯絡人已完成交接，列表已重新載入。", { exact: true })
      .waitFor({ state: "visible" });
    const newPrimaryCard = relationshipArticle(page, currentRelationshipsSection, primaryGuardianName);
    await newPrimaryCard.waitFor({ state: "visible" });
    evidence.new_primary_visible =
      await newPrimaryCard.count() === 1 &&
      await newPrimaryCard.getByText("主要聯絡人", { exact: true }).count() === 1;
    assert.equal(evidence.new_primary_visible, true);

    stage = "closed_history_aggregate";
    evidence.closed_history_minimum_met = await countClosedRelationships(target, studentId) >= 4;
    assert.equal(evidence.closed_history_minimum_met, true);

    stage = "advisor_relogin_persistence";
    await logout(page);
    await loginAndWaitForWorkspace(page, canonicalBaseUrl, ADVISOR.email, advisorPassword);
    await page.goto(managementUrl);
    const reloginCurrentSection = page.locator('section[aria-labelledby="current-relationships-heading"]');
    const reloginPrimaryCard = relationshipArticle(page, reloginCurrentSection, primaryGuardianName);
    await reloginPrimaryCard.waitFor({ state: "visible" });
    evidence.attach_relogin_persisted =
      await reloginPrimaryCard.count() === 1 &&
      await reloginPrimaryCard.getByText("主要聯絡人", { exact: true }).count() === 1;
    assert.equal(evidence.attach_relogin_persisted, true);

    stage = "desktop_viewport";
    await assertViewport(page, "crm02-final-desktop");
    evidence.desktop_viewport_passed = true;

    stage = "founder_read_only";
    await logout(page);
    await loginAndWaitForWorkspace(page, canonicalBaseUrl, FOUNDER.email, founderPassword);
    const founderResult = await verifyGuardianReadOnlyRole(page, {
      detailUrl,
      managementUrl,
      primaryGuardianName,
      studentId,
      candidateId: sharedCandidate.id,
    });
    evidence.founder_current_readable = founderResult.current_readable;
    evidence.founder_controls_hidden = founderResult.controls_hidden;
    assert.equal(evidence.founder_current_readable, true);
    assert.equal(evidence.founder_controls_hidden, true);

    stage = "founder_direct_forbidden";
    evidence.founder_direct_forbidden = founderResult.direct_forbidden;
    assert.equal(evidence.founder_direct_forbidden, true);

    stage = "admin_read_only";
    await logout(page);
    await loginAndWaitForWorkspace(page, canonicalBaseUrl, ADMIN.email, adminPassword);
    const adminResult = await verifyGuardianReadOnlyRole(page, {
      detailUrl,
      managementUrl,
      primaryGuardianName,
      studentId,
      candidateId: sharedCandidate.id,
    });
    evidence.admin_current_readable = adminResult.current_readable;
    evidence.admin_controls_hidden = adminResult.controls_hidden;
    assert.equal(evidence.admin_current_readable, true);
    assert.equal(evidence.admin_controls_hidden, true);

    stage = "admin_direct_forbidden";
    evidence.admin_direct_forbidden = adminResult.direct_forbidden;
    assert.equal(evidence.admin_direct_forbidden, true);

    stage = "browser_log_safety";
    const sensitiveMarkers = [
      applicationPassword,
      advisorPassword,
      founderPassword,
      adminPassword,
      ADVISOR.email,
      FOUNDER.email,
      ADMIN.email,
      studentName,
      primaryGuardianName,
      primaryGuardianEmail,
      SHARED_GUARDIAN.guardianName,
      SHARED_GUARDIAN.guardianEmail ?? "",
      target.connectionString,
    ].filter(Boolean);
    const fixedSensitiveMarkers = ["postgresql://", "database_url", "tx_session=", "set-cookie"];
    const browserLogs = [...consoleMessages, ...pageErrors];
    evidence.sensitive_log_matches = browserLogs.filter((entry) => {
      const normalized = entry.toLowerCase();
      return sensitiveMarkers.some((marker) => entry.includes(marker)) ||
        fixedSensitiveMarkers.some((marker) => normalized.includes(marker));
    }).length;
    evidence.page_errors = pageErrors.length;
    assert.equal(evidence.sensitive_log_matches, 0);
    assert.equal(evidence.page_errors, 0);

    stage = "complete";
  } catch {
    failureStage = stage;
  } finally {
    stage = "cleanup";
    cleanupEvidence.context_closed = await closeBrowser(context);
    cleanupEvidence.dev_stopped = await stopNextDev(devServer);
    cleanupEvidence.app_directory_removed = await removeDirectory(appDirectory);
    cleanupEvidence.profile_removed = await removeDirectory(profileDirectory);
    cleanupEvidence.container_removed = containerStarted
      ? await removeDockerResource(["rm", "--force", containerName])
      : true;
    cleanupEvidence.volume_removed = secretVolumeCreated
      ? await removeDockerResource(["volume", "rm", "--force", secretVolumeName])
      : true;
  }

  if (!Object.values(cleanupEvidence).every(Boolean)) failureStage = "cleanup";
  if (failureStage) {
    throw new SafeCrm02BrowserGateFailure({
      stage: CRM02_BROWSER_STAGES.includes(failureStage) ? failureStage : "runtime_preflight",
      evidence: Object.freeze({ ...evidence }),
      cleanup: Object.freeze({ ...cleanupEvidence }),
    });
  }
  process.stdout.write(`${JSON.stringify(Object.freeze({
    status: "pass",
    stage: "complete",
    runtime: Object.freeze({
      postgres_major: 17,
      baseline_generated_files: baselineGeneratedFiles,
      seed: "release1_synthetic",
      browser_driver: "playwright-core-1.55.0",
      browser_binary: "system_chrome",
    }),
    evidence: Object.freeze({ ...evidence }),
    cleanup: Object.freeze({ ...cleanupEvidence }),
  }))}\n`);
});

test("CRM-03 maintains Student and Guardian profiles through a real local browser", {
  timeout: 300_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-crm03-browser-pg17-${suffix}`;
  const secretVolumeName = `tianxing-crm03-browser-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const advisorPassword = randomBytes(32).toString("base64url");
  const founderPassword = randomBytes(32).toString("base64url");
  const adminPassword = randomBytes(32).toString("base64url");
  const appDirectory = await mkdtemp(join(tmpdir(), "tianxing-crm03-browser-app-"));
  const profileDirectory = await mkdtemp(join(tmpdir(), "tianxing-crm03-browser-profile-"));
  const evidence: Crm03BrowserEvidence = {
    advisor_entries_visible: false,
    advisor_assignment_fetch_completed: false,
    advisor_assignment_json_parseable: false,
    advisor_assignment_status: null,
    advisor_assignment_exact_case_dto: false,
    founder_entries_visible: false,
    admin_entries_hidden: false,
    admin_auth_status: null,
    admin_auth_json_parseable: false,
    admin_auth_role_exact_admin: false,
    admin_auth_profiles_manage_capability_present: null,
    admin_student_request_started: false,
    admin_student_response_received: false,
    admin_student_response_status: null,
    admin_guardian_request_started: false,
    admin_guardian_response_received: false,
    admin_guardian_response_status: null,
    admin_detail_student_heading_count: null,
    admin_detail_denied_count: null,
    admin_student_edit_button_count: null,
    admin_student_edit_button_visible_count: null,
    admin_guardian_edit_button_count: null,
    admin_guardian_edit_button_visible_count: null,
    keyboard_cancel_restores_focus: false,
    student_validation_zero_patch: false,
    guardian_validation_zero_patch: false,
    synchronous_double_patch_count: null,
    uncertain_retry_same_key: false,
    changed_field_rotated_key: false,
    student_conflict_seed_fetch_completed: false,
    student_conflict_seed_json_parseable: false,
    student_conflict_seed_status: null,
    student_conflict_seed_ack_exact: false,
    student_conflict_submit_status: null,
    student_conflict_submit_code: null,
    student_conflict_alert_count: null,
    student_conflict_alert_visible: false,
    student_patch_status: null,
    student_ack_exact: false,
    student_authoritative_get_status: null,
    student_refresh_persisted: false,
    guardian_stale_status: null,
    guardian_stale_visible: false,
    guardian_stale_recovered: false,
    guardian_patch_status: null,
    guardian_ack_exact: false,
    guardian_authoritative_get_status: null,
    relogin_persisted: false,
    admin_student_status: null,
    admin_guardian_status: null,
    admin_forbidden_codes: false,
    admin_private_echo: null,
    desktop_viewport_passed: false,
    mobile_viewport_passed: false,
    mobile_viewport: emptyCrm03MobileViewportEvidence(),
    page_errors: 0,
    sensitive_log_matches: 0,
  };
  const cleanupEvidence: CleanupEvidence = {
    context_closed: false,
    dev_stopped: false,
    app_directory_removed: false,
    profile_removed: false,
    container_removed: false,
    volume_removed: false,
  };
  const canonicalOriginEvidence: CanonicalOriginEvidence = {
    response_status_307: false,
    location_present: false,
    location_parseable: false,
    pathname_exact: false,
    protocol_http: false,
    hostname_loopback: false,
    port_matches: false,
    credentials_absent: false,
    search_absent: false,
    hash_absent: false,
  };

  let stage: Crm03BrowserStage = "runtime_preflight";
  let containerStarted = false;
  let secretVolumeCreated = false;
  let devServer: ChildProcess | undefined;
  let context: BrowserContext | undefined;
  let failureStage: Crm03BrowserStage | undefined;
  let baselineGeneratedFiles = 0;

  try {
    await access(DOCKER, constants.X_OK);
    await access(CHROME, constants.X_OK);

    stage = "postgres_setup";
    await runDocker(["image", "inspect", POSTGRES_IMAGE]);
    await runDocker(["volume", "create", secretVolumeName]);
    secretVolumeCreated = true;
    await runDocker([
      "run", "--rm", "--interactive", "--pull=never",
      "--volume", `${secretVolumeName}:/run/secrets`,
      POSTGRES_IMAGE, "/bin/sh", "-c",
      "umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password",
    ], applicationPassword);
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", containerName,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env", "POSTGRES_DB=tianxing",
      "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/local_postgres_password",
      "--volume", `${secretVolumeName}:/run/secrets:ro`,
      "--volume", `${resolve("infra/local/postgres/init")}:/docker-entrypoint-initdb.d:ro`,
      "--volume", `${resolve("infra/local/postgres/healthcheck.sh")}:/usr/local/bin/tianxing-postgres-healthcheck:ro`,
      "--publish", "127.0.0.1::5432",
      POSTGRES_IMAGE,
    ]);
    containerStarted = true;
    await waitForPostgres(containerName);
    const databasePort = readLoopbackPort((await runDocker(["port", containerName, "5432/tcp"])).stdout);
    const target = localTarget(databasePort, applicationPassword);

    stage = "baseline_seed";
    const build = await verifyCommittedOneRoleBaseline();
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply",
      target,
      build,
      dependencies: baselineDependencies(target),
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.generated_files, 31);
    baselineGeneratedFiles = baseline.generated_files;
    const seed = await seedNeonTestRelease1(target, "apply");
    assert.equal(seed.status, "pass");
    assert.equal(seed.baseline.id, ONE_ROLE_BASELINE_ID);

    stage = "identity_provision";
    assert.equal(await provision(target, ADVISOR.email, advisorPassword), "created");
    assert.equal(await provision(target, FOUNDER.email, founderPassword), "created");
    assert.equal(await provision(target, ADMIN.email, adminPassword), "created");

    stage = "next_dev";
    await populateIsolatedApp(appDirectory);
    const nextPort = await reserveLoopbackPort();
    devServer = startNextDev(appDirectory, nextPort, target.connectionString);
    const listenUrl = `http://127.0.0.1:${nextPort}`;
    await waitForNextDev(listenUrl, devServer);

    stage = "canonical_origin_discovery";
    const canonicalBaseUrl = await discoverCanonicalBaseUrl(
      listenUrl,
      nextPort,
      canonicalOriginEvidence,
    );

    stage = "chrome_launch";
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: CHROME,
      headless: true,
      viewport: { width: 1440, height: 900 },
      locale: "zh-HK",
      args: ["--disable-background-networking", "--no-first-run", "--no-default-browser-check"],
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(30_000);
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => consoleMessages.push(`${message.type()}:${message.text()}`));
    page.on("pageerror", (error) => pageErrors.push(error.message));

    stage = "advisor_login";
    await loginAndWaitForWorkspace(page, canonicalBaseUrl, ADVISOR.email, advisorPassword);

    stage = "crm01_student_create";
    await page.goto(`${canonicalBaseUrl}/students/new`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "建立學生", exact: true }).waitFor({ state: "visible" });
    const token = randomBytes(5).toString("hex");
    const studentName = `CRM03 Student ${token}`;
    const guardianName = `CRM03 Guardian ${token}`;
    const guardianEmail = `crm03-guardian-${token}@example.invalid`;
    const updatedStudentName = `CRM03 Updated Student ${token}`;
    const updatedStudentEmail = `crm03-student-${token}@example.invalid`;
    const conflictStudentName = `CRM03 Conflict Student ${token}`;
    const concurrentGuardianName = `CRM03 Concurrent Guardian ${token}`;
    const updatedGuardianName = `CRM03 Updated Guardian ${token}`;
    const updatedGuardianEmail = `crm03-updated-${token}@example.invalid`;
    await fillValidDraft(page, { studentName, guardianName, guardianEmail });
    await Promise.all([
      page.waitForURL(/\/students\/[0-9a-f-]{36}$/i),
      page.getByRole("button", { name: "建立學生", exact: true }).click(),
    ]);
    const detailUrl = page.url();
    const studentId = new URL(detailUrl).pathname.split("/").at(-1) ?? "";
    assert.match(studentId, /^[0-9a-f-]{36}$/i);

    stage = "advisor_assignment";
    const assignment = await createAdvisorAssignment(page, {
      studentId,
      intakeYear: 2037,
      admissionType: "transfer",
      primaryRoleBindingId: ADVISOR.roleBindingId,
      manifestId: NEON_TEST_MANIFEST_ID,
      idempotencyKey: `crm03-advisor-assignment:${randomBytes(12).toString("hex")}`,
    });
    evidence.advisor_assignment_fetch_completed = assignment.fetch_completed;
    evidence.advisor_assignment_json_parseable = assignment.json_parseable;
    evidence.advisor_assignment_status = assignment.status;
    evidence.advisor_assignment_exact_case_dto = assignment.exact_case_dto;
    assert.equal(evidence.advisor_assignment_fetch_completed, true);
    assert.equal(evidence.advisor_assignment_json_parseable, true);
    assert.equal(evidence.advisor_assignment_status, 200);
    assert.equal(evidence.advisor_assignment_exact_case_dto, true);

    let snapshot = await readBrowserProfileSnapshot(page, studentId);

    stage = "profile_entries";
    await page.reload({ waitUntil: "domcontentloaded" });
    const studentEditButton = page.getByRole("button", { name: "編輯學生資料", exact: true });
    await studentEditButton.waitFor({ state: "visible" });
    const initialGuardianCard = relationshipArticle(
      page,
      page.locator('section[aria-labelledby="student-guardian-heading"]'),
      guardianName,
    );
    await initialGuardianCard.waitFor({ state: "visible" });
    const initialGuardianEditButton = initialGuardianCard.getByRole("button", {
      name: "編輯監護人資料",
      exact: true,
    });
    await initialGuardianEditButton.waitFor({ state: "visible" });
    evidence.advisor_entries_visible =
      await studentEditButton.count() === 1 && await initialGuardianEditButton.count() === 1;
    assert.equal(evidence.advisor_entries_visible, true);

    stage = "keyboard_focus";
    await studentEditButton.focus();
    await page.keyboard.press("Enter");
    const studentForm = page.locator('form[aria-label="編輯學生基本資料"]');
    await studentForm.waitFor({ state: "visible" });
    await studentForm.getByRole("button", { name: "取消", exact: true }).click();
    await studentForm.waitFor({ state: "hidden" });
    evidence.keyboard_cancel_restores_focus = await studentEditButton.evaluate(
      (element) => element === document.activeElement,
    );
    assert.equal(evidence.keyboard_cancel_restores_focus, true);

    stage = "desktop_viewport";
    await assertViewport(page, "crm03-detail-desktop");
    evidence.desktop_viewport_passed = true;

    stage = "student_validation";
    await studentEditButton.click();
    await studentForm.waitFor({ state: "visible" });
    let studentValidationPatches = 0;
    const studentPath = `/api/v1/students/${studentId}`;
    const studentValidationObserver = async (route: Route) => {
      if (route.request().method() === "PATCH" &&
          new URL(route.request().url()).pathname === studentPath) studentValidationPatches += 1;
      await route.continue();
    };
    await page.route("**/api/v1/students/*", studentValidationObserver);
    const studentNameInput = studentForm.getByRole("textbox", { name: "學生姓名", exact: true });
    await studentNameInput.fill("");
    await studentForm.getByRole("button", { name: "保存學生資料", exact: true }).click();
    await studentForm.getByRole("alert").filter({ hasText: "學生姓名必須為 1 至 512 個字元。" })
      .waitFor({ state: "visible" });
    evidence.student_validation_zero_patch = studentValidationPatches === 0;
    assert.equal(evidence.student_validation_zero_patch, true);
    await page.unroute("**/api/v1/students/*", studentValidationObserver);

    stage = "student_idempotency";
    await studentNameInput.fill(updatedStudentName);
    await studentForm.getByLabel("學生 Email", { exact: true }).fill(updatedStudentEmail);
    const studentSave = studentForm.getByRole("button", { name: "保存學生資料", exact: true });
    const observedKeys: string[] = [];
    const studentRetryInterceptor = async (route: Route) => {
      const request = route.request();
      if (request.method() === "PATCH" && new URL(request.url()).pathname === studentPath) {
        observedKeys.push(request.headers()["idempotency-key"] ?? "");
        await route.abort("failed");
        return;
      }
      await route.continue();
    };
    await page.route("**/api/v1/students/*", studentRetryInterceptor);
    await studentSave.evaluate((element) => {
      const button = element as HTMLButtonElement;
      button.click();
      button.click();
    });
    await waitUntil(() => observedKeys.length === 1);
    await studentForm.getByRole("alert").filter({ hasText: "資料服務暫時不可用" })
      .waitFor({ state: "visible" });
    evidence.synchronous_double_patch_count = observedKeys.length;
    await studentSave.click();
    await waitUntil(() => observedKeys.length === 2);
    await studentForm.getByRole("alert").filter({ hasText: "資料服務暫時不可用" })
      .waitFor({ state: "visible" });
    evidence.uncertain_retry_same_key = observedKeys[0] !== "" && observedKeys[0] === observedKeys[1];
    await studentForm.getByLabel("學生電話", { exact: true }).fill("+852 5555 0103");
    await studentSave.click();
    await waitUntil(() => observedKeys.length === 3);
    await studentForm.getByRole("alert").filter({ hasText: "資料服務暫時不可用" })
      .waitFor({ state: "visible" });
    evidence.changed_field_rotated_key = observedKeys[2] !== "" && observedKeys[2] !== observedKeys[1];
    assert.equal(evidence.synchronous_double_patch_count, 1);
    assert.equal(evidence.uncertain_retry_same_key, true);
    assert.equal(evidence.changed_field_rotated_key, true);
    await page.unroute("**/api/v1/students/*", studentRetryInterceptor);

    stage = "student_conflict_seed";
    const conflictSeed = await performProfilePatch(page, {
      path: studentPath,
      idempotencyKey: observedKeys[2]!,
      body: {
        display_name: conflictStudentName,
        date_of_birth: "2013-06-18",
        contact_email: updatedStudentEmail,
        contact_phone: null,
        expected_record_version: snapshot.studentVersion,
      },
      acknowledgement: "student",
      expectedId: studentId,
    });
    evidence.student_conflict_seed_fetch_completed = conflictSeed.fetch_completed;
    evidence.student_conflict_seed_json_parseable = conflictSeed.json_parseable;
    evidence.student_conflict_seed_status = conflictSeed.status;
    evidence.student_conflict_seed_ack_exact = conflictSeed.ack_exact;
    assert.equal(evidence.student_conflict_seed_fetch_completed, true);
    assert.equal(evidence.student_conflict_seed_json_parseable, true);
    assert.equal(evidence.student_conflict_seed_status, 200);
    assert.equal(evidence.student_conflict_seed_ack_exact, true);

    stage = "student_conflict_submit";
    const conflictResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === studentPath);
    await studentSave.click();
    const conflictResponse = await conflictResponsePromise;
    evidence.student_conflict_submit_status = conflictResponse.status();
    try {
      const payload = await conflictResponse.json() as {
        readonly error?: { readonly code?: unknown };
      };
      evidence.student_conflict_submit_code = payload.error?.code === "CONFLICT"
        ? "CONFLICT"
        : payload.error?.code === "STALE_VERSION"
          ? "STALE_VERSION"
          : typeof payload.error?.code === "string" ? "OTHER" : null;
    } catch {
      evidence.student_conflict_submit_code = null;
    }
    assert.equal(evidence.student_conflict_submit_status, 409);
    assert.equal(evidence.student_conflict_submit_code, "CONFLICT");

    stage = "student_conflict_feedback";
    const conflictAlert = studentForm.getByRole("alert")
      .filter({ hasText: "這次保存與先前操作衝突，請修改資料後再提交。" });
    await conflictAlert.waitFor({ state: "visible" });
    evidence.student_conflict_alert_count = await conflictAlert.count();
    evidence.student_conflict_alert_visible = await conflictAlert.isVisible();
    assert.equal(evidence.student_conflict_alert_count, 1);
    assert.equal(evidence.student_conflict_alert_visible, true);
    observedKeys.fill("[redacted]");

    stage = "student_update";
    await page.reload({ waitUntil: "domcontentloaded" });
    snapshot = await readBrowserProfileSnapshot(page, studentId);
    await page.getByRole("button", { name: "編輯學生資料", exact: true }).click();
    const refreshedStudentForm = page.locator('form[aria-label="編輯學生基本資料"]');
    await refreshedStudentForm.waitFor({ state: "visible" });
    await refreshedStudentForm.getByRole("textbox", { name: "學生姓名", exact: true })
      .fill(updatedStudentName);
    await refreshedStudentForm.getByLabel("學生 Email", { exact: true }).fill(updatedStudentEmail);
    const studentPatchPromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === studentPath);
    const studentRefreshPromise = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === studentPath);
    await refreshedStudentForm.getByRole("button", { name: "保存學生資料", exact: true }).click();
    const studentPatch = await studentPatchPromise;
    evidence.student_patch_status = studentPatch.status();
    evidence.student_ack_exact = isExactProfileAcknowledgement(
      await studentPatch.json(),
      "student",
      studentId,
    );
    const studentRefresh = await studentRefreshPromise;
    evidence.student_authoritative_get_status = studentRefresh.status();
    assert.equal(evidence.student_patch_status, 200);
    assert.equal(evidence.student_ack_exact, true);
    assert.equal(evidence.student_authoritative_get_status, 200);
    await page.getByRole("status").getByText("學生資料已保存。", { exact: true })
      .waitFor({ state: "visible" });
    await page.getByRole("heading", { name: updatedStudentName, exact: true, level: 2 })
      .waitFor({ state: "visible" });

    stage = "student_refresh";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: updatedStudentName, exact: true, level: 2 })
      .waitFor({ state: "visible" });
    evidence.student_refresh_persisted = true;
    snapshot = await readBrowserProfileSnapshot(page, studentId);

    stage = "guardian_validation";
    const guardianSection = page.locator('section[aria-labelledby="student-guardian-heading"]');
    let guardianCard = relationshipArticle(page, guardianSection, guardianName);
    await guardianCard.waitFor({ state: "visible" });
    await guardianCard.getByRole("button", { name: "編輯監護人資料", exact: true }).click();
    let guardianForm = guardianCard.locator('form[aria-label="編輯監護人基本資料"]');
    await guardianForm.waitFor({ state: "visible" });
    let guardianValidationPatches = 0;
    const guardianPath = `/api/v1/guardians/${snapshot.guardianId}`;
    const guardianValidationObserver = async (route: Route) => {
      if (route.request().method() === "PATCH" &&
          new URL(route.request().url()).pathname === guardianPath) guardianValidationPatches += 1;
      await route.continue();
    };
    await page.route("**/api/v1/guardians/*", guardianValidationObserver);
    await guardianForm.getByLabel("監護人 Email", { exact: true }).fill("");
    await guardianForm.getByLabel("監護人電話", { exact: true }).fill("");
    await guardianForm.getByRole("button", { name: "保存監護人資料", exact: true }).click();
    const contactAlert = guardianForm.getByRole("alert")
      .filter({ hasText: "監護人 Email 和電話至少填寫一項。" });
    await contactAlert.waitFor({ state: "visible" });
    assert.equal(await contactAlert.count(), 1);
    evidence.guardian_validation_zero_patch = guardianValidationPatches === 0;
    assert.equal(evidence.guardian_validation_zero_patch, true);
    await page.unroute("**/api/v1/guardians/*", guardianValidationObserver);

    await guardianForm.getByRole("textbox", { name: "監護人姓名", exact: true })
      .fill(updatedGuardianName);
    await guardianForm.getByLabel("監護人 Email", { exact: true }).fill(updatedGuardianEmail);

    stage = "guardian_stale_setup";
    const staleSeed = await performProfilePatch(page, {
      path: guardianPath,
      idempotencyKey: `crm03-stale-seed:${randomBytes(12).toString("hex")}`,
      body: {
        display_name: concurrentGuardianName,
        email: guardianEmail,
        phone: null,
        expected_record_version: snapshot.guardianVersion,
      },
      acknowledgement: "guardian",
      expectedId: snapshot.guardianId,
    });
    assert.equal(staleSeed.status, 200);
    assert.equal(staleSeed.ack_exact, true);

    stage = "guardian_stale_feedback";
    const staleResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === guardianPath);
    await guardianForm.getByRole("button", { name: "保存監護人資料", exact: true }).click();
    const staleResponse = await staleResponsePromise;
    evidence.guardian_stale_status = staleResponse.status();
    assert.equal(evidence.guardian_stale_status, 409);
    const staleAlert = guardianForm.getByRole("alert")
      .filter({ hasText: "這筆資料已被更新。請重新載入最新資料後再編輯。" });
    await staleAlert.waitFor({ state: "visible" });
    evidence.guardian_stale_visible = true;

    stage = "guardian_stale_recovery";
    const staleRefreshPromise = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === studentPath);
    await staleAlert.getByRole("button", { name: "重新載入最新資料", exact: true }).click();
    assert.equal((await staleRefreshPromise).status(), 200);
    guardianCard = relationshipArticle(page, guardianSection, concurrentGuardianName);
    await guardianCard.waitFor({ state: "visible" });
    evidence.guardian_stale_recovered = true;

    stage = "guardian_update";
    await guardianCard.getByRole("button", { name: "編輯監護人資料", exact: true }).click();
    guardianForm = guardianCard.locator('form[aria-label="編輯監護人基本資料"]');
    await guardianForm.waitFor({ state: "visible" });
    await guardianForm.getByRole("textbox", { name: "監護人姓名", exact: true })
      .fill(updatedGuardianName);
    await guardianForm.getByLabel("監護人 Email", { exact: true }).fill(updatedGuardianEmail);
    const guardianPatchPromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === guardianPath);
    const guardianRefreshPromise = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === studentPath);
    await guardianForm.getByRole("button", { name: "保存監護人資料", exact: true }).click();
    const guardianPatch = await guardianPatchPromise;
    evidence.guardian_patch_status = guardianPatch.status();
    evidence.guardian_ack_exact = isExactProfileAcknowledgement(
      await guardianPatch.json(),
      "guardian",
      snapshot.guardianId,
    );
    evidence.guardian_authoritative_get_status = (await guardianRefreshPromise).status();
    assert.equal(evidence.guardian_patch_status, 200);
    assert.equal(evidence.guardian_ack_exact, true);
    assert.equal(evidence.guardian_authoritative_get_status, 200);
    await page.getByRole("status").getByText("監護人資料已保存。", { exact: true })
      .waitFor({ state: "visible" });
    await relationshipArticle(page, guardianSection, updatedGuardianName).waitFor({ state: "visible" });

    stage = "relogin_persistence";
    await logout(page);
    await loginAndWaitForWorkspace(page, canonicalBaseUrl, ADVISOR.email, advisorPassword);
    await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: updatedStudentName, exact: true, level: 2 })
      .waitFor({ state: "visible" });
    await relationshipArticle(page, guardianSection, updatedGuardianName).waitFor({ state: "visible" });
    evidence.relogin_persisted = true;
    snapshot = await readBrowserProfileSnapshot(page, studentId);

    stage = "founder_allowed";
    await logout(page);
    await loginAndWaitForWorkspace(page, canonicalBaseUrl, FOUNDER.email, founderPassword);
    await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
    const founderGuardianCard = relationshipArticle(page, guardianSection, updatedGuardianName);
    await founderGuardianCard.waitFor({ state: "visible" });
    evidence.founder_entries_visible =
      await page.getByRole("button", { name: "編輯學生資料", exact: true }).count() === 1 &&
      await founderGuardianCard.getByRole("button", { name: "編輯監護人資料", exact: true }).count() === 1;
    assert.equal(evidence.founder_entries_visible, true);

    stage = "admin_login_contract";
    await logout(page);
    await loginAndWaitForWorkspace(page, canonicalBaseUrl, ADMIN.email, adminPassword);
    const adminAccess = await readAdminAccessContract(page);
    evidence.admin_auth_status = adminAccess.status;
    evidence.admin_auth_json_parseable = adminAccess.json_parseable;
    evidence.admin_auth_role_exact_admin = adminAccess.role_exact_admin;
    evidence.admin_auth_profiles_manage_capability_present =
      adminAccess.profiles_manage_capability_present;
    assert.equal(evidence.admin_auth_status, 200);
    assert.equal(evidence.admin_auth_json_parseable, true);
    assert.equal(evidence.admin_auth_role_exact_admin, true);
    assert.equal(evidence.admin_auth_profiles_manage_capability_present, false);

    stage = "admin_detail_requests";
    const guardianRelationshipsPath = `/api/v1/students/${studentId}/guardians`;
    const observeAdminDetailRequest = (request: PlaywrightRequest) => {
      if (request.method() !== "GET") return;
      const pathname = new URL(request.url()).pathname;
      if (pathname === studentPath) evidence.admin_student_request_started = true;
      if (pathname === guardianRelationshipsPath) evidence.admin_guardian_request_started = true;
    };
    const observeAdminDetailResponse = (response: PlaywrightResponse) => {
      if (response.request().method() !== "GET") return;
      const pathname = new URL(response.url()).pathname;
      if (pathname === studentPath) {
        evidence.admin_student_response_received = true;
        evidence.admin_student_response_status = response.status();
      }
      if (pathname === guardianRelationshipsPath) {
        evidence.admin_guardian_response_received = true;
        evidence.admin_guardian_response_status = response.status();
      }
    };
    page.on("request", observeAdminDetailRequest);
    page.on("response", observeAdminDetailResponse);
    await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
    const adminStudentHeading = page.getByRole("heading", {
      name: updatedStudentName,
      exact: true,
      level: 2,
    });
    const adminDeniedState = page.getByText("無法查看學生資料", { exact: true });
    await Promise.race([
      adminStudentHeading.waitFor({ state: "visible" }),
      adminDeniedState.waitFor({ state: "visible" }),
    ]);
    page.off("request", observeAdminDetailRequest);
    page.off("response", observeAdminDetailResponse);
    evidence.admin_detail_student_heading_count = await adminStudentHeading.count();
    evidence.admin_detail_denied_count = await adminDeniedState.count();
    assert.equal(evidence.admin_student_request_started, true);
    assert.equal(evidence.admin_student_response_received, true);
    assert.equal(evidence.admin_student_response_status, 200);
    assert.equal(evidence.admin_guardian_request_started, true);
    assert.equal(evidence.admin_guardian_response_received, true);
    assert.equal(evidence.admin_guardian_response_status, 200);

    stage = "admin_detail_ready";
    assert.equal(evidence.admin_detail_student_heading_count, 1);
    assert.equal(evidence.admin_detail_denied_count, 0);

    stage = "admin_entries_hidden";
    const adminStudentEditButton = page.getByRole("button", {
      name: "編輯學生資料",
      exact: true,
    });
    const adminGuardianEditButton = page.getByRole("button", {
      name: "編輯監護人資料",
      exact: true,
    });
    evidence.admin_student_edit_button_count = await adminStudentEditButton.count();
    evidence.admin_student_edit_button_visible_count =
      await visibleLocatorCount(adminStudentEditButton);
    evidence.admin_guardian_edit_button_count = await adminGuardianEditButton.count();
    evidence.admin_guardian_edit_button_visible_count =
      await visibleLocatorCount(adminGuardianEditButton);
    evidence.admin_entries_hidden =
      evidence.admin_student_edit_button_count === 0 &&
      evidence.admin_student_edit_button_visible_count === 0 &&
      evidence.admin_guardian_edit_button_count === 0 &&
      evidence.admin_guardian_edit_button_visible_count === 0;
    assert.equal(evidence.admin_entries_hidden, true);

    stage = "admin_direct_denied";
    const denied = await performDeniedProfilePatches(page, {
      studentId,
      guardianId: snapshot.guardianId,
      studentVersion: snapshot.studentVersion,
      guardianVersion: snapshot.guardianVersion,
      studentMarker: updatedStudentName,
      guardianMarker: updatedGuardianEmail,
    });
    evidence.admin_student_status = denied.student_status;
    evidence.admin_guardian_status = denied.guardian_status;
    evidence.admin_forbidden_codes = denied.forbidden_codes;
    evidence.admin_private_echo = denied.private_echo;
    assert.equal(evidence.admin_student_status, 403);
    assert.equal(evidence.admin_guardian_status, 403);
    assert.equal(evidence.admin_forbidden_codes, true);
    assert.equal(evidence.admin_private_echo, false);

    await logout(page);
    await loginAndWaitForWorkspace(page, canonicalBaseUrl, ADVISOR.email, advisorPassword);
    await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: updatedStudentName, exact: true, level: 2 })
      .waitFor({ state: "visible" });

    stage = "mobile_editor_ready";
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileGuardianCard = relationshipArticle(page, guardianSection, updatedGuardianName);
    await mobileGuardianCard.waitFor({ state: "visible" });
    await mobileGuardianCard.getByRole("button", { name: "編輯監護人資料", exact: true }).click();
    await mobileGuardianCard.locator('form[aria-label="編輯監護人基本資料"]')
      .waitFor({ state: "visible" });

    stage = "mobile_viewport_measurement";
    evidence.mobile_viewport = await measureCrm03MobileViewport(page);

    stage = "mobile_viewport_assertion";
    assert.equal(evidence.mobile_viewport.page_horizontal_overflow, 0);
    assert.equal(evidence.mobile_viewport.out_of_bounds_controls, 0);
    assert.equal(evidence.mobile_viewport.overlapping_controls, 0);
    assert.equal(evidence.mobile_viewport.clipped_text, 0);
    evidence.mobile_viewport_passed = true;

    stage = "browser_log_safety";
    const sensitiveMarkers = [
      applicationPassword,
      advisorPassword,
      founderPassword,
      adminPassword,
      ADVISOR.email,
      FOUNDER.email,
      ADMIN.email,
      studentName,
      guardianName,
      guardianEmail,
      updatedStudentName,
      updatedStudentEmail,
      conflictStudentName,
      concurrentGuardianName,
      updatedGuardianName,
      updatedGuardianEmail,
      target.connectionString,
    ];
    const fixedSensitiveMarkers = ["postgresql://", "database_url", "tx_session=", "set-cookie"];
    const browserLogs = [...consoleMessages, ...pageErrors];
    evidence.sensitive_log_matches = browserLogs.filter((entry) => {
      const normalized = entry.toLowerCase();
      return sensitiveMarkers.some((marker) => entry.includes(marker)) ||
        fixedSensitiveMarkers.some((marker) => normalized.includes(marker));
    }).length;
    evidence.page_errors = pageErrors.length;
    assert.equal(evidence.sensitive_log_matches, 0);
    assert.equal(evidence.page_errors, 0);

    stage = "complete";
  } catch {
    failureStage = stage;
  } finally {
    stage = "cleanup";
    cleanupEvidence.context_closed = await closeBrowser(context);
    cleanupEvidence.dev_stopped = await stopNextDev(devServer);
    cleanupEvidence.app_directory_removed = await removeDirectory(appDirectory);
    cleanupEvidence.profile_removed = await removeDirectory(profileDirectory);
    cleanupEvidence.container_removed = containerStarted
      ? await removeDockerResource(["rm", "--force", containerName])
      : true;
    cleanupEvidence.volume_removed = secretVolumeCreated
      ? await removeDockerResource(["volume", "rm", "--force", secretVolumeName])
      : true;
  }

  if (!Object.values(cleanupEvidence).every(Boolean)) failureStage = "cleanup";
  if (failureStage) {
    throw new SafeCrm03BrowserGateFailure({
      stage: CRM03_BROWSER_STAGES.includes(failureStage) ? failureStage : "runtime_preflight",
      evidence: Object.freeze({ ...evidence }),
      cleanup: Object.freeze({ ...cleanupEvidence }),
    });
  }
  process.stdout.write(`${JSON.stringify(Object.freeze({
    status: "pass",
    stage: "complete",
    runtime: Object.freeze({
      postgres_major: 17,
      baseline_generated_files: baselineGeneratedFiles,
      seed: "release1_synthetic",
      browser_driver: "playwright-core-1.55.0",
      browser_binary: "system_chrome",
    }),
    evidence: Object.freeze({ ...evidence }),
    cleanup: Object.freeze({ ...cleanupEvidence }),
  }))}\n`);
});

interface BrowserProfileSnapshot {
  readonly studentVersion: number;
  readonly guardianId: string;
  readonly guardianVersion: number;
}

async function readAdminAccessContract(page: Page): Promise<Readonly<{
  status: number | null;
  json_parseable: boolean;
  role_exact_admin: boolean;
  profiles_manage_capability_present: boolean | null;
}>> {
  return page.evaluate(async () => {
    let response: Response;
    try {
      response = await fetch("/api/v1/auth/me", {
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      return {
        status: null,
        json_parseable: false,
        role_exact_admin: false,
        profiles_manage_capability_present: null,
      };
    }
    try {
      const payload = await response.json() as {
        readonly data?: {
          readonly role?: unknown;
          readonly capabilities?: unknown;
        };
      };
      const capabilities = payload.data?.capabilities;
      return {
        status: response.status,
        json_parseable: true,
        role_exact_admin: payload.data?.role === "admin",
        profiles_manage_capability_present: Array.isArray(capabilities)
          ? capabilities.includes("students.profiles.manage")
          : null,
      };
    } catch {
      return {
        status: response.status,
        json_parseable: false,
        role_exact_admin: false,
        profiles_manage_capability_present: null,
      };
    }
  });
}

async function visibleLocatorCount(locator: Locator): Promise<number> {
  let visible = 0;
  for (let index = 0; index < await locator.count(); index += 1) {
    if (await locator.nth(index).isVisible()) visible += 1;
  }
  return visible;
}

async function createAdvisorAssignment(page: Page, input: {
  readonly studentId: string;
  readonly intakeYear: number;
  readonly admissionType: "transfer" | "s1_admission";
  readonly primaryRoleBindingId: string;
  readonly manifestId: string;
  readonly idempotencyKey: string;
}): Promise<Readonly<{
  fetch_completed: boolean;
  json_parseable: boolean;
  status: number | null;
  exact_case_dto: boolean;
}>> {
  return page.evaluate(async (value) => {
    let response: Response;
    try {
      response = await fetch("/api/v1/cases", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": value.idempotencyKey,
        },
        body: JSON.stringify({
          student_id: value.studentId,
          intake_year: value.intakeYear,
          admission_type: value.admissionType,
          primary_role_binding_id: value.primaryRoleBindingId,
          manifest_id: value.manifestId,
        }),
      });
    } catch {
      return {
        fetch_completed: false,
        json_parseable: false,
        status: null,
        exact_case_dto: false,
      };
    }
    let jsonParseable = false;
    let exactCaseDto = false;
    try {
      const payload = await response.json() as {
        readonly data?: Readonly<Record<string, unknown>>;
      };
      jsonParseable = true;
      const data = payload.data;
      const candidate = data?.case;
      if (data && Object.keys(data).length === 1 && candidate &&
          typeof candidate === "object" && !Array.isArray(candidate)) {
        const record = candidate as Readonly<Record<string, unknown>>;
        const keys = Object.keys(record).sort();
        const expectedKeys = [
          "admissionType",
          "assessmentId",
          "caseNumber",
          "id",
          "intakeYear",
          "manifestId",
          "recordVersion",
          "stage",
          "studentId",
        ];
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        exactCaseDto = keys.length === expectedKeys.length &&
          keys.every((key, index) => key === expectedKeys[index]) &&
          typeof record.id === "string" && uuid.test(record.id) &&
          typeof record.assessmentId === "string" && uuid.test(record.assessmentId) &&
          typeof record.caseNumber === "string" && record.caseNumber.trim().length > 0 &&
          record.studentId === value.studentId &&
          record.intakeYear === value.intakeYear &&
          record.admissionType === value.admissionType &&
          record.stage === "signed" &&
          record.manifestId === value.manifestId &&
          record.recordVersion === 1;
      }
    } catch {}
    return {
      fetch_completed: true,
      json_parseable: jsonParseable,
      status: response.status,
      exact_case_dto: exactCaseDto,
    };
  }, input);
}

async function readBrowserProfileSnapshot(
  page: Page,
  studentId: string,
): Promise<BrowserProfileSnapshot> {
  const result = await page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: "same-origin" });
    const payload = await response.json() as unknown;
    return { status: response.status, payload };
  }, `/api/v1/students/${studentId}`);
  assert.equal(result.status, 200);
  const root = requiredBrowserRecord(result.payload);
  const data = requiredBrowserRecord(root.data);
  const student = requiredBrowserRecord(data.student);
  assert.equal(student.id, studentId);
  assert.equal(Number.isSafeInteger(student.recordVersion), true);
  assert.equal(Array.isArray(student.guardians), true);
  const guardians = student.guardians as readonly unknown[];
  assert.equal(guardians.length, 1);
  const guardian = requiredBrowserRecord(guardians[0]);
  assert.equal(typeof guardian.id, "string");
  assert.equal(Number.isSafeInteger(guardian.recordVersion), true);
  return Object.freeze({
    studentVersion: student.recordVersion as number,
    guardianId: guardian.id as string,
    guardianVersion: guardian.recordVersion as number,
  });
}

async function performProfilePatch(page: Page, input: {
  readonly path: string;
  readonly idempotencyKey: string;
  readonly body: Readonly<Record<string, string | number | null>>;
  readonly acknowledgement: "student" | "guardian";
  readonly expectedId: string;
}): Promise<Readonly<{
  fetch_completed: boolean;
  json_parseable: boolean;
  status: number | null;
  ack_exact: boolean;
}>> {
  return page.evaluate(async ({ path, idempotencyKey, body, acknowledgement, expectedId }) => {
    let response: Response;
    try {
      response = await fetch(path, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
      });
    } catch {
      return {
        fetch_completed: false,
        json_parseable: false,
        status: null,
        ack_exact: false,
      };
    }
    let ackExact = false;
    let jsonParseable = false;
    try {
      const payload = await response.json() as {
        readonly data?: Readonly<Record<string, unknown>>;
      };
      jsonParseable = true;
      const data = payload.data;
      const acknowledgementValue = data?.[acknowledgement];
      if (acknowledgementValue && typeof acknowledgementValue === "object" &&
          !Array.isArray(acknowledgementValue)) {
        const record = acknowledgementValue as Readonly<Record<string, unknown>>;
        const keys = Object.keys(record).sort();
        ackExact = keys.length === 3 &&
          keys[0] === "id" && keys[1] === "record_version" && keys[2] === "updated_at" &&
          record.id === expectedId && Number.isSafeInteger(record.record_version) &&
          Number(record.record_version) > 0 && typeof record.updated_at === "string" &&
          !Number.isNaN(Date.parse(record.updated_at));
      }
    } catch {}
    return {
      fetch_completed: true,
      json_parseable: jsonParseable,
      status: response.status,
      ack_exact: ackExact,
    };
  }, input);
}

function isExactProfileAcknowledgement(
  value: unknown,
  acknowledgement: "student" | "guardian",
  expectedId: string,
): boolean {
  try {
    const root = requiredBrowserRecord(value);
    const data = requiredBrowserRecord(root.data);
    if (Object.keys(data).length !== 1 || !Object.hasOwn(data, acknowledgement)) return false;
    const record = requiredBrowserRecord(data[acknowledgement]);
    const keys = Object.keys(record).sort();
    return keys.length === 3 &&
      keys[0] === "id" && keys[1] === "record_version" && keys[2] === "updated_at" &&
      record.id === expectedId && Number.isSafeInteger(record.record_version) &&
      Number(record.record_version) > 0 && typeof record.updated_at === "string" &&
      !Number.isNaN(Date.parse(record.updated_at));
  } catch {
    return false;
  }
}

async function performDeniedProfilePatches(page: Page, input: {
  readonly studentId: string;
  readonly guardianId: string;
  readonly studentVersion: number;
  readonly guardianVersion: number;
  readonly studentMarker: string;
  readonly guardianMarker: string;
}): Promise<Readonly<{
  student_status: number;
  guardian_status: number;
  forbidden_codes: boolean;
  private_echo: boolean;
}>> {
  return page.evaluate(async (value) => {
    const commands = [
      {
        path: `/api/v1/students/${value.studentId}`,
        key: "crm03-admin-student-denied",
        marker: value.studentMarker,
        body: {
          display_name: value.studentMarker,
          date_of_birth: null,
          contact_email: null,
          contact_phone: null,
          expected_record_version: value.studentVersion,
        },
      },
      {
        path: `/api/v1/guardians/${value.guardianId}`,
        key: "crm03-admin-guardian-denied",
        marker: value.guardianMarker,
        body: {
          display_name: "Synthetic denied guardian",
          email: value.guardianMarker,
          phone: null,
          expected_record_version: value.guardianVersion,
        },
      },
    ];
    const responses = await Promise.all(commands.map(async (command) => {
      const response = await fetch(command.path, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": command.key },
        body: JSON.stringify(command.body),
      });
      let code: "FORBIDDEN" | "OTHER" | null = null;
      let echoed = false;
      try {
        const payload = await response.json() as { readonly error?: { readonly code?: unknown } };
        code = payload.error?.code === "FORBIDDEN"
          ? "FORBIDDEN"
          : typeof payload.error?.code === "string" ? "OTHER" : null;
        echoed = JSON.stringify(payload).includes(command.marker);
      } catch {}
      return { status: response.status, code, echoed };
    }));
    return {
      student_status: responses[0]?.status ?? 0,
      guardian_status: responses[1]?.status ?? 0,
      forbidden_codes: responses.every(({ code }) => code === "FORBIDDEN"),
      private_echo: responses.some(({ echoed }) => echoed),
    };
  }, input);
}

interface BrowserCurrentRelationship {
  readonly guardian_id: string;
  readonly relationship_type: "father" | "mother" | "other_guardian";
  readonly is_primary_contact: boolean;
  readonly record_version: number;
}

interface BrowserGuardianCandidate {
  readonly id: string;
  readonly display_name: string;
  readonly email_hint: string | null;
  readonly phone_hint: string | null;
}

function readCurrentRelationshipResponse(
  value: unknown,
  expectedStudentId: string,
): Readonly<{ relationships: readonly BrowserCurrentRelationship[] }> {
  const root = requiredBrowserRecord(value);
  const data = requiredBrowserRecord(root.data);
  const student = requiredBrowserRecord(data.student);
  assert.equal(student.id, expectedStudentId);
  assert.ok(Array.isArray(data.relationships));
  const relationships = data.relationships.map((item) => {
    const relationship = requiredBrowserRecord(item);
    const guardian = requiredBrowserRecord(relationship.guardian);
    assert.equal(typeof guardian.id, "string");
    assert.ok(["father", "mother", "other_guardian"].includes(String(relationship.relationship_type)));
    assert.equal(typeof relationship.is_primary_contact, "boolean");
    assert.equal(Number.isSafeInteger(relationship.record_version), true);
    return Object.freeze({
      guardian_id: String(guardian.id),
      relationship_type: relationship.relationship_type as BrowserCurrentRelationship["relationship_type"],
      is_primary_contact: relationship.is_primary_contact as boolean,
      record_version: relationship.record_version as number,
    });
  });
  return Object.freeze({ relationships: Object.freeze(relationships) });
}

function readGuardianSearchResponse(value: unknown): readonly BrowserGuardianCandidate[] {
  const root = requiredBrowserRecord(value);
  assert.ok(Array.isArray(root.data));
  assert.equal(root.data.length <= 20, true);
  return Object.freeze(root.data.map((item) => {
    const candidate = requiredBrowserRecord(item);
    assert.equal(typeof candidate.id, "string");
    assert.equal(typeof candidate.display_name, "string");
    assert.equal(candidate.email_hint === null || typeof candidate.email_hint === "string", true);
    assert.equal(candidate.phone_hint === null || typeof candidate.phone_hint === "string", true);
    return Object.freeze({
      id: String(candidate.id),
      display_name: String(candidate.display_name),
      email_hint: candidate.email_hint as string | null,
      phone_hint: candidate.phone_hint as string | null,
    });
  }));
}

function readGuardianCommandResponse(value: unknown): Readonly<{ guardian_id: string }> {
  const root = requiredBrowserRecord(value);
  const data = requiredBrowserRecord(root.data);
  const relationship = requiredBrowserRecord(data.relationship);
  assert.equal(typeof relationship.guardian_id, "string");
  return Object.freeze({ guardian_id: String(relationship.guardian_id) });
}

function readSafeErrorCode(value: unknown): string | null {
  const root = requiredBrowserRecord(value);
  if (root.error === null || typeof root.error !== "object" || Array.isArray(root.error)) return null;
  const code = (root.error as Readonly<Record<string, unknown>>).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : null;
}

function requiredBrowserRecord(value: unknown): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Readonly<Record<string, unknown>>;
}

async function readCurrentViaBrowser(
  page: Page,
  studentId: string,
): Promise<Readonly<{ relationships: readonly BrowserCurrentRelationship[] }>> {
  const result = await page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: "same-origin" });
    return { status: response.status, body: await response.json() as unknown };
  }, `/api/v1/students/${studentId}/guardians`);
  assert.equal(result.status, 200);
  return readCurrentRelationshipResponse(result.body, studentId);
}

async function performBrowserMutation(page: Page, input: {
  readonly path: string;
  readonly idempotencyKey: string;
  readonly body: Readonly<Record<string, string | number | boolean>>;
}): Promise<Readonly<{ status: number; code: string | null }>> {
  return page.evaluate(async ({ path, idempotencyKey, body }) => {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    });
    let code: string | null = null;
    try {
      const payload = await response.json() as { readonly error?: { readonly code?: unknown } };
      code = typeof payload.error?.code === "string" ? payload.error.code : null;
    } catch {}
    return { status: response.status, code };
  }, input);
}

async function searchAndSelectGuardian(
  page: Page,
  displayName: string,
): Promise<BrowserGuardianCandidate> {
  const attachSection = page.locator('section[aria-labelledby="attach-guardian-heading"]');
  await attachSection.getByLabel("姓名或聯絡線索", { exact: true }).fill(displayName);
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname.endsWith("/guardians/search"));
  await attachSection.getByRole("button", { name: "搜尋", exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  const candidates = readGuardianSearchResponse(await response.json());
  const candidate = candidates.find(({ display_name }) => display_name === displayName);
  assert.ok(candidate);
  const label = attachSection.locator("label").filter({
    has: page.getByText(displayName, { exact: true }),
  });
  const radio = label.getByRole("radio");
  assert.equal(await radio.count(), 1);
  await radio.focus();
  await page.keyboard.press("Space");
  assert.equal(await radio.isChecked(), true);
  return candidate;
}

function relationshipArticle(page: Page, section: Locator, displayName: string): Locator {
  return section.locator("article").filter({
    has: page.getByText(displayName, { exact: true }),
  });
}

async function countClosedRelationships(
  target: OneRoleBaselineTarget,
  studentId: string,
): Promise<number> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [NEON_TEST_ORGANIZATION.id]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [ADVISOR.userId]);
    const result = await client.query<{ readonly count: number }>(
      `SELECT count(*)::int AS count
         FROM crm_student_guardian_relationships
        WHERE student_id = $1 AND ends_at IS NOT NULL`,
      [studentId],
    );
    return result.rows[0]?.count ?? 0;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
}

async function verifyGuardianReadOnlyRole(page: Page, input: {
  readonly detailUrl: string;
  readonly managementUrl: string;
  readonly primaryGuardianName: string;
  readonly studentId: string;
  readonly candidateId: string;
}): Promise<Readonly<{
  current_readable: boolean;
  controls_hidden: boolean;
  direct_forbidden: boolean;
}>> {
  await page.goto(input.detailUrl, { waitUntil: "domcontentloaded" });
  const detailRelationshipsSection = page.locator('section[aria-labelledby="student-guardian-heading"]');
  const detailPrimaryCard = relationshipArticle(page, detailRelationshipsSection, input.primaryGuardianName);
  await detailPrimaryCard.waitFor({ state: "visible" });
  assert.equal(await detailPrimaryCard.getByText("主要聯絡人", { exact: true }).count(), 1);
  const detailEntryHidden = await page.getByRole("link", {
    name: "管理監護人關係",
    exact: true,
  }).count() === 0;

  await page.goto(input.managementUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "監護人關係管理", exact: true, level: 2 })
    .waitFor({ state: "visible" });
  const currentRelationshipsSection = page.locator('section[aria-labelledby="current-relationships-heading"]');
  const managementPrimaryCard = relationshipArticle(page, currentRelationshipsSection, input.primaryGuardianName);
  await managementPrimaryCard.waitFor({ state: "visible" });
  assert.equal(await managementPrimaryCard.getByText("主要聯絡人", { exact: true }).count(), 1);
  const attachSection = page.locator('section[aria-labelledby="attach-guardian-heading"]');
  const handoffSection = page.locator('section[aria-labelledby="handoff-primary-heading"]');
  const readOnlyText = "目前為只讀模式。管理入口的隱藏只改善使用體驗，每次操作仍由服務端獨立驗證權限。";
  const attachReadOnlyNotice = attachSection.getByText(readOnlyText, { exact: true });
  const handoffReadOnlyNotice = handoffSection.getByText(readOnlyText, { exact: true });
  await attachReadOnlyNotice.waitFor({ state: "visible" });
  await handoffReadOnlyNotice.waitFor({ state: "visible" });
  const controlsHidden = detailEntryHidden &&
    await attachReadOnlyNotice.count() === 1 &&
    await handoffReadOnlyNotice.count() === 1 &&
    await attachSection.getByLabel("姓名或聯絡線索", { exact: true }).count() === 0 &&
    await handoffSection.getByRole("combobox", { name: "新的主要聯絡人", exact: true }).count() === 0 &&
    await attachSection.getByRole("button", { name: "確認關聯為次要監護人", exact: true }).count() === 0;

  const direct = await page.evaluate(async ({ studentId, candidateId, query }) => {
    const commands = [
      { path: `/api/v1/students/${studentId}/guardians/search`, body: { query }, key: null },
      {
        path: `/api/v1/students/${studentId}/guardians`,
        body: {
          guardian_id: candidateId,
          relationship_type: "mother",
          is_legal_guardian: true,
          is_emergency_contact: false,
          is_billing_contact: false,
          notification_consent: false,
        },
        key: "crm02-read-only-attach",
      },
      {
        path: `/api/v1/students/${studentId}/guardians/primary-handoffs`,
        body: { successor_guardian_id: candidateId, expected_primary_record_version: 1 },
        key: "crm02-read-only-handoff",
      },
    ];
    return Promise.all(commands.map(async (command) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (command.key) headers["idempotency-key"] = command.key;
      const response = await fetch(command.path, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify(command.body),
      });
      let code: "FORBIDDEN" | "OTHER" | null = null;
      let echoed = false;
      try {
        const payload = await response.json() as { readonly error?: { readonly code?: unknown } };
        code = payload.error?.code === "FORBIDDEN"
          ? "FORBIDDEN"
          : typeof payload.error?.code === "string" ? "OTHER" : null;
        echoed = JSON.stringify(payload).includes(query);
      } catch {}
      return { status: response.status, code, echoed };
    }));
  }, {
    studentId: input.studentId,
    candidateId: input.candidateId,
    query: input.primaryGuardianName,
  });
  return Object.freeze({
    current_readable: true,
    controls_hidden: controlsHidden,
    direct_forbidden: direct.every(({ status, code, echoed }) =>
      status === 403 && code === "FORBIDDEN" && !echoed),
  });
}

async function loginAdvisor(input: {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly evidence: LoginEvidence;
  readonly renderEvidence: LoginRenderEvidence;
  readonly sessionDiagnosticEvidence: SessionDiagnosticEvidence;
  readonly setStage: (stage: BrowserStage) => void;
}): Promise<void> {
  const {
    page,
    context,
    baseUrl,
    email,
    password,
    evidence,
    renderEvidence,
    sessionDiagnosticEvidence,
    setStage,
  } = input;

  setStage("login_server_render");
  evidence.error_enum = "server_render_failed";
  const serverResponse = await fetch(`${baseUrl}/login`);
  renderEvidence.server.status = serverResponse.status;
  renderEvidence.server.content_type_html =
    serverResponse.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
      "text/html";
  {
    const serverHtml = await serverResponse.text();
    renderEvidence.server.database_test_presentation = serverHtml.includes(
      "使用獲提供的合成測試帳號登入測試工作台。本環境只包含合成測試資料。",
    );
    renderEvidence.server.configuration_unavailable_absent = [
      "登入服務尚未完成部署設定，請聯絡管理員。",
      "登入服務暫時不可用，請聯絡系統管理員。",
      "登入服務目前不可使用，請聯絡系統管理員確認設定。",
    ].every((message) => !serverHtml.includes(message));
  }
  assert.equal(renderEvidence.server.status, 200);
  assert.equal(renderEvidence.server.content_type_html, true);
  assert.equal(renderEvidence.server.database_test_presentation, true);
  assert.equal(renderEvidence.server.configuration_unavailable_absent, true);

  setStage("login_browser_render");
  evidence.error_enum = "browser_render_failed";
  const navigationResponse = await page.goto(`${baseUrl}/login`, {
    waitUntil: "domcontentloaded",
  });
  const emailInput = page.getByLabel("測試帳號電郵", { exact: true });
  const passwordInput = page.getByLabel("密碼", { exact: true });
  const submitButton = page.getByRole("button", {
    name: "登入測試工作台",
    exact: true,
  });
  await Promise.all([
    emailInput.waitFor({ state: "visible" }),
    passwordInput.waitFor({ state: "visible" }),
    submitButton.waitFor({ state: "visible" }),
  ]);
  renderEvidence.browser.navigation_status = navigationResponse?.status() ?? null;
  renderEvidence.browser.final_pathname = new URL(page.url()).pathname;
  renderEvidence.browser.email_label_count = await emailInput.count();
  renderEvidence.browser.password_label_count = await passwordInput.count();
  renderEvidence.browser.submit_button_count = await submitButton.count();
  renderEvidence.browser.role_select_count = await page.locator('select[name="role"]').count();
  assert.equal(renderEvidence.browser.navigation_status, 200);
  assert.equal(renderEvidence.browser.final_pathname, "/login");
  assert.equal(renderEvidence.browser.email_label_count, 1);
  assert.equal(renderEvidence.browser.password_label_count, 1);
  assert.equal(renderEvidence.browser.submit_button_count, 1);
  assert.equal(renderEvidence.browser.role_select_count, 0);

  setStage("login_field_fill");
  evidence.error_enum = "field_fill_failed";
  await emailInput.fill(email);
  await passwordInput.fill(password);
  assert.equal((await emailInput.inputValue()).length > 0, true);
  assert.equal((await passwordInput.inputValue()).length > 0, true);

  setStage("login_submit_response");
  evidence.error_enum = "submit_response_failed";
  const loginResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/v1/auth/login");
  const browserAuthResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    new URL(response.url()).pathname === "/api/v1/auth/me");
  await submitButton.click();
  const response = await loginResponsePromise;
  const headers = await response.allHeaders();
  evidence.status = response.status();
  evidence.location_pathname = safePathname(headers.location);
  evidence.cookie_present = typeof headers["set-cookie"] === "string";
  sessionDiagnosticEvidence.login_location_origin_matches_base =
    locationOriginMatchesBase(headers.location, baseUrl);
  assert.equal(evidence.status, 303);
  assert.equal(evidence.location_pathname, "/today");
  assert.equal(evidence.cookie_present, true);

  setStage("login_redirect");
  evidence.error_enum = "redirect_failed";
  await page.waitForURL("**/today");
  evidence.final_pathname = new URL(page.url()).pathname;
  sessionDiagnosticEvidence.final_page_origin_matches_base =
    urlsShareOrigin(page.url(), baseUrl);
  assert.equal(evidence.final_pathname, "/today");

  setStage("login_session_response");
  evidence.error_enum = "session_response_failed";
  const browserAuthResponse = await browserAuthResponsePromise;
  evidence.auth_me_status = browserAuthResponse.status();
  Object.assign(
    sessionDiagnosticEvidence,
    await inspectStoredSessionCookie(context, baseUrl),
    await inspectSessionRequestHeader(browserAuthResponse.request()),
    await inspectSessionRequestUrlApplicability(
      context,
      baseUrl,
      page.url(),
      browserAuthResponse.request(),
    ),
  );
  assert.equal(evidence.auth_me_status, 200);

  setStage("login_workspace_render");
  evidence.error_enum = "workspace_render_failed";
  const workspaceHeading = page.getByRole("heading", {
    name: "今日工作",
    exact: true,
    level: 2,
  });
  await workspaceHeading.waitFor({ state: "visible" });
  renderEvidence.browser.workspace_heading_count = await workspaceHeading.count();
  assert.equal(renderEvidence.browser.workspace_heading_count, 1);

  setStage("login_workspace_settled");
  evidence.error_enum = "workspace_settled_failed";
  evidence.final_pathname = new URL(page.url()).pathname;
  assert.equal(evidence.final_pathname, "/today");
  assert.equal(evidence.auth_me_status, 200);
  await workspaceHeading.waitFor({ state: "visible" });
  renderEvidence.browser.workspace_heading_count = await workspaceHeading.count();
  assert.equal(renderEvidence.browser.workspace_heading_count, 1);
  renderEvidence.browser.session_checking_count = await page
    .getByText("正在確認工作階段…", { exact: true })
    .count();
  renderEvidence.browser.returning_to_login_count = await page
    .getByText("正在返回登入頁…", { exact: true })
    .count();
  assert.equal(renderEvidence.browser.session_checking_count, 0);
  assert.equal(renderEvidence.browser.returning_to_login_count, 0);
  renderEvidence.browser.workspace_settled = true;
  evidence.error_enum = "none";
}

async function inspectStoredSessionCookie(
  context: BrowserContext,
  baseUrl: string,
): Promise<StoredSessionCookieEvidence> {
  const sessionCookie = (await context.cookies(baseUrl))
    .find((cookie) => cookie.name === "tx_session");
  return Object.freeze({
    cookie_stored: sessionCookie !== undefined,
    value_nonempty: (sessionCookie?.value.length ?? 0) > 0,
    value_length_valid: sessionCookie?.value.length === 43,
    http_only: sessionCookie?.httpOnly === true,
    secure_false: sessionCookie?.secure === false,
    same_site_lax: sessionCookie?.sameSite === "Lax",
    path_root: sessionCookie?.path === "/",
  });
}

async function inspectSessionRequestHeader(
  request: PlaywrightRequest,
): Promise<SessionRequestCookieEvidence> {
  const cookieHeader = Object.entries(await request.allHeaders())
    .find(([name]) => name.toLowerCase() === "cookie")?.[1];
  return Object.freeze({
    cookie_header_present: typeof cookieHeader === "string" && cookieHeader.length > 0,
    session_cookie_name_present: typeof cookieHeader === "string" && cookieHeader
      .split(";")
      .some((entry) => entry.trim().split("=", 1)[0] === "tx_session"),
  });
}

async function inspectSessionRequestUrlApplicability(
  context: BrowserContext,
  baseUrl: string,
  finalPageUrl: string,
  request: PlaywrightRequest,
): Promise<SessionUrlDiagnosticEvidence> {
  const authRequestUrl = request.url();
  const authRequestResourceTypeFetch = request.resourceType() === "fetch";
  try {
    const authUrl = new URL(authRequestUrl);
    const storedCookie = (await context.cookies(baseUrl))
      .find((cookie) => cookie.name === "tx_session");
    const applicableCookieExists = (await context.cookies(authRequestUrl))
      .some((cookie) => cookie.name === "tx_session");
    const cookieDomain = storedCookie?.domain.replace(/^\./, "").toLowerCase();
    const authHostname = authUrl.hostname.toLowerCase();
    return Object.freeze({
      auth_request_origin_matches_base: urlsShareOrigin(authRequestUrl, baseUrl),
      final_page_origin_matches_auth_request: urlsShareOrigin(finalPageUrl, authRequestUrl),
      session_cookie_applicable_to_auth_request_url: applicableCookieExists,
      stored_cookie_domain_matches_auth_request_hostname: cookieDomain !== undefined &&
        (authHostname === cookieDomain || authHostname.endsWith(`.${cookieDomain}`)),
      auth_request_resource_type_fetch: authRequestResourceTypeFetch,
    });
  } catch {
    return Object.freeze({
      auth_request_origin_matches_base: false,
      final_page_origin_matches_auth_request: false,
      session_cookie_applicable_to_auth_request_url: false,
      stored_cookie_domain_matches_auth_request_hostname: false,
      auth_request_resource_type_fetch: authRequestResourceTypeFetch,
    });
  }
}

function locationOriginMatchesBase(
  location: string | undefined,
  baseUrl: string,
): boolean {
  if (!location) return false;
  try {
    const base = new URL(baseUrl);
    return new URL(location, base).origin === base.origin;
  } catch {
    return false;
  }
}

function urlsShareOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

async function loginAndWaitForWorkspace(
  page: Page,
  baseUrl: string,
  email: string,
  password: string,
  setStage?: (stage: Extract<Crm02BrowserStage,
    "advisor_login_server_render" | "advisor_login_browser_render" | "advisor_login_session">) => void,
): Promise<void> {
  setStage?.("advisor_login_server_render");
  const serverResponse = await fetch(`${baseUrl}/login`);
  assert.equal(serverResponse.status, 200);
  assert.equal(
    serverResponse.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase(),
    "text/html",
  );
  await serverResponse.text();

  setStage?.("advisor_login_browser_render");
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  const emailInput = page.getByLabel("測試帳號電郵", { exact: true });
  const passwordInput = page.getByLabel("密碼", { exact: true });
  const submitButton = page.getByRole("button", { name: "登入測試工作台", exact: true });
  await Promise.all([
    emailInput.waitFor({ state: "visible" }),
    passwordInput.waitFor({ state: "visible" }),
    submitButton.waitFor({ state: "visible" }),
  ]);
  await emailInput.fill(email);
  await passwordInput.fill(password);
  setStage?.("advisor_login_session");
  const loginResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/v1/auth/login");
  const authResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    new URL(response.url()).pathname === "/api/v1/auth/me");
  await submitButton.click();
  assert.equal((await loginResponsePromise).status(), 303);
  await page.waitForURL("**/today");
  assert.equal((await authResponsePromise).status(), 200);
  await page.getByRole("heading", { name: "今日工作", exact: true, level: 2 })
    .waitFor({ state: "visible" });
}

async function loginWithoutEvidence(
  page: Page,
  baseUrl: string,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("測試帳號電郵", { exact: true }).fill(email);
  await page.getByLabel("密碼", { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL("**/today"),
    page.getByRole("button", { name: "登入測試工作台", exact: true }).click(),
  ]);
}

async function logout(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "帳戶選單", exact: true }).click();
  const accountMenu = page.getByRole("menu", { name: "帳戶選單", exact: true });
  await accountMenu.waitFor({ state: "visible" });
  await Promise.all([
    page.waitForURL("**/login**"),
    accountMenu.getByRole("menuitem", { name: "登出", exact: true }).click(),
  ]);
  assert.equal(new URL(page.url()).pathname, "/login");
}

async function fillValidDraft(
  page: Page,
  draft: Readonly<{
    studentName: string;
    guardianName: string;
    guardianEmail: string;
  }>,
): Promise<void> {
  await page.getByRole("textbox", { name: "學生姓名", exact: true })
    .fill(draft.studentName);
  await page.getByLabel("出生日期", { exact: true }).fill("2013-06-18");
  await page.getByRole("textbox", { name: "監護人姓名", exact: true })
    .fill(draft.guardianName);
  await page.getByRole("combobox", { name: "與學生關係", exact: true })
    .selectOption("father");
  await page.getByLabel("監護人 Email", { exact: true }).fill(draft.guardianEmail);
}

async function submitAndWaitUnavailable(
  page: Page,
  expectedCount: number,
  observedKeys: readonly string[],
): Promise<void> {
  await page.getByRole("button", { name: "建立學生", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "學生服務暫時不可用" }).waitFor();
  await waitUntil(() => observedKeys.length === expectedCount);
}

async function withViewport<T>(
  page: Page,
  viewport: Readonly<{ width: number; height: number }>,
  action: () => Promise<T>,
): Promise<T> {
  await page.setViewportSize(viewport);
  try {
    return await action();
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
}

async function assertViewport(page: Page, label: string): Promise<ViewportEvidence> {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const main = document.querySelector("main") ?? document.body;
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" &&
        rect.width > 0 && rect.height > 0;
    };
    const inHorizontalScroller = (element: Element) =>
      Boolean(element.closest(".overflow-x-auto"));
    const controls = [...main.querySelectorAll("a,button,input,select")]
      .filter((element) => visible(element) && !inHorizontalScroller(element));
    const outOfBoundsControls = controls.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > window.innerWidth + 1;
    }).length;
    let overlappingControls = 0;
    for (let left = 0; left < controls.length; left += 1) {
      const a = controls[left]!.getBoundingClientRect();
      for (let right = left + 1; right < controls.length; right += 1) {
        const b = controls[right]!.getBoundingClientRect();
        const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapWidth > 2 && overlapHeight > 2) overlappingControls += 1;
      }
    }
    const clippedText = [...main.querySelectorAll("h1,h2,h3,p,label,button,a,strong,small")]
      .filter((element) => visible(element) && !inHorizontalScroller(element))
      .filter((element) => !element.classList.contains("truncate"))
      .filter((element) => {
        const htmlElement = element as HTMLElement;
        const style = getComputedStyle(element);
        return htmlElement.scrollWidth > htmlElement.clientWidth + 1 &&
          style.overflowX === "hidden";
      }).length;
    return {
      page_horizontal_overflow: Math.max(0, root.scrollWidth - window.innerWidth),
      out_of_bounds_controls: outOfBoundsControls,
      overlapping_controls: overlappingControls,
      clipped_text: clippedText,
    };
  });
  assert.deepEqual(result, {
    page_horizontal_overflow: 0,
    out_of_bounds_controls: 0,
    overlapping_controls: 0,
    clipped_text: 0,
  }, label);
  return Object.freeze({ label, ...result });
}

function emptyCrm03MobileViewportEvidence(): Crm03MobileViewportEvidence {
  const controlCategories = Object.freeze({
    input_count: 0,
    button_count: 0,
    link_count: 0,
    select_count: 0,
  });
  const fixedControls = Object.freeze({
    cancel: false,
    save_guardian_profile: false,
    edit_guardian_profile: false,
    create_case: false,
    manage_guardian_relationships: false,
  });
  return Object.freeze({
    page_horizontal_overflow: null,
    out_of_bounds_controls: null,
    overlapping_controls: null,
    clipped_text: null,
    out_of_bounds_categories: controlCategories,
    out_of_bounds_fixed_controls: fixedControls,
    overlapping_categories: controlCategories,
    overlapping_fixed_controls: fixedControls,
    clipped_categories: Object.freeze({
      heading_count: 0,
      paragraph_count: 0,
      label_count: 0,
      button_count: 0,
      link_count: 0,
      strong_count: 0,
      small_count: 0,
    }),
    clipped_fixed_controls: fixedControls,
    clipped_fixed_titles: Object.freeze({
      student_profile: false,
      guardian_relationships: false,
      edit_guardian_profile: false,
    }),
  });
}

async function measureCrm03MobileViewport(page: Page): Promise<Crm03MobileViewportEvidence> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const main = document.querySelector("main") ?? document.body;
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" &&
        rect.width > 0 && rect.height > 0;
    };
    const inHorizontalScroller = (element: Element) =>
      Boolean(element.closest(".overflow-x-auto"));
    const controls = [...main.querySelectorAll("a,button,input,select")]
      .filter((element) => visible(element) && !inHorizontalScroller(element));
    const outOfBounds = controls.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > window.innerWidth + 1;
    });
    const overlapping = new Set<Element>();
    let overlappingPairs = 0;
    for (let left = 0; left < controls.length; left += 1) {
      const leftElement = controls[left]!;
      const leftRect = leftElement.getBoundingClientRect();
      for (let right = left + 1; right < controls.length; right += 1) {
        const rightElement = controls[right]!;
        const rightRect = rightElement.getBoundingClientRect();
        const overlapWidth = Math.min(leftRect.right, rightRect.right) -
          Math.max(leftRect.left, rightRect.left);
        const overlapHeight = Math.min(leftRect.bottom, rightRect.bottom) -
          Math.max(leftRect.top, rightRect.top);
        if (overlapWidth > 2 && overlapHeight > 2) {
          overlappingPairs += 1;
          overlapping.add(leftElement);
          overlapping.add(rightElement);
        }
      }
    }
    const clipped = [...main.querySelectorAll("h1,h2,h3,p,label,button,a,strong,small")]
      .filter((element) => visible(element) && !inHorizontalScroller(element))
      .filter((element) => !element.classList.contains("truncate"))
      .filter((element) => {
        const htmlElement = element as HTMLElement;
        const style = getComputedStyle(element);
        return htmlElement.scrollWidth > htmlElement.clientWidth + 1 &&
          style.overflowX === "hidden";
      });
    const categoryCounts = (elements: readonly Element[]) => ({
      input_count: elements.filter((element) => element.tagName === "INPUT").length,
      button_count: elements.filter((element) => element.tagName === "BUTTON").length,
      link_count: elements.filter((element) => element.tagName === "A").length,
      select_count: elements.filter((element) => element.tagName === "SELECT").length,
    });
    const hasExactText = (elements: readonly Element[], text: string) =>
      elements.some((element) => element.textContent?.trim() === text);
    const fixedControls = (elements: readonly Element[]) => ({
      cancel: hasExactText(elements, "取消"),
      save_guardian_profile: hasExactText(elements, "保存監護人資料"),
      edit_guardian_profile: hasExactText(elements, "編輯監護人資料"),
      create_case: hasExactText(elements, "建立案件"),
      manage_guardian_relationships: hasExactText(elements, "管理監護人關係"),
    });
    const overlappingElements = [...overlapping];
    return {
      page_horizontal_overflow: Math.max(0, root.scrollWidth - window.innerWidth),
      out_of_bounds_controls: outOfBounds.length,
      overlapping_controls: overlappingPairs,
      clipped_text: clipped.length,
      out_of_bounds_categories: categoryCounts(outOfBounds),
      out_of_bounds_fixed_controls: fixedControls(outOfBounds),
      overlapping_categories: categoryCounts(overlappingElements),
      overlapping_fixed_controls: fixedControls(overlappingElements),
      clipped_categories: {
        heading_count: clipped.filter((element) => /^H[1-3]$/.test(element.tagName)).length,
        paragraph_count: clipped.filter((element) => element.tagName === "P").length,
        label_count: clipped.filter((element) => element.tagName === "LABEL").length,
        button_count: clipped.filter((element) => element.tagName === "BUTTON").length,
        link_count: clipped.filter((element) => element.tagName === "A").length,
        strong_count: clipped.filter((element) => element.tagName === "STRONG").length,
        small_count: clipped.filter((element) => element.tagName === "SMALL").length,
      },
      clipped_fixed_controls: fixedControls(clipped),
      clipped_fixed_titles: {
        student_profile: hasExactText(clipped, "學生基本資料"),
        guardian_relationships: hasExactText(clipped, "監護人與聯絡關係"),
        edit_guardian_profile: hasExactText(clipped, "編輯監護人資料"),
      },
    };
  });
}

function isLoginStage(stage: BrowserStage): boolean {
  return stage === "login_server_render" || stage === "login_browser_render" ||
    stage === "login_field_fill" ||
    stage === "login_submit_response" || stage === "login_redirect" ||
    stage === "login_session_response" || stage === "login_workspace_render" ||
    stage === "login_workspace_settled";
}

function isAdvisorEntryStage(stage: BrowserStage): boolean {
  return stage === "advisor_list_navigation" || stage === "advisor_list_shell" ||
    stage === "advisor_list_data" || stage === "advisor_create_entry";
}

function isClientValidationStage(stage: BrowserStage): boolean {
  return stage === "create_form_navigation" || stage === "create_form_shell" ||
    stage === "create_form_access" || stage === "create_form_ready" ||
    stage === "client_validation_fill" || stage === "client_validation_submit" ||
    stage === "client_validation_feedback" || stage === "client_validation_no_post";
}

function isAdminDirectStage(stage: BrowserStage): boolean {
  return stage === "admin_direct_transport" || stage === "admin_direct_status" ||
    stage === "admin_direct_privacy";
}

function freezeLoginRenderEvidence(
  evidence: LoginRenderEvidence,
): Readonly<LoginRenderEvidence> {
  return Object.freeze({
    server: Object.freeze({ ...evidence.server }),
    browser: Object.freeze({ ...evidence.browser }),
  });
}

function safeStage(stage: BrowserStage): BrowserStage {
  return BROWSER_STAGES.includes(stage) ? stage : "runtime_preflight";
}

function safePathname(location: string | undefined): string | null {
  if (!location) return null;
  try {
    return new URL(location, "http://local.invalid").pathname;
  } catch {
    return null;
  }
}

async function populateIsolatedApp(directory: string): Promise<void> {
  const excluded = new Set([".git", ".next", "node_modules"]);
  for (const entry of await readdir(process.cwd())) {
    if (excluded.has(entry) || entry.startsWith(".env") || [
      ".DS_Store", ".idea", ".kition", ".pnpm-store",
    ].includes(entry)) continue;
    await cp(resolve(entry), join(directory, entry), { recursive: true });
  }
  await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
}

async function discoverCanonicalBaseUrl(
  listenUrl: string,
  expectedPort: number,
  evidence: CanonicalOriginEvidence,
): Promise<string> {
  const response = await fetch(`${listenUrl}/api/auth/login`, {
    method: "GET",
    redirect: "manual",
  });
  evidence.response_status_307 = response.status === 307;
  const location = response.headers.get("location");
  evidence.location_present = typeof location === "string" && location.length > 0;
  assert.equal(evidence.response_status_307, true);
  assert.equal(evidence.location_present, true);
  if (!location) throw new Error("canonical_location_missing");

  let canonicalUrl: URL;
  try {
    canonicalUrl = new URL(location, listenUrl);
    evidence.location_parseable = true;
  } catch {
    throw new Error("canonical_location_invalid");
  }
  evidence.pathname_exact = canonicalUrl.pathname === "/api/v1/auth/login";
  evidence.protocol_http = canonicalUrl.protocol === "http:";
  evidence.hostname_loopback = ["localhost", "127.0.0.1", "::1", "[::1]"]
    .includes(canonicalUrl.hostname.toLowerCase());
  evidence.port_matches = canonicalUrl.port === String(expectedPort);
  evidence.credentials_absent = canonicalUrl.username === "" && canonicalUrl.password === "";
  evidence.search_absent = canonicalUrl.search === "";
  evidence.hash_absent = canonicalUrl.hash === "";

  assert.equal(evidence.location_parseable, true);
  assert.equal(evidence.pathname_exact, true);
  assert.equal(evidence.protocol_http, true);
  assert.equal(evidence.hostname_loopback, true);
  assert.equal(evidence.port_matches, true);
  assert.equal(evidence.credentials_absent, true);
  assert.equal(evidence.search_absent, true);
  assert.equal(evidence.hash_absent, true);
  return canonicalUrl.origin;
}

function startNextDev(directory: string, port: number, connectionString: string): ChildProcess {
  return spawn(process.execPath, [
    resolve("node_modules/next/dist/bin/next"),
    "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port),
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
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  child.stdout?.resume();
  child.stderr?.resume();
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new Error("next_dev_early_exit");
    try {
      const response = await fetch(`${baseUrl}/api/v1/auth/me`);
      if (response.status === 401) return;
    } catch {}
    await delay(500);
  }
  throw new Error("next_dev_readiness_timeout");
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

async function closeBrowser(context: BrowserContext | undefined): Promise<boolean> {
  if (!context) return true;
  try {
    await context.close();
    return true;
  } catch {
    return false;
  }
}

async function removeDirectory(directory: string): Promise<boolean> {
  try {
    await rm(directory, { recursive: true, force: true });
    await access(directory);
    return false;
  } catch {
    return true;
  }
}

async function removeDockerResource(arguments_: readonly string[]): Promise<boolean> {
  const result = await runDocker(arguments_, undefined, true);
  return result.exitCode === 0;
}

async function provision(
  target: OneRoleBaselineTarget,
  email: string,
  password: string,
): Promise<string> {
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
    const probe = await runDocker([
      "exec", containerName, "/bin/sh", "/usr/local/bin/tianxing-postgres-healthcheck",
    ], undefined, true);
    if (probe.exitCode === 0) return;
    await delay(250);
  }
  throw new Error("postgres_readiness_timeout");
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function readLoopbackPort(output: string): number {
  const match = /^127\.0\.0\.1:([0-9]+)\s*$/.exec(output);
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("postgres_port_inspection");
  }
  return port;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error("observation_timeout");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function runDocker(
  arguments_: readonly string[],
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
    child.once("error", reject);
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !allowFailure) reject(new Error("docker_command_failed"));
      else resolveRun(Object.freeze({ exitCode, stdout }));
    });
    child.stdin.end(input);
  });
}
