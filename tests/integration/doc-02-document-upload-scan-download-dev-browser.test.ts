import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  chromium,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
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
const LOCALSTACK_IMAGE = "localstack/localstack:4.14.0";
const CLAMAV_IMAGE = "clamav/clamav:1.4.5-debian13-slim";
const REGION = "ap-east-1";
const BUCKET = "tianxing-local-documents";
const QUEUE = "tianxing-local-document-scan";
const DLQ = "tianxing-local-document-scan-dlq";
const ORGANIZATION_ID = NEON_TEST_ORGANIZATION.id;
const WORKER_CONTEXT_ID = "10000000-0000-4000-8000-000000000901";
const WORKER_READY_MARKER = "document-worker-ready";
const WORKER_UNAVAILABLE_MARKER = "document-worker-unavailable";
const WORKER_MAIN_DELETE_REQUESTED_MARKER = "document-worker-main-delete-requested";
const WORKER_MAIN_DELETE_COMPLETED_MARKER = "document-worker-main-delete-completed";
const QUEUE_DRAIN_EVIDENCE_TIMEOUT_MS = 75_000;
const QUEUE_DRAIN_POLL_INTERVAL_MS = 500;
const QUEUE_DRAIN_MAX_POLLS = Math.ceil(
  QUEUE_DRAIN_EVIDENCE_TIMEOUT_MS / QUEUE_DRAIN_POLL_INTERVAL_MS,
) + 1;
const VERSION_CHANGED_DIAGNOSTIC_TIMEOUT_MS = 5_000;
const FOUNDER = principal("founder");
const ADVISOR = principal("advisor");
const ADMIN = principal("admin");
const DATA_REVIEWER = principal("data_reviewer");
const CONTRACTOR = principal("contractor");
const CLEAN_FILE_NAME = "doc02-clean-release1.pdf";
const CHANGED_FILE_NAME = "doc02-clean-changed-release1.pdf";
const MALICIOUS_FILE_NAME = "doc02-rejected-release1.pdf";
const STALE_FILE_NAME = "doc02-stale-release1.pdf";
const ADVISOR_FILE_NAME = "doc02-advisor-clean-release1.pdf";
const RECOVERY_FILE_NAME = "doc02-recovery-release1.pdf";
const RECOVERY_WRONG_FILE_NAME = "doc02-recovery-wrong-release1.pdf";
const SAME_PAGE_RECOVERY_FILE_NAME = "doc02-same-page-recovery-release1.pdf";
const ABANDON_NEW_FILE_NAME = "doc02-abandon-new-release1.pdf";
const SCAN_FAILED_FILE_NAME = "doc02-scan-failed-release1.pdf";
const CLEAN_RAW_MARKER = "DOC02-CLEAN-RAW-RELEASE1";
const CHANGED_RAW_MARKER = "DOC02-CHANGED-RAW-RELEASE1";
const ADVISOR_RAW_MARKER = "DOC02-ADVISOR-RAW-RELEASE1";
const SAME_PAGE_RECOVERY_RAW_MARKER = "DOC02-SAME-PAGE-RECOVERY-RAW-RELEASE1";
const SCAN_FAILED_RAW_MARKER = "DOC02-SCAN-FAILED-RAW-RELEASE1";
const CLEAN_BYTES = Buffer.from(`%PDF-1.4\n% ${CLEAN_RAW_MARKER}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`, "utf8");
const CHANGED_CLEAN_BYTES = Buffer.from(`%PDF-1.4\n% ${CHANGED_RAW_MARKER}\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF\n`, "utf8");
const ADVISOR_CLEAN_BYTES = Buffer.from(`%PDF-1.4\n% ${ADVISOR_RAW_MARKER}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`, "utf8");
const SAME_PAGE_RECOVERY_BYTES = Buffer.from(
  `%PDF-1.4\n% ${SAME_PAGE_RECOVERY_RAW_MARKER}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`,
  "utf8",
);
const SCAN_FAILED_BYTES = Buffer.from(`%PDF-1.4\n% ${SCAN_FAILED_RAW_MARKER}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`, "utf8");
const EICAR_FRAGMENTS = [
  "X5O!P%@AP[4", "\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-", "ANTIVIRUS-TEST-FILE!$H+H*",
] as const;
const EICAR_MARKER = EICAR_FRAGMENTS.join("");
const MALICIOUS_BYTES = Buffer.from(EICAR_MARKER, "ascii");

type Actor = "founder" | "advisor" | "admin" | "data_reviewer" | "contractor";
type SafeCode = "NONE" | "VALIDATION_FAILED" | "STALE_VERSION" | "CONFLICT" | "FORBIDDEN" | "NOT_FOUND" | "OTHER";
type SafeWorkerState = "unknown" | "alive" | "exited";
type SafeDocumentState =
  | "NONE" | "pending_upload" | "quarantined" | "scanning" | "available" | "rejected"
  | "scan_failed" | "abandoned" | "superseded" | "pending_delete" | "deleted" | "OTHER";
type SafePendingUploadState = "unknown" | "present" | "absent" | "invalid";
type WorkerDeleteMarker = typeof WORKER_MAIN_DELETE_REQUESTED_MARKER |
  typeof WORKER_MAIN_DELETE_COMPLETED_MARKER;
type LoginStage =
  | "founder_login_page" | "founder_login_form_ready" | "founder_login_submit"
  | "founder_login_redirect" | "founder_login_session" | "founder_login_workspace";
type Stage =
  | "runtime_preflight" | "postgres_setup" | "localstack_setup" | "clamav_setup"
  | "baseline_seed" | "identity_provision" | "next_dev" | "document_worker"
  | "canonical_origin_transport" | "canonical_origin_response" | "canonical_origin_location"
  | "canonical_origin_contract"
  | "canonical_origin_match" | "chrome_launch" | LoginStage | "case_fixture"
  | "document_fixture" | "capability_controls" | "preclean_download_denied"
  | "client_validation" | "version_retry_first" | "version_retry_second"
  | "version_changed_submit" | "version_changed_post_transport" | "version_changed_receipt_contract"
  | "version_changed_detail_refresh" | "version_changed_upload_intent" | "version_changed_put"
  | "version_changed_worker" | "version_changed_feedback"
  | "version_receipt" | "clean_scan" | "clean_download"
  | "same_page_recovery_first_submit" | "same_page_recovery_uncertain_intent"
  | "same_page_recovery_pending_authority" | "same_page_recovery_retry"
  | "same_page_recovery_put" | "same_page_recovery_authority" | "same_page_recovery_feedback"
  | "unbound_fixture" | "unbound_worker_pause" | "unbound_provider_versions"
  | "unbound_cleanup" | "unbound_queue_drain" | "unbound_authority" | "unbound_download"
  | "unbound_replay" | "unbound_replay_database"
  | "keyboard_focus_initial" | "keyboard_focus_forward" | "keyboard_focus_return"
  | "malicious_upload" | "old_clean_retained"
  | "pending_recovery_fixture" | "pending_recovery_refresh" | "pending_recovery_wrong_file"
  | "pending_recovery_same_file_controls" | "pending_recovery_same_file_upload_intent"
  | "pending_recovery_same_file_put" | "pending_recovery_same_file_authority"
  | "pending_recovery_same_file_worker" | "pending_recovery_same_file_feedback"
  | "abandonment_fixture" | "abandonment_retry_first"
  | "abandonment_retry_second" | "abandonment_submit" | "abandonment_replay"
  | "abandonment_worker_pause" | "abandonment_late_provider_versions"
  | "abandonment_late_cleanup" | "abandonment_late_database"
  | "abandonment_new_version" | "abandonment_changed_authority"
  | "stale_fixture" | "stale_feedback" | "refresh_persistence" | "relogin_persistence"
  | "advisor_scope" | "advisor_upload" | "advisor_download" | "advisor_unassigned" | "denied_roles"
  | "scan_failed_clamav_unavailable" | "scan_failed_authority" | "scan_failed_clamav_restore"
  | "desktop_viewport" | "mobile_viewport" | "browser_log_safety"
  | "dev_process_log_safety" | "worker_process_log_safety"
  | "cleanup" | "complete";

interface LoginEvidence {
  page_navigation_completed: boolean;
  page_status: number | null;
  page_path_exact: boolean;
  page_origin_exact: boolean;
  form_email_count: number | null;
  form_password_count: number | null;
  form_submit_count: number | null;
  submit_request_observed: boolean;
  submit_response_received: boolean;
  submit_status: number | null;
  submit_response_origin_exact: boolean;
  submit_location_present: boolean;
  submit_location_parseable: boolean;
  submit_location_path_exact: boolean;
  submit_target_origin_exact: boolean;
  submit_target_protocol_http: boolean;
  submit_target_loopback: boolean;
  submit_target_port_matches: boolean;
  redirect_path_exact: boolean;
  redirect_origin_exact: boolean;
  session_request_observed: boolean;
  session_response_received: boolean;
  session_status: number | null;
  session_response_origin_matches_page: boolean;
  workspace_heading_count: number | null;
  workspace_heading_visible: boolean;
}

interface Evidence {
  baseline_generated_files: number | null;
  canonical_next_state: SafeWorkerState;
  canonical_request_started: boolean;
  canonical_fetch_completed: boolean;
  canonical_response_status: number | null;
  canonical_response_status_307: boolean;
  canonical_response_origin_exact: boolean;
  canonical_response_path_exact: boolean;
  canonical_redirect_count: number | null;
  canonical_location_present: boolean;
  canonical_location_parseable: boolean;
  canonical_location_origin_exact: boolean;
  canonical_location_path_exact: boolean;
  canonical_protocol_http: boolean;
  canonical_hostname_loopback: boolean;
  canonical_port_matches: boolean;
  canonical_credentials_absent: boolean;
  canonical_search_absent: boolean;
  canonical_hash_absent: boolean;
  canonical_returned_origin_exact: boolean;
  founder_login: LoginEvidence;
  founder_controls_visible: boolean;
  advisor_controls_visible: boolean;
  validation_zero_post: boolean;
  uncertain_retry_same_key: boolean;
  changed_file_rotates_key: boolean;
  synchronous_double_post_count: number | null;
  version_changed_post_request_started: boolean;
  version_changed_post_response_received: boolean;
  version_changed_post_status: number | null;
  version_changed_post_json_parseable: boolean;
  version_changed_post_receipt_exact: boolean;
  version_changed_post_safe_code: SafeCode;
  version_changed_detail_request_started: boolean;
  version_changed_detail_response_received: boolean;
  version_changed_detail_status: number | null;
  version_changed_intent_request_started: boolean;
  version_changed_intent_response_received: boolean;
  version_changed_intent_status: number | null;
  version_changed_intent_safe_code: SafeCode;
  version_changed_put_request_started: boolean;
  version_changed_put_response_received: boolean;
  version_changed_put_status: number | null;
  version_changed_worker_before: SafeWorkerState;
  version_changed_worker_after: SafeWorkerState;
  version_changed_worker_unavailable_marker_delta: number | null;
  version_changed_queue_visible_count: number | null;
  version_changed_queue_not_visible_count: number | null;
  version_changed_queue_delayed_count: number | null;
  version_changed_queue_attributes_complete: boolean;
  version_changed_authority_fetch_completed: boolean;
  version_changed_authority_status: number | null;
  version_changed_authority_json_parseable: boolean;
  version_changed_authority_state: SafeDocumentState;
  version_changed_authority_pending: SafePendingUploadState;
  version_changed_success_status_count: number | null;
  version_changed_success_status_visible: boolean;
  version_changed_available_badge_count: number | null;
  version_changed_available_badge_visible: boolean;
  version_changed_alert_count: number | null;
  version_changed_unavailable_alert_count: number | null;
  version_changed_conflict_alert_count: number | null;
  version_changed_timeout_alert_count: number | null;
  version_receipt_exact: boolean;
  authoritative_detail_after_create: boolean;
  preclean_download_denied: boolean;
  clean_available: boolean;
  clean_download_exact_bytes: boolean;
  same_page_recovery_version_post_count: number | null;
  same_page_recovery_receipt_exact: boolean;
  same_page_recovery_pending_detail_status: number | null;
  same_page_recovery_pending_authoritative: boolean;
  same_page_recovery_intent_attempt_count: number | null;
  same_page_recovery_first_intent_uncertain: boolean;
  same_page_recovery_unavailable_feedback: boolean;
  same_page_recovery_file_preserved: boolean;
  same_page_recovery_retry_intent_status: number | null;
  same_page_recovery_put_status: number | null;
  same_page_recovery_zero_new_version_post: boolean;
  same_page_recovery_final_authority_available: boolean;
  same_page_recovery_success_feedback: boolean;
  same_page_recovery_private_transport_hidden: boolean;
  unbound_worker_stop_requested: boolean;
  unbound_worker_stop_soft_close_observed: boolean;
  unbound_worker_stop_group_alive_after_soft: boolean;
  unbound_worker_stop_hard_kill_requested: boolean;
  unbound_worker_stop_final_close_observed: boolean;
  unbound_worker_stop_final_group_absent: boolean;
  unbound_worker_stopped: boolean;
  unbound_same_capability_put_count: number | null;
  unbound_provider_version_ids_distinct: boolean;
  unbound_provider_version_count_before_cleanup: number | null;
  unbound_provider_version_count_after_cleanup: number | null;
  unbound_delete_marker_count_after_cleanup: number | null;
  unbound_bound_version_authoritative: boolean;
  unbound_bound_version_preserved: boolean;
  unbound_extra_version_absent: boolean;
  unbound_scan_fact_count: number | null;
  unbound_cleanup_audit_count: number | null;
  unbound_cleanup_outbox_count: number | null;
  unbound_cleanup_private_value_matches: number | null;
  unbound_cleanup_forbidden_field_matches: number | null;
  test_event_acknowledged: boolean;
  unbound_main_delete_requested_count: number | null;
  unbound_main_delete_completed_count: number | null;
  unbound_queue_visible_count: number | null;
  unbound_queue_not_visible_count: number | null;
  unbound_queue_delayed_count: number | null;
  unbound_queue_attributes_complete: boolean;
  unbound_queue_poll_count: number | null;
  unbound_queue_worker_state: SafeWorkerState;
  unbound_queue_drained: boolean;
  unbound_download_exact_bytes: boolean;
  unbound_replay_enqueued: boolean;
  unbound_replay_queue_observed: boolean;
  unbound_replay_main_delete_requested_count: number | null;
  unbound_replay_main_delete_completed_count: number | null;
  unbound_replay_queue_visible_count: number | null;
  unbound_replay_queue_not_visible_count: number | null;
  unbound_replay_queue_delayed_count: number | null;
  unbound_replay_queue_attributes_complete: boolean;
  unbound_replay_queue_poll_count: number | null;
  unbound_replay_queue_worker_state: SafeWorkerState;
  unbound_replay_queue_drained: boolean;
  unbound_replay_zero_extra_effects: boolean;
  keyboard_file_input_count: number | null;
  keyboard_file_input_visible: boolean;
  keyboard_file_input_enabled: boolean;
  keyboard_upload_button_count: number | null;
  keyboard_upload_button_visible: boolean;
  keyboard_upload_button_enabled: boolean;
  keyboard_initial_file_input_focused: boolean;
  keyboard_forward_upload_button_focused: boolean;
  keyboard_return_file_input_focused: boolean;
  keyboard_focus_returned: boolean;
  malicious_rejected: boolean;
  old_clean_retained: boolean;
  pending_recovery_persisted: boolean;
  pending_recovery_wrong_file_zero_put: boolean;
  pending_recovery_wrong_file_zero_new_version: boolean;
  pending_recovery_same_file_input_count: number | null;
  pending_recovery_same_file_input_visible: boolean;
  pending_recovery_same_file_input_enabled: boolean;
  pending_recovery_same_file_upload_button_count: number | null;
  pending_recovery_same_file_upload_button_visible: boolean;
  pending_recovery_same_file_upload_button_enabled: boolean;
  pending_recovery_same_file_intent_request_started: boolean;
  pending_recovery_same_file_intent_response_received: boolean;
  pending_recovery_same_file_intent_status: number | null;
  pending_recovery_same_file_intent_safe_code: SafeCode;
  pending_recovery_same_file_put_request_started: boolean;
  pending_recovery_same_file_put_response_received: boolean;
  pending_recovery_same_file_put_status: number | null;
  pending_recovery_same_file_authority_fetch_completed: boolean;
  pending_recovery_same_file_authority_status: number | null;
  pending_recovery_same_file_authority_json_parseable: boolean;
  pending_recovery_same_file_authority_state: SafeDocumentState;
  pending_recovery_same_file_authority_pending: SafePendingUploadState;
  pending_recovery_same_file_worker_before: SafeWorkerState;
  pending_recovery_same_file_worker_after: SafeWorkerState;
  pending_recovery_same_file_success_status_count: number | null;
  pending_recovery_same_file_success_status_visible: boolean;
  pending_recovery_same_file_available_badge_count: number | null;
  pending_recovery_same_file_available_badge_visible: boolean;
  pending_recovery_same_file_alert_count: number | null;
  pending_recovery_same_file_recovery_conflict_alert_count: number | null;
  pending_recovery_same_file_conflict_alert_count: number | null;
  pending_recovery_same_file_timeout_alert_count: number | null;
  pending_recovery_same_file_unavailable_alert_count: number | null;
  pending_recovery_same_file_available: boolean;
  abandonment_uncertain_retry_same_key: boolean;
  abandonment_double_post_count: number | null;
  abandonment_receipt_exact: boolean;
  abandonment_replay_exact: boolean;
  abandonment_authoritative: boolean;
  abandonment_late_put_count: number | null;
  abandonment_late_provider_version_header_count: number | null;
  abandonment_late_provider_version_ids_distinct: boolean;
  abandonment_provider_version_count_before_cleanup: number | null;
  abandonment_delete_marker_count_before_cleanup: number | null;
  abandonment_provider_versions_exact_before_cleanup: boolean;
  abandonment_provider_version_count_after_cleanup: number | null;
  abandonment_delete_marker_count_after_cleanup: number | null;
  abandonment_provider_versions_exact_absent: boolean;
  abandonment_late_objects_cleaned: boolean;
  abandonment_scan_results_count: number | null;
  abandonment_cleanup_audit_count: number | null;
  abandonment_cleanup_outbox_count: number | null;
  abandonment_scan_audit_count: number | null;
  abandonment_scan_outbox_count: number | null;
  abandonment_private_object_coordinate_matches: number | null;
  abandonment_version_abandoned_unbound: boolean;
  abandonment_active_pointer_null: boolean;
  abandonment_never_scanned_or_downloadable: boolean;
  abandonment_new_version_available: boolean;
  abandonment_changed_authority_rotates_key: boolean;
  refresh_persistence: boolean;
  relogin_persistence: boolean;
  stale_visible: boolean;
  stale_authoritative_detail_status: number | null;
  stale_pending_recovery_visible: boolean;
  advisor_upload_available: boolean;
  advisor_download_exact_bytes: boolean;
  advisor_unassigned_not_found: boolean;
  denied_ui_hidden_count: number;
  denied_direct_forbidden_count: number;
  scan_failed_authoritative_detail_status: number | null;
  scan_failed_authoritative_state: boolean;
  scan_failed_fixed_feedback: boolean;
  scan_failed_download_disabled: boolean;
  scan_failed_clamav_recovered: boolean;
  desktop_viewport: ViewportEvidence | null;
  mobile_viewport: ViewportEvidence | null;
  page_errors: number | null;
  sensitive_log_matches: number | null;
  dev_process_log_captured: boolean;
  dev_process_stdout_frozen_private_matches: number | null;
  dev_process_stderr_frozen_private_matches: number | null;
  dev_process_stdout_standalone_business_route_id_matches: number | null;
  dev_process_stderr_standalone_business_route_id_matches: number | null;
  worker_process_count: number | null;
  worker_process_log_captured_count: number | null;
  worker_process_stdout_frozen_private_matches: number | null;
  worker_process_stderr_frozen_private_matches: number | null;
  worker_process_stdout_standalone_business_route_id_matches: number | null;
  worker_process_stderr_standalone_business_route_id_matches: number | null;
}

interface SafeProcessLogCategoryCounts {
  readonly frozen_private: number;
  readonly standalone_business_route_id: number;
}

interface SafeProcessLogEvidence {
  readonly captured: boolean;
  readonly stdout: SafeProcessLogCategoryCounts;
  readonly stderr: SafeProcessLogCategoryCounts;
}

