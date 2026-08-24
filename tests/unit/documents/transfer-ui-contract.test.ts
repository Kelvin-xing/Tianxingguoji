import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

test("DOC-02 Case controls are capability-only and the directory remains read-only", async () => {
  const [panel, transfer, directory] = await Promise.all([
    source("components/documents/CaseDocumentsPanel.tsx"),
    source("components/documents/DocumentTransferControls.tsx"),
    source("components/documents/DocumentsDirectory.tsx"),
  ]);
  for (const capability of ["documents.upload", "documents.download"]) assert.match(panel, new RegExp(capability.replace(".", "\\.")));
  assert.doesNotMatch(`${panel}\n${transfer}`, /access\.role|snapshot\.role|capabilitiesByRole|ROLE_(?:CAPABILITIES|NAVIGATION)/);
  assert.doesNotMatch(directory, /type=["']file|issueDocumentUploadIntent|issueDocumentDownloadIntent|putDocumentBytes/);
});

test("DOC-02 upload control locks one file, exact MIME, hash, idempotency and authoritative polling", async () => {
  const [transfer, client] = await Promise.all([
    source("components/documents/DocumentTransferControls.tsx"),
    source("modules/documents/client.ts"),
  ]);
  assert.match(transfer, /type="file"/);
  assert.match(transfer, /accept=\{DOCUMENT_UPLOAD_CONTENT_TYPES\.join\(","\)\}/);
  assert.doesNotMatch(transfer, /multiple/);
  assert.match(transfer, /if \(uploadLocked\.current \|\| uploadPending \|\| !uploadAllowed\) return/);
  assert.match(transfer, /digestDocumentUploadFile\(selectedFile\)/);
  assert.match(transfer, /attempt\.current!\.keyFor\(documentVersionFingerprint\(currentAttempt\.command\)\)/);
  assert.match(transfer, /currentAttempt\.receipt \?\? await createDocumentVersion/);
  assert.match(transfer, /failure !== "unavailable" && failure !== "timeout"/);
  assert.match(transfer, /error instanceof DocumentTransferError && error\.recoverable/);
  assert.match(transfer, /document\.latest_version_state === "pending_upload" && document\.pending_upload !== null/);
  assert.match(transfer, /const receipt = authoritativePending \?\? currentAttempt\.receipt \?\? await createDocumentVersion/);
  assert.match(transfer, /afterCreatePending\?\.id !== receipt\.id/);
  assert.match(transfer, /setNotice\(canRecover \? "recovery_conflict" : "conflict"\)/);
  assert.match(transfer, /if \(failure === "stale"\)/);
  assert.match(transfer, /if \(failure === "conflict" && !recoverableTransfer\)/);
  assert.match(transfer, /const authoritative = await getCaseDocument\(caseId, document\.id\)/);
  assert.match(transfer, /const afterCreate = await getCaseDocument\(caseId, document\.id\)/);
  assert.match(transfer, /const expectedAuthorityVersion = expectedDocumentVersion\s*\+ \(authoritativePending === null \? 1 : 0\)/);
  assert.doesNotMatch(transfer, /const expectedAuthorityVersion = currentAttempt\.command\.expected_document_record_version/);
  assert.match(transfer, /afterCreate\.document\.record_version !== expectedAuthorityVersion/);
  assert.match(transfer, /pollCaseDocumentUntilSettled/);
  assert.match(client, /DOCUMENT_SCAN_POLL_TIMEOUT_MS = 90_000/);
  assert.match(client, /globalThis\.crypto\.subtle\.digest\("SHA-256"/);
  assert.match(client, /credentials: "omit"/);
  assert.doesNotMatch(client, /["']content-length["']/i);
});

test("DOC-02 pending recovery and abandonment remain authoritative, fixed and idempotent", async () => {
  const [transfer, client] = await Promise.all([
    source("components/documents/DocumentTransferControls.tsx"),
    source("modules/documents/client.ts"),
  ]);
  assert.match(client, /readonly pending_upload: DocumentPendingUpload \| null/);
  assert.match(client, /\(latestVersionState === "pending_upload"\) !== \(pendingUpload !== null\)/);
  assert.match(client, /throw new DocumentTransferError\("conflict"\)/);
  assert.match(client, /versions\/\$\{versionId\}\/abandonments/);
  assert.match(client, /documentAbandonmentFingerprint/);
  assert.match(transfer, /aria-label="確認放棄待上載版本"/);
  assert.match(transfer, /if \(abandonLocked\.current \|\| abandonPending \|\| !abandonAllowed \|\| !abandonConfirmed\) return/);
  assert.match(transfer, /abandonmentAttempt\.current!\.keyFor\(documentAbandonmentFingerprint\(input\)\)/);
  assert.match(transfer, /authoritative\.document\.latest_version_state !== "abandoned"/);
  assert.match(transfer, /authoritative\.document\.pending_upload !== null/);
  assert.match(transfer, /待上載版本已放棄，文件狀態已重新載入，可建立新版本/);
  assert.match(transfer, /即使舊連結在到期前被使用，遲到物件也只會由系統清理，不會進入掃描或成為可下載版本/);
  assert.doesNotMatch(transfer, /上載連結將失效/);
  assert.match(transfer, /所選文件與待上載版本不一致，未上載任何內容/);
  assert.doesNotMatch(transfer, /textarea|放棄原因/);
});

test("DOC-02 download is fresh, fixed-name, byte-based and ends with authority", async () => {
  const transfer = await source("components/documents/DocumentTransferControls.tsx");
  assert.match(transfer, /document\.has_active_version/);
  assert.doesNotMatch(transfer, /latest_version_state === "available".*downloadAllowed/);
  assert.match(transfer, /issueDocumentDownloadIntent\(caseId, document\.id\)/);
  assert.match(transfer, /fetchDocumentBytes\(intent\)/);
  assert.match(transfer, /anchor\.download = intent\.download_name/);
  assert.match(transfer, /URL\.revokeObjectURL\(objectUrl\)/);
  assert.match(transfer, /const authoritative = await getCaseDocument\(caseId, document\.id\)/);
});

test("DOC-02 never renders or persists signed URLs, checksums or bytes", async () => {
  const [transfer, client] = await Promise.all([
    source("components/documents/DocumentTransferControls.tsx"),
    source("modules/documents/client.ts"),
  ]);
  assert.doesNotMatch(`${transfer}\n${client}`, /localStorage|sessionStorage|indexedDB|console\./);
  assert.doesNotMatch(transfer, /set(?:Upload|Download)Intent|set(?:Signed|Capability)Url/);
  assert.doesNotMatch(transfer, /checksum_sha256\}|checksum_base64\}|intent\.url\}/);
  assert.match(transfer, /selectedFile\.name/);
});

test("DOC-02 lifecycle feedback is truthful, accessible and responsive", async () => {
  const transfer = await source("components/documents/DocumentTransferControls.tsx");
  for (const state of [
    "hashing", "creating", "uploading", "scanning", "available", "rejected",
    "scan_failed", "abandoning", "abandoned", "validation", "stale", "conflict", "recovery_conflict", "denied", "timeout", "unavailable",
  ]) assert.match(transfer, new RegExp(`\\"${state}\\"`));
  assert.match(transfer, /role=\{isStatus \? "status" : "alert"\}/);
  assert.match(transfer, /grid-cols-1 sm:grid-cols-/);
  assert.match(transfer, /\(notice !== "available" && notice !== "abandoned"\) \|\| uploadPending \|\| abandonPending/);
  assert.match(transfer, /const input = fileInput\.current/);
  assert.match(transfer, /if \(input === null \|\| input\.disabled\) return/);
  assert.match(transfer, /input\.focus\(\)/);
  assert.match(transfer, /\[notice, uploadPending, abandonPending\]/);
  assert.doesNotMatch(transfer, /queueMicrotask\(\(\) => fileInput\.current\?\.focus\(\)\)/);
});

test("DOC-02 permanent browser gate owns real dependencies without committing a malicious signature", async () => {
  const [browser, packageSource, worker] = await Promise.all([
    source("tests/integration/doc-02-document-upload-scan-download-dev-browser.test.ts"),
    source("package.json"),
    source("workers/document-worker.ts"),
  ]);
  const fullSignatureMarker = ["EICAR-STANDARD-", "ANTIVIRUS-TEST-FILE"].join("");
  assert.doesNotMatch(browser, new RegExp(fullSignatureMarker));
  assert.match(browser, /const MALICIOUS_BYTES = Buffer\.from\(EICAR_MARKER, "ascii"\)/);
  assert.doesNotMatch(browser, /Buffer\.from\(`%PDF-1\.4\\n\$\{EICAR_MARKER\}/);
  assert.match(browser, /assert\.equal\(MALICIOUS_BYTES\.length, 68\)/);
  assert.match(browser, /MALICIOUS_BYTES\.toString\("ascii"\), EICAR_FRAGMENTS\.join\(""\)/);
  assert.match(browser, /EICAR_FRAGMENTS\.every\(\(fragment\) =>/);
  assert.match(browser, /mimeType: "application\/pdf", buffer: MALICIOUS_BYTES/);
  assert.match(browser, /LOCALSTACK_IMAGE = "localstack\/localstack:4\.14\.0"/);
  assert.match(browser, /CLAMAV_IMAGE = "clamav\/clamav:1\.4\.5-debian13-slim"/);
  assert.match(browser, /"--env", "SQS_ENDPOINT_STRATEGY=path"/);
  assert.match(browser, /spawn\(process\.execPath, \[/);
  assert.match(browser, /join\(directory, "workers\/document-worker\.ts"\)/);
  assert.doesNotMatch(browser, /spawn\(COREPACK|\["pnpm", "worker:documents:local"\]/);
  assert.match(browser, /detached: true/);
  assert.match(browser, /child\.signalCode !== null/);
  assert.match(browser, /process\.kill\(-pid, signal\)/);
  assert.match(browser, /LOCAL_SYNTHETIC_ORGANIZATION_ID: ORGANIZATION_ID/);
  assert.match(browser, /const ORGANIZATION_ID = NEON_TEST_ORGANIZATION\.id/);
  assert.match(browser, /LOCAL_SYNTHETIC_DOCUMENT_WORKER_CONTEXT_ID: WORKER_CONTEXT_ID/);
  assert.match(browser, /waitForProcessLog\(worker, WORKER_READY_MARKER, "document_worker"\)/);
  assert.match(browser, /assert\.equal\(build\.files\.length, 36\)/);
  for (const evidence of [
    "validation_zero_post", "uncertain_retry_same_key", "changed_file_rotates_key",
    "synchronous_double_post_count", "version_changed_post_request_started",
    "version_changed_post_response_received", "version_changed_post_status",
    "version_changed_post_json_parseable", "version_changed_post_receipt_exact",
    "version_changed_post_safe_code", "version_changed_detail_request_started",
    "version_changed_detail_response_received", "version_changed_detail_status",
    "version_changed_intent_request_started", "version_changed_intent_response_received",
    "version_changed_intent_status", "version_changed_intent_safe_code",
    "version_changed_put_request_started", "version_changed_put_response_received",
    "version_changed_put_status", "version_changed_worker_before", "version_changed_worker_after",
    "version_changed_worker_unavailable_marker_delta", "version_changed_queue_visible_count",
    "version_changed_queue_not_visible_count", "version_changed_queue_delayed_count",
    "version_changed_queue_attributes_complete",
    "version_changed_authority_fetch_completed", "version_changed_authority_status",
    "version_changed_authority_json_parseable", "version_changed_authority_state",
    "version_changed_authority_pending", "version_changed_success_status_count",
    "version_changed_success_status_visible", "version_changed_available_badge_count",
    "version_changed_available_badge_visible", "version_changed_alert_count",
    "version_changed_unavailable_alert_count", "version_changed_conflict_alert_count",
    "version_changed_timeout_alert_count",
    "clean_download_exact_bytes", "malicious_rejected", "old_clean_retained", "stale_visible",
    "same_page_recovery_version_post_count", "same_page_recovery_receipt_exact",
    "same_page_recovery_pending_detail_status", "same_page_recovery_pending_authoritative",
    "same_page_recovery_intent_attempt_count",
    "same_page_recovery_first_intent_uncertain", "same_page_recovery_unavailable_feedback",
    "same_page_recovery_file_preserved", "same_page_recovery_retry_intent_status",
    "same_page_recovery_put_status", "same_page_recovery_zero_new_version_post",
    "same_page_recovery_final_authority_available", "same_page_recovery_success_feedback",
    "same_page_recovery_private_transport_hidden",
    "unbound_worker_stop_requested", "unbound_worker_stop_soft_close_observed",
    "unbound_worker_stop_group_alive_after_soft", "unbound_worker_stop_hard_kill_requested",
    "unbound_worker_stop_final_close_observed", "unbound_worker_stop_final_group_absent",
    "unbound_worker_stopped",
    "unbound_same_capability_put_count", "unbound_provider_version_ids_distinct",
    "unbound_provider_version_count_before_cleanup", "unbound_provider_version_count_after_cleanup",
    "unbound_delete_marker_count_after_cleanup", "unbound_bound_version_authoritative",
    "unbound_bound_version_preserved", "unbound_extra_version_absent", "unbound_scan_fact_count",
    "unbound_cleanup_audit_count", "unbound_cleanup_outbox_count",
    "unbound_cleanup_private_value_matches", "unbound_cleanup_forbidden_field_matches",
    "unbound_download_exact_bytes", "unbound_replay_enqueued", "unbound_replay_queue_observed",
    "unbound_replay_queue_drained",
    "unbound_replay_zero_extra_effects",
    "stale_authoritative_detail_status", "stale_pending_recovery_visible",
    "pending_recovery_persisted", "pending_recovery_wrong_file_zero_put",
    "pending_recovery_wrong_file_zero_new_version", "pending_recovery_same_file_available",
    "pending_recovery_same_file_input_count", "pending_recovery_same_file_input_visible",
    "pending_recovery_same_file_input_enabled", "pending_recovery_same_file_upload_button_count",
    "pending_recovery_same_file_upload_button_visible", "pending_recovery_same_file_upload_button_enabled",
    "pending_recovery_same_file_intent_request_started", "pending_recovery_same_file_intent_response_received",
    "pending_recovery_same_file_intent_status", "pending_recovery_same_file_intent_safe_code",
    "pending_recovery_same_file_put_request_started", "pending_recovery_same_file_put_response_received",
    "pending_recovery_same_file_put_status", "pending_recovery_same_file_authority_fetch_completed",
    "pending_recovery_same_file_authority_status", "pending_recovery_same_file_authority_json_parseable",
    "pending_recovery_same_file_authority_state", "pending_recovery_same_file_authority_pending",
    "pending_recovery_same_file_worker_before", "pending_recovery_same_file_worker_after",
    "pending_recovery_same_file_success_status_count", "pending_recovery_same_file_success_status_visible",
    "pending_recovery_same_file_available_badge_count", "pending_recovery_same_file_available_badge_visible",
    "pending_recovery_same_file_alert_count", "pending_recovery_same_file_recovery_conflict_alert_count",
    "pending_recovery_same_file_conflict_alert_count", "pending_recovery_same_file_timeout_alert_count",
    "pending_recovery_same_file_unavailable_alert_count",
    "abandonment_uncertain_retry_same_key", "abandonment_double_post_count",
    "abandonment_receipt_exact", "abandonment_replay_exact", "abandonment_authoritative",
    "abandonment_late_put_count", "abandonment_late_provider_version_header_count",
    "abandonment_late_provider_version_ids_distinct", "abandonment_provider_version_count_before_cleanup",
    "abandonment_delete_marker_count_before_cleanup", "abandonment_provider_versions_exact_before_cleanup",
    "abandonment_provider_version_count_after_cleanup", "abandonment_delete_marker_count_after_cleanup",
    "abandonment_provider_versions_exact_absent", "abandonment_late_objects_cleaned",
    "abandonment_scan_results_count", "abandonment_cleanup_audit_count", "abandonment_cleanup_outbox_count",
    "abandonment_scan_audit_count", "abandonment_scan_outbox_count",
    "abandonment_private_object_coordinate_matches", "abandonment_version_abandoned_unbound",
    "abandonment_active_pointer_null",
    "abandonment_never_scanned_or_downloadable", "abandonment_new_version_available",
    "abandonment_changed_authority_rotates_key",
    "advisor_upload_available", "advisor_download_exact_bytes", "controlledWait",
    "scan_failed_authoritative_detail_status", "scan_failed_authoritative_state",
    "scan_failed_fixed_feedback", "scan_failed_download_disabled", "scan_failed_clamav_recovered",
    "dev_process_log_captured", "dev_process_stdout_frozen_private_matches",
    "dev_process_stderr_frozen_private_matches", "dev_process_stdout_standalone_business_route_id_matches",
    "dev_process_stderr_standalone_business_route_id_matches", "worker_process_count",
    "worker_process_log_captured_count", "worker_process_stdout_frozen_private_matches",
    "worker_process_stderr_frozen_private_matches", "worker_process_stdout_standalone_business_route_id_matches",
    "worker_process_stderr_standalone_business_route_id_matches",
    "desktop_viewport", "mobile_viewport", "sensitive_log_matches",
  ]) assert.match(browser, new RegExp(evidence));
  assert.match(browser, /page_errors: number \| null/);
  assert.match(browser, /"x-doc02-private-probe": markerValue/);
  assert.match(browser, /privateValues = \[caseValue, documentValue, versionValue, checksumValue, markerValue\]/);
  assert.match(browser, /founderCase\.caseId!, advisorCase\.caseId!/);
  assert.match(browser, /`documents\/\$\{cleanDocument\.documentId\}\/versions\/\$\{versionWrite\.id\}`/);
  assert.match(browser, /CLEAN_RAW_MARKER, CHANGED_RAW_MARKER, ADVISOR_RAW_MARKER/);
  assert.match(browser, /directIssueUploadCapability/);
  assert.match(browser, /waitForObjectVersionListing/);
  assert.match(browser, /putLateObject\(unboundCapability!, CLEAN_BYTES\)/);
  assert.match(browser, /waitForUnboundCleanupDatabaseEvidence/);
  assert.match(browser, /waitForBoundObjectVersionOnly/);
  assert.match(browser, /QUEUE_DRAIN_EVIDENCE_TIMEOUT_MS = 75_000/);
  assert.match(browser, /QUEUE_DRAIN_MAX_POLLS = Math\.ceil\(/);
  assert.match(browser, /LOCAL_SYNTHETIC_DOCUMENT_WORKER_SAFE_EVIDENCE: "1"/);
  assert.match(worker, /SAFE_EVIDENCE_SWITCH = "LOCAL_SYNTHETIC_DOCUMENT_WORKER_SAFE_EVIDENCE"/);
  assert.match(browser, /WORKER_MAIN_DELETE_REQUESTED_MARKER = "document-worker-main-delete-requested"/);
  assert.match(browser, /WORKER_MAIN_DELETE_COMPLETED_MARKER = "document-worker-main-delete-completed"/);
  assert.match(worker, /DOCUMENT_WORKER_MAIN_DELETE_REQUESTED_MARKER =\s*\n\s*"document-worker-main-delete-requested"/);
  assert.match(worker, /DOCUMENT_WORKER_MAIN_DELETE_COMPLETED_MARKER =\s*\n\s*"document-worker-main-delete-completed"/);
  assert.match(browser, /waitForMainQueueDrainEvidence\(/);
  assert.match(browser, /line === marker/);
  for (const evidence of [
    "test_event_acknowledged",
    "unbound_main_delete_requested_count", "unbound_main_delete_completed_count",
    "unbound_queue_visible_count", "unbound_queue_not_visible_count",
    "unbound_queue_delayed_count", "unbound_queue_attributes_complete",
    "unbound_queue_poll_count", "unbound_queue_worker_state", "unbound_queue_drained",
    "unbound_replay_main_delete_requested_count", "unbound_replay_main_delete_completed_count",
    "unbound_replay_queue_visible_count", "unbound_replay_queue_not_visible_count",
    "unbound_replay_queue_delayed_count", "unbound_replay_queue_attributes_complete",
    "unbound_replay_queue_poll_count", "unbound_replay_queue_worker_state",
  ]) assert.match(browser, new RegExp(evidence));
  assert.match(browser, /unbound_main_delete_requested_count === 3/);
  assert.match(browser, /unbound_main_delete_completed_count === 3/);
  assert.match(browser, /unbound_scan_fact_count === 1/);
  assert.match(browser, /unbound_cleanup_audit_count === 1/);
  assert.match(browser, /unbound_cleanup_outbox_count === 1/);
  assert.match(browser, /testEventQueue\.main_delete_requested_count, 1/);
  assert.match(browser, /testEventQueue\.main_delete_completed_count, 1/);
  assert.match(browser, /testEventQueue\.main_delete_requested_count \+ unboundQueue\.main_delete_requested_count/);
  assert.match(browser, /testEventQueue\.main_delete_completed_count \+ unboundQueue\.main_delete_completed_count/);
  assert.match(browser, /assert\.equal\(evidence\.test_event_acknowledged, true\)/);
  assert.match(browser, /sendUnboundProviderVersionReplay/);
  assert.match(browser, /waitForMainQueueMessage/);
  assert.match(browser, /assert\.equal\(evidence\.unbound_replay_queue_observed, true\)/);
  assert.match(browser, /assert\.equal\(evidence\.unbound_replay_queue_drained, true\)/);
  for (const canonicalEvidence of [
    "canonical_next_state", "canonical_request_started", "canonical_fetch_completed",
    "canonical_response_status", "canonical_response_status_307",
    "canonical_response_origin_exact", "canonical_response_path_exact", "canonical_redirect_count",
    "canonical_location_present", "canonical_location_parseable", "canonical_location_origin_exact",
    "canonical_location_path_exact", "canonical_protocol_http", "canonical_hostname_loopback",
    "canonical_port_matches", "canonical_credentials_absent", "canonical_search_absent",
    "canonical_hash_absent", "canonical_returned_origin_exact",
  ]) assert.match(browser, new RegExp(canonicalEvidence));
  assert.match(browser, /canonical_origin_transport/);
  assert.match(browser, /canonical_origin_response/);
  assert.match(browser, /canonical_origin_location/);
  assert.match(browser, /canonical_origin_contract/);
  assert.match(browser, /canonical_origin_match/);
  assert.match(browser, /canonical_redirect_count = location === null \? 0 : 1/);
  assert.match(browser, /canonical_response_origin_exact = responseUrl\.origin === listenUrl/);
  assert.match(browser, /canonical_response_path_exact = responseUrl\.pathname === "\/api\/auth\/login"/);
  assert.match(browser, /assert\.equal\(evidence\.canonical_response_origin_exact, true\)/);
  assert.match(browser, /assert\.equal\(evidence\.canonical_response_path_exact, true\)/);
  assert.match(browser, /const listenUrl = `http:\/\/127\.0\.0\.1:\$\{httpPort\}`/);
  assert.match(browser, /const browserOrigin = `http:\/\/localhost:\$\{httpPort\}`/);
  assert.match(browser, /canonical_location_origin_exact = target\.origin === browserOrigin/);
  assert.match(browser, /assert\.equal\(evidence\.canonical_location_origin_exact, true\)/);
  assert.match(browser, /canonical_location_path_exact = target\.pathname === "\/api\/v1\/auth\/login"/);
  assert.match(browser, /canonical_returned_origin_exact = baseUrl === browserOrigin/);
  assert.match(browser, /return target\.origin;/);
  assert.doesNotMatch(browser, /return listenUrl;/);
  for (const loginStage of [
    "founder_login_page", "founder_login_form_ready", "founder_login_submit",
    "founder_login_redirect", "founder_login_session", "founder_login_workspace",
  ]) assert.match(browser, new RegExp(loginStage));
  for (const loginEvidence of [
    "page_navigation_completed", "page_status", "page_path_exact", "page_origin_exact",
    "form_email_count", "form_password_count", "form_submit_count",
    "submit_request_observed", "submit_response_received", "submit_status",
    "submit_response_origin_exact", "submit_location_present", "submit_location_parseable",
    "submit_location_path_exact", "submit_target_origin_exact", "submit_target_loopback",
    "submit_target_protocol_http", "submit_target_port_matches", "redirect_path_exact", "redirect_origin_exact",
    "session_request_observed", "session_response_received", "session_status",
    "session_response_origin_matches_page", "workspace_heading_count", "workspace_heading_visible",
  ]) assert.match(browser, new RegExp(loginEvidence));
  assert.match(browser, /controlledWait\(page\.waitForRequest/);
  assert.match(browser, /controlledWait\(page\.waitForResponse/);
  assert.match(browser, /submit_target_origin_exact = submitTarget\?\.origin === baseUrl/);
  assert.match(browser, /session_response_origin_matches_page = accessHttp !== null/);
  assert.doesNotMatch(browser, /diagnostics\.evidence\.(?:email|password|cookie|header|raw_url)/);
  assert.match(browser, /documents\.unbound_provider_version_removed/);
  assert.match(browser, /unboundAfterReplay\.cleanup_audit === 1/);
  assert.match(browser, /unboundAfterReplay\.cleanup_outbox === 1/);
  assert.match(browser, /waitForAbandonedCleanupDatabaseEvidence/);
  assert.match(browser, /response\.headers\.get\("x-amz-version-id"\)/);
  assert.match(browser, /credentials: "omit"/);
  assert.match(browser, /cache: "no-store"/);
  assert.match(browser, /redirect: "error"/);
  assert.match(browser, /data\.expires_at_ms as number\) <= Date\.now\(\)/);
  assert.match(browser, /data\.expires_at_ms as number\) > Date\.now\(\) \+ 600_000/);
  assert.match(browser, /expectedOrigin\.hostname === "127\.0\.0\.1"/);
  assert.match(browser, /expectedOrigin\.hostname === "localhost"/);
  assert.match(browser, /expectedOrigin\.hostname === "\[::1\]"/);
  assert.match(browser, /expectedOrigin\.protocol !== "http:"/);
  assert.match(browser, /signed\.origin !== expectedOrigin\.origin/);
  assert.match(browser, /signed\.pathname !== expectedPath/);
  assert.match(browser, /signed\.username !== "" \|\| signed\.password !== "" \|\| signed\.hash !== ""/);
  assert.match(browser, /staleAuthorityResponse/);
  assert.match(browser, /stale_authoritative_detail_status, 200/);
  for (const versionChangedStage of [
    "version_changed_submit", "version_changed_post_transport", "version_changed_receipt_contract",
    "version_changed_detail_refresh", "version_changed_upload_intent", "version_changed_put",
    "version_changed_worker", "version_changed_feedback",
  ]) assert.match(browser, new RegExp(versionChangedStage));
  assert.match(browser, /if \(versionPosts <= 2\) return route\.abort\("timedout"\)/);
  assert.match(
    browser,
    /cleanUploadButton\.evaluate\(\(button\) => \{\s*\(button as HTMLButtonElement\)\.click\(\);\s*\(button as HTMLButtonElement\)\.click\(\);\s*\}\)/,
  );
  assert.match(browser, /const versionChangedPostRequestWait = controlledWait\(page\.waitForRequest/);
  assert.match(browser, /const versionChangedPostResponseWait = controlledWait\(page\.waitForResponse/);
  assert.match(browser, /const versionChangedDetailRequestWait = controlledWait\(page\.waitForRequest/);
  assert.match(browser, /const versionChangedDetailResponseWait = controlledWait\(page\.waitForResponse/);
  assert.match(browser, /const versionChangedIntentRequestWait = controlledWait\(page\.waitForRequest/);
  assert.match(browser, /const versionChangedIntentResponseWait = controlledWait\(page\.waitForResponse/);
  assert.match(browser, /const versionChangedPrivateSignedTargetWait = controlledWait/);
  assert.match(browser, /readPrivateSignedUploadTarget\(\s*intentResponse,\s*runtime\.localstackEndpoint,\s*CHANGED_CLEAN_BYTES/);
  assert.match(browser, /const versionChangedPutRequestWait = controlledWait\(page\.waitForRequest/);
  assert.match(browser, /const versionChangedPutResponseWait = controlledWait\(page\.waitForResponse/);
  assert.match(browser, /new URL\(request\.url\(\)\)\.href === privateSignedTarget/);
  assert.match(browser, /new URL\(response\.url\(\)\)\.href === privateSignedTarget/);
  assert.doesNotMatch(browser, /versionChangedPutRequestWait = controlledWait\(page\.waitForRequest\(\(request\) => request\.method\(\) === "PUT"\)\)/);
  assert.doesNotMatch(browser, /versionChangedPutResponseWait = controlledWait\(page\.waitForResponse\(\(response\) =>\s*response\.request\(\)\.method\(\) === "PUT"\)\)/);
  assert.match(browser, /hasExactKeys\(root, \["api_version", "request_id", "data"\]\)/);
  assert.match(browser, /privateSignedTarget\.origin === expectedOrigin\.origin/);
  assert.match(browser, /const versionChangedTransportProgress = controlledWait/);
  assert.match(browser, /VERSION_CHANGED_DIAGNOSTIC_TIMEOUT_MS = 5_000/);
  assert.match(browser, /async function boundedDiagnostic/);
  assert.match(browser, /Promise\.race\(\[result, timeout\]\)/);
  assert.match(browser, /page\.off\("response", detailObserver\);\s*await boundedDiagnostic\(async \(\) => \{\s*await Promise\.all\(\[\s*versionChangedTransportProgress,/);
  assert.match(browser, /boundedDiagnostic\(\(\) => readSafeDocumentAuthority\(\s*page,\s*founderCase\.caseId!,\s*cleanDocument\.documentId!/);
  assert.match(browser, /boundedDiagnostic\(\s*\(\) => readMainQueueCounts\(localstackName, "version_changed_feedback"\)/);
  assert.match(browser, /boundedDiagnostic\(\(\) => readVersionChangedUiSnapshot\(cleanRow\), null\)/);
  assert.match(browser, /WORKER_UNAVAILABLE_MARKER = "document-worker-unavailable"/);
  assert.match(browser, /line === WORKER_UNAVAILABLE_MARKER/);
  assert.match(browser, /if \(versionChangedFailed\) \{\s*evidence\.version_changed_queue_attributes_complete = queueCounts !== null/);
  assert.doesNotMatch(browser, /versionChangedFailed[\s\S]{0,500}(?:receive-message|delete-message|purge-queue)/);
  assert.match(browser, /stage = "version_changed_put";[\s\S]*stage = "version_changed_worker";\s*stage = "version_changed_feedback";/);
  assert.match(browser, /stage = "version_changed_feedback";\s*await cleanRow\.getByRole\("status"\)/);
  assert.match(browser, /if \(versionChangedFailed\) throw versionChangedFailure/);
  assert.match(browser, /hasText: "掃描完成，安全版本已可下載。" \}\)\s*\.waitFor\(\{ state: "visible", timeout: 90_000 \}\)/);
  assert.doesNotMatch(
    browser,
    /evidence\.version_changed_(?:body|id|url|handle|coordinate|raw|log|filename|hash|key)/,
  );
  for (const samePageStage of [
    "same_page_recovery_first_submit", "same_page_recovery_uncertain_intent",
    "same_page_recovery_pending_authority", "same_page_recovery_retry",
    "same_page_recovery_put", "same_page_recovery_authority", "same_page_recovery_feedback",
  ]) assert.match(browser, new RegExp(samePageStage));
  assert.match(browser, /Synthetic DOC-02 same-page recovery evidence/);
  const samePageStart = browser.indexOf("const samePageRecoveryRow = documentRow");
  const samePageEnd = browser.indexOf('stage = "unbound_fixture";', samePageStart);
  assert.notEqual(samePageStart, -1);
  assert.notEqual(samePageEnd, -1);
  const samePageFlow = browser.slice(samePageStart, samePageEnd);
  assert.equal((samePageFlow.match(/setInputFiles\(/g) ?? []).length, 1);
  assert.doesNotMatch(samePageFlow, /page\.reload|logout\(|login\(/);
  assert.match(samePageFlow, /samePageRecoveryIntentAttempts === 1[\s\S]*route\.abort\("timedout"\)/);
  assert.match(samePageFlow, /assert\.equal\(evidence\.same_page_recovery_intent_attempt_count, 2\)/);
  assert.match(samePageFlow, /samePageRecoveryWrite\.status === 201[\s\S]*samePageRecoveryWrite\.exactAck/);
  assert.match(samePageFlow, /same_page_recovery_pending_detail_status === 200/);
  assert.match(samePageFlow, /versionPostsBeforeRetry === 1\s*&& samePageRecoveryVersionPosts === 1/);
  assert.match(samePageFlow, /readPrivateSignedUploadTarget\([\s\S]*SAME_PAGE_RECOVERY_BYTES/);
  assert.match(samePageFlow, /new URL\(request\.url\(\)\)\.href === privateSignedTarget/);
  assert.match(samePageFlow, /new URL\(response\.url\(\)\)\.href === privateSignedTarget/);
  assert.match(samePageFlow, /samePageFinalAuthority\.state === "available"[\s\S]*samePageFinalAuthority\.pending === "absent"/);
  assert.match(samePageFlow, /same_page_recovery_success_feedback = await samePageSuccessStatus\.isVisible/);
  assert.doesNotMatch(
    browser,
    /evidence\.same_page_recovery_(?:body|id|url|handle|coordinate|raw|log|filename|hash|key)/,
  );
  assert.match(browser, /const unboundWorkerStop = emptyProcessStopEvidence\(\)/);
  assert.match(browser, /stopProcess\(worker, unboundWorkerStop\)/);
  assert.match(browser, /const softCloseObserved = await Promise\.race\(\[closed, delay\(15_000\)/);
  assert.match(browser, /const groupAliveAfterSoft = processGroupAlive\(pid\)/);
  assert.match(browser, /if \(groupAliveAfterSoft\) \{[\s\S]*signalProcessGroup\(pid, "SIGKILL", child\)/);
  assert.match(
    browser,
    /const finalCloseObserved = softCloseObserved \|\|\s*await Promise\.race\(\[closed, delay\(5_000\)/,
  );
  assert.match(browser, /const finalGroupAbsent = !processGroupAlive\(pid\)/);
  assert.match(browser, /const stopped = finalGroupAbsent/);
  assert.doesNotMatch(browser, /return processExited\(child\) && !processGroupAlive\(pid\)/);
  assert.match(browser, /getByLabel\("重新選擇原上載文件", \{ exact: true \}\)/);
  assert.match(browser, /getByRole\("button", \{ name: "繼續上載並掃描", exact: true \}\)/);
  for (const pendingRecoveryStage of [
    "pending_recovery_same_file_controls", "pending_recovery_same_file_upload_intent",
    "pending_recovery_same_file_put", "pending_recovery_same_file_authority",
    "pending_recovery_same_file_worker", "pending_recovery_same_file_feedback",
  ]) assert.match(browser, new RegExp(pendingRecoveryStage));
  assert.match(browser, /const recoveryIntentRequestWait = controlledWait\(page\.waitForRequest/);
  assert.match(browser, /const recoveryIntentResponseWait = controlledWait\(page\.waitForResponse/);
  assert.match(browser, /const recoveryPutRequestWait = controlledWait\(page\.waitForRequest/);
  assert.match(browser, /const recoveryPutResponseWait = controlledWait\(page\.waitForResponse/);
  assert.match(browser, /const recoveryTransportProgress = controlledWait/);
  assert.match(browser, /await Promise\.all\(\[\s*recoveryTransportProgress,/);
  assert.match(browser, /await controlledWait\(readSafeDocumentAuthority/);
  assert.match(browser, /\.waitFor\(\{ state: "visible", timeout: 90_000 \}\)/);
  assert.match(browser, /pending_recovery_same_file_intent_safe_code = await safePlaywrightResponseCode/);
  assert.doesNotMatch(
    browser,
    /evidence\.pending_recovery_same_file_(?:body|id|url|handle|coordinate|raw|log|filename|hash)/,
  );
  assert.match(browser, /removeContainer\(clamavName\)/);
  assert.match(browser, /安全掃描未能完成，可稍後建立新版本。/u);
  assert.match(browser, /latest_version_state === "scan_failed"/);
  assert.match(browser, /waitForClamAv\(clamavPort, stage\)/);
  assert.match(browser, /inspectAbandonedDocument/);
  assert.match(browser, /inspectScanFailedDocument/);
  assert.match(browser, /readDocumentRecordVersion/);
  assert.match(browser, /cleanFileInput\.press\("Tab"\)/);
  assert.match(browser, /page\.keyboard\.press\("Shift\+Tab"\)/);
  for (const diagnostic of [
    "keyboard_focus_initial", "keyboard_focus_forward", "keyboard_focus_return",
    "keyboard_file_input_count", "keyboard_file_input_visible", "keyboard_file_input_enabled",
    "keyboard_upload_button_count", "keyboard_upload_button_visible", "keyboard_upload_button_enabled",
    "keyboard_initial_file_input_focused", "keyboard_forward_upload_button_focused",
    "keyboard_return_file_input_focused",
  ]) assert.match(browser, new RegExp(diagnostic));
  assert.match(browser, /keyboard_focus_returned = evidence\.keyboard_initial_file_input_focused/);
  assert.match(browser, /&& evidence\.keyboard_forward_upload_button_focused/);
  assert.match(browser, /&& evidence\.keyboard_return_file_input_focused/);
  assert.match(browser, /stage = "dev_process_log_safety"/);
  assert.match(browser, /stage = "worker_process_log_safety"/);
  assert.match(browser, /safeProcessLogEvidence\(/);
  assert.match(browser, /frozen_private: countUniqueProcessLogMatches/);
  assert.match(browser, /standalone_business_route_id: countUniqueProcessLogMatches/);
  assert.match(browser, /assertNoSensitiveProcessLogs\(devServer, frozenPrivateValues\)/);
  assert.match(browser, /for \(const workerProcess of workerProcesses\) assertNoSensitiveProcessLogs\(workerProcess, frozenPrivateValues\)/);
  assert.doesNotMatch(browser, /assertNoSensitiveProcessLogs\(devServer, sensitiveValues\)/);
  assert.doesNotMatch(browser, /assertNoSensitiveProcessLogs\(workerProcess, sensitiveValues\)/);
  assert.doesNotMatch(browser, /process_log_(?:matched_value|raw_log|log_line|url|id|hash|stack)/);
  assert.match(browser, /h1,h2,h3,h4,p,label,dt,dd,th,td,\[role='status'\],\[role='alert'\]/);
  for (const cleanup of [
    "context_closed", "worker_stopped", "dev_stopped", "app_removed", "profile_removed",
    "postgres_removed", "localstack_removed", "clamav_removed", "queues_and_objects_removed", "volume_removed",
  ]) assert.match(browser, new RegExp(cleanup));
  assert.match(packageSource, /"test:doc-02-dev-browser": "node --conditions=react-server --test tests\/integration\/doc-02-document-upload-scan-download-dev-browser\.test\.ts"/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}