interface CleanupEvidence {
  context_closed: boolean;
  worker_stopped: boolean;
  dev_stopped: boolean;
  app_removed: boolean;
  profile_removed: boolean;
  postgres_removed: boolean;
  localstack_removed: boolean;
  clamav_removed: boolean;
  queues_and_objects_removed: boolean;
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

interface DocumentFixture {
  readonly status: number | null;
  readonly exact: boolean;
  readonly documentId: string | null;
  readonly recordVersion: number | null;
}

interface WriteEvidence {
  readonly status: number | null;
  readonly jsonParseable: boolean;
  readonly exactAck: boolean;
  readonly id: string | null;
  readonly version: number | null;
  readonly safeCode: SafeCode;
  readonly privateEcho: boolean;
}

interface SafeDocumentAuthorityEvidence {
  readonly fetchCompleted: boolean;
  readonly status: number | null;
  readonly jsonParseable: boolean;
  readonly state: SafeDocumentState;
  readonly pending: SafePendingUploadState;
}

interface ProcessStopEvidence {
  stopRequested: boolean;
  softCloseObserved: boolean;
  groupAliveAfterSoft: boolean;
  hardKillRequested: boolean;
  finalCloseObserved: boolean;
  finalGroupAbsent: boolean;
  stopped: boolean;
}

interface VersionChangedUiSnapshot {
  readonly successStatusCount: number;
  readonly successStatusVisible: boolean;
  readonly availableBadgeCount: number;
  readonly availableBadgeVisible: boolean;
  readonly alertCount: number;
  readonly unavailableAlertCount: number;
  readonly conflictAlertCount: number;
  readonly timeoutAlertCount: number;
}

interface PrivateUploadCapability {
  readonly url: string;
  readonly contentType: "application/pdf";
  readonly checksumBase64: string;
}

interface LatePutEvidence {
  readonly status: number;
  readonly providerVersionId: string | null;
}

interface ObjectVersionListingEvidence {
  readonly provider_version_count: number;
  readonly delete_marker_count: number;
  readonly expected_provider_versions_present: boolean;
  readonly expected_provider_versions_absent: boolean;
}

interface AbandonedCleanupDatabaseEvidence {
  readonly scan_results: number;
  readonly cleanup_audit: number;
  readonly cleanup_outbox: number;
  readonly scan_audit: number;
  readonly scan_outbox: number;
  readonly private_object_coordinate_matches: number;
  readonly abandoned_unbound: number;
  readonly active_pointer_null: number;
}

interface UnboundCleanupDatabaseEvidence {
  readonly scan_results: number;
  readonly cleanup_audit: number;
  readonly cleanup_outbox: number;
  readonly private_value_matches: number;
  readonly forbidden_field_matches: number;
  readonly available_bound: number;
  readonly active_pointer_bound: number;
  readonly bound_provider_version_id: string | null;
}

interface BoundObjectVersionListingEvidence {
  readonly provider_version_count: number;
  readonly delete_marker_count: number;
  readonly bound_provider_version_present: boolean;
  readonly unbound_provider_version_absent: boolean;
}

interface QueueDrainEvidence {
  readonly main_delete_requested_count: number;
  readonly main_delete_completed_count: number;
  readonly visible_count: number | null;
  readonly not_visible_count: number | null;
  readonly delayed_count: number | null;
  readonly attributes_complete: boolean;
  readonly poll_count: number;
  readonly worker_state: Exclude<SafeWorkerState, "unknown">;
  readonly drained: boolean;
}

interface RuntimeEnvironment {
  readonly connectionString: string;
  readonly localstackEndpoint: string;
  readonly clamavPort: number;
}

const PROCESS_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

test("DOC-02 uploads, scans and downloads through a real local browser", {
  timeout: 900_000,
}, async () => {
  let stage: Stage = "runtime_preflight";
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const postgresName = `tianxing-doc02-browser-pg17-${suffix}`;
  const localstackName = `tianxing-doc02-browser-localstack-${suffix}`;
  const clamavName = `tianxing-doc02-browser-clamav-${suffix}`;
  const volumeName = `tianxing-doc02-browser-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const actors = [FOUNDER, ADVISOR, ADMIN, DATA_REVIEWER, CONTRACTOR] as const;
  const passwords = new Map<Actor, string>(actors.map((actor) => [actor.role, randomBytes(32).toString("base64url")]));
  const evidence: Evidence = {
    baseline_generated_files: null,
    canonical_next_state: "unknown",
    canonical_request_started: false,
    canonical_fetch_completed: false,
    canonical_response_status: null,
    canonical_response_status_307: false,
    canonical_response_origin_exact: false,
    canonical_response_path_exact: false,
    canonical_redirect_count: null,
    canonical_location_present: false,
    canonical_location_parseable: false,
    canonical_location_origin_exact: false,
    canonical_location_path_exact: false,
    canonical_protocol_http: false,
    canonical_hostname_loopback: false,
    canonical_port_matches: false,
    canonical_credentials_absent: false,
    canonical_search_absent: false,
    canonical_hash_absent: false,
    canonical_returned_origin_exact: false,
    founder_login: emptyLoginEvidence(),
    founder_controls_visible: false,
    advisor_controls_visible: false,
    validation_zero_post: false,
    uncertain_retry_same_key: false,
    changed_file_rotates_key: false,
    synchronous_double_post_count: null,
    version_changed_post_request_started: false,
    version_changed_post_response_received: false,
    version_changed_post_status: null,
    version_changed_post_json_parseable: false,
    version_changed_post_receipt_exact: false,
    version_changed_post_safe_code: "OTHER",
    version_changed_detail_request_started: false,
    version_changed_detail_response_received: false,
    version_changed_detail_status: null,
    version_changed_intent_request_started: false,
    version_changed_intent_response_received: false,
    version_changed_intent_status: null,
    version_changed_intent_safe_code: "OTHER",
    version_changed_put_request_started: false,
    version_changed_put_response_received: false,
    version_changed_put_status: null,
    version_changed_worker_before: "unknown",
    version_changed_worker_after: "unknown",
    version_changed_worker_unavailable_marker_delta: null,
    version_changed_queue_visible_count: null,
    version_changed_queue_not_visible_count: null,
    version_changed_queue_delayed_count: null,
    version_changed_queue_attributes_complete: false,
    version_changed_authority_fetch_completed: false,
    version_changed_authority_status: null,
    version_changed_authority_json_parseable: false,
    version_changed_authority_state: "NONE",
    version_changed_authority_pending: "unknown",
    version_changed_success_status_count: null,
    version_changed_success_status_visible: false,
    version_changed_available_badge_count: null,
    version_changed_available_badge_visible: false,
    version_changed_alert_count: null,
    version_changed_unavailable_alert_count: null,
    version_changed_conflict_alert_count: null,
    version_changed_timeout_alert_count: null,
    version_receipt_exact: false,
    authoritative_detail_after_create: false,
    preclean_download_denied: false,
    clean_available: false,
    clean_download_exact_bytes: false,
    same_page_recovery_version_post_count: null,
    same_page_recovery_receipt_exact: false,
    same_page_recovery_pending_detail_status: null,
    same_page_recovery_pending_authoritative: false,
    same_page_recovery_intent_attempt_count: null,
    same_page_recovery_first_intent_uncertain: false,
    same_page_recovery_unavailable_feedback: false,
    same_page_recovery_file_preserved: false,
    same_page_recovery_retry_intent_status: null,
    same_page_recovery_put_status: null,
    same_page_recovery_zero_new_version_post: false,
    same_page_recovery_final_authority_available: false,
    same_page_recovery_success_feedback: false,
    same_page_recovery_private_transport_hidden: false,
    unbound_worker_stop_requested: false,
    unbound_worker_stop_soft_close_observed: false,
    unbound_worker_stop_group_alive_after_soft: false,
    unbound_worker_stop_hard_kill_requested: false,
    unbound_worker_stop_final_close_observed: false,
    unbound_worker_stop_final_group_absent: false,
    unbound_worker_stopped: false,
    unbound_same_capability_put_count: null,
    unbound_provider_version_ids_distinct: false,
    unbound_provider_version_count_before_cleanup: null,
    unbound_provider_version_count_after_cleanup: null,
    unbound_delete_marker_count_after_cleanup: null,
    unbound_bound_version_authoritative: false,
    unbound_bound_version_preserved: false,
    unbound_extra_version_absent: false,
    unbound_scan_fact_count: null,
    unbound_cleanup_audit_count: null,
    unbound_cleanup_outbox_count: null,
    unbound_cleanup_private_value_matches: null,
    unbound_cleanup_forbidden_field_matches: null,
    test_event_acknowledged: false,
    unbound_main_delete_requested_count: null,
    unbound_main_delete_completed_count: null,
    unbound_queue_visible_count: null,
    unbound_queue_not_visible_count: null,
    unbound_queue_delayed_count: null,
    unbound_queue_attributes_complete: false,
    unbound_queue_poll_count: null,
    unbound_queue_worker_state: "unknown",
    unbound_queue_drained: false,
    unbound_download_exact_bytes: false,
    unbound_replay_enqueued: false,
    unbound_replay_queue_observed: false,
    unbound_replay_main_delete_requested_count: null,
    unbound_replay_main_delete_completed_count: null,
    unbound_replay_queue_visible_count: null,
    unbound_replay_queue_not_visible_count: null,
    unbound_replay_queue_delayed_count: null,
    unbound_replay_queue_attributes_complete: false,
    unbound_replay_queue_poll_count: null,
    unbound_replay_queue_worker_state: "unknown",
    unbound_replay_queue_drained: false,
    unbound_replay_zero_extra_effects: false,
    keyboard_file_input_count: null,
    keyboard_file_input_visible: false,
    keyboard_file_input_enabled: false,
    keyboard_upload_button_count: null,
    keyboard_upload_button_visible: false,
    keyboard_upload_button_enabled: false,
    keyboard_initial_file_input_focused: false,
    keyboard_forward_upload_button_focused: false,
    keyboard_return_file_input_focused: false,
    keyboard_focus_returned: false,
    malicious_rejected: false,
    old_clean_retained: false,
    pending_recovery_persisted: false,
    pending_recovery_wrong_file_zero_put: false,
    pending_recovery_wrong_file_zero_new_version: false,
    pending_recovery_same_file_input_count: null,
    pending_recovery_same_file_input_visible: false,
    pending_recovery_same_file_input_enabled: false,
    pending_recovery_same_file_upload_button_count: null,
    pending_recovery_same_file_upload_button_visible: false,
    pending_recovery_same_file_upload_button_enabled: false,
    pending_recovery_same_file_intent_request_started: false,
    pending_recovery_same_file_intent_response_received: false,
    pending_recovery_same_file_intent_status: null,
    pending_recovery_same_file_intent_safe_code: "OTHER",
    pending_recovery_same_file_put_request_started: false,
    pending_recovery_same_file_put_response_received: false,
    pending_recovery_same_file_put_status: null,
    pending_recovery_same_file_authority_fetch_completed: false,
    pending_recovery_same_file_authority_status: null,
    pending_recovery_same_file_authority_json_parseable: false,
    pending_recovery_same_file_authority_state: "NONE",
    pending_recovery_same_file_authority_pending: "unknown",
    pending_recovery_same_file_worker_before: "unknown",
    pending_recovery_same_file_worker_after: "unknown",
    pending_recovery_same_file_success_status_count: null,
    pending_recovery_same_file_success_status_visible: false,
    pending_recovery_same_file_available_badge_count: null,
    pending_recovery_same_file_available_badge_visible: false,
    pending_recovery_same_file_alert_count: null,
    pending_recovery_same_file_recovery_conflict_alert_count: null,
    pending_recovery_same_file_conflict_alert_count: null,
    pending_recovery_same_file_timeout_alert_count: null,
    pending_recovery_same_file_unavailable_alert_count: null,
    pending_recovery_same_file_available: false,
    abandonment_uncertain_retry_same_key: false,
    abandonment_double_post_count: null,
    abandonment_receipt_exact: false,
    abandonment_replay_exact: false,
    abandonment_authoritative: false,
    abandonment_late_put_count: null,
    abandonment_late_provider_version_header_count: null,
    abandonment_late_provider_version_ids_distinct: false,
    abandonment_provider_version_count_before_cleanup: null,
    abandonment_delete_marker_count_before_cleanup: null,
    abandonment_provider_versions_exact_before_cleanup: false,
    abandonment_provider_version_count_after_cleanup: null,
    abandonment_delete_marker_count_after_cleanup: null,
    abandonment_provider_versions_exact_absent: false,
    abandonment_late_objects_cleaned: false,
    abandonment_scan_results_count: null,
    abandonment_cleanup_audit_count: null,
    abandonment_cleanup_outbox_count: null,
    abandonment_scan_audit_count: null,
    abandonment_scan_outbox_count: null,
    abandonment_private_object_coordinate_matches: null,
    abandonment_version_abandoned_unbound: false,
    abandonment_active_pointer_null: false,
    abandonment_never_scanned_or_downloadable: false,
    abandonment_new_version_available: false,
    abandonment_changed_authority_rotates_key: false,
    refresh_persistence: false,
    relogin_persistence: false,
    stale_visible: false,
    stale_authoritative_detail_status: null,
    stale_pending_recovery_visible: false,
    advisor_upload_available: false,
    advisor_download_exact_bytes: false,
    advisor_unassigned_not_found: false,
    denied_ui_hidden_count: 0,
    denied_direct_forbidden_count: 0,
    scan_failed_authoritative_detail_status: null,
    scan_failed_authoritative_state: false,
    scan_failed_fixed_feedback: false,
    scan_failed_download_disabled: false,
    scan_failed_clamav_recovered: false,
    desktop_viewport: null,
    mobile_viewport: null,
    page_errors: null,
    sensitive_log_matches: null,
    dev_process_log_captured: false,
    dev_process_stdout_frozen_private_matches: null,
    dev_process_stderr_frozen_private_matches: null,
    dev_process_stdout_standalone_business_route_id_matches: null,
    dev_process_stderr_standalone_business_route_id_matches: null,
    worker_process_count: null,
    worker_process_log_captured_count: null,
    worker_process_stdout_frozen_private_matches: null,
    worker_process_stderr_frozen_private_matches: null,
    worker_process_stdout_standalone_business_route_id_matches: null,
    worker_process_stderr_standalone_business_route_id_matches: null,
  };
  const cleanup: CleanupEvidence = {
    context_closed: false,
    worker_stopped: false,
    dev_stopped: false,
    app_removed: false,
    profile_removed: false,
    postgres_removed: false,
    localstack_removed: false,
    clamav_removed: false,
    queues_and_objects_removed: false,
    volume_removed: false,
  };
  let postgresStarted = false;
  let localstackStarted = false;
  let clamavStarted = false;
  let volumeCreated = false;
  let appDirectory = "";
  let profileDirectory = "";
  let devServer: ChildProcess | undefined;
  let worker: ChildProcess | undefined;
  const workerProcesses: ChildProcess[] = [];
  let context: BrowserContext | undefined;
  let failureStage: Stage | null = null;
  const requestPrivacyMarkers: string[] = [];
  let advisorVersionWrite = emptyWriteEvidence();

  try {
    assert.equal(MALICIOUS_BYTES.length, 68);
    assert.equal(MALICIOUS_BYTES.toString("ascii"), EICAR_FRAGMENTS.join(""));
    assert.equal(EICAR_FRAGMENTS.every((fragment) =>
      MALICIOUS_BYTES.includes(Buffer.from(fragment, "ascii"))), true);
    await Promise.all([access(DOCKER), access(process.execPath), access(CHROME)]);
    await Promise.all([
      runDocker(["image", "inspect", POSTGRES_IMAGE], stage),
      runDocker(["image", "inspect", LOCALSTACK_IMAGE], stage),
      runDocker(["image", "inspect", CLAMAV_IMAGE], stage),
    ]);
    const httpPort = await reserveLoopbackPort();
    const listenUrl = `http://127.0.0.1:${httpPort}`;
    const browserOrigin = `http://localhost:${httpPort}`;

    stage = "postgres_setup";
    await runDocker(["volume", "create", volumeName], stage);
    volumeCreated = true;
    await runDocker([
      "run", "--rm", "--interactive", "--pull=never",
      "--volume", `${volumeName}:/run/secrets`, POSTGRES_IMAGE,
      "/bin/sh", "-c", "umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password",
    ], stage, applicationPassword);
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", postgresName,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env", "POSTGRES_DB=tianxing", "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/local_postgres_password",
      "--volume", `${volumeName}:/run/secrets:ro`,
      "--volume", `${resolve("infra/local/postgres/init")}:/docker-entrypoint-initdb.d:ro`,
      "--volume", `${resolve("infra/local/postgres/healthcheck.sh")}:/usr/local/bin/tianxing-postgres-healthcheck:ro`,
      "--publish", "127.0.0.1::5432", POSTGRES_IMAGE,
    ], stage);
    postgresStarted = true;
    await waitForPostgres(postgresName);
    const postgresPort = readLoopbackPort(
      (await runDocker(["port", postgresName, "5432/tcp"], stage)).stdout,
      "postgres_setup",
    );
    const target = localTarget(postgresPort, applicationPassword);

    stage = "localstack_setup";
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", localstackName,
      "--env", "SERVICES=s3,sqs", "--env", `AWS_DEFAULT_REGION=${REGION}`,
      "--env", "AWS_ACCESS_KEY_ID=test", "--env", "AWS_SECRET_ACCESS_KEY=test",
      "--env", "SQS_ENDPOINT_STRATEGY=path",
      "--env", `LOCALSTACK_S3_BUCKET=${BUCKET}`, "--env", `LOCALSTACK_SQS_QUEUE=${QUEUE}`,
      "--env", `LOCALSTACK_SQS_DLQ=${DLQ}`, "--env", `LOCALSTACK_BROWSER_ORIGIN=${browserOrigin}`,
      "--volume", `${resolve("infra/local/localstack/init")}:/etc/localstack/init/ready.d:ro`,
      "--publish", "127.0.0.1::4566", LOCALSTACK_IMAGE,
    ], stage);
    localstackStarted = true;
    const localstackPort = await waitForPublishedPort(localstackName, "4566/tcp", stage);
    await waitForLocalStack(localstackName);

    stage = "clamav_setup";
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", clamavName,
      "--env", "CLAMD_STARTUP_TIMEOUT=300", "--publish", "127.0.0.1::3310", CLAMAV_IMAGE,
    ], stage);
    clamavStarted = true;
    const clamavPort = await waitForPublishedPort(clamavName, "3310/tcp", stage);
    await waitForClamAv(clamavPort);

    stage = "baseline_seed";
    const build = await verifyCommittedOneRoleBaseline();
    evidence.baseline_generated_files = build.files.length;
    assert.equal(build.files.length, 35);
    const baseline = await executeOneRoleBaselineRun({ mode: "apply", target, build, dependencies: baselineDependencies(target) });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.baseline_id, ONE_ROLE_BASELINE_ID);
    assert.equal((await seedNeonTestRelease1(target, "apply")).status, "pass");

    stage = "identity_provision";
    for (const actor of actors) assert.equal(await provision(target, actor.email, passwords.get(actor.role)!), "created");

    stage = "next_dev";
    appDirectory = await createIsolatedAppDirectory();
    profileDirectory = await mkdtemp(join(tmpdir(), "tianxing-doc02-chrome-"));
    const runtime = Object.freeze({
      connectionString: target.connectionString,
      localstackEndpoint: `http://127.0.0.1:${localstackPort}`,
      clamavPort,
    });
    devServer = startNextDev(appDirectory, httpPort, runtime);
    await waitForNextDev(listenUrl, devServer);

    stage = "document_worker";
    worker = startDocumentWorker(appDirectory, runtime);
    workerProcesses.push(worker);
    await waitForProcessLog(worker, WORKER_READY_MARKER, "document_worker");
    const testEventQueue = await waitForMainQueueDrainEvidence(
      localstackName,
      worker,
      1,
      "document_worker",
    );
    assert.equal(testEventQueue.main_delete_requested_count, 1);
    assert.equal(testEventQueue.main_delete_completed_count, 1);
    assert.equal(testEventQueue.attributes_complete, true);
    assert.equal(testEventQueue.visible_count, 0);
    assert.equal(testEventQueue.not_visible_count, 0);
    assert.equal(testEventQueue.delayed_count, 0);
    assert.equal(testEventQueue.worker_state, "alive");
    assert.equal(testEventQueue.drained, true);

    evidence.canonical_next_state = devServer === undefined
      ? "unknown" : processExited(devServer) ? "exited" : "alive";
    const baseUrl = await discoverCanonicalBaseUrl(
      listenUrl,
      browserOrigin,
      httpPort,
      evidence,
      (canonicalStage) => { stage = canonicalStage; },
    );
    stage = "canonical_origin_match";
    evidence.canonical_returned_origin_exact = baseUrl === browserOrigin;
    assert.equal(baseUrl, browserOrigin);

    stage = "chrome_launch";
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: CHROME,
      headless: true,
      baseURL: baseUrl,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    context.setDefaultTimeout(30_000);
    const page = context.pages()[0] ?? await context.newPage();
    const browserMessages: string[] = [];
    evidence.page_errors = 0;
    page.on("pageerror", () => {
      evidence.page_errors = (evidence.page_errors ?? 0) + 1;
    });
    page.on("console", (message) => { browserMessages.push(message.text()); });

    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!, {
      evidence: evidence.founder_login,
      setStage: (loginStage) => { stage = loginStage; },
    });

    stage = "case_fixture";
    const founderCase = await createCaseFixture(page, FOUNDER.roleBindingId, 2051);
    assert.equal(founderCase.status, 200);
    assert.equal(founderCase.exact, true);
    assert.notEqual(founderCase.caseId, null);

    stage = "document_fixture";
    const cleanDocument = await registerDocumentFixture(page, founderCase.caseId!, "Synthetic DOC-02 clean evidence");
    const staleDocument = await registerDocumentFixture(page, founderCase.caseId!, "Synthetic DOC-02 stale evidence");
    const recoveryDocument = await registerDocumentFixture(page, founderCase.caseId!, "Synthetic DOC-02 recovery evidence");
    const samePageRecoveryDocument = await registerDocumentFixture(
      page,
      founderCase.caseId!,
      "Synthetic DOC-02 same-page recovery evidence",
    );
    const abandonmentDocument = await registerDocumentFixture(page, founderCase.caseId!, "Synthetic DOC-02 abandonment evidence");
    const scanFailedDocument = await registerDocumentFixture(page, founderCase.caseId!, "Synthetic DOC-02 scan failure evidence");
    const unboundDocument = await registerDocumentFixture(page, founderCase.caseId!, "Synthetic DOC-02 unbound cleanup evidence");
    for (const fixture of [
      cleanDocument,
      staleDocument,
      recoveryDocument,
      samePageRecoveryDocument,
      abandonmentDocument,
      scanFailedDocument,
      unboundDocument,
    ]) {
      assert.equal(fixture.status, 201);
      assert.equal(fixture.exact, true);
      assert.notEqual(fixture.documentId, null);
      assert.equal(fixture.recordVersion, 1);
    }

    stage = "capability_controls";
    await openCaseDocuments(page, baseUrl, founderCase.caseId!);
    const cleanRow = documentRow(page, "Synthetic DOC-02 clean evidence");
    const cleanFileInput = cleanRow.getByLabel("選擇上載文件", { exact: true });
    const cleanUploadButton = cleanRow.getByRole("button", { name: "上載並掃描", exact: true });
    const cleanDownloadButton = cleanRow.getByRole("button", { name: "下載安全版本", exact: true });
    for (const control of [cleanFileInput, cleanUploadButton, cleanDownloadButton]) {
      await control.waitFor({ state: "visible" });
      assert.equal(await control.count(), 1);
    }
    evidence.founder_controls_visible = true;

    stage = "preclean_download_denied";
    assert.equal(await cleanDownloadButton.isDisabled(), true);
    const precleanMarker = `doc02-preclean-${randomBytes(8).toString("hex")}`;
    requestPrivacyMarkers.push(precleanMarker);
    const preclean = await directDownloadIntent(
      page,
      founderCase.caseId!,
      cleanDocument.documentId!,
      precleanMarker,
    );
    evidence.preclean_download_denied = preclean.status === 409 && preclean.safeCode === "CONFLICT" && !preclean.privateEcho;
    assert.equal(evidence.preclean_download_denied, true);

    stage = "client_validation";
    let validationPosts = 0;
    const versionPath = `/api/v1/cases/${founderCase.caseId}/documents/${cleanDocument.documentId}/versions`;
    const validationObserver = (request: { method(): string; url(): string }) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === versionPath) validationPosts += 1;
    };
    page.on("request", validationObserver);
    try {
      await cleanFileInput.setInputFiles({ name: "doc02-empty.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0) });
      await cleanRow.getByRole("alert").filter({ hasText: "請選擇一個 PDF、JPEG 或 PNG 文件" }).waitFor({ state: "visible" });
      evidence.validation_zero_post = validationPosts === 0;
    } finally {
      page.off("request", validationObserver);
    }
    assert.equal(evidence.validation_zero_post, true);

    const keys: string[] = [];
    let versionPosts = 0;
    let versionWrite: WriteEvidence = emptyWriteEvidence();
    let detailAfterCreateStatus: number | null = null;
    const detailObserver = (response: { request(): { method(): string }; url(): string; status(): number }) => {
      if (isGetPath(response, `/api/v1/cases/${founderCase.caseId}/documents/${cleanDocument.documentId}`)) {
        detailAfterCreateStatus = response.status();
      }
    };
    page.on("response", detailObserver);
    await page.route(`**${versionPath}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      versionPosts += 1;
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (versionPosts <= 2) return route.abort("timedout");
      const response = await route.fetch();
      versionWrite = safeWriteEvidence(response.status(), await response.text(), 1);
      await route.fulfill({ response });
    });

    stage = "version_retry_first";
    await cleanFileInput.setInputFiles({ name: CLEAN_FILE_NAME, mimeType: "application/pdf", buffer: CLEAN_BYTES });
    await cleanUploadButton.click();
    await transferUnavailableNotice(cleanRow);

    stage = "version_retry_second";
    await cleanUploadButton.click();
    await transferUnavailableNotice(cleanRow);
    evidence.uncertain_retry_same_key = keys[0] !== "" && keys[0] === keys[1];
    assert.equal(evidence.uncertain_retry_same_key, true);

    stage = "version_changed_submit";
    await cleanFileInput.setInputFiles({ name: CHANGED_FILE_NAME, mimeType: "application/pdf", buffer: CHANGED_CLEAN_BYTES });
    stage = "version_changed_worker";
    evidence.version_changed_worker_before = worker === undefined
      ? "unknown" : processExited(worker) ? "exited" : "alive";
    const versionChangedWorkerUnavailableBefore = worker === undefined
      ? null : countWorkerUnavailableMarker(worker);
    const cleanDetailPath = `/api/v1/cases/${founderCase.caseId}/documents/${cleanDocument.documentId}`;
    const matchesChangedUploadIntent = (method: string, requestUrl: string) => {
      if (method !== "POST") return false;
      const pathname = new URL(requestUrl).pathname;
      if (!pathname.startsWith(`${versionPath}/`)) return false;
      const segments = pathname.slice(versionPath.length + 1).split("/");
      return segments.length === 2 && segments[0] !== "" && segments[1] === "upload-intents";
    };
    const versionChangedPostRequestWait = controlledWait(page.waitForRequest((request) =>
      isRequestPath(request, "POST", versionPath)));
    const versionChangedPostResponseWait = controlledWait(page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === versionPath));
    const versionChangedDetailRequestWait = controlledWait(page.waitForRequest((request) =>
      isRequestPath(request, "GET", cleanDetailPath)));
    const versionChangedDetailResponseWait = controlledWait(page.waitForResponse((response) =>
      isGetPath(response, cleanDetailPath)));
    const versionChangedIntentRequestWait = controlledWait(page.waitForRequest((request) =>
      matchesChangedUploadIntent(request.method(), request.url())));
    const versionChangedIntentResponseWait = controlledWait(page.waitForResponse((response) =>
      matchesChangedUploadIntent(response.request().method(), response.url())));
    const versionChangedPrivateSignedTargetWait = controlledWait((async () => {
      const intentResponse = await versionChangedIntentResponseWait;
      return intentResponse === null ? null : readPrivateSignedUploadTarget(
        intentResponse,
        runtime.localstackEndpoint,
        CHANGED_CLEAN_BYTES,
      );
    })());
    const versionChangedPutRequestWait = controlledWait(page.waitForRequest(async (request) => {
      const privateSignedTarget = await versionChangedPrivateSignedTargetWait;
      return request.method() === "PUT" && privateSignedTarget !== null
        && new URL(request.url()).href === privateSignedTarget;
    }));
    const versionChangedPutResponseWait = controlledWait(page.waitForResponse(async (response) => {
      const privateSignedTarget = await versionChangedPrivateSignedTargetWait;
      return response.request().method() === "PUT" && privateSignedTarget !== null
        && new URL(response.url()).href === privateSignedTarget;
    }));
    const versionChangedTransportProgress = controlledWait((async () => {
      stage = "version_changed_post_transport";
      const [postRequest, postResponse] = await Promise.all([
        versionChangedPostRequestWait,
        versionChangedPostResponseWait,
      ]);
      evidence.version_changed_post_request_started = postRequest !== null;
      evidence.version_changed_post_response_received = postResponse !== null;
      evidence.version_changed_post_status = postResponse?.status() ?? null;
      if (postRequest === null || postResponse === null) return;

      stage = "version_changed_receipt_contract";
      evidence.version_changed_post_json_parseable = versionWrite.jsonParseable;
      evidence.version_changed_post_receipt_exact = versionWrite.exactAck;
      evidence.version_changed_post_safe_code = versionWrite.safeCode;

      stage = "version_changed_detail_refresh";
      const [detailRequest, detailResponse] = await Promise.all([
        versionChangedDetailRequestWait,
        versionChangedDetailResponseWait,
      ]);
      evidence.version_changed_detail_request_started = detailRequest !== null;
      evidence.version_changed_detail_response_received = detailResponse !== null;
      evidence.version_changed_detail_status = detailResponse?.status() ?? null;
      if (detailRequest === null || detailResponse === null) return;

      stage = "version_changed_upload_intent";
      const [intentRequest, intentResponse] = await Promise.all([
        versionChangedIntentRequestWait,
        versionChangedIntentResponseWait,
      ]);
      evidence.version_changed_intent_request_started = intentRequest !== null;
      evidence.version_changed_intent_response_received = intentResponse !== null;
      evidence.version_changed_intent_status = intentResponse?.status() ?? null;
      evidence.version_changed_intent_safe_code = await safePlaywrightResponseCode(intentResponse);
      if (intentRequest === null || intentResponse === null) return;

      stage = "version_changed_put";
      const [putRequest, putResponse] = await Promise.all([
        versionChangedPutRequestWait,
        versionChangedPutResponseWait,
      ]);
      evidence.version_changed_put_request_started = putRequest !== null;
      evidence.version_changed_put_response_received = putResponse !== null;
      evidence.version_changed_put_status = putResponse?.status() ?? null;
      stage = "version_changed_worker";
      stage = "version_changed_feedback";
    })());
    const beforeDouble = versionPosts;
    let versionChangedFailure: unknown;
    let versionChangedFailed = false;
    try {
      await cleanUploadButton.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      stage = "version_changed_feedback";
      await cleanRow.getByRole("status").filter({ hasText: "掃描完成，安全版本已可下載。" })
        .waitFor({ state: "visible", timeout: 90_000 });
      evidence.changed_file_rotates_key = keys[2] !== "" && keys[2] !== keys[1];
      evidence.synchronous_double_post_count = versionPosts - beforeDouble;
      assert.equal(evidence.changed_file_rotates_key, true);
      assert.equal(evidence.synchronous_double_post_count, 1);
    } catch (error) {
      versionChangedFailed = true;
      versionChangedFailure = error;
    } finally {
      page.off("response", detailObserver);
      await boundedDiagnostic(async () => {
        await Promise.all([
          versionChangedTransportProgress,
          versionChangedPostRequestWait,
          versionChangedPostResponseWait,
          versionChangedDetailRequestWait,
          versionChangedDetailResponseWait,
          versionChangedIntentRequestWait,
          versionChangedIntentResponseWait,
          versionChangedPrivateSignedTargetWait,
          versionChangedPutRequestWait,
          versionChangedPutResponseWait,
        ]);
      }, undefined);
      const [authority, queueCounts, uiSnapshot] = await Promise.all([
        boundedDiagnostic(() => readSafeDocumentAuthority(
          page,
          founderCase.caseId!,
          cleanDocument.documentId!,
        ), null),
        versionChangedFailed
          ? boundedDiagnostic(
            () => readMainQueueCounts(localstackName, "version_changed_feedback"),
            null,
          )
          : Promise.resolve(null),
        boundedDiagnostic(() => readVersionChangedUiSnapshot(cleanRow), null),
      ]);
      if (authority !== null) {
        evidence.version_changed_authority_fetch_completed = authority.fetchCompleted;
        evidence.version_changed_authority_status = authority.status;
        evidence.version_changed_authority_json_parseable = authority.jsonParseable;
        evidence.version_changed_authority_state = authority.state;
        evidence.version_changed_authority_pending = authority.pending;
      }
      evidence.version_changed_worker_after = worker === undefined
        ? "unknown" : processExited(worker) ? "exited" : "alive";
      const versionChangedWorkerUnavailableAfter = worker === undefined
        ? null : countWorkerUnavailableMarker(worker);
      evidence.version_changed_worker_unavailable_marker_delta =
        versionChangedWorkerUnavailableBefore === null || versionChangedWorkerUnavailableAfter === null
          ? null : versionChangedWorkerUnavailableAfter - versionChangedWorkerUnavailableBefore;
      if (versionChangedFailed) {
        evidence.version_changed_queue_attributes_complete = queueCounts !== null;
        evidence.version_changed_queue_visible_count = queueCounts?.[0] ?? null;
        evidence.version_changed_queue_not_visible_count = queueCounts?.[1] ?? null;
        evidence.version_changed_queue_delayed_count = queueCounts?.[2] ?? null;
      }
      if (uiSnapshot !== null) {
        evidence.version_changed_success_status_count = uiSnapshot.successStatusCount;
        evidence.version_changed_success_status_visible = uiSnapshot.successStatusVisible;
        evidence.version_changed_available_badge_count = uiSnapshot.availableBadgeCount;
        evidence.version_changed_available_badge_visible = uiSnapshot.availableBadgeVisible;
        evidence.version_changed_alert_count = uiSnapshot.alertCount;
        evidence.version_changed_unavailable_alert_count = uiSnapshot.unavailableAlertCount;
        evidence.version_changed_conflict_alert_count = uiSnapshot.conflictAlertCount;
        evidence.version_changed_timeout_alert_count = uiSnapshot.timeoutAlertCount;
      }
    }
    if (versionChangedFailed) throw versionChangedFailure;
    await page.unroute(`**${versionPath}`);
    page.off("response", detailObserver);

    stage = "version_receipt";
    evidence.version_receipt_exact = versionWrite.status === 201 && versionWrite.exactAck && versionWrite.id !== null;
    evidence.authoritative_detail_after_create = detailAfterCreateStatus === 200;
    assert.equal(evidence.version_receipt_exact, true);
    assert.equal(evidence.authoritative_detail_after_create, true);

    stage = "clean_scan";
    await cleanRow.getByText("可使用", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await cleanDownloadButton.isEnabled(), true);
    evidence.clean_available = true;

    stage = "keyboard_focus_initial";
    evidence.keyboard_file_input_count = await cleanFileInput.count();
    evidence.keyboard_file_input_visible = evidence.keyboard_file_input_count === 1 && await cleanFileInput.isVisible();
    evidence.keyboard_file_input_enabled = evidence.keyboard_file_input_count === 1 && await cleanFileInput.isEnabled();
    evidence.keyboard_upload_button_count = await cleanUploadButton.count();
    evidence.keyboard_upload_button_visible = evidence.keyboard_upload_button_count === 1 && await cleanUploadButton.isVisible();
    evidence.keyboard_upload_button_enabled = evidence.keyboard_upload_button_count === 1 && await cleanUploadButton.isEnabled();
    evidence.keyboard_initial_file_input_focused = await cleanFileInput.evaluate((input) => input === document.activeElement);

    stage = "keyboard_focus_forward";
    await cleanFileInput.press("Tab");
    evidence.keyboard_forward_upload_button_focused = await cleanUploadButton.evaluate((button) => button === document.activeElement);

    stage = "keyboard_focus_return";
    await page.keyboard.press("Shift+Tab");
    evidence.keyboard_return_file_input_focused = await cleanFileInput.evaluate((input) => input === document.activeElement);
    evidence.keyboard_focus_returned = evidence.keyboard_initial_file_input_focused
      && evidence.keyboard_forward_upload_button_focused
      && evidence.keyboard_return_file_input_focused;
    assert.equal(evidence.keyboard_focus_returned, true);

    stage = "clean_download";
    evidence.clean_download_exact_bytes = await downloadAndCompare(page, cleanDownloadButton, CHANGED_CLEAN_BYTES);
    assert.equal(evidence.clean_download_exact_bytes, true);

    const samePageRecoveryRow = documentRow(page, "Synthetic DOC-02 same-page recovery evidence");
    const samePageRecoveryFileInput = samePageRecoveryRow.getByLabel("選擇上載文件", { exact: true });
    const samePageRecoveryUploadButton = samePageRecoveryRow.getByRole(
      "button",
      { name: "上載並掃描", exact: true },
    );
    const samePageRecoveryVersionPath =
      `/api/v1/cases/${founderCase.caseId}/documents/${samePageRecoveryDocument.documentId}/versions`;
    const samePageRecoveryDetailPath =
      `/api/v1/cases/${founderCase.caseId}/documents/${samePageRecoveryDocument.documentId}`;
    let samePageRecoveryVersionPosts = 0;
    let samePageRecoveryIntentAttempts = 0;
    let samePageRecoveryFirstIntentAborted = false;
    let samePageRecoveryWrite = emptyWriteEvidence();
    let samePageRecoveryPrivateSignedTarget: string | null = null;
    await page.route(`**${samePageRecoveryVersionPath}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      samePageRecoveryVersionPosts += 1;
      evidence.same_page_recovery_version_post_count = samePageRecoveryVersionPosts;
      const response = await route.fetch();
      samePageRecoveryWrite = safeWriteEvidence(response.status(), await response.text(), 1);
      await route.fulfill({ response });
    });
    await page.route(`**${samePageRecoveryVersionPath}/*/upload-intents`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      samePageRecoveryIntentAttempts += 1;
      evidence.same_page_recovery_intent_attempt_count = samePageRecoveryIntentAttempts;
      if (samePageRecoveryIntentAttempts === 1) {
        samePageRecoveryFirstIntentAborted = true;
        return route.abort("timedout");
      }
      return route.continue();
    });
    try {
      stage = "same_page_recovery_first_submit";
      const samePagePendingDetailResponseWait = controlledWait(page.waitForResponse((response) =>
        isGetPath(response, samePageRecoveryDetailPath)));
      await samePageRecoveryFileInput.setInputFiles({
        name: SAME_PAGE_RECOVERY_FILE_NAME,
        mimeType: "application/pdf",
        buffer: SAME_PAGE_RECOVERY_BYTES,
      });
      await samePageRecoveryUploadButton.click();

      stage = "same_page_recovery_uncertain_intent";
      const samePageUnavailableAlert = samePageRecoveryRow.getByRole("alert")
        .filter({ hasText: "結果暫時無法確認，請稍後重試；重試不會重複建立版本。" });
      await samePageUnavailableAlert.waitFor({ state: "visible" });
      evidence.same_page_recovery_first_intent_uncertain = samePageRecoveryFirstIntentAborted
        && samePageRecoveryIntentAttempts === 1;
      evidence.same_page_recovery_unavailable_feedback = await samePageUnavailableAlert.isVisible();
      evidence.same_page_recovery_receipt_exact = samePageRecoveryWrite.status === 201
        && samePageRecoveryWrite.exactAck && samePageRecoveryWrite.id !== null;
      assert.equal(evidence.same_page_recovery_receipt_exact, true);
      assert.notEqual(samePageRecoveryWrite.id, null);

      stage = "same_page_recovery_pending_authority";
      const samePagePendingDetailResponse = await samePagePendingDetailResponseWait;
      evidence.same_page_recovery_pending_detail_status = samePagePendingDetailResponse?.status() ?? null;
      const samePageContinueButton = samePageRecoveryRow.getByRole(
        "button",
        { name: "繼續上載並掃描", exact: true },
      );
      await samePageRecoveryRow.getByText("等待上載", { exact: true }).waitFor({ state: "visible" });
      await samePageContinueButton.waitFor({ state: "visible" });
      evidence.same_page_recovery_pending_authoritative =
        evidence.same_page_recovery_pending_detail_status === 200 && await samePageContinueButton.isEnabled();
      evidence.same_page_recovery_file_preserved = await samePageRecoveryRow.locator('input[type="file"]')
        .evaluate((input) => (input as HTMLInputElement).files?.length === 1);

      const samePageRetryIntentPath = `${samePageRecoveryVersionPath}/${samePageRecoveryWrite.id}/upload-intents`;
      const samePageRetryIntentResponseWait = controlledWait(page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === samePageRetryIntentPath));
      const samePageRetryPrivateSignedTargetWait = controlledWait((async () => {
        const response = await samePageRetryIntentResponseWait;
        return response === null ? null : readPrivateSignedUploadTarget(
          response,
          runtime.localstackEndpoint,
          SAME_PAGE_RECOVERY_BYTES,
        );
      })());
      const samePageRetryPutRequestWait = controlledWait(page.waitForRequest(async (request) => {
        const privateSignedTarget = await samePageRetryPrivateSignedTargetWait;
        return request.method() === "PUT" && privateSignedTarget !== null
          && new URL(request.url()).href === privateSignedTarget;
      }));
      const samePageRetryPutResponseWait = controlledWait(page.waitForResponse(async (response) => {
        const privateSignedTarget = await samePageRetryPrivateSignedTargetWait;
        return response.request().method() === "PUT" && privateSignedTarget !== null
          && new URL(response.url()).href === privateSignedTarget;
      }));
      const samePageRetryProgress = controlledWait((async () => {
        const intentResponse = await samePageRetryIntentResponseWait;
        evidence.same_page_recovery_retry_intent_status = intentResponse?.status() ?? null;
        if (intentResponse === null) return;
        stage = "same_page_recovery_put";
        const [putRequest, putResponse] = await Promise.all([
          samePageRetryPutRequestWait,
          samePageRetryPutResponseWait,
        ]);
        evidence.same_page_recovery_put_status = putRequest === null ? null : putResponse?.status() ?? null;
        if (putRequest !== null && putResponse !== null) stage = "same_page_recovery_feedback";
      })());

      stage = "same_page_recovery_retry";
      const versionPostsBeforeRetry = samePageRecoveryVersionPosts;
      await samePageContinueButton.click();
      stage = "same_page_recovery_feedback";
      const samePageSuccessStatus = samePageRecoveryRow.getByRole("status")
        .filter({ hasText: "掃描完成，安全版本已可下載。" });
      await samePageSuccessStatus.waitFor({ state: "visible", timeout: 90_000 });
      await Promise.all([
        samePageRetryProgress,
        samePageRetryIntentResponseWait,
        samePageRetryPrivateSignedTargetWait,
        samePageRetryPutRequestWait,
        samePageRetryPutResponseWait,
      ]);
      evidence.same_page_recovery_zero_new_version_post = versionPostsBeforeRetry === 1
        && samePageRecoveryVersionPosts === 1;
      evidence.same_page_recovery_version_post_count = samePageRecoveryVersionPosts;
      evidence.same_page_recovery_intent_attempt_count = samePageRecoveryIntentAttempts;

      stage = "same_page_recovery_authority";
      const samePageFinalAuthority = await readSafeDocumentAuthority(
        page,
        founderCase.caseId!,
        samePageRecoveryDocument.documentId!,
      );
      evidence.same_page_recovery_final_authority_available = samePageFinalAuthority.fetchCompleted
        && samePageFinalAuthority.status === 200 && samePageFinalAuthority.jsonParseable
        && samePageFinalAuthority.state === "available" && samePageFinalAuthority.pending === "absent";

      stage = "same_page_recovery_feedback";
      evidence.same_page_recovery_success_feedback = await samePageSuccessStatus.isVisible()
        && await samePageRecoveryRow.getByRole("alert").count() === 0;
      samePageRecoveryPrivateSignedTarget = await samePageRetryPrivateSignedTargetWait;
      assert.notEqual(samePageRecoveryPrivateSignedTarget, null);
      const samePageRowText = await samePageRecoveryRow.innerText();
      evidence.same_page_recovery_private_transport_hidden = [
        samePageRecoveryPrivateSignedTarget!,
        sha256Hex(SAME_PAGE_RECOVERY_BYTES),
        createHash("sha256").update(SAME_PAGE_RECOVERY_BYTES).digest("base64"),
      ].every((privateValue) => !samePageRowText.includes(privateValue));

      assert.equal(evidence.same_page_recovery_first_intent_uncertain, true);
      assert.equal(evidence.same_page_recovery_unavailable_feedback, true);
      assert.equal(evidence.same_page_recovery_pending_authoritative, true);
      assert.equal(evidence.same_page_recovery_file_preserved, true);
      assert.equal(evidence.same_page_recovery_retry_intent_status, 200);
      assert.equal(
        evidence.same_page_recovery_put_status !== null
          && evidence.same_page_recovery_put_status >= 200
          && evidence.same_page_recovery_put_status < 300,
        true,
      );
      assert.equal(evidence.same_page_recovery_intent_attempt_count, 2);
      assert.equal(evidence.same_page_recovery_zero_new_version_post, true);
      assert.equal(evidence.same_page_recovery_final_authority_available, true);
      assert.equal(evidence.same_page_recovery_success_feedback, true);
      assert.equal(evidence.same_page_recovery_private_transport_hidden, true);
    } finally {
      await page.unroute(`**${samePageRecoveryVersionPath}/*/upload-intents`);
      await page.unroute(`**${samePageRecoveryVersionPath}`);
    }

    stage = "unbound_fixture";
    const unboundWorkerStop = emptyProcessStopEvidence();
    evidence.unbound_worker_stopped = await stopProcess(worker, unboundWorkerStop);
    evidence.unbound_worker_stop_requested = unboundWorkerStop.stopRequested;
    evidence.unbound_worker_stop_soft_close_observed = unboundWorkerStop.softCloseObserved;
    evidence.unbound_worker_stop_group_alive_after_soft = unboundWorkerStop.groupAliveAfterSoft;
    evidence.unbound_worker_stop_hard_kill_requested = unboundWorkerStop.hardKillRequested;
    evidence.unbound_worker_stop_final_close_observed = unboundWorkerStop.finalCloseObserved;
    evidence.unbound_worker_stop_final_group_absent = unboundWorkerStop.finalGroupAbsent;
    assert.equal(evidence.unbound_worker_stop_requested, true);
    assert.equal(evidence.unbound_worker_stop_final_group_absent, true);
    assert.equal(evidence.unbound_worker_stopped, true);
    worker = undefined;
    const unboundVersion = await directCreateVersion(
      page,
      founderCase.caseId!,
      unboundDocument.documentId!,
      CLEAN_BYTES,
      unboundDocument.recordVersion!,
      `doc02-unbound-version-${randomBytes(8).toString("hex")}`,
    );
    assert.equal(unboundVersion.status, 201);
    assert.equal(unboundVersion.exactAck, true);
    assert.notEqual(unboundVersion.id, null);
    const unboundObjectKey = `documents/${unboundDocument.documentId}/versions/${unboundVersion.id}`;
    const unboundCapability = await directIssueUploadCapability(
      page,
      founderCase.caseId!,
      unboundDocument.documentId!,
      unboundVersion.id!,
      CLEAN_BYTES,
      runtime.localstackEndpoint,
      BUCKET,
      unboundObjectKey,
    );
    assert.notEqual(unboundCapability, null);

    stage = "unbound_worker_pause";
    const unboundPutResponses = await Promise.all([
      putLateObject(unboundCapability!, CLEAN_BYTES),
      putLateObject(unboundCapability!, CLEAN_BYTES),
    ]);
    evidence.unbound_same_capability_put_count = unboundPutResponses.filter(({ status }) =>
      status >= 200 && status < 300).length;
    const unboundProviderVersionIds = unboundPutResponses.flatMap(({ providerVersionId }) =>
      providerVersionId === null ? [] : [providerVersionId]);
    evidence.unbound_provider_version_ids_distinct = unboundProviderVersionIds.length === 2
      && new Set(unboundProviderVersionIds).size === 2;
    assert.equal(evidence.unbound_same_capability_put_count, 2);
    assert.equal(evidence.unbound_provider_version_ids_distinct, true);

    stage = "unbound_provider_versions";
    const unboundBeforeCleanup = await waitForObjectVersionListing(
      localstackName,
      unboundObjectKey,
      unboundProviderVersionIds,
      "present",
      "unbound_provider_versions",
    );
    evidence.unbound_provider_version_count_before_cleanup = unboundBeforeCleanup.provider_version_count;
    assert.equal(evidence.unbound_provider_version_count_before_cleanup, 2);
    assert.equal(unboundBeforeCleanup.delete_marker_count, 0);
    assert.equal(unboundBeforeCleanup.expected_provider_versions_present, true);

    stage = "unbound_cleanup";
    worker = startDocumentWorker(appDirectory, runtime);
    workerProcesses.push(worker);
    await waitForProcessLog(worker, WORKER_READY_MARKER, "unbound_cleanup");
    const unboundDatabase = await waitForUnboundCleanupDatabaseEvidence(
      target,
      unboundDocument.documentId!,
      unboundVersion.id!,
      unboundProviderVersionIds,
      [
        unboundObjectKey,
        ...unboundProviderVersionIds,
        unboundCapability!.url,
        unboundCapability!.checksumBase64,
        sha256Hex(CLEAN_BYTES),
      ],
      "unbound_cleanup",
    );
    const boundProviderVersionId = unboundDatabase.bound_provider_version_id;
    assert.notEqual(boundProviderVersionId, null);
    const unboundProviderVersionId = unboundProviderVersionIds.find((providerVersionId) =>
      providerVersionId !== boundProviderVersionId) ?? null;
    assert.notEqual(unboundProviderVersionId, null);
    const unboundAfterCleanup = await waitForBoundObjectVersionOnly(
      localstackName,
      unboundObjectKey,
      boundProviderVersionId!,
      unboundProviderVersionId!,
      "unbound_cleanup",
    );
    evidence.unbound_provider_version_count_after_cleanup = unboundAfterCleanup.provider_version_count;
    evidence.unbound_delete_marker_count_after_cleanup = unboundAfterCleanup.delete_marker_count;
    evidence.unbound_bound_version_authoritative = unboundDatabase.available_bound === 1
      && unboundDatabase.active_pointer_bound === 1;
    evidence.unbound_bound_version_preserved = unboundAfterCleanup.bound_provider_version_present;
    evidence.unbound_extra_version_absent = unboundAfterCleanup.unbound_provider_version_absent;
    evidence.unbound_scan_fact_count = unboundDatabase.scan_results;
    evidence.unbound_cleanup_audit_count = unboundDatabase.cleanup_audit;
    evidence.unbound_cleanup_outbox_count = unboundDatabase.cleanup_outbox;
    evidence.unbound_cleanup_private_value_matches = unboundDatabase.private_value_matches;
    evidence.unbound_cleanup_forbidden_field_matches = unboundDatabase.forbidden_field_matches;
    assert.equal(evidence.unbound_provider_version_count_after_cleanup, 1);
    assert.equal(evidence.unbound_delete_marker_count_after_cleanup, 0);
    assert.equal(evidence.unbound_bound_version_authoritative, true);
    assert.equal(evidence.unbound_bound_version_preserved, true);
    assert.equal(evidence.unbound_extra_version_absent, true);
    assert.equal(evidence.unbound_scan_fact_count, 1);
    assert.equal(evidence.unbound_cleanup_audit_count, 1);
    assert.equal(evidence.unbound_cleanup_outbox_count, 1);
    assert.equal(evidence.unbound_cleanup_private_value_matches, 0);
    assert.equal(evidence.unbound_cleanup_forbidden_field_matches, 0);

    stage = "unbound_queue_drain";
    const unboundQueue = await waitForMainQueueDrainEvidence(
      localstackName,
      worker,
      2,
      "unbound_queue_drain",
    );
    evidence.unbound_main_delete_requested_count =
      testEventQueue.main_delete_requested_count + unboundQueue.main_delete_requested_count;
    evidence.unbound_main_delete_completed_count =
      testEventQueue.main_delete_completed_count + unboundQueue.main_delete_completed_count;
    evidence.unbound_queue_visible_count = unboundQueue.visible_count;
    evidence.unbound_queue_not_visible_count = unboundQueue.not_visible_count;
    evidence.unbound_queue_delayed_count = unboundQueue.delayed_count;
    evidence.unbound_queue_attributes_complete = unboundQueue.attributes_complete;
    evidence.unbound_queue_poll_count = unboundQueue.poll_count;
    evidence.unbound_queue_worker_state = unboundQueue.worker_state;
    evidence.unbound_queue_drained = unboundQueue.drained;
    evidence.test_event_acknowledged =
      evidence.unbound_main_delete_requested_count === 3 &&
      evidence.unbound_main_delete_completed_count === 3 &&
      evidence.unbound_scan_fact_count === 1 &&
      evidence.unbound_cleanup_audit_count === 1 &&
      evidence.unbound_cleanup_outbox_count === 1;
    assert.equal(evidence.unbound_main_delete_requested_count, 3);
    assert.equal(evidence.unbound_main_delete_completed_count, 3);
    assert.equal(evidence.test_event_acknowledged, true);
    assert.equal(evidence.unbound_queue_visible_count, 0);
    assert.equal(evidence.unbound_queue_not_visible_count, 0);
    assert.equal(evidence.unbound_queue_delayed_count, 0);
    assert.equal(evidence.unbound_queue_attributes_complete, true);
    assert.equal(
      evidence.unbound_queue_poll_count !== null &&
        evidence.unbound_queue_poll_count >= 1 &&
        evidence.unbound_queue_poll_count <= QUEUE_DRAIN_MAX_POLLS,
      true,
    );
    assert.equal(evidence.unbound_queue_worker_state, "alive");
    assert.equal(evidence.unbound_queue_drained, true);

    stage = "unbound_authority";
    await page.reload({ waitUntil: "domcontentloaded" });
    const unboundRow = documentRow(page, "Synthetic DOC-02 unbound cleanup evidence");
    await unboundRow.getByText("可使用", { exact: true }).waitFor({ state: "visible" });
    const unboundDownloadButton = unboundRow.getByRole("button", { name: "下載安全版本", exact: true });
    assert.equal(await unboundDownloadButton.isEnabled(), true);

    stage = "unbound_download";
    evidence.unbound_download_exact_bytes = await downloadAndCompare(page, unboundDownloadButton, CLEAN_BYTES);
    assert.equal(evidence.unbound_download_exact_bytes, true);

    stage = "unbound_replay";
    assert.equal(evidence.unbound_queue_drained, true);
    assert.equal(await stopProcess(worker), true);
    worker = undefined;
    evidence.unbound_replay_enqueued = await sendUnboundProviderVersionReplay(
      localstackName,
      unboundObjectKey,
      unboundProviderVersionId!,
    );
    assert.equal(evidence.unbound_replay_enqueued, true);
    evidence.unbound_replay_queue_observed = await waitForMainQueueMessage(localstackName, "unbound_replay");
    assert.equal(evidence.unbound_replay_queue_observed, true);
    worker = startDocumentWorker(appDirectory, runtime);
    workerProcesses.push(worker);
    await waitForProcessLog(worker, WORKER_READY_MARKER, "unbound_replay");
    const unboundReplayQueue = await waitForMainQueueDrainEvidence(
      localstackName,
      worker,
      1,
      "unbound_replay",
    );
    evidence.unbound_replay_main_delete_requested_count =
      unboundReplayQueue.main_delete_requested_count;
    evidence.unbound_replay_main_delete_completed_count =
      unboundReplayQueue.main_delete_completed_count;
    evidence.unbound_replay_queue_visible_count = unboundReplayQueue.visible_count;
    evidence.unbound_replay_queue_not_visible_count = unboundReplayQueue.not_visible_count;
    evidence.unbound_replay_queue_delayed_count = unboundReplayQueue.delayed_count;
    evidence.unbound_replay_queue_attributes_complete = unboundReplayQueue.attributes_complete;
    evidence.unbound_replay_queue_poll_count = unboundReplayQueue.poll_count;
    evidence.unbound_replay_queue_worker_state = unboundReplayQueue.worker_state;
    evidence.unbound_replay_queue_drained = unboundReplayQueue.drained;
    assert.equal(evidence.unbound_replay_main_delete_requested_count, 1);
    assert.equal(evidence.unbound_replay_main_delete_completed_count, 1);
    assert.equal(evidence.unbound_replay_queue_visible_count, 0);
    assert.equal(evidence.unbound_replay_queue_not_visible_count, 0);
    assert.equal(evidence.unbound_replay_queue_delayed_count, 0);
    assert.equal(evidence.unbound_replay_queue_attributes_complete, true);
    assert.equal(
      evidence.unbound_replay_queue_poll_count !== null &&
        evidence.unbound_replay_queue_poll_count >= 1 &&
        evidence.unbound_replay_queue_poll_count <= QUEUE_DRAIN_MAX_POLLS,
      true,
    );
    assert.equal(evidence.unbound_replay_queue_worker_state, "alive");
    assert.equal(evidence.unbound_replay_queue_drained, true);

    stage = "unbound_replay_database";
    const unboundAfterReplay = await waitForUnboundCleanupDatabaseEvidence(
      target,
      unboundDocument.documentId!,
      unboundVersion.id!,
      unboundProviderVersionIds,
      [
        unboundObjectKey,
        ...unboundProviderVersionIds,
        unboundCapability!.url,
        unboundCapability!.checksumBase64,
        sha256Hex(CLEAN_BYTES),
      ],
      "unbound_replay_database",
    );
    const unboundListingAfterReplay = await waitForBoundObjectVersionOnly(
      localstackName,
      unboundObjectKey,
      boundProviderVersionId!,
      unboundProviderVersionId!,
      "unbound_replay_database",
    );
    evidence.unbound_replay_zero_extra_effects = unboundAfterReplay.scan_results === 1
      && unboundAfterReplay.cleanup_audit === 1 && unboundAfterReplay.cleanup_outbox === 1
      && unboundAfterReplay.private_value_matches === 0
      && unboundAfterReplay.forbidden_field_matches === 0
      && unboundAfterReplay.available_bound === 1 && unboundAfterReplay.active_pointer_bound === 1
      && unboundAfterReplay.bound_provider_version_id === boundProviderVersionId
      && unboundListingAfterReplay.provider_version_count === 1
      && unboundListingAfterReplay.delete_marker_count === 0
      && unboundListingAfterReplay.bound_provider_version_present
      && unboundListingAfterReplay.unbound_provider_version_absent;
    assert.equal(evidence.unbound_replay_zero_extra_effects, true);

    stage = "pending_recovery_fixture";
    const recoveryVersion = await directCreateVersion(
      page,
      founderCase.caseId!,
      recoveryDocument.documentId!,
      CLEAN_BYTES,
      recoveryDocument.recordVersion!,
      `doc02-recovery-${randomBytes(8).toString("hex")}`,
    );
    assert.equal(recoveryVersion.status, 201);
    assert.equal(recoveryVersion.exactAck, true);

    stage = "pending_recovery_refresh";
    await page.reload({ waitUntil: "domcontentloaded" });
    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!);
    await openCaseDocuments(page, baseUrl, founderCase.caseId!);
    const recoveryRow = documentRow(page, "Synthetic DOC-02 recovery evidence");
    const recoveryFileInput = recoveryRow.getByLabel("重新選擇原上載文件", { exact: true });
    const recoveryUploadButton = recoveryRow.getByRole("button", { name: "繼續上載並掃描", exact: true });
    await recoveryFileInput.waitFor({ state: "visible" });
    await recoveryUploadButton.waitFor({ state: "visible" });
    await recoveryRow.getByText("等待上載", { exact: true }).waitFor({ state: "visible" });
    evidence.pending_recovery_persisted = true;

    stage = "pending_recovery_wrong_file";
    const recoveryVersionPath = `/api/v1/cases/${founderCase.caseId}/documents/${recoveryDocument.documentId}/versions`;
    let recoveryNewVersionPosts = 0;
    let recoveryPutCount = 0;
    const recoveryObserver = (request: { method(): string; url(): string }) => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "POST" && pathname === recoveryVersionPath) recoveryNewVersionPosts += 1;
      if (request.method() === "PUT") recoveryPutCount += 1;
    };
    page.on("request", recoveryObserver);
    try {
      await recoveryFileInput.setInputFiles({
        name: RECOVERY_WRONG_FILE_NAME,
        mimeType: "application/pdf",
        buffer: CHANGED_CLEAN_BYTES,
      });
      await recoveryUploadButton.click();
      await recoveryRow.getByRole("alert").filter({ hasText: "所選文件與待上載版本不一致，未上載任何內容" })
        .waitFor({ state: "visible" });
      evidence.pending_recovery_wrong_file_zero_put = recoveryPutCount === 0;
      evidence.pending_recovery_wrong_file_zero_new_version = recoveryNewVersionPosts === 0;
    } finally {
      page.off("request", recoveryObserver);
    }
    assert.equal(evidence.pending_recovery_wrong_file_zero_put, true);
    assert.equal(evidence.pending_recovery_wrong_file_zero_new_version, true);

    stage = "pending_recovery_same_file_controls";
    evidence.pending_recovery_same_file_input_count = await recoveryFileInput.count();
    evidence.pending_recovery_same_file_input_visible = evidence.pending_recovery_same_file_input_count === 1
      && await recoveryFileInput.isVisible();
    evidence.pending_recovery_same_file_input_enabled = evidence.pending_recovery_same_file_input_count === 1
      && await recoveryFileInput.isEnabled();
    evidence.pending_recovery_same_file_upload_button_count = await recoveryUploadButton.count();
    evidence.pending_recovery_same_file_upload_button_visible =
      evidence.pending_recovery_same_file_upload_button_count === 1 && await recoveryUploadButton.isVisible();
    await recoveryFileInput.setInputFiles({
      name: RECOVERY_FILE_NAME,
      mimeType: "application/pdf",
      buffer: CLEAN_BYTES,
    });
    evidence.pending_recovery_same_file_upload_button_enabled =
      evidence.pending_recovery_same_file_upload_button_count === 1 && await recoveryUploadButton.isEnabled();

    stage = "pending_recovery_same_file_worker";
    evidence.pending_recovery_same_file_worker_before = worker === undefined
      ? "unknown" : processExited(worker) ? "exited" : "alive";
    const recoveryIntentPath =
      `/api/v1/cases/${founderCase.caseId}/documents/${recoveryDocument.documentId}/versions/${recoveryVersion.id}/upload-intents`;
    const recoveryIntentRequestWait = controlledWait(page.waitForRequest((request) =>
      isRequestPath(request, "POST", recoveryIntentPath)));
    const recoveryIntentResponseWait = controlledWait(page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === recoveryIntentPath));
    const recoveryPutRequestWait = controlledWait(page.waitForRequest((request) => request.method() === "PUT"));
    const recoveryPutResponseWait = controlledWait(page.waitForResponse((response) =>
      response.request().method() === "PUT"));
    const recoveryTransportProgress = controlledWait((async () => {
      stage = "pending_recovery_same_file_upload_intent";
      const [intentRequest, intentResponse] = await Promise.all([
        recoveryIntentRequestWait,
        recoveryIntentResponseWait,
      ]);
      evidence.pending_recovery_same_file_intent_request_started = intentRequest !== null;
      evidence.pending_recovery_same_file_intent_response_received = intentResponse !== null;
      evidence.pending_recovery_same_file_intent_status = intentResponse?.status() ?? null;
      evidence.pending_recovery_same_file_intent_safe_code = await safePlaywrightResponseCode(intentResponse);
      if (intentRequest === null || intentResponse === null) return;

      stage = "pending_recovery_same_file_put";
      const [putRequest, putResponse] = await Promise.all([
        recoveryPutRequestWait,
        recoveryPutResponseWait,
      ]);
      evidence.pending_recovery_same_file_put_request_started = putRequest !== null;
      evidence.pending_recovery_same_file_put_response_received = putResponse !== null;
      evidence.pending_recovery_same_file_put_status = putResponse?.status() ?? null;
      if (putRequest !== null && putResponse !== null) stage = "pending_recovery_same_file_authority";
    })());

    let recoveryFailure: unknown;
    let recoveryFailed = false;
    try {
      await recoveryUploadButton.click();
      await recoveryRow.getByRole("status").filter({ hasText: "掃描完成，安全版本已可下載。" })
        .waitFor({ state: "visible", timeout: 90_000 });
      stage = "pending_recovery_same_file_feedback";
      await recoveryRow.getByText("可使用", { exact: true }).waitFor({ state: "visible" });
      evidence.pending_recovery_same_file_available = true;
    } catch (error) {
      recoveryFailed = true;
      recoveryFailure = error;
    } finally {
      await Promise.all([
        recoveryTransportProgress,
        recoveryIntentRequestWait,
        recoveryIntentResponseWait,
        recoveryPutRequestWait,
        recoveryPutResponseWait,
      ]);
      const authority = await controlledWait(readSafeDocumentAuthority(
        page,
        founderCase.caseId!,
        recoveryDocument.documentId!,
      ));
      if (authority !== null) {
        evidence.pending_recovery_same_file_authority_fetch_completed = authority.fetchCompleted;
        evidence.pending_recovery_same_file_authority_status = authority.status;
        evidence.pending_recovery_same_file_authority_json_parseable = authority.jsonParseable;
        evidence.pending_recovery_same_file_authority_state = authority.state;
        evidence.pending_recovery_same_file_authority_pending = authority.pending;
      }
      evidence.pending_recovery_same_file_worker_after = worker === undefined
        ? "unknown" : processExited(worker) ? "exited" : "alive";

      const recoverySuccessStatus = recoveryRow.getByRole("status")
        .filter({ hasText: "掃描完成，安全版本已可下載。" });
      evidence.pending_recovery_same_file_success_status_count = await recoverySuccessStatus.count();
      evidence.pending_recovery_same_file_success_status_visible =
        evidence.pending_recovery_same_file_success_status_count > 0 && await recoverySuccessStatus.first().isVisible();
      const recoveryAvailableBadge = recoveryRow.getByText("可使用", { exact: true });
      evidence.pending_recovery_same_file_available_badge_count = await recoveryAvailableBadge.count();
      evidence.pending_recovery_same_file_available_badge_visible =
        evidence.pending_recovery_same_file_available_badge_count > 0 && await recoveryAvailableBadge.first().isVisible();
      evidence.pending_recovery_same_file_alert_count = await recoveryRow.getByRole("alert").count();
      evidence.pending_recovery_same_file_recovery_conflict_alert_count = await recoveryRow.getByRole("alert")
        .filter({ hasText: "所選文件與待上載版本不一致，未上載任何內容" }).count();
      evidence.pending_recovery_same_file_conflict_alert_count = await recoveryRow.getByRole("alert")
        .filter({ hasText: "文件狀態已變更或操作已逾期，請重新確認。" }).count();
      evidence.pending_recovery_same_file_timeout_alert_count = await recoveryRow.getByRole("alert")
        .filter({ hasText: "掃描仍未在 90 秒內完成，可稍後重新檢查。" }).count();
      evidence.pending_recovery_same_file_unavailable_alert_count = await recoveryRow.getByRole("alert")
        .filter({ hasText: "結果暫時無法確認，請稍後重試；重試不會重複建立版本。" }).count();
    }
    if (recoveryFailed) throw recoveryFailure;

    stage = "abandonment_fixture";
    const abandonmentVersion = await directCreateVersion(
      page,
      founderCase.caseId!,
      abandonmentDocument.documentId!,
      CLEAN_BYTES,
      abandonmentDocument.recordVersion!,
      `doc02-abandon-version-${randomBytes(8).toString("hex")}`,
    );
    assert.equal(abandonmentVersion.status, 201);
    assert.equal(abandonmentVersion.exactAck, true);
    const abandonmentObjectKey = `documents/${abandonmentDocument.documentId}/versions/${abandonmentVersion.id}`;
    const lateCapability = await directIssueUploadCapability(
      page,
      founderCase.caseId!,
      abandonmentDocument.documentId!,
      abandonmentVersion.id!,
      CLEAN_BYTES,
      runtime.localstackEndpoint,
      BUCKET,
      abandonmentObjectKey,
    );
    assert.notEqual(lateCapability, null);
    await page.reload({ waitUntil: "domcontentloaded" });
    const abandonmentRow = documentRow(page, "Synthetic DOC-02 abandonment evidence");
    const abandonmentConfirmation = abandonmentRow.getByRole("checkbox", { name: "確認放棄待上載版本", exact: true });
    const abandonmentButton = abandonmentRow.getByRole("button", { name: "放棄待上載版本", exact: true });
    await abandonmentConfirmation.check();
    const abandonmentPath = `/api/v1/cases/${founderCase.caseId}/documents/${abandonmentDocument.documentId}/versions/${abandonmentVersion.id}/abandonments`;
    const abandonmentKeys: string[] = [];
    let abandonmentPosts = 0;
    let abandonmentWrite = emptyWriteEvidence();
    await page.route(`**${abandonmentPath}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      abandonmentPosts += 1;
      abandonmentKeys.push(route.request().headers()["idempotency-key"] ?? "");
      if (abandonmentPosts <= 2) return route.abort("timedout");
      const response = await route.fetch();
      abandonmentWrite = safeWriteEvidence(response.status(), await response.text(), 2);
      await route.fulfill({ response });
    });

    stage = "abandonment_retry_first";
    await abandonmentButton.click();
    await transferUnavailableNotice(abandonmentRow);

    stage = "abandonment_retry_second";
    await abandonmentButton.click();
    await transferUnavailableNotice(abandonmentRow);
    evidence.abandonment_uncertain_retry_same_key = abandonmentKeys[0] !== ""
      && abandonmentKeys[0] === abandonmentKeys[1];
    assert.equal(evidence.abandonment_uncertain_retry_same_key, true);

    stage = "abandonment_submit";
    const beforeAbandonDouble = abandonmentPosts;
    await abandonmentButton.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await abandonmentRow.getByRole("status").filter({ hasText: "待上載版本已放棄，文件狀態已重新載入，可建立新版本。" })
      .waitFor({ state: "visible" });
    evidence.abandonment_double_post_count = abandonmentPosts - beforeAbandonDouble;
    evidence.abandonment_receipt_exact = abandonmentWrite.status === 200 && abandonmentWrite.exactAck
      && abandonmentWrite.id === abandonmentVersion.id;
    evidence.abandonment_authoritative = await abandonmentRow.getByText("已放棄", { exact: true }).isVisible()
      && await abandonmentRow.getByRole("button", { name: "下載安全版本", exact: true }).isDisabled();
    assert.equal(evidence.abandonment_double_post_count, 1);
    assert.equal(evidence.abandonment_receipt_exact, true);
    assert.equal(evidence.abandonment_authoritative, true);
    await page.unroute(`**${abandonmentPath}`);

    stage = "abandonment_replay";
    const replay = await directAbandonmentReplay(
      page,
      abandonmentPath,
      abandonmentKeys[2]!,
      abandonmentVersion.id!,
      2,
      1,
    );
    evidence.abandonment_replay_exact = replay.status === 200 && replay.exactAck
      && replay.id === abandonmentWrite.id && replay.version === abandonmentWrite.version;
    assert.equal(evidence.abandonment_replay_exact, true);

    stage = "abandonment_worker_pause";
    assert.equal(await stopProcess(worker), true);
    worker = undefined;

    stage = "abandonment_late_provider_versions";
    const lateResponses = await Promise.all([
      putLateObject(lateCapability!, CLEAN_BYTES),
      putLateObject(lateCapability!, CLEAN_BYTES),
    ]);
    evidence.abandonment_late_put_count = lateResponses.filter(({ status }) => status >= 200 && status < 300).length;
    const lateProviderVersionIds = lateResponses.flatMap(({ providerVersionId }) =>
      providerVersionId === null ? [] : [providerVersionId]);
    evidence.abandonment_late_provider_version_header_count = lateProviderVersionIds.length;
    evidence.abandonment_late_provider_version_ids_distinct = lateProviderVersionIds.length === 2
      && new Set(lateProviderVersionIds).size === 2;
    assert.equal(evidence.abandonment_late_put_count, 2);
    assert.equal(evidence.abandonment_late_provider_version_header_count, 2);
    assert.equal(evidence.abandonment_late_provider_version_ids_distinct, true);
    const beforeCleanup = await waitForObjectVersionListing(
      localstackName,
      abandonmentObjectKey,
      lateProviderVersionIds,
      "present",
    );
    evidence.abandonment_provider_version_count_before_cleanup = beforeCleanup.provider_version_count;
    evidence.abandonment_delete_marker_count_before_cleanup = beforeCleanup.delete_marker_count;
    evidence.abandonment_provider_versions_exact_before_cleanup = beforeCleanup.expected_provider_versions_present;
    assert.equal(evidence.abandonment_provider_version_count_before_cleanup, 2);
    assert.equal(evidence.abandonment_delete_marker_count_before_cleanup, 0);
    assert.equal(evidence.abandonment_provider_versions_exact_before_cleanup, true);

    stage = "abandonment_late_cleanup";
    worker = startDocumentWorker(appDirectory, runtime);
    workerProcesses.push(worker);
    await waitForProcessLog(worker, WORKER_READY_MARKER, "abandonment_late_cleanup");
    const afterCleanup = await waitForObjectVersionListing(
      localstackName,
      abandonmentObjectKey,
      lateProviderVersionIds,
      "absent",
    );
    evidence.abandonment_provider_version_count_after_cleanup = afterCleanup.provider_version_count;
    evidence.abandonment_delete_marker_count_after_cleanup = afterCleanup.delete_marker_count;
    evidence.abandonment_provider_versions_exact_absent = afterCleanup.expected_provider_versions_absent;
    evidence.abandonment_late_objects_cleaned = afterCleanup.provider_version_count === 0
      && afterCleanup.delete_marker_count === 0 && afterCleanup.expected_provider_versions_absent;
    assert.equal(evidence.abandonment_provider_version_count_after_cleanup, 0);
    assert.equal(evidence.abandonment_delete_marker_count_after_cleanup, 0);
    assert.equal(evidence.abandonment_provider_versions_exact_absent, true);

    stage = "abandonment_late_database";
    const cleanupDatabase = await waitForAbandonedCleanupDatabaseEvidence(
      target,
      abandonmentDocument.documentId!,
      abandonmentVersion.id!,
      [
        abandonmentObjectKey,
        ...lateProviderVersionIds,
        lateCapability!.url,
        lateCapability!.checksumBase64,
        sha256Hex(CLEAN_BYTES),
      ],
    );
    evidence.abandonment_scan_results_count = cleanupDatabase.scan_results;
    evidence.abandonment_cleanup_audit_count = cleanupDatabase.cleanup_audit;
    evidence.abandonment_cleanup_outbox_count = cleanupDatabase.cleanup_outbox;
    evidence.abandonment_scan_audit_count = cleanupDatabase.scan_audit;
    evidence.abandonment_scan_outbox_count = cleanupDatabase.scan_outbox;
    evidence.abandonment_private_object_coordinate_matches = cleanupDatabase.private_object_coordinate_matches;
    evidence.abandonment_version_abandoned_unbound = cleanupDatabase.abandoned_unbound === 1;
    evidence.abandonment_active_pointer_null = cleanupDatabase.active_pointer_null === 1;
    const abandonedAuthority = await inspectAbandonedDocument(
      page,
      founderCase.caseId!,
      abandonmentDocument.documentId!,
    );
    evidence.abandonment_never_scanned_or_downloadable = abandonedAuthority;
    assert.equal(evidence.abandonment_late_objects_cleaned, true);
    assert.equal(evidence.abandonment_scan_results_count, 0);
    assert.equal(evidence.abandonment_cleanup_audit_count, 2);
    assert.equal(evidence.abandonment_cleanup_outbox_count, 2);
    assert.equal(evidence.abandonment_scan_audit_count, 0);
    assert.equal(evidence.abandonment_scan_outbox_count, 0);
    assert.equal(evidence.abandonment_private_object_coordinate_matches, 0);
    assert.equal(evidence.abandonment_version_abandoned_unbound, true);
    assert.equal(evidence.abandonment_active_pointer_null, true);
    assert.equal(evidence.abandonment_never_scanned_or_downloadable, true);

    stage = "abandonment_new_version";
    const abandonmentNewFileInput = abandonmentRow.getByLabel("選擇上載文件", { exact: true });
    await abandonmentNewFileInput.setInputFiles({
      name: ABANDON_NEW_FILE_NAME,
      mimeType: "application/pdf",
      buffer: CHANGED_CLEAN_BYTES,
    });
    await abandonmentRow.getByRole("button", { name: "上載並掃描", exact: true }).click();
    await abandonmentRow.getByRole("status").filter({ hasText: "掃描完成，安全版本已可下載。" })
      .waitFor({ state: "visible", timeout: 90_000 });
    await abandonmentRow.getByText("可使用", { exact: true }).waitFor({ state: "visible" });
    evidence.abandonment_new_version_available = true;

    stage = "abandonment_changed_authority";
    const changedAuthorityRecordVersion = await readDocumentRecordVersion(
      page,
      founderCase.caseId!,
      abandonmentDocument.documentId!,
    );
    assert.notEqual(changedAuthorityRecordVersion, null);
    const changedAuthorityPending = await directCreateVersion(
      page,
      founderCase.caseId!,
      abandonmentDocument.documentId!,
      CLEAN_BYTES,
      changedAuthorityRecordVersion!,
      `doc02-abandon-changed-authority-${randomBytes(8).toString("hex")}`,
    );
    assert.equal(changedAuthorityPending.status, 201);
    assert.equal(changedAuthorityPending.exactAck, true);
    await page.reload({ waitUntil: "domcontentloaded" });
    const changedAuthorityRow = documentRow(page, "Synthetic DOC-02 abandonment evidence");
    const changedAuthorityConfirmation = changedAuthorityRow.getByRole("checkbox", {
      name: "確認放棄待上載版本",
      exact: true,
    });
    const changedAuthorityButton = changedAuthorityRow.getByRole("button", {
      name: "放棄待上載版本",
      exact: true,
    });
    const changedAuthorityPath = `/api/v1/cases/${founderCase.caseId}/documents/${abandonmentDocument.documentId}/versions/${changedAuthorityPending.id}/abandonments`;
    let changedAuthorityKey = "";
    const changedAuthorityObserver = (request: { method(): string; url(): string; headers(): Record<string, string> }) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === changedAuthorityPath) {
        changedAuthorityKey = request.headers()["idempotency-key"] ?? "";
      }
    };
    page.on("request", changedAuthorityObserver);
    try {
      await changedAuthorityConfirmation.check();
      await changedAuthorityButton.click();
      await changedAuthorityRow.getByRole("status")
        .filter({ hasText: "待上載版本已放棄，文件狀態已重新載入，可建立新版本。" })
        .waitFor({ state: "visible" });
    } finally {
      page.off("request", changedAuthorityObserver);
    }
    evidence.abandonment_changed_authority_rotates_key = changedAuthorityKey !== ""
      && changedAuthorityKey !== abandonmentKeys[2];
    assert.equal(evidence.abandonment_changed_authority_rotates_key, true);

    stage = "malicious_upload";
    await cleanFileInput.setInputFiles({ name: MALICIOUS_FILE_NAME, mimeType: "application/pdf", buffer: MALICIOUS_BYTES });
    await cleanUploadButton.click();
    await cleanRow.getByRole("alert").filter({ hasText: "文件未通過完整性或安全檢查" }).waitFor({ state: "visible", timeout: 90_000 });
    await cleanRow.getByText("已拒絕", { exact: true }).waitFor({ state: "visible" });
    evidence.malicious_rejected = true;

    stage = "old_clean_retained";
    evidence.old_clean_retained = await cleanDownloadButton.isEnabled()
      && await downloadAndCompare(page, cleanDownloadButton, CHANGED_CLEAN_BYTES);
    assert.equal(evidence.old_clean_retained, true);

    stage = "stale_fixture";
    const staleRow = documentRow(page, "Synthetic DOC-02 stale evidence");
    const staleFileInput = staleRow.getByLabel("選擇上載文件", { exact: true });
    await staleFileInput.setInputFiles({ name: STALE_FILE_NAME, mimeType: "application/pdf", buffer: CLEAN_BYTES });
    const staleSeed = await directCreateVersion(
      page,
      founderCase.caseId!,
      staleDocument.documentId!,
      CLEAN_BYTES,
      staleDocument.recordVersion!,
      `doc02-stale-seed-${randomBytes(8).toString("hex")}`,
    );
    assert.equal(staleSeed.status, 201);
    assert.equal(staleSeed.exactAck, true);

    stage = "stale_feedback";
    const staleResponse = controlledWait(page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname ===
      `/api/v1/cases/${founderCase.caseId}/documents/${staleDocument.documentId}/versions`));
    const staleAuthorityResponse = controlledWait(page.waitForResponse((response) =>
      isGetPath(response, `/api/v1/cases/${founderCase.caseId}/documents/${staleDocument.documentId}`)));
    await staleRow.getByRole("button", { name: "上載並掃描", exact: true }).click();
    const staleHttp = await staleResponse;
    const staleAuthorityHttp = await staleAuthorityResponse;
    assert.notEqual(staleHttp, null);
    assert.notEqual(staleAuthorityHttp, null);
    await staleRow.getByRole("alert").filter({ hasText: "文件已被更新，已重新載入目前版本" }).waitFor({ state: "visible" });
    evidence.stale_visible = staleHttp!.status() === 409;
    evidence.stale_authoritative_detail_status = staleAuthorityHttp!.status();
    const staleRecoveryInput = staleRow.getByLabel("重新選擇原上載文件", { exact: true });
    const staleRecoveryButton = staleRow.getByRole("button", { name: "繼續上載並掃描", exact: true });
    await staleRecoveryInput.waitFor({ state: "visible" });
    await staleRecoveryButton.waitFor({ state: "visible" });
    await staleRow.getByText("等待上載", { exact: true }).waitFor({ state: "visible" });
    evidence.stale_pending_recovery_visible = true;
    assert.equal(evidence.stale_visible, true);
    assert.equal(evidence.stale_authoritative_detail_status, 200);
    assert.equal(evidence.stale_pending_recovery_visible, true);

    stage = "refresh_persistence";
    await page.reload({ waitUntil: "domcontentloaded" });
    const refreshedCleanRow = documentRow(page, "Synthetic DOC-02 clean evidence");
    await refreshedCleanRow.getByText("已拒絕", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await refreshedCleanRow.getByRole("button", { name: "下載安全版本", exact: true }).isEnabled(), true);
    evidence.refresh_persistence = true;

    stage = "relogin_persistence";
    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!);
    await openCaseDocuments(page, baseUrl, founderCase.caseId!);
    const reloginCleanRow = documentRow(page, "Synthetic DOC-02 clean evidence");
    await reloginCleanRow.getByText("已拒絕", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await reloginCleanRow.getByRole("button", { name: "下載安全版本", exact: true }).isEnabled(), true);
    evidence.relogin_persistence = true;

    stage = "advisor_scope";
    await logout(page);
    await login(page, baseUrl, ADVISOR.email, passwords.get("advisor")!);
    const advisorCase = await createCaseFixture(page, ADVISOR.roleBindingId, 2052);
    assert.equal(advisorCase.status, 200);
    assert.equal(advisorCase.exact, true);
    const advisorDocument = await registerDocumentFixture(page, advisorCase.caseId!, "Synthetic DOC-02 Advisor evidence");
    assert.equal(advisorDocument.status, 201);
    assert.equal(advisorDocument.exact, true);
    await openCaseDocuments(page, baseUrl, advisorCase.caseId!);
    const advisorRow = documentRow(page, "Synthetic DOC-02 Advisor evidence");
    await advisorRow.getByLabel("選擇上載文件", { exact: true }).waitFor({ state: "visible" });
    const advisorFileInput = advisorRow.getByLabel("選擇上載文件", { exact: true });
    const advisorUploadButton = advisorRow.getByRole("button", { name: "上載並掃描", exact: true });
    const advisorDownloadButton = advisorRow.getByRole("button", { name: "下載安全版本", exact: true });
    await advisorUploadButton.waitFor({ state: "visible" });
    await advisorDownloadButton.waitFor({ state: "visible" });
    evidence.advisor_controls_visible = true;

    stage = "advisor_upload";
    const advisorVersionResponse = controlledWait(page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname ===
      `/api/v1/cases/${advisorCase.caseId}/documents/${advisorDocument.documentId}/versions`));
    await advisorFileInput.setInputFiles({
      name: ADVISOR_FILE_NAME,
      mimeType: "application/pdf",
      buffer: ADVISOR_CLEAN_BYTES,
    });
    await advisorUploadButton.click();
    const advisorVersionHttp = await advisorVersionResponse;
    assert.notEqual(advisorVersionHttp, null);
    advisorVersionWrite = safeWriteEvidence(
      advisorVersionHttp!.status(),
      await advisorVersionHttp!.text(),
      1,
    );
    assert.equal(advisorVersionWrite.status, 201);
    assert.equal(advisorVersionWrite.exactAck, true);
    await advisorRow.getByRole("status").filter({ hasText: "掃描完成，安全版本已可下載。" })
      .waitFor({ state: "visible", timeout: 90_000 });
    await advisorRow.getByText("可使用", { exact: true }).waitFor({ state: "visible" });
    evidence.advisor_upload_available = await advisorDownloadButton.isEnabled();
    assert.equal(evidence.advisor_upload_available, true);

    stage = "advisor_download";
    evidence.advisor_download_exact_bytes = await downloadAndCompare(
      page,
      advisorDownloadButton,
      ADVISOR_CLEAN_BYTES,
    );
    assert.equal(evidence.advisor_download_exact_bytes, true);

    stage = "advisor_unassigned";
    const unassigned = await directCreateVersion(
      page,
      founderCase.caseId!,
      cleanDocument.documentId!,
      CLEAN_BYTES,
      1,
      `doc02-unassigned-${randomBytes(8).toString("hex")}`,
    );
    evidence.advisor_unassigned_not_found = unassigned.status === 404 && unassigned.safeCode === "NOT_FOUND" && !unassigned.privateEcho;
    assert.equal(evidence.advisor_unassigned_not_found, true);

    stage = "denied_roles";
    for (const actor of [ADMIN, DATA_REVIEWER, CONTRACTOR] as const) {
      await logout(page);
      await login(page, baseUrl, actor.email, passwords.get(actor.role)!);
      const deniedMarker = `doc02-denied-${actor.role}-${randomBytes(8).toString("hex")}`;
      requestPrivacyMarkers.push(deniedMarker);
      const denied = await inspectDeniedRole(
        page,
        baseUrl,
        founderCase.caseId!,
        cleanDocument.documentId!,
        versionWrite.id!,
        sha256Hex(CHANGED_CLEAN_BYTES),
        deniedMarker,
      );
      if (denied.uiHidden) evidence.denied_ui_hidden_count += 1;
      evidence.denied_direct_forbidden_count += denied.forbiddenCount;
      assert.equal(denied.privateEcho, false);
    }
    assert.equal(evidence.denied_ui_hidden_count, 3);
    assert.equal(evidence.denied_direct_forbidden_count, 12);

    await logout(page);
    await login(page, baseUrl, FOUNDER.email, passwords.get("founder")!);
    await openCaseDocuments(page, baseUrl, founderCase.caseId!);

    stage = "scan_failed_clamav_unavailable";
    assert.equal(await removeContainer(clamavName), true);
    clamavStarted = false;
    const scanFailedRow = documentRow(page, "Synthetic DOC-02 scan failure evidence");
    const scanFailedInput = scanFailedRow.getByLabel("選擇上載文件", { exact: true });
    const scanFailedUploadButton = scanFailedRow.getByRole("button", { name: "上載並掃描", exact: true });
    const scanFailedDownloadButton = scanFailedRow.getByRole("button", { name: "下載安全版本", exact: true });
    await scanFailedInput.setInputFiles({
      name: SCAN_FAILED_FILE_NAME,
      mimeType: "application/pdf",
      buffer: SCAN_FAILED_BYTES,
    });
    await scanFailedUploadButton.click();
    await scanFailedRow.getByRole("alert")
      .filter({ hasText: "安全掃描未能完成，可稍後建立新版本。" })
      .waitFor({ state: "visible", timeout: 90_000 });
    await scanFailedRow.getByText("掃描失敗", { exact: true }).waitFor({ state: "visible" });
    evidence.scan_failed_fixed_feedback = true;

    stage = "scan_failed_authority";
    const scanFailedAuthority = await inspectScanFailedDocument(
      page,
      founderCase.caseId!,
      scanFailedDocument.documentId!,
    );
    evidence.scan_failed_authoritative_detail_status = scanFailedAuthority.status;
    evidence.scan_failed_authoritative_state = scanFailedAuthority.exact;
    evidence.scan_failed_download_disabled = await scanFailedDownloadButton.isDisabled();
    assert.equal(evidence.scan_failed_authoritative_detail_status, 200);
    assert.equal(evidence.scan_failed_authoritative_state, true);
    assert.equal(evidence.scan_failed_fixed_feedback, true);
    assert.equal(evidence.scan_failed_download_disabled, true);

    stage = "scan_failed_clamav_restore";
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", clamavName,
      "--env", "CLAMD_STARTUP_TIMEOUT=300", "--publish", `127.0.0.1:${clamavPort}:3310`, CLAMAV_IMAGE,
    ], stage);
    clamavStarted = true;
    await waitForClamAv(clamavPort, stage);
    evidence.scan_failed_clamav_recovered = true;

    stage = "desktop_viewport";
    evidence.desktop_viewport = await viewportEvidence(page);
    assert.deepEqual(evidence.desktop_viewport, zeroViewport());

    stage = "mobile_viewport";
    await page.setViewportSize({ width: 390, height: 844 });
    evidence.mobile_viewport = await viewportEvidence(page);
    assert.deepEqual(evidence.mobile_viewport, zeroViewport());

    stage = "browser_log_safety";
    const sensitiveValues = [
      ...actors.map((actor) => actor.email), ...passwords.values(), applicationPassword,
      CLEAN_FILE_NAME, CHANGED_FILE_NAME, MALICIOUS_FILE_NAME, STALE_FILE_NAME, ADVISOR_FILE_NAME,
      RECOVERY_FILE_NAME, RECOVERY_WRONG_FILE_NAME, SAME_PAGE_RECOVERY_FILE_NAME,
      ABANDON_NEW_FILE_NAME, SCAN_FAILED_FILE_NAME,
      CLEAN_RAW_MARKER, CHANGED_RAW_MARKER, ADVISOR_RAW_MARKER, SAME_PAGE_RECOVERY_RAW_MARKER,
      SCAN_FAILED_RAW_MARKER, EICAR_MARKER,
      sha256Hex(CLEAN_BYTES), sha256Hex(CHANGED_CLEAN_BYTES), sha256Hex(ADVISOR_CLEAN_BYTES),
      sha256Hex(SAME_PAGE_RECOVERY_BYTES), sha256Hex(SCAN_FAILED_BYTES),
      createHash("sha256").update(SAME_PAGE_RECOVERY_BYTES).digest("base64"),
      founderCase.caseId!, advisorCase.caseId!,
      cleanDocument.documentId!, staleDocument.documentId!, recoveryDocument.documentId!,
      samePageRecoveryDocument.documentId!,
      abandonmentDocument.documentId!, scanFailedDocument.documentId!, unboundDocument.documentId!,
      advisorDocument.documentId!,
      versionWrite.id!, samePageRecoveryWrite.id!, staleSeed.id!, recoveryVersion.id!,
      abandonmentVersion.id!, advisorVersionWrite.id!,
      changedAuthorityPending.id!, unboundVersion.id!, changedAuthorityKey,
      abandonmentObjectKey, abandonmentPath, changedAuthorityPath, ...lateProviderVersionIds,
      unboundObjectKey, ...unboundProviderVersionIds, boundProviderVersionId!, unboundProviderVersionId!,
      `documents/${cleanDocument.documentId}/versions/${versionWrite.id}`,
      `documents/${samePageRecoveryDocument.documentId}/versions/${samePageRecoveryWrite.id}`,
      `documents/${advisorDocument.documentId}/versions/${advisorVersionWrite.id}`,
      `${BUCKET}/documents/${cleanDocument.documentId}/versions/${versionWrite.id}`,
      `${BUCKET}/documents/${samePageRecoveryDocument.documentId}/versions/${samePageRecoveryWrite.id}`,
      `${BUCKET}/documents/${advisorDocument.documentId}/versions/${advisorVersionWrite.id}`,
      samePageRecoveryPrivateSignedTarget!,
      lateCapability!.url, lateCapability!.checksumBase64,
      unboundCapability!.url, unboundCapability!.checksumBase64, ...abandonmentKeys,
      ...requestPrivacyMarkers,
      "postgresql://", "tx_session=", "X-Amz-Signature", "x-amz-checksum-sha256",
    ];
    evidence.sensitive_log_matches = browserMessages.filter((message) =>
      sensitiveValues.some((value) => value !== "" && message.includes(value))).length;
    assert.equal(evidence.page_errors, 0);
    assert.equal(evidence.sensitive_log_matches, 0);

    const standaloneBusinessRouteIds = [
      founderCase.caseId!, advisorCase.caseId!,
      cleanDocument.documentId!, staleDocument.documentId!, recoveryDocument.documentId!,
      samePageRecoveryDocument.documentId!,
      abandonmentDocument.documentId!, scanFailedDocument.documentId!, unboundDocument.documentId!,
      advisorDocument.documentId!,
      versionWrite.id!, samePageRecoveryWrite.id!, staleSeed.id!, recoveryVersion.id!,
      abandonmentVersion.id!, advisorVersionWrite.id!,
      changedAuthorityPending.id!, unboundVersion.id!,
    ];
    const standaloneBusinessRouteIdSet = new Set(standaloneBusinessRouteIds);
    const frozenPrivateValues = sensitiveValues.filter((value) => !standaloneBusinessRouteIdSet.has(value));
    const devProcessLogEvidence = safeProcessLogEvidence(
      devServer,
      frozenPrivateValues,
      standaloneBusinessRouteIds,
    );
    const workerProcessLogEvidence = workerProcesses.map((workerProcess) =>
      safeProcessLogEvidence(workerProcess, frozenPrivateValues, standaloneBusinessRouteIds));
    evidence.dev_process_log_captured = devProcessLogEvidence.captured;
    evidence.dev_process_stdout_frozen_private_matches = devProcessLogEvidence.stdout.frozen_private;
    evidence.dev_process_stderr_frozen_private_matches = devProcessLogEvidence.stderr.frozen_private;
    evidence.dev_process_stdout_standalone_business_route_id_matches =
      devProcessLogEvidence.stdout.standalone_business_route_id;
    evidence.dev_process_stderr_standalone_business_route_id_matches =
      devProcessLogEvidence.stderr.standalone_business_route_id;
    evidence.worker_process_count = workerProcesses.length;
    evidence.worker_process_log_captured_count = workerProcessLogEvidence.filter((item) => item.captured).length;
    evidence.worker_process_stdout_frozen_private_matches = workerProcessLogEvidence.reduce(
      (total, item) => total + item.stdout.frozen_private,
      0,
    );
    evidence.worker_process_stderr_frozen_private_matches = workerProcessLogEvidence.reduce(
      (total, item) => total + item.stderr.frozen_private,
      0,
    );
    evidence.worker_process_stdout_standalone_business_route_id_matches = workerProcessLogEvidence.reduce(
      (total, item) => total + item.stdout.standalone_business_route_id,
      0,
    );
    evidence.worker_process_stderr_standalone_business_route_id_matches = workerProcessLogEvidence.reduce(
      (total, item) => total + item.stderr.standalone_business_route_id,
      0,
    );

    stage = "dev_process_log_safety";
    assertNoSensitiveProcessLogs(devServer, frozenPrivateValues);

    stage = "worker_process_log_safety";
    for (const workerProcess of workerProcesses) assertNoSensitiveProcessLogs(workerProcess, frozenPrivateValues);
    stage = "complete";
  } catch {
    failureStage = stage;
  } finally {
    cleanup.context_closed = await closeContext(context);
    cleanup.worker_stopped = await stopProcess(worker);
    cleanup.dev_stopped = await stopProcess(devServer);
    cleanup.app_removed = await removeDirectory(appDirectory);
    cleanup.profile_removed = await removeDirectory(profileDirectory);
    cleanup.postgres_removed = !postgresStarted || await removeContainer(postgresName);
    cleanup.localstack_removed = !localstackStarted || await removeContainer(localstackName);
    cleanup.clamav_removed = !clamavStarted || await removeContainer(clamavName);
    cleanup.queues_and_objects_removed = cleanup.localstack_removed;
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
  if (failureStage !== null || !cleanupComplete) throw new BrowserGateError(failureStage ?? "cleanup");
});

function principal(role: Actor) {
  const value = NEON_TEST_PRINCIPALS.find((candidate) => candidate.role === role);
  if (!value) throw new Error("Synthetic principal contract is incomplete.");
  return value as typeof value & { readonly role: Actor };
}

interface LoginDiagnostics {
  readonly evidence: LoginEvidence;
  readonly setStage: (stage: LoginStage) => void;
}

async function login(
  page: Page,
  baseUrl: string,
  email: string,
  password: string,
  diagnostics?: LoginDiagnostics,
): Promise<void> {
  if (diagnostics) Object.assign(diagnostics.evidence, emptyLoginEvidence());
  diagnostics?.setStage("founder_login_page");
  const navigation = await controlledWait(
    page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" }),
  );
  if (diagnostics) {
    diagnostics.evidence.page_navigation_completed = navigation !== null;
    diagnostics.evidence.page_status = navigation?.status() ?? null;
    diagnostics.evidence.page_path_exact = urlPathExact(page.url(), "/login");
    diagnostics.evidence.page_origin_exact = urlOriginExact(page.url(), baseUrl);
  }
  assert.equal(navigation?.status(), 200);
  if (diagnostics) {
    assert.equal(diagnostics.evidence.page_path_exact, true);
    assert.equal(diagnostics.evidence.page_origin_exact, true);
  }

  diagnostics?.setStage("founder_login_form_ready");
  const emailInput = page.getByRole("textbox", { name: "測試帳號電郵", exact: true });
  const passwordInput = page.getByLabel("密碼", { exact: true });
  const submit = page.getByRole("button", { name: "登入測試工作台", exact: true });
  const formReadiness = await Promise.all([
    controlledWait(emailInput.waitFor({ state: "visible" }).then(() => true)),
    controlledWait(passwordInput.waitFor({ state: "visible" }).then(() => true)),
    controlledWait(submit.waitFor({ state: "visible" }).then(() => true)),
  ]);
  if (diagnostics) {
    diagnostics.evidence.form_email_count = await emailInput.count();
    diagnostics.evidence.form_password_count = await passwordInput.count();
    diagnostics.evidence.form_submit_count = await submit.count();
  }
  assert.equal(formReadiness.every((ready) => ready === true), true);
  if (diagnostics) {
    assert.equal(diagnostics.evidence.form_email_count, 1);
    assert.equal(diagnostics.evidence.form_password_count, 1);
    assert.equal(diagnostics.evidence.form_submit_count, 1);
  }
  await emailInput.fill(email);
  await passwordInput.fill(password);
  const submitRequest = controlledWait(page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/auth/login"));
  const submitResponse = controlledWait(page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/auth/login"));
  const accessRequest = controlledWait(page.waitForRequest((request) =>
    request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/auth/me"));
  const accessResponse = controlledWait(page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me")));

  diagnostics?.setStage("founder_login_submit");
  await submit.click();
  const [submitRequestValue, submitHttp] = await Promise.all([submitRequest, submitResponse]);
  const submitLocation = submitHttp?.headers()["location"] ?? null;
  let submitTarget: URL | null = null;
  if (submitLocation !== null) {
    try { submitTarget = new URL(submitLocation, baseUrl); } catch {}
  }
  if (diagnostics) {
    diagnostics.evidence.submit_request_observed = submitRequestValue !== null;
    diagnostics.evidence.submit_response_received = submitHttp !== null;
    diagnostics.evidence.submit_status = submitHttp?.status() ?? null;
    diagnostics.evidence.submit_response_origin_exact = submitHttp !== null &&
      urlOriginExact(submitHttp.url(), baseUrl);
    diagnostics.evidence.submit_location_present = submitLocation !== null;
    diagnostics.evidence.submit_location_parseable = submitTarget !== null;
    diagnostics.evidence.submit_location_path_exact = submitTarget?.pathname === "/today";
    diagnostics.evidence.submit_target_origin_exact = submitTarget?.origin === baseUrl;
    diagnostics.evidence.submit_target_protocol_http = submitTarget?.protocol === "http:";
    diagnostics.evidence.submit_target_loopback = submitTarget !== null && isLoopbackHostname(submitTarget.hostname);
    diagnostics.evidence.submit_target_port_matches = submitTarget?.port === new URL(baseUrl).port;
  }
  assert.notEqual(submitRequestValue, null);
  assert.notEqual(submitHttp, null);
  assert.equal(submitHttp!.status(), 303);
  if (diagnostics) {
    assert.equal(diagnostics.evidence.submit_response_origin_exact, true);
    assert.equal(diagnostics.evidence.submit_location_present, true);
    assert.equal(diagnostics.evidence.submit_location_parseable, true);
    assert.equal(diagnostics.evidence.submit_location_path_exact, true);
    assert.equal(diagnostics.evidence.submit_target_origin_exact, true);
    assert.equal(diagnostics.evidence.submit_target_protocol_http, true);
    assert.equal(diagnostics.evidence.submit_target_loopback, true);
    assert.equal(diagnostics.evidence.submit_target_port_matches, true);
  }

  diagnostics?.setStage("founder_login_redirect");
  const redirectReady = await controlledWait(
    page.waitForURL((url) => url.pathname === "/today").then(() => true),
  );
  if (diagnostics) {
    diagnostics.evidence.redirect_path_exact = urlPathExact(page.url(), "/today");
    diagnostics.evidence.redirect_origin_exact = urlOriginExact(page.url(), baseUrl);
  }
  assert.equal(redirectReady, true);
  if (diagnostics) {
    assert.equal(diagnostics.evidence.redirect_path_exact, true);
    assert.equal(diagnostics.evidence.redirect_origin_exact, true);
  }

  diagnostics?.setStage("founder_login_session");
  const [accessRequestValue, accessHttp] = await Promise.all([accessRequest, accessResponse]);
  if (diagnostics) {
    diagnostics.evidence.session_request_observed = accessRequestValue !== null;
    diagnostics.evidence.session_response_received = accessHttp !== null;
    diagnostics.evidence.session_status = accessHttp?.status() ?? null;
    diagnostics.evidence.session_response_origin_matches_page = accessHttp !== null &&
      urlOriginExact(accessHttp.url(), new URL(page.url()).origin);
  }
  assert.notEqual(accessRequestValue, null);
  assert.notEqual(accessHttp, null);
  assert.equal(accessHttp!.status(), 200);

  diagnostics?.setStage("founder_login_workspace");
  const workspaceHeading = page.getByRole("heading", { name: "今日工作", exact: true, level: 2 });
  const workspaceReady = await controlledWait(
    workspaceHeading.waitFor({ state: "visible" }).then(() => true),
  );
  if (diagnostics) {
    diagnostics.evidence.workspace_heading_count = await workspaceHeading.count();
    diagnostics.evidence.workspace_heading_visible = workspaceReady === true && await workspaceHeading.isVisible();
  }
  assert.equal(workspaceReady, true);
  if (diagnostics) {
    assert.equal(diagnostics.evidence.workspace_heading_count, 1);
    assert.equal(diagnostics.evidence.workspace_heading_visible, true);
  }
}

function emptyLoginEvidence(): LoginEvidence {
  return {
    page_navigation_completed: false,
    page_status: null,
    page_path_exact: false,
    page_origin_exact: false,
    form_email_count: null,
    form_password_count: null,
    form_submit_count: null,
    submit_request_observed: false,
    submit_response_received: false,
    submit_status: null,
    submit_response_origin_exact: false,
    submit_location_present: false,
    submit_location_parseable: false,
    submit_location_path_exact: false,
    submit_target_origin_exact: false,
    submit_target_protocol_http: false,
    submit_target_loopback: false,
    submit_target_port_matches: false,
    redirect_path_exact: false,
    redirect_origin_exact: false,
    session_request_observed: false,
    session_response_received: false,
    session_status: null,
    session_response_origin_matches_page: false,
    workspace_heading_count: null,
    workspace_heading_visible: false,
  };
}

function urlPathExact(value: string, expectedPath: string): boolean {
  try { return new URL(value).pathname === expectedPath; } catch { return false; }
}

function urlOriginExact(value: string, expectedOrigin: string): boolean {
  try { return new URL(value).origin === expectedOrigin; } catch { return false; }
}

function isLoopbackHostname(value: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(value.toLowerCase());
}

async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "帳戶選單", exact: true }).click();
  await page.getByRole("menuitem", { name: "登出", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/login");
}

async function createCaseFixture(page: Page, bindingId: string, intakeYear: number): Promise<CaseFixture> {
  return page.evaluate(async ({ binding, manifest, student, year }) => {
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
      Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    try {
      const response = await fetch("/api/v1/cases", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `doc02-case-${crypto.randomUUID()}` },
        body: JSON.stringify({
          student_id: student,
          intake_year: year,
          admission_type: "transfer",
          primary_role_binding_id: binding,
          manifest_id: manifest,
        }),
      });
      const root = await response.json() as unknown;
      if (!object(root) || !object(root.data) || !exact(root.data, ["case"]) || !object(root.data.case)) {
        return { status: response.status, exact: false, caseId: null };
      }
      const record = root.data.case;
      const keys = [
        "id", "caseNumber", "studentId", "assessmentId", "intakeYear",
        "admissionType", "stage", "manifestId", "recordVersion",
      ];
      const valid = exact(record, keys) && typeof record.id === "string" &&
        record.studentId === student && record.intakeYear === year && record.recordVersion === 1;
      return { status: response.status, exact: valid, caseId: valid ? record.id as string : null };
    } catch {
      return { status: null, exact: false, caseId: null };
    }
  }, { binding: bindingId, manifest: NEON_TEST_MANIFEST_ID, student: NEON_TEST_STUDENTS[0]!.id, year: intakeYear });
}

async function registerDocumentFixture(page: Page, caseId: string, displayName: string): Promise<DocumentFixture> {
  return page.evaluate(async ({ id, name }) => {
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
      Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    try {
      const response = await fetch(`/api/v1/cases/${id}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `doc02-register-${crypto.randomUUID()}` },
        body: JSON.stringify({ display_name: name, classification: "identity_and_case_evidence" }),
      });
      const root = await response.json() as unknown;
      const data = object(root) ? root.data : null;
      const valid = object(data) && exact(data, ["id", "record_version"]) &&
        typeof data.id === "string" && data.record_version === 1;
      return {
        status: response.status,
        exact: valid,
        documentId: valid ? data.id as string : null,
        recordVersion: valid ? 1 : null,
      };
    } catch {
      return { status: null, exact: false, documentId: null, recordVersion: null };
    }
  }, { id: caseId, name: displayName });
}

async function openCaseDocuments(page: Page, baseUrl: string, caseId: string): Promise<void> {
  const list = controlledWait(page.waitForResponse((response) => isGetPath(response, `/api/v1/cases/${caseId}/documents`)));
  const access = controlledWait(page.waitForResponse((response) => isGetPath(response, "/api/v1/auth/me")));
  const navigation = await page.goto(`${baseUrl}/cases/${caseId}`, { waitUntil: "domcontentloaded" });
  const listHttp = await list;
  const accessHttp = await access;
  assert.equal(navigation?.status(), 200);
  assert.notEqual(listHttp, null);
  assert.notEqual(accessHttp, null);
  assert.equal(listHttp!.status(), 200);
  assert.equal(accessHttp!.status(), 200);
  await page.getByRole("heading", { name: "案件文件", exact: true, level: 3 }).waitFor({ state: "visible" });
}

function documentRow(page: Page, displayName: string): Locator {
  return page.locator("li").filter({ has: page.getByText(displayName, { exact: true }) });
}

async function transferUnavailableNotice(row: Locator): Promise<void> {
  await row.getByRole("alert").filter({ hasText: "結果暫時無法確認" }).waitFor({ state: "visible" });
}

async function directCreateVersion(
  page: Page,
  caseId: string,
  documentId: string,
  bytes: Buffer,
  expectedDocumentVersion: number,
  idempotencyKey: string,
): Promise<WriteEvidence> {
  const checksum = sha256Hex(bytes);
  return page.evaluate(async ({ body, caseValue, documentValue, key, privateValue }) => {
    const privateValues = [caseValue, documentValue, key, privateValue];
    const echoed = (text: string) => privateValues.some((value) => text.includes(value));
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
      Object.keys(value).length === keys.length && keys.every((field) => Object.hasOwn(value, field));
    const uuid = (value: unknown): value is string => typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    const decode = (status: number, text: string) => {
      let value: unknown;
      try { value = JSON.parse(text); } catch {
        return { status, jsonParseable: false, exactAck: false, id: null, version: null, safeCode: "OTHER" as const, privateEcho: echoed(text) };
      }
      if (!object(value)) return { status, jsonParseable: true, exactAck: false, id: null, version: null, safeCode: "OTHER" as const, privateEcho: echoed(text) };
      const data = value.data;
      const exactAck = status >= 200 && status < 300 && object(data) && exact(data, ["id", "record_version"]) && uuid(data.id) && data.record_version === 1;
      const code = object(value.error) && typeof value.error.code === "string" ? value.error.code : "NONE";
      const safeCode = code === "VALIDATION_FAILED" || code === "STALE_VERSION" || code === "CONFLICT" ||
        code === "FORBIDDEN" || code === "NOT_FOUND" || code === "NONE" ? code as SafeCode : "OTHER" as const;
      return { status, jsonParseable: true, exactAck, id: exactAck ? data.id as string : null, version: exactAck ? 1 : null, safeCode, privateEcho: echoed(text) };
    };
    try {
      const response = await fetch(`/api/v1/cases/${caseValue}/documents/${documentValue}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      });
      return decode(response.status, await response.text());
    } catch {
      return { status: null, jsonParseable: false, exactAck: false, id: null, version: null, safeCode: "OTHER" as const, privateEcho: false };
    }
  }, {
    body: {
      checksum_sha256: checksum,
      size_bytes: bytes.length,
      content_type: "application/pdf",
      expected_document_record_version: expectedDocumentVersion,
    },
    caseValue: caseId,
    documentValue: documentId,
    key: idempotencyKey,
    privateValue: checksum,
  });
}

async function directIssueUploadCapability(
  page: Page,
  caseId: string,
  documentId: string,
  versionId: string,
  bytes: Buffer,
  expectedLocalstackOrigin: string,
  expectedBucket: string,
  expectedObjectKey: string,
): Promise<PrivateUploadCapability | null> {
  const checksumBase64 = createHash("sha256").update(bytes).digest("base64");
  return page.evaluate(async ({
    caseValue,
    documentValue,
    versionValue,
    expectedChecksum,
    localstackOrigin,
    bucketValue,
    objectKeyValue,
  }) => {
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
      Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    try {
      const response = await fetch(
        `/api/v1/cases/${caseValue}/documents/${documentValue}/versions/${versionValue}/upload-intents`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expected_record_version: 1 }),
        },
      );
      const root = await response.json() as unknown;
      const data = object(root) && exact(root, ["api_version", "request_id", "data"])
        && root.api_version === "v1" && typeof root.request_id === "string"
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(root.request_id) ? root.data : null;
      if (response.status !== 200 || !object(data)
        || !exact(data, ["method", "expires_at_ms", "url", "headers"])
        || data.method !== "PUT" || !Number.isSafeInteger(data.expires_at_ms)
        || (data.expires_at_ms as number) <= Date.now()
        || (data.expires_at_ms as number) > Date.now() + 600_000
        || typeof data.url !== "string" || !object(data.headers)
        || !exact(data.headers, ["content-type", "x-amz-checksum-sha256"])
        || data.headers["content-type"] !== "application/pdf"
        || data.headers["x-amz-checksum-sha256"] !== expectedChecksum) return null;
      const expectedOrigin = new URL(localstackOrigin);
      const signed = new URL(data.url);
      const expectedPath = `/${encodeURIComponent(bucketValue)}/${objectKeyValue
        .split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
      const expectedLoopback = expectedOrigin.hostname === "127.0.0.1"
        || expectedOrigin.hostname === "localhost" || expectedOrigin.hostname === "[::1]";
      if (!expectedLoopback || expectedOrigin.protocol !== "http:" || signed.protocol !== "http:"
        || signed.origin !== expectedOrigin.origin || signed.pathname !== expectedPath
        || signed.username !== "" || signed.password !== "" || signed.hash !== "") return null;
      return {
        url: data.url,
        contentType: "application/pdf" as const,
        checksumBase64: expectedChecksum,
      };
    } catch {
      return null;
    }
  }, {
    caseValue: caseId,
    documentValue: documentId,
    versionValue: versionId,
    expectedChecksum: checksumBase64,
    localstackOrigin: expectedLocalstackOrigin,
    bucketValue: expectedBucket,
    objectKeyValue: expectedObjectKey,
  });
}

async function directAbandonmentReplay(
  page: Page,
  path: string,
  idempotencyKey: string,
  expectedVersionId: string,
  expectedDocumentRecordVersion: number,
  expectedVersionRecordVersion: number,
): Promise<WriteEvidence> {
  const result = await page.evaluate(async ({ endpoint, key, documentVersion, versionVersion }) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          expected_document_record_version: documentVersion,
          expected_version_record_version: versionVersion,
        }),
      });
      return { status: response.status, text: await response.text() };
    } catch {
      return { status: 0, text: "" };
    }
  }, {
    endpoint: path,
    key: idempotencyKey,
    documentVersion: expectedDocumentRecordVersion,
    versionVersion: expectedVersionRecordVersion,
  });
  const evidence = safeWriteEvidence(result.status, result.text, expectedVersionRecordVersion + 1);
  return Object.freeze({
    ...evidence,
    privateEcho: evidence.id !== null && evidence.id !== expectedVersionId,
  });
}

async function putLateObject(capability: PrivateUploadCapability, bytes: Buffer): Promise<LatePutEvidence> {
  try {
    const response = await fetch(capability.url, {
      method: "PUT",
      headers: {
        "content-type": capability.contentType,
        "x-amz-checksum-sha256": capability.checksumBase64,
      },
      body: Uint8Array.from(bytes),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    const providerVersionId = response.headers.get("x-amz-version-id");
    return Object.freeze({
      status: response.status,
      providerVersionId: response.status >= 200 && response.status < 300
        && providerVersionId !== null && /^\S{1,1024}$/.test(providerVersionId)
        ? providerVersionId : null,
    });
  } catch {
    return Object.freeze({ status: 0, providerVersionId: null });
  }
}

async function waitForObjectVersionListing(
  localstackName: string,
  exactKey: string,
  expectedProviderVersionIds: readonly string[],
  expectedState: "present" | "absent",
  failureStage?: Stage,
): Promise<ObjectVersionListingEvidence> {
  const stage: Stage = failureStage ?? (expectedState === "present"
    ? "abandonment_late_provider_versions" : "abandonment_late_cleanup");
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const result = await runDocker([
      "exec", localstackName, "awslocal", "s3api", "list-object-versions",
      "--bucket", BUCKET, "--prefix", exactKey, "--output", "json",
    ], stage, undefined, true);
    if (result.exitCode === 0) {
      try {
        const value = JSON.parse(result.stdout) as unknown;
        if (isObject(value)) {
          const providerVersionIds = (Array.isArray(value.Versions) ? value.Versions : [])
            .flatMap((item) => isObject(item) && item.Key === exactKey
              && typeof item.VersionId === "string" && /^\S{1,1024}$/.test(item.VersionId)
              ? [item.VersionId] : []);
          const deleteMarkers = (Array.isArray(value.DeleteMarkers) ? value.DeleteMarkers : [])
            .filter((item) => isObject(item) && item.Key === exactKey);
          const expectedPresent = expectedProviderVersionIds.length === 2
            && providerVersionIds.length === 2
            && expectedProviderVersionIds.every((versionId) => providerVersionIds.includes(versionId));
          const expectedAbsent = expectedProviderVersionIds.every((versionId) =>
            !providerVersionIds.includes(versionId));
          const evidence = Object.freeze({
            provider_version_count: providerVersionIds.length,
            delete_marker_count: deleteMarkers.length,
            expected_provider_versions_present: expectedPresent,
            expected_provider_versions_absent: expectedAbsent,
          });
          if ((expectedState === "present" && expectedPresent && deleteMarkers.length === 0)
            || (expectedState === "absent" && providerVersionIds.length === 0
              && deleteMarkers.length === 0 && expectedAbsent)) return evidence;
        }
      } catch {}
    }
    await delay(250);
  }
  throw new BrowserGateError(stage);
}

async function waitForBoundObjectVersionOnly(
  localstackName: string,
  exactKey: string,
  boundProviderVersionId: string,
  unboundProviderVersionId: string,
  stage: Stage,
): Promise<BoundObjectVersionListingEvidence> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const result = await runDocker([
      "exec", localstackName, "awslocal", "s3api", "list-object-versions",
      "--bucket", BUCKET, "--prefix", exactKey, "--output", "json",
    ], stage, undefined, true);
    if (result.exitCode === 0) {
      try {
        const value = JSON.parse(result.stdout) as unknown;
        if (isObject(value)) {
          const providerVersionIds = (Array.isArray(value.Versions) ? value.Versions : [])
            .flatMap((item) => isObject(item) && item.Key === exactKey
              && typeof item.VersionId === "string" && /^\S{1,1024}$/.test(item.VersionId)
              ? [item.VersionId] : []);
          const deleteMarkers = (Array.isArray(value.DeleteMarkers) ? value.DeleteMarkers : [])
            .filter((item) => isObject(item) && item.Key === exactKey);
          const evidence = Object.freeze({
            provider_version_count: providerVersionIds.length,
            delete_marker_count: deleteMarkers.length,
            bound_provider_version_present: providerVersionIds.length === 1
              && providerVersionIds[0] === boundProviderVersionId,
            unbound_provider_version_absent: !providerVersionIds.includes(unboundProviderVersionId),
          });
          if (evidence.provider_version_count === 1 && evidence.delete_marker_count === 0
            && evidence.bound_provider_version_present && evidence.unbound_provider_version_absent) {
            return evidence;
          }
        }
      } catch {}
    }
    await delay(250);
  }
  throw new BrowserGateError(stage);
}

async function inspectAbandonedDocument(page: Page, caseId: string, documentId: string): Promise<boolean> {
  return page.evaluate(async ({ caseValue, documentValue }) => {
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
      Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    try {
      const detailResponse = await fetch(`/api/v1/cases/${caseValue}/documents/${documentValue}`);
      const detailRoot = await detailResponse.json() as unknown;
      const document = object(detailRoot) && object(detailRoot.data) ? detailRoot.data.document : null;
      const detailExact = detailResponse.status === 200 && object(document) && exact(document, [
        "id", "case_id", "case_number", "display_name", "classification", "lifecycle_state",
        "latest_version_state", "pending_upload", "has_active_version", "record_version", "updated_at",
      ]) && document.latest_version_state === "abandoned" && document.pending_upload === null
        && document.has_active_version === false;
      const downloadResponse = await fetch(
        `/api/v1/cases/${caseValue}/documents/${documentValue}/download-intents`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      const downloadRoot = await downloadResponse.json() as unknown;
      const code = object(downloadRoot) && object(downloadRoot.error) ? downloadRoot.error.code : null;
      return detailExact && downloadResponse.status === 409 && code === "CONFLICT";
    } catch {
      return false;
    }
  }, { caseValue: caseId, documentValue: documentId });
}

async function inspectScanFailedDocument(
  page: Page,
  caseId: string,
  documentId: string,
): Promise<{ readonly status: number | null; readonly exact: boolean }> {
  return page.evaluate(async ({ caseValue, documentValue }) => {
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
      Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    try {
      const response = await fetch(`/api/v1/cases/${caseValue}/documents/${documentValue}`);
      const root = await response.json() as unknown;
      const document = object(root) && object(root.data) ? root.data.document : null;
      return Object.freeze({
        status: response.status,
        exact: response.status === 200 && object(document) && exact(document, [
          "id", "case_id", "case_number", "display_name", "classification", "lifecycle_state",
          "latest_version_state", "pending_upload", "has_active_version", "record_version", "updated_at",
        ]) && document.id === documentValue && document.case_id === caseValue
          && document.latest_version_state === "scan_failed" && document.pending_upload === null
          && document.has_active_version === false,
      });
    } catch {
      return Object.freeze({ status: null, exact: false });
    }
  }, { caseValue: caseId, documentValue: documentId });
}

async function waitForUnboundCleanupDatabaseEvidence(
  target: OneRoleBaselineTarget,
  documentId: string,
  documentVersionId: string,
  providerVersionIds: readonly string[],
  privateValues: readonly string[],
  stage: Stage,
): Promise<UnboundCleanupDatabaseEvidence> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('app.organization_id',$1,true)", [ORGANIZATION_ID]);
        await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
        const result = await client.query<UnboundCleanupDatabaseEvidence>(`SELECT
          (SELECT count(*)::int FROM documents_scan_results
            WHERE organization_id=$1 AND document_version_id=$3) AS scan_results,
          (SELECT count(*)::int FROM audit_events
            WHERE organization_id=$1 AND resource_id=$3
              AND event_type='documents.unbound_provider_version_removed') AS cleanup_audit,
          (SELECT count(*)::int FROM audit_outbox
            WHERE organization_id=$1 AND aggregate_id=$3
              AND event_type='documents.unbound_provider_version_removed') AS cleanup_outbox,
          ((SELECT count(*) FROM audit_events AS event
            WHERE event.organization_id=$1 AND event.resource_id=$3
              AND event.event_type='documents.unbound_provider_version_removed'
              AND EXISTS (SELECT 1 FROM unnest($5::text[]) AS private_value
                WHERE event.metadata::text LIKE '%' || private_value || '%')) +
           (SELECT count(*) FROM audit_outbox AS message
            WHERE message.organization_id=$1 AND message.aggregate_id=$3
              AND message.event_type='documents.unbound_provider_version_removed'
              AND EXISTS (SELECT 1 FROM unnest($5::text[]) AS private_value
                WHERE message.payload::text LIKE '%' || private_value || '%')))::int
            AS private_value_matches,
          ((SELECT count(*) FROM audit_events AS event
            WHERE event.organization_id=$1 AND event.resource_id=$3
              AND event.event_type='documents.unbound_provider_version_removed'
              AND event.metadata ?| ARRAY[
                'object_bucket','object_key','object_version_id','provider_version_id',
                'checksum_sha256','content_type','size_bytes','url','filename','bytes'
              ]) +
           (SELECT count(*) FROM audit_outbox AS message
            WHERE message.organization_id=$1 AND message.aggregate_id=$3
              AND message.event_type='documents.unbound_provider_version_removed'
              AND message.payload ?| ARRAY[
                'object_bucket','object_key','object_version_id','provider_version_id',
                'checksum_sha256','content_type','size_bytes','url','filename','bytes'
              ]))::int AS forbidden_field_matches,
          (SELECT count(*)::int FROM documents_document_versions
            WHERE organization_id=$1 AND document_id=$2 AND id=$3 AND state='available'
              AND object_version_id=ANY($4::text[])) AS available_bound,
          (SELECT count(*)::int FROM documents_documents
            WHERE organization_id=$1 AND id=$2 AND active_document_version_id=$3)
            AS active_pointer_bound,
          (SELECT object_version_id FROM documents_document_versions
            WHERE organization_id=$1 AND document_id=$2 AND id=$3)
            AS bound_provider_version_id`, [
          ORGANIZATION_ID,
          documentId,
          documentVersionId,
          providerVersionIds,
          privateValues,
        ]);
        await client.query("COMMIT");
        const row = result.rows[0];
        if (!row) throw new BrowserGateError(stage);
        const complete = row.scan_results === 1 && row.cleanup_audit === 1
          && row.cleanup_outbox === 1 && row.private_value_matches === 0
          && row.forbidden_field_matches === 0 && row.available_bound === 1
          && row.active_pointer_bound === 1 && row.bound_provider_version_id !== null
          && providerVersionIds.includes(row.bound_provider_version_id);
        if (complete) return Object.freeze(row);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error instanceof BrowserGateError) throw error;
        throw new BrowserGateError(stage);
      }
      await delay(250);
    }
    throw new BrowserGateError(stage);
  } finally {
    await client.end().catch(() => {});
  }
}

async function waitForAbandonedCleanupDatabaseEvidence(
  target: OneRoleBaselineTarget,
  documentId: string,
  documentVersionId: string,
  privateObjectCoordinates: readonly string[],
): Promise<AbandonedCleanupDatabaseEvidence> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('app.organization_id',$1,true)", [ORGANIZATION_ID]);
        await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
        const result = await client.query<AbandonedCleanupDatabaseEvidence>(`SELECT
          (SELECT count(*)::int FROM documents_scan_results
            WHERE organization_id=$1 AND document_version_id=$3) AS scan_results,
          (SELECT count(*)::int FROM audit_events
            WHERE organization_id=$1 AND resource_id=$3
              AND event_type='documents.abandoned_object_removed') AS cleanup_audit,
          (SELECT count(*)::int FROM audit_outbox
            WHERE organization_id=$1 AND aggregate_id=$3
              AND event_type='documents.abandoned_object_removed') AS cleanup_outbox,
          (SELECT count(*)::int FROM audit_events
            WHERE organization_id=$1 AND resource_id=$3 AND event_type IN (
              'documents.object_received','documents.object_rejected','documents.scan_claimed',
              'documents.scan_clean','documents.scan_rejected','documents.scan_failed',
              'documents.scan_dead_lettered','documents.scan_reconciled'
            )) AS scan_audit,
          (SELECT count(*)::int FROM audit_outbox
            WHERE organization_id=$1 AND aggregate_id=$3 AND event_type IN (
              'documents.object_received','documents.object_rejected','documents.scan_claimed',
              'documents.scan_clean','documents.scan_rejected','documents.scan_failed',
              'documents.scan_dead_lettered','documents.scan_reconciled'
            )) AS scan_outbox,
          ((SELECT count(*) FROM audit_events AS event
            WHERE event.organization_id=$1 AND event.resource_id=$3
              AND event.event_type IN (
                'documents.abandoned_object_removed','documents.object_received',
                'documents.object_rejected','documents.scan_claimed','documents.scan_clean',
                'documents.scan_rejected','documents.scan_failed',
                'documents.scan_dead_lettered','documents.scan_reconciled'
              ) AND EXISTS (SELECT 1 FROM unnest($4::text[]) AS coordinate
                WHERE event.metadata::text LIKE '%' || coordinate || '%')) +
           (SELECT count(*) FROM audit_outbox AS message
            WHERE message.organization_id=$1 AND message.aggregate_id=$3
              AND message.event_type IN (
                'documents.abandoned_object_removed','documents.object_received',
                'documents.object_rejected','documents.scan_claimed','documents.scan_clean',
                'documents.scan_rejected','documents.scan_failed',
                'documents.scan_dead_lettered','documents.scan_reconciled'
              ) AND EXISTS (SELECT 1 FROM unnest($4::text[]) AS coordinate
                WHERE message.payload::text LIKE '%' || coordinate || '%')))::int
            AS private_object_coordinate_matches,
          (SELECT count(*)::int FROM documents_document_versions
            WHERE organization_id=$1 AND document_id=$2 AND id=$3
              AND state='abandoned' AND object_version_id IS NULL) AS abandoned_unbound,
          (SELECT count(*)::int FROM documents_documents
            WHERE organization_id=$1 AND id=$2 AND active_document_version_id IS NULL)
            AS active_pointer_null`, [
          ORGANIZATION_ID,
          documentId,
          documentVersionId,
          privateObjectCoordinates,
        ]);
        await client.query("COMMIT");
        const row = result.rows[0];
        if (!row) throw new BrowserGateError("abandonment_late_database");
        const complete = row.scan_results === 0 && row.cleanup_audit === 2
          && row.cleanup_outbox === 2 && row.scan_audit === 0 && row.scan_outbox === 0
          && row.private_object_coordinate_matches === 0 && row.abandoned_unbound === 1
          && row.active_pointer_null === 1;
        if (complete) return Object.freeze(row);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error instanceof BrowserGateError) throw error;
        throw new BrowserGateError("abandonment_late_database");
      }
      await delay(250);
    }
    throw new BrowserGateError("abandonment_late_database");
  } finally {
    await client.end().catch(() => {});
  }
}

async function readDocumentRecordVersion(page: Page, caseId: string, documentId: string): Promise<number | null> {
  return page.evaluate(async ({ caseValue, documentValue }) => {
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
      Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    try {
      const response = await fetch(`/api/v1/cases/${caseValue}/documents/${documentValue}`);
      const root = await response.json() as unknown;
      const document = object(root) && object(root.data) ? root.data.document : null;
      if (response.status !== 200 || !object(document) || !exact(document, [
        "id", "case_id", "case_number", "display_name", "classification", "lifecycle_state",
        "latest_version_state", "pending_upload", "has_active_version", "record_version", "updated_at",
      ]) || !Number.isSafeInteger(document.record_version) || (document.record_version as number) < 1) return null;
      return document.record_version as number;
    } catch {
      return null;
    }
  }, { caseValue: caseId, documentValue: documentId });
}

async function directDownloadIntent(
  page: Page,
  caseId: string,
  documentId: string,
  privateMarker: string,
): Promise<WriteEvidence> {
  return page.evaluate(async ({ caseValue, documentValue, markerValue }) => {
    const privateValues = [caseValue, documentValue, markerValue];
    const echoed = (text: string) => privateValues.some((value) => text.includes(value));
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const decode = (status: number, text: string) => {
      let value: unknown;
      try { value = JSON.parse(text); } catch {
        return { status, jsonParseable: false, exactAck: false, id: null, version: null, safeCode: "OTHER" as const, privateEcho: echoed(text) };
      }
      if (!object(value)) return { status, jsonParseable: true, exactAck: false, id: null, version: null, safeCode: "OTHER" as const, privateEcho: echoed(text) };
      const code = object(value.error) && typeof value.error.code === "string" ? value.error.code : "NONE";
      const safeCode = code === "VALIDATION_FAILED" || code === "STALE_VERSION" || code === "CONFLICT" ||
        code === "FORBIDDEN" || code === "NOT_FOUND" || code === "NONE" ? code as SafeCode : "OTHER" as const;
      return { status, jsonParseable: true, exactAck: false, id: null, version: null, safeCode, privateEcho: echoed(text) };
    };
    try {
      const response = await fetch(`/api/v1/cases/${caseValue}/documents/${documentValue}/download-intents`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-doc02-private-probe": markerValue },
        body: "{}",
      });
      return decode(response.status, await response.text());
    } catch {
      return { status: null, jsonParseable: false, exactAck: false, id: null, version: null, safeCode: "OTHER" as const, privateEcho: false };
    }
  }, { caseValue: caseId, documentValue: documentId, markerValue: privateMarker });
}

async function inspectDeniedRole(
  page: Page,
  baseUrl: string,
  caseId: string,
  documentId: string,
  versionId: string,
  privateChecksum: string,
  privateMarker: string,
): Promise<{ readonly uiHidden: boolean; readonly forbiddenCount: number; readonly privateEcho: boolean }> {
  const navigation = await page.goto(`${baseUrl}/documents`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  await page.getByText("無法查看文件", { exact: true }).waitFor({ state: "visible" });
  const uiHidden = await page.locator('input[type="file"]').count() === 0 &&
    await page.getByRole("link", { name: "文件", exact: true }).count() === 0;
  const result = await page.evaluate(async ({ caseValue, documentValue, versionValue, checksumValue, markerValue }) => {
    const privateValues = [caseValue, documentValue, versionValue, checksumValue, markerValue];
    const echoed = (text: string) => privateValues.some((value) => text.includes(value));
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const decode = (status: number, text: string) => {
      let value: unknown;
      try { value = JSON.parse(text); } catch {
        return { status, safeCode: "OTHER" as const, privateEcho: echoed(text) };
      }
      if (!object(value)) return { status, safeCode: "OTHER" as const, privateEcho: echoed(text) };
      const code = object(value.error) && typeof value.error.code === "string" ? value.error.code : "NONE";
      const safeCode = code === "VALIDATION_FAILED" || code === "STALE_VERSION" || code === "CONFLICT" ||
        code === "FORBIDDEN" || code === "NOT_FOUND" || code === "NONE" ? code as SafeCode : "OTHER" as const;
      return { status, safeCode, privateEcho: echoed(text) };
    };
    const call = async (path: string, body: object, key?: string) => {
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-doc02-private-probe": markerValue,
        };
        if (key) headers["idempotency-key"] = key;
        const response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
        return decode(response.status, await response.text());
      } catch {
        return { status: null, safeCode: "OTHER" as const, privateEcho: false };
      }
    };
    return Promise.all([
      call(`/api/v1/cases/${caseValue}/documents/${documentValue}/versions`, {
        checksum_sha256: checksumValue,
        size_bytes: 1,
        content_type: "application/pdf",
        expected_document_record_version: 1,
      }, `doc02-denied-${crypto.randomUUID()}`),
      call(`/api/v1/cases/${caseValue}/documents/${documentValue}/versions/${versionValue}/upload-intents`, {
        expected_record_version: 1,
      }),
      call(`/api/v1/cases/${caseValue}/documents/${documentValue}/versions/${versionValue}/abandonments`, {
        expected_document_record_version: 1,
        expected_version_record_version: 1,
      }, `doc02-denied-abandon-${crypto.randomUUID()}`),
      call(`/api/v1/cases/${caseValue}/documents/${documentValue}/download-intents`, {}),
    ]);
  }, {
    caseValue: caseId,
    documentValue: documentId,
    versionValue: versionId,
    checksumValue: privateChecksum,
    markerValue: privateMarker,
  });
  return {
    uiHidden,
    forbiddenCount: result.filter((item) => item.status === 403 && item.safeCode === "FORBIDDEN").length,
    privateEcho: result.some((item) => item.privateEcho),
  };
}

async function downloadAndCompare(page: Page, button: Locator, expected: Buffer): Promise<boolean> {
  const downloadPromise = controlledWait(page.waitForEvent("download"));
  await button.click();
  const download = await downloadPromise;
  if (download === null) return false;
  const bytes = await readDownload(download);
  await page.getByRole("status").filter({ hasText: "安全版本已下載，文件狀態已重新確認。" }).waitFor({ state: "visible" });
  return download.suggestedFilename() === "document.pdf" && bytes.equals(expected);
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  assert.notEqual(stream, null);
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readSafeDocumentAuthority(
  page: Page,
  caseId: string,
  documentId: string,
): Promise<SafeDocumentAuthorityEvidence> {
  return page.evaluate(async ({ caseValue, documentValue }) => {
    const states = [
      "pending_upload", "quarantined", "scanning", "available", "rejected", "scan_failed",
      "abandoned", "superseded", "pending_delete", "deleted",
    ] as const;
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    try {
      const response = await fetch(`/api/v1/cases/${caseValue}/documents/${documentValue}`, {
        method: "GET",
        cache: "no-store",
      });
      const status = response.status;
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return {
          fetchCompleted: true,
          status,
          jsonParseable: false,
          state: "NONE" as const,
          pending: "unknown" as const,
        };
      }
      const data = object(value) ? value.data : null;
      const document = object(data) ? data.document : null;
      if (!object(document)) {
        return {
          fetchCompleted: true,
          status,
          jsonParseable: true,
          state: "NONE" as const,
          pending: "unknown" as const,
        };
      }
      const state = document.latest_version_state === null
        ? "NONE" as const
        : typeof document.latest_version_state === "string" && states.some((item) => item === document.latest_version_state)
          ? document.latest_version_state as (typeof states)[number]
          : "OTHER" as const;
      const pending = document.pending_upload === null
        ? "absent" as const
        : object(document.pending_upload) ? "present" as const : "invalid" as const;
      return { fetchCompleted: true, status, jsonParseable: true, state, pending };
    } catch {
      return {
        fetchCompleted: false,
        status: null,
        jsonParseable: false,
        state: "NONE" as const,
        pending: "unknown" as const,
      };
    }
  }, { caseValue: caseId, documentValue: documentId });
}

async function readPrivateSignedUploadTarget(
  response: PlaywrightResponse,
  expectedLocalstackOrigin: string,
  expectedBytes: Buffer,
): Promise<string | null> {
  if (response.status() !== 200) return null;
  try {
    const root = await response.json() as unknown;
    if (!isObject(root) || !hasExactKeys(root, ["api_version", "request_id", "data"])
      || root.api_version !== "v1" || typeof root.request_id !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(root.request_id)
      || !isObject(root.data) || !hasExactKeys(root.data, ["method", "expires_at_ms", "url", "headers"])
      || root.data.method !== "PUT" || !Number.isSafeInteger(root.data.expires_at_ms)
      || (root.data.expires_at_ms as number) <= Date.now()
      || (root.data.expires_at_ms as number) > Date.now() + 600_000
      || typeof root.data.url !== "string" || !isObject(root.data.headers)
      || !hasExactKeys(root.data.headers, ["content-type", "x-amz-checksum-sha256"])
      || root.data.headers["content-type"] !== "application/pdf"
      || root.data.headers["x-amz-checksum-sha256"] !== createHash("sha256").update(expectedBytes).digest("base64")) {
      return null;
    }
    const expectedOrigin = new URL(expectedLocalstackOrigin);
    const privateSignedTarget = new URL(root.data.url);
    return privateSignedTarget.protocol === "http:" && privateSignedTarget.origin === expectedOrigin.origin
      && privateSignedTarget.username === "" && privateSignedTarget.password === "" && privateSignedTarget.hash === ""
      ? privateSignedTarget.href : null;
  } catch {
    return null;
  }
}

async function readVersionChangedUiSnapshot(cleanRow: Locator): Promise<VersionChangedUiSnapshot> {
  const successStatus = cleanRow.getByRole("status")
    .filter({ hasText: "掃描完成，安全版本已可下載。" });
  const availableBadge = cleanRow.getByText("可使用", { exact: true });
  const successStatusCount = await successStatus.count();
  const availableBadgeCount = await availableBadge.count();
  return Object.freeze({
    successStatusCount,
    successStatusVisible: successStatusCount > 0 && await successStatus.first().isVisible(),
    availableBadgeCount,
    availableBadgeVisible: availableBadgeCount > 0 && await availableBadge.first().isVisible(),
    alertCount: await cleanRow.getByRole("alert").count(),
    unavailableAlertCount: await cleanRow.getByRole("alert")
      .filter({ hasText: "結果暫時無法確認，請稍後重試；重試不會重複建立版本。" }).count(),
    conflictAlertCount: await cleanRow.getByRole("alert")
      .filter({ hasText: "文件狀態已變更或操作已逾期，請重新確認。" }).count(),
    timeoutAlertCount: await cleanRow.getByRole("alert")
      .filter({ hasText: "掃描仍未在 90 秒內完成，可稍後重新檢查。" }).count(),
  });
}

async function safePlaywrightResponseCode(response: PlaywrightResponse | null): Promise<SafeCode> {
  if (response === null) return "OTHER";
  if (response.status() >= 200 && response.status() < 300) return "NONE";
  try {
    const value = await response.json() as unknown;
    return isObject(value) ? safeErrorCode(value) : "OTHER";
  } catch {
    return "OTHER";
  }
}

function safeWriteEvidence(status: number, text: string, expectedVersion: number): WriteEvidence {
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    return { ...emptyWriteEvidence(), status, jsonParseable: false };
  }
  if (!isObject(value)) return { ...emptyWriteEvidence(), status, jsonParseable: true };
  const data = value.data;
  const exactAck = status >= 200 && status < 300 && isObject(data) &&
    hasExactKeys(data, ["id", "record_version"]) && isUuid(data.id) && data.record_version === expectedVersion;
  const code = safeErrorCode(value);
  return {
    status,
    jsonParseable: true,
    exactAck,
    id: exactAck ? data.id as string : null,
    version: exactAck ? expectedVersion : null,
    safeCode: code,
    privateEcho: false,
  };
}

function emptyWriteEvidence(): WriteEvidence {
  return {
    status: null,
    jsonParseable: false,
    exactAck: false,
    id: null,
    version: null,
    safeCode: "OTHER",
    privateEcho: false,
  };
}

function safeErrorCode(value: Record<string, unknown>): SafeCode {
  const code = isObject(value.error) && typeof value.error.code === "string" ? value.error.code : "NONE";
  return code === "VALIDATION_FAILED" || code === "STALE_VERSION" || code === "CONFLICT" ||
    code === "FORBIDDEN" || code === "NOT_FOUND" || code === "NONE" ? code : "OTHER";
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isGetPath(response: { request(): { method(): string }; url(): string }, pathname: string): boolean {
  return response.request().method() === "GET" && new URL(response.url()).pathname === pathname;
}

function isRequestPath(request: PlaywrightRequest, method: string, pathname: string): boolean {
  return request.method() === method && new URL(request.url()).pathname === pathname;
}

function controlledWait<Value>(promise: Promise<Value>): Promise<Value | null> {
  return promise.catch(() => null);
}

async function boundedDiagnostic<Value>(
  operation: () => Promise<Value>,
  fallback: Value,
): Promise<Value> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Value>((resolveTimeout) => {
    timeoutHandle = setTimeout(
      () => resolveTimeout(fallback),
      VERSION_CHANGED_DIAGNOSTIC_TIMEOUT_MS,
    );
    timeoutHandle.unref();
  });
  const result = Promise.resolve().then(operation).catch(() => fallback);
  try {
    return await Promise.race([result, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function zeroViewport(): ViewportEvidence {
  return { horizontal_overflow: 0, out_of_bounds_controls: 0, overlapping_controls: 0, clipped_text: 0 };
}

async function viewportEvidence(page: Page): Promise<ViewportEvidence> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const isVisible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const controls = [...document.querySelectorAll<HTMLElement>("a,button,input,select,textarea")].filter(isVisible);
    const textContainers = [...document.querySelectorAll<HTMLElement>(
      "h1,h2,h3,h4,p,label,dt,dd,th,td,[role='status'],[role='alert']",
    )].filter((element) => isVisible(element) && (element.textContent?.trim().length ?? 0) > 0);
    const outOfBounds = controls.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > root.clientWidth + 1;
    }).length;
    let overlapping = 0;
    for (let left = 0; left < controls.length; left += 1) {
      const first = controls[left]!.getBoundingClientRect();
      for (let right = left + 1; right < controls.length; right += 1) {
        if (controls[left]!.contains(controls[right]!) || controls[right]!.contains(controls[left]!)) continue;
        const second = controls[right]!.getBoundingClientRect();
        if (Math.min(first.right, second.right) - Math.max(first.left, second.left) > 2 &&
            Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 2) {
          overlapping += 1;
        }
      }
    }
    return {
      horizontal_overflow: Math.max(0, root.scrollWidth - root.clientWidth),
      out_of_bounds_controls: outOfBounds,
      overlapping_controls: overlapping,
      clipped_text: textContainers.filter((element) => {
        const style = getComputedStyle(element);
        const clipsX = (style.overflowX === "hidden" || style.overflowX === "clip") &&
          element.scrollWidth > element.clientWidth + 1;
        const clipsY = (style.overflowY === "hidden" || style.overflowY === "clip") &&
          element.scrollHeight > element.clientHeight + 1;
        return clipsX || clipsY;
      }).length,
    };
  });
}

async function discoverCanonicalBaseUrl(
  listenUrl: string,
  browserOrigin: string,
  port: number,
  evidence: Evidence,
  setStage: (stage: Stage) => void,
): Promise<string> {
  setStage("canonical_origin_transport");
  evidence.canonical_request_started = true;
  let response: Response;
  try {
    response = await fetch(`${listenUrl}/api/auth/login`, { redirect: "manual" });
    evidence.canonical_fetch_completed = true;
  } catch {
    throw new BrowserGateError("canonical_origin_transport");
  }

  setStage("canonical_origin_response");
  let responseUrl: URL;
  try {
    responseUrl = new URL(response.url);
  } catch {
    throw new BrowserGateError("canonical_origin_response");
  }
  evidence.canonical_response_origin_exact = responseUrl.origin === listenUrl;
  evidence.canonical_response_path_exact = responseUrl.pathname === "/api/auth/login";
  evidence.canonical_response_status = response.status;
  evidence.canonical_response_status_307 = response.status === 307;
  assert.equal(evidence.canonical_response_origin_exact, true);
  assert.equal(evidence.canonical_response_path_exact, true);
  assert.equal(response.status, 307);

  setStage("canonical_origin_location");
  const location = response.headers.get("location");
  evidence.canonical_location_present = location !== null;
  evidence.canonical_redirect_count = location === null ? 0 : 1;
  assert.notEqual(location, null);
  let target: URL;
  try {
    target = new URL(location!, listenUrl);
    evidence.canonical_location_parseable = true;
  } catch {
    throw new BrowserGateError("canonical_origin_location");
  }

  setStage("canonical_origin_contract");
  evidence.canonical_location_origin_exact = target.origin === browserOrigin;
  evidence.canonical_location_path_exact = target.pathname === "/api/v1/auth/login";
  evidence.canonical_protocol_http = target.protocol === "http:";
  evidence.canonical_hostname_loopback = ["localhost", "127.0.0.1", "::1", "[::1]"]
    .includes(target.hostname.toLowerCase());
  evidence.canonical_port_matches = target.port === String(port);
  evidence.canonical_credentials_absent = target.username === "" && target.password === "";
  evidence.canonical_search_absent = target.search === "";
  evidence.canonical_hash_absent = target.hash === "";
  assert.equal(evidence.canonical_location_origin_exact, true);
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
  const directory = await mkdtemp(join(tmpdir(), "tianxing-doc02-browser-next-"));
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

function runtimeEnv(runtime: RuntimeEnvironment): NodeJS.ProcessEnv {
  return {
    PATH: `/opt/homebrew/opt/node@22/bin:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    NEXT_TELEMETRY_DISABLED: "1",
    APP_ENV: "development",
    NODE_ENV: "development",
    APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "database-test",
    LOCAL_SYNTHETIC_DATABASE_URL: runtime.connectionString,
    LOCAL_SYNTHETIC_LOCALSTACK_ENDPOINT: runtime.localstackEndpoint,
    LOCAL_SYNTHETIC_AWS_REGION: REGION,
    LOCAL_SYNTHETIC_S3_BUCKET: BUCKET,
    LOCAL_SYNTHETIC_SQS_QUEUE: QUEUE,
    LOCAL_SYNTHETIC_SQS_DLQ: DLQ,
    LOCAL_SYNTHETIC_CLAMAV_HOST: "127.0.0.1",
    LOCAL_SYNTHETIC_CLAMAV_PORT: String(runtime.clamavPort),
    LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: "2000",
  };
}

function startNextDev(directory: string, port: number, runtime: RuntimeEnvironment): ChildProcess {
  const child = spawn(process.execPath, [
    resolve("node_modules/next/dist/bin/next"), "dev", "--webpack",
    "--hostname", "127.0.0.1", "--port", String(port),
  ], {
    cwd: directory,
    env: runtimeEnv(runtime),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  captureProcessLogs(child);
  return child;
}

function startDocumentWorker(directory: string, runtime: RuntimeEnvironment): ChildProcess {
  const child = spawn(process.execPath, [
    "--conditions=react-server",
    join(directory, "workers/document-worker.ts"),
  ], {
    cwd: directory,
    env: {
      ...runtimeEnv(runtime),
      LOCAL_SYNTHETIC_ORGANIZATION_ID: ORGANIZATION_ID,
      LOCAL_SYNTHETIC_DOCUMENT_WORKER_CONTEXT_ID: WORKER_CONTEXT_ID,
      LOCAL_SYNTHETIC_DOCUMENT_WORKER_SAFE_EVIDENCE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  captureProcessLogs(child);
  return child;
}

function captureProcessLogs(child: ChildProcess): void {
  const logs = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { logs.stdout = boundedLog(`${logs.stdout}${chunk}`); });
  child.stderr?.on("data", (chunk: string) => { logs.stderr = boundedLog(`${logs.stderr}${chunk}`); });
  PROCESS_LOGS.set(child, logs);
}

function boundedLog(value: string): string {
  return value.length <= 1_000_000 ? value : value.slice(value.length - 1_000_000);
}

function safeProcessLogEvidence(
  child: ChildProcess | undefined,
  frozenPrivate: readonly string[],
  standaloneBusinessRouteIds: readonly string[],
): SafeProcessLogEvidence {
  const logs = child === undefined ? undefined : PROCESS_LOGS.get(child);
  if (logs === undefined) {
    return Object.freeze({
      captured: false,
      stdout: Object.freeze({ frozen_private: 0, standalone_business_route_id: 0 }),
      stderr: Object.freeze({ frozen_private: 0, standalone_business_route_id: 0 }),
    });
  }
  return Object.freeze({
    captured: true,
    stdout: safeProcessLogCategoryCounts(logs.stdout, frozenPrivate, standaloneBusinessRouteIds),
    stderr: safeProcessLogCategoryCounts(logs.stderr, frozenPrivate, standaloneBusinessRouteIds),
  });
}

function safeProcessLogCategoryCounts(
  channel: string,
  frozenPrivate: readonly string[],
  standaloneBusinessRouteIds: readonly string[],
): SafeProcessLogCategoryCounts {
  return Object.freeze({
    frozen_private: countUniqueProcessLogMatches(channel, frozenPrivate),
    standalone_business_route_id: countUniqueProcessLogMatches(channel, standaloneBusinessRouteIds),
  });
}

function countUniqueProcessLogMatches(channel: string, forbidden: readonly string[]): number {
  return new Set(forbidden.filter((value) => value !== "" && channel.includes(value))).size;
}

function assertNoSensitiveProcessLogs(child: ChildProcess | undefined, forbidden: readonly string[]): void {
  assert.notEqual(child, undefined);
  const logs = PROCESS_LOGS.get(child!);
  assert.notEqual(logs, undefined);
  const combined = `${logs!.stdout}\n${logs!.stderr}`;
  assert.equal(forbidden.some((value) => value !== "" && combined.includes(value)), false);
}

async function waitForProcessLog(child: ChildProcess, marker: string, stage: Stage): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (processExited(child)) throw new BrowserGateError(stage);
    const logs = PROCESS_LOGS.get(child);
    if (logs?.stdout.includes(marker) || logs?.stderr.includes(marker)) return;
    await delay(250);
  }
  throw new BrowserGateError(stage);
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  child.stdout?.resume();
  child.stderr?.resume();
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (processExited(child)) throw new BrowserGateError("next_dev");
    try { if ((await fetch(`${baseUrl}/api/v1/auth/me`)).status === 401) return; } catch {}
    await delay(500);
  }
  throw new BrowserGateError("next_dev");
}

function emptyProcessStopEvidence(): ProcessStopEvidence {
  return {
    stopRequested: false,
    softCloseObserved: false,
    groupAliveAfterSoft: false,
    hardKillRequested: false,
    finalCloseObserved: false,
    finalGroupAbsent: false,
    stopped: false,
  };
}

async function stopProcess(
  child: ChildProcess | undefined,
  evidence?: ProcessStopEvidence,
): Promise<boolean> {
  if (!child) return true;
  const pid = child.pid;
  if (pid === undefined) return processExited(child);
  if (evidence) evidence.stopRequested = true;
  const closed = processExited(child)
    ? Promise.resolve(true)
    : new Promise<boolean>((resolveStopped) => child.once("close", () => resolveStopped(true)));
  signalProcessGroup(pid, "SIGTERM", child);
  const softCloseObserved = await Promise.race([closed, delay(15_000).then(() => false)]);
  const groupAliveAfterSoft = processGroupAlive(pid);
  if (evidence) {
    evidence.softCloseObserved = softCloseObserved;
    evidence.groupAliveAfterSoft = groupAliveAfterSoft;
  }
  if (groupAliveAfterSoft) {
    if (evidence) evidence.hardKillRequested = true;
    signalProcessGroup(pid, "SIGKILL", child);
  }
  const finalCloseObserved = softCloseObserved ||
    await Promise.race([closed, delay(5_000).then(() => false)]);
  for (let attempt = 0; attempt < 50 && processGroupAlive(pid); attempt += 1) await delay(100);
  const finalGroupAbsent = !processGroupAlive(pid);
  const stopped = finalGroupAbsent;
  if (evidence) {
    evidence.finalCloseObserved = finalCloseObserved || processExited(child);
    evidence.finalGroupAbsent = finalGroupAbsent;
    evidence.stopped = stopped;
  }
  return stopped;
}

function processExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return nodeErrorCode(error) !== "ESRCH";
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals, child: ChildProcess): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (nodeErrorCode(error) !== "ESRCH") child.kill(signal);
  }
}

function nodeErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : null;
}

async function closeContext(context: BrowserContext | undefined): Promise<boolean> {
  if (!context) return true;
  try { await context.close(); return true; } catch { return false; }
}

async function removeDirectory(directory: string): Promise<boolean> {
  if (!directory) return true;
  try { await rm(directory, { recursive: true, force: true }); return true; } catch { return false; }
}

async function removeContainer(name: string): Promise<boolean> {
  const inspect = await runDocker(["container", "inspect", name], "cleanup", undefined, true);
  if (inspect.exitCode !== 0) return true;
  return (await runDocker(["rm", "--force", name], "cleanup", undefined, true)).exitCode === 0;
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

async function waitForPublishedPort(containerName: string, containerPort: string, stage: Stage): Promise<number> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await runDocker(["port", containerName, containerPort], stage, undefined, true);
    if (result.exitCode === 0 && result.stdout.trim() !== "") return readLoopbackPort(result.stdout, stage);
    await delay(250);
  }
  throw new BrowserGateError(stage);
}

async function waitForLocalStack(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const result = await runDocker([
      "exec", containerName, "/bin/sh", "-c",
      `awslocal s3api head-bucket --bucket ${BUCKET} >/dev/null 2>&1 && ` +
      `awslocal sqs get-queue-url --queue-name ${QUEUE} >/dev/null 2>&1 && ` +
      `awslocal sqs get-queue-url --queue-name ${DLQ} >/dev/null 2>&1`,
    ], "localstack_setup", undefined, true);
    if (result.exitCode === 0) return;
    await delay(500);
  }
  throw new BrowserGateError("localstack_setup");
}

async function sendUnboundProviderVersionReplay(
  localstackName: string,
  exactKey: string,
  providerVersionId: string,
): Promise<boolean> {
  const body = JSON.stringify({
    Records: [{
      eventSource: "aws:s3",
      eventName: "ObjectCreated:Put",
      awsRegion: REGION,
      s3: {
        bucket: { name: BUCKET },
        object: { key: exactKey, versionId: providerVersionId },
      },
    }],
  });
  const result = await runDocker([
    "exec", "--interactive", localstackName, "/bin/sh", "-c",
    `queue_url="$(awslocal sqs get-queue-url --queue-name ${QUEUE} --query QueueUrl --output text)" && ` +
      "payload=\"$(cat)\" && " +
      "awslocal sqs send-message --queue-url \"$queue_url\" --message-body \"$payload\" >/dev/null",
  ], "unbound_replay", body, true);
  return result.exitCode === 0;
}

async function waitForMainQueueDrainEvidence(
  localstackName: string,
  worker: ChildProcess,
  expectedDeleteCount: number,
  stage: Stage,
): Promise<QueueDrainEvidence> {
  let visibleCount: number | null = null;
  let notVisibleCount: number | null = null;
  let delayedCount: number | null = null;
  let attributesComplete = false;
  let workerState: QueueDrainEvidence["worker_state"] = "alive";
  let pollCount = 0;

  for (let attempt = 0; attempt < QUEUE_DRAIN_MAX_POLLS; attempt += 1) {
    pollCount = attempt + 1;
    workerState = processExited(worker) ? "exited" : "alive";
    const counts = await readMainQueueCounts(localstackName, stage);
    attributesComplete = counts !== null;
    visibleCount = counts?.[0] ?? null;
    notVisibleCount = counts?.[1] ?? null;
    delayedCount = counts?.[2] ?? null;
    const requestedCount = countWorkerDeleteMarker(
      worker,
      WORKER_MAIN_DELETE_REQUESTED_MARKER,
    );
    const completedCount = countWorkerDeleteMarker(
      worker,
      WORKER_MAIN_DELETE_COMPLETED_MARKER,
    );
    const drained = attributesComplete && visibleCount === 0 && notVisibleCount === 0 &&
      delayedCount === 0 && requestedCount === expectedDeleteCount &&
      completedCount === expectedDeleteCount && workerState === "alive";
    if (drained || workerState === "exited") {
      return Object.freeze({
        main_delete_requested_count: requestedCount,
        main_delete_completed_count: completedCount,
        visible_count: visibleCount,
        not_visible_count: notVisibleCount,
        delayed_count: delayedCount,
        attributes_complete: attributesComplete,
        poll_count: pollCount,
        worker_state: workerState,
        drained,
      });
    }
    if (attempt + 1 < QUEUE_DRAIN_MAX_POLLS) await delay(QUEUE_DRAIN_POLL_INTERVAL_MS);
  }

  return Object.freeze({
    main_delete_requested_count: countWorkerDeleteMarker(
      worker,
      WORKER_MAIN_DELETE_REQUESTED_MARKER,
    ),
    main_delete_completed_count: countWorkerDeleteMarker(
      worker,
      WORKER_MAIN_DELETE_COMPLETED_MARKER,
    ),
    visible_count: visibleCount,
    not_visible_count: notVisibleCount,
    delayed_count: delayedCount,
    attributes_complete: attributesComplete,
    poll_count: pollCount,
    worker_state: workerState,
    drained: false,
  });
}

function countWorkerDeleteMarker(child: ChildProcess, marker: WorkerDeleteMarker): number {
  const stdout = PROCESS_LOGS.get(child)?.stdout ?? "";
  return stdout.split(/\r?\n/u).filter((line) => line === marker).length;
}

function countWorkerUnavailableMarker(child: ChildProcess): number {
  const logs = PROCESS_LOGS.get(child);
  return [logs?.stdout ?? "", logs?.stderr ?? ""].reduce(
    (count, channel) => count + channel.split(/\r?\n/u)
      .filter((line) => line === WORKER_UNAVAILABLE_MARKER).length,
    0,
  );
}

async function waitForMainQueueMessage(localstackName: string, stage: Stage): Promise<boolean> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const counts = await readMainQueueCounts(localstackName, stage);
    if (counts !== null && counts[0] >= 1 && counts[1] === 0 && counts[2] === 0) return true;
    await delay(250);
  }
  throw new BrowserGateError(stage);
}

async function readMainQueueCounts(
  localstackName: string,
  stage: Stage,
): Promise<readonly [number, number, number] | null> {
  const result = await runDocker([
    "exec", localstackName, "/bin/sh", "-c",
    `queue_url="$(awslocal sqs get-queue-url --queue-name ${QUEUE} --query QueueUrl --output text)" && ` +
      "awslocal sqs get-queue-attributes --queue-url \"$queue_url\" --attribute-names All " +
      "--query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible," +
      "ApproximateNumberOfMessagesDelayed]' --output text",
  ], stage, undefined, true);
  if (result.exitCode !== 0) return null;
  const counts = result.stdout.trim().split(/\s+/u).map(Number);
  return counts.length === 3 && counts.every((count) => Number.isSafeInteger(count) && count >= 0)
    ? [counts[0]!, counts[1]!, counts[2]!] : null;
}

async function waitForClamAv(port: number, stage: Stage = "clamav_setup"): Promise<void> {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    if (await pingClamAv(port)) return;
    await delay(500);
  }
  throw new BrowserGateError(stage);
}

async function pingClamAv(port: number): Promise<boolean> {
  return new Promise((resolvePing) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let output = "";
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePing(result);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("error", () => finish(false));
    socket.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("PONG")) finish(true);
    });
    socket.once("connect", () => socket.write("zPING\0"));
    socket.once("close", () => finish(output.includes("PONG")));
  });
}

function readLoopbackPort(output: string, stage: Stage): number {
  const port = Number(/^127\.0\.0\.1:([0-9]+)\s*$/.exec(output)?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new BrowserGateError(stage);
  return port;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => reject(new BrowserGateError("runtime_preflight")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error
        ? reject(new BrowserGateError("runtime_preflight"))
        : resolvePort(port));
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class BrowserGateError extends Error {
  readonly stage: Stage;

  constructor(stage: Stage) {
    super(`DOC-02 browser gate failed at ${stage}.`);
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
