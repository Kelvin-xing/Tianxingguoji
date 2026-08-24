import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import {
  HeadObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Client, Pool } from "pg";

import {
  DocumentObjectReceiptService,
  isDocumentObjectReceiptError,
} from "../../modules/documents/application/object-receipt-service.ts";
import { DocumentScanService } from "../../modules/documents/application/scan-service.ts";
import { LocalClamavDocumentScanner } from "../../modules/documents/infrastructure/clamav-scanner.ts";
import {
  LocalDocumentObjectStoreUnavailable,
  LocalSyntheticDocumentObjectStore,
} from "../../modules/documents/infrastructure/local-object-store.ts";
import { LocalSyntheticDocumentScanRequeuePublisher } from "../../modules/documents/infrastructure/local-scan-requeue-publisher.ts";
import { PostgresqlDocumentScanRepository } from "../../modules/documents/infrastructure/postgresql-scan-repository.ts";
import type { DocumentScanRuntime } from "../../modules/documents/infrastructure/scan-runtime.ts";
import type { DatabasePool } from "../../modules/shared/server.ts";
import { createTenantTransactionRunner } from "../../modules/shared/server.ts";
import {
  NEON_TEST_MANIFEST_ID,
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
  NEON_TEST_STUDENTS,
} from "../../scripts/db/neon-test-synthetic-fixture.ts";
import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_VERSION,
  verifyCommittedOneRoleBaseline,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  runDatabaseTestProvisionCli,
  type DatabaseTestProvisionTarget,
} from "../../scripts/db/provision-database-test-identity.ts";
import { seedNeonTestRelease1 } from "../../scripts/db/seed-neon-test-release1.ts";
import {
  assertOneRoleBaselinePostflight,
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  type OneRoleBaselineDatabaseState,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";
import {
  DOCUMENT_WORKER_MAIN_DELETE_COMPLETED_MARKER,
  DOCUMENT_WORKER_MAIN_DELETE_REQUESTED_MARKER,
  documentDeadLetterMessageDisposition,
  documentMessageDisposition,
  parseDocumentObjectCreatedMessage,
  validateLocalQueueUrl,
} from "../../workers/document-worker.ts";
import {
  DocumentScanDeadLetterWorkerError,
  DocumentScanRetryableWorkerError,
  processDocumentCleanupFromDeadLetter,
  processDocumentObjectCreated,
} from "../../workers/scan-document.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const DOCKER = "/opt/homebrew/bin/docker";
const LOCALSTACK_IMAGE = "localstack/localstack:4.14.0";
const CLAMAV_IMAGE = "clamav/clamav:1.4.5-debian13-slim";
const REGION = "ap-east-1";
const BUCKET = "tianxing-local-documents";
const QUEUE = "tianxing-local-document-scan";
const DLQ = "tianxing-local-document-scan-dlq";
const ORGANIZATION_ID = NEON_TEST_ORGANIZATION.id;
const WORKER_CONTEXT_ID = "10000000-0000-4000-8000-000000000901";
const FOREIGN_ORGANIZATION_ID = "65000000-0000-4000-8000-000000000001";
const FOREIGN_MEMBERSHIP_ID = "65000000-0000-4000-8000-000000000002";
const FOREIGN_ROLE_BINDING_ID = "65000000-0000-4000-8000-000000000003";
const FOREIGN_STUDENT_ID = "65000000-0000-4000-8000-000000000004";
const FOREIGN_CASE_ID = "65000000-0000-4000-8000-000000000005";
const FOREIGN_DOCUMENT_ID = "65000000-0000-4000-8000-000000000006";
const FOREIGN_GUARDIAN_ID = "65000000-0000-4000-8000-000000000007";
const FOREIGN_RELATIONSHIP_ID = "65000000-0000-4000-8000-000000000008";
const FOREIGN_CASE_TRANSITION_FACT_ID = "65000000-0000-4000-8000-000000000009";
const WORKER_READY_MARKER = "document-worker-ready";
const QUEUE_CONVERGENCE_POLL_COUNT = 301;
const QUEUE_CONVERGENCE_POLL_INTERVAL_MS = 250;
const MAX_QUEUE_OBSERVATION_COUNT = 10_000;
const SAFE_WORKER_EXIT_CODES = Object.freeze([0, 1] as const);
const SAFE_WORKER_EXIT_SIGNALS = Object.freeze([
  "SIGABRT",
  "SIGHUP",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGQUIT",
  "SIGSEGV",
  "SIGTERM",
] as const satisfies readonly NodeJS.Signals[]);
const FOUNDER = principal("founder");
const ADVISOR = principal("advisor");
const CLEAN_BYTES = Buffer.from(
  "%PDF-1.4\n% DOC02-HTTP-CLEAN-RAW-RELEASE1\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
  "utf8",
);
const NEWER_BYTES = Buffer.from(
  "%PDF-1.4\n% DOC02-HTTP-NEWER-RAW-RELEASE1\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF\n",
  "utf8",
);
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("DOC02-HTTP-JPEG-RAW-RELEASE1", "utf8"),
  Buffer.from([0xff, 0xd9]),
]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("DOC02-HTTP-PNG-RAW-RELEASE1", "utf8"),
]);
const EICAR_MARKER = [
  "X5O!P%@AP[4", "\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-", "ANTIVIRUS-TEST-FILE!$H+H*",
].join("");
const EICAR_BYTES = Buffer.from(EICAR_MARKER, "ascii");
const PRIVATE_MARKERS = [
  "DOC02-HTTP-CLEAN-RAW-RELEASE1",
  "DOC02-HTTP-NEWER-RAW-RELEASE1",
  "DOC02-HTTP-JPEG-RAW-RELEASE1",
  "DOC02-HTTP-PNG-RAW-RELEASE1",
  EICAR_MARKER,
];
const CASE_DOCUMENT_CLASSIFICATIONS = Object.freeze([
  "identity_and_case_evidence",
  "operational_attachment",
] as const);
const VISIBLE_DOCUMENT_LIFECYCLE_STATES = Object.freeze(["active", "pending_delete"] as const);
const DOCUMENT_VERSION_STATES = Object.freeze([
  "pending_upload",
  "quarantined",
  "scanning",
  "available",
  "rejected",
  "scan_failed",
  "abandoned",
  "superseded",
  "pending_delete",
  "deleted",
] as const);
const API_ERROR_CONTRACT = Object.freeze({
  UNAUTHENTICATED: Object.freeze({ message: "Authentication is required.", retryable: false }),
  FORBIDDEN: Object.freeze({ message: "You are not allowed to perform this action.", retryable: false }),
  NOT_FOUND: Object.freeze({ message: "The requested resource was not found.", retryable: false }),
  CONFLICT: Object.freeze({ message: "The request conflicts with the current resource state.", retryable: false }),
  STALE_VERSION: Object.freeze({
    message: "The resource changed. Refresh and retry your update.",
    retryable: false,
  }),
  VALIDATION_FAILED: Object.freeze({ message: "The request did not pass validation.", retryable: false }),
} as const);
const PROCESS_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();
const RUNTIME_PRIVATE_VALUES = new Set<string>();
const SENSITIVE_LOG_CATEGORIES = Object.freeze([
  "fixture_bytes",
  "object_coordinate",
  "content_contract",
  "service_coordinate",
  "signed_capability",
  "database_endpoint",
  "runtime_private",
] as const);

type Role = "founder" | "advisor" | "admin" | "data_reviewer" | "contractor";
type SensitiveLogCategory = (typeof SENSITIVE_LOG_CATEGORIES)[number];
type SensitiveLogMarker = Readonly<{ category: SensitiveLogCategory; value: string }>;
type SensitiveLogCounts = Readonly<{
  stdout: Readonly<Record<SensitiveLogCategory, number>>;
  stderr: Readonly<Record<SensitiveLogCategory, number>>;
  total: number;
}>;
type Envelope = Readonly<{
  api_version?: unknown;
  request_id?: unknown;
  data?: unknown;
  error?: Readonly<{ code?: unknown }>;
}>;
type HttpResult = Readonly<{ response: Response; body: Envelope; text: string }>;
type RuntimeEnvironment = Readonly<{
  connectionString: string;
  localstackEndpoint: string;
  clamavPort: number;
}>;
type ScanDependencies = Readonly<{
  receiptService: DocumentScanRuntime["receiptService"];
  objectReader: DocumentScanRuntime["objectStore"];
  objectCleaner: DocumentScanRuntime["objectStore"];
  service: DocumentScanRuntime["service"];
  scanner: DocumentScanRuntime["scanner"];
}>;
type VersionReceipt = Readonly<{ id: string; recordVersion: number }>;
type DocumentAuthority = Readonly<{
  id: string;
  caseId: string;
  state: string | null;
  pending: null | VersionReceipt;
  hasActive: boolean;
  recordVersion: number;
}>;
type UploadIntent = Readonly<{
  method: "PUT";
  expiresAtMs: number;
  url: string;
  contentType: "application/pdf" | "image/jpeg" | "image/png";
  checksumBase64: string;
}>;
type DownloadIntent = Readonly<{
  method: "GET";
  expiresAtMs: number;
  url: string;
  downloadName: "document.pdf";
}>;
type ObservedProcessResult =
  | "available"
  | "rejected"
  | "receipt_rejected"
  | "duplicate"
  | "abandoned_removed"
  | "unbound_provider_version_removed"
  | null;
type ObservedProcessError = "RETRYABLE" | "DEAD_LETTER" | "OTHER" | null;
type ReceiptObservation = {
  request_completed: boolean;
  response_completed: boolean;
  http_status: number | null;
  exact_dto: boolean;
  record_version: number | null;
};
type IntentObservation = {
  request_completed: boolean;
  response_completed: boolean;
  http_status: number | null;
  exact_dto: boolean;
};
type TransferObservation = {
  request_completed: boolean;
  response_completed: boolean;
  http_status: number | null;
  provider_version_present: boolean;
};
type ObjectReadObservation = {
  request_completed: boolean;
  response_completed: boolean;
  http_status: number | null;
};
type AuthorityObservation = {
  request_completed: boolean;
  response_completed: boolean;
  http_status: number | null;
  exact_dto: boolean;
  state: (typeof DOCUMENT_VERSION_STATES)[number] | null;
  has_active: boolean | null;
};
type ScanScenarioObservation = {
  version: ReceiptObservation;
  upload_intent: IntentObservation;
  put: TransferObservation;
  message_received: boolean;
  process_result: ObservedProcessResult;
  process_error: ObservedProcessError;
  disposition: "delete" | "retain" | null;
  delete_completed: boolean;
  authority: AuthorityObservation;
};
type RecoveryScenarioObservation = {
  registration: ReceiptObservation;
  version_put_completed: boolean;
  head_completed: boolean;
  message_received: boolean;
  receipt_status: "ready" | null;
  claim_status: "claimed" | null;
  injected_disposition: "delete" | "retain" | null;
  rollback_db_exact: boolean;
  version_state: (typeof DOCUMENT_VERSION_STATES)[number] | null;
  scan_state: "queued" | "running" | "clean" | "rejected" | "failed" | null;
  bound_count: number | null;
  scan_count: number | null;
  attempt_count: number | null;
  audit_count: number | null;
  outbox_count: number | null;
  conflict_http_status: number | null;
  conflict_exact: boolean;
  object_absent: boolean | null;
  redelivery_received: boolean;
  redelivery_count: number | null;
  recovered_disposition: "delete" | "retain" | null;
  overlap_disposition: "delete" | "retain" | null;
  delete_completed: boolean;
  authority: AuthorityObservation;
  reconcile_exact: boolean;
  reconcile_inspected: number | null;
  reconcile_requeued: number | null;
  reconcile_dead_lettered: number | null;
  reconcile_ignored: number | null;
  effect_audit_count: number | null;
  effect_outbox_count: number | null;
  scan_results_count: number | null;
  scan_claim_audit_count: number | null;
  scan_claim_outbox_count: number | null;
  scan_clean_audit_count: number | null;
  scan_clean_outbox_count: number | null;
  completed: boolean;
};
type MissedEventRecoveryObservation = RecoveryScenarioObservation & {
  publish_started: boolean;
  publish_completed: boolean;
  reconcile_call_completed: boolean;
};
type StuckScanRecoveryObservation = RecoveryScenarioObservation & {
  readiness_candidate_count: number | null;
  readiness_exact_target: boolean;
  readiness_kind_stuck_scan: boolean;
  reconcile_call_completed: boolean;
};
type QueueAttemptObservation = {
  receive_completed: boolean;
  receive_count: number | null;
  disposition: "delete" | "retain" | null;
  visibility_reset: boolean;
};
type AbandonedCleanupDlqObservation = {
  registration: ReceiptObservation;
  version_put_completed: boolean;
  abandonment_http_status: number | null;
  abandonment_exact: boolean;
  attempts: [QueueAttemptObservation, QueueAttemptObservation, QueueAttemptObservation];
  main_empty: boolean;
  cleanup_dlq_received: boolean;
  cleanup_dlq_disposition: "delete" | "retain" | null;
  cleanup_dlq_deleted: boolean;
  object_absent: boolean | null;
  audit_count: number | null;
  outbox_count: number | null;
  ordinary_restored: boolean;
  ordinary_received: boolean;
  ordinary_same_message: boolean;
  ordinary_disposition: "delete" | "retain" | null;
  completed: boolean;
};
type ScanFailureObservation = {
  registration: ReceiptObservation;
  version_put_completed: boolean;
  scanner_constructed: boolean;
  attempts: [QueueAttemptObservation, QueueAttemptObservation, QueueAttemptObservation];
  main_empty: boolean;
  ordinary_dlq_received: boolean;
  ordinary_dlq_disposition: "delete" | "retain" | null;
  authority: AuthorityObservation;
  download_request_completed: boolean;
  download_http_status: number | null;
  download_code: "CONFLICT" | null;
  durable_attempt_count: number | null;
  cleanup: AbandonedCleanupDlqObservation;
  completed: boolean;
};
type PendingRecoveryObservation = {
  registration: ReceiptObservation;
  version: ReceiptObservation;
  authority: AuthorityObservation;
  pending_exact: boolean;
  upload_intent: IntentObservation;
  checksum_contract: boolean;
  stale_abandonment: {
    request_completed: boolean;
    response_completed: boolean;
    http_status: number | null;
    exact_dto: boolean;
    code: "STALE_VERSION" | null;
    private_echo: boolean | null;
  };
  post_stale_authority: AuthorityObservation;
  post_stale_pending_unchanged: boolean;
  completed: boolean;
};
type QueueDrainObservation = {
  delete_requested_count: number | null;
  delete_completed_count: number | null;
  attributes_complete: boolean;
  visible_count: number | null;
  not_visible_count: number | null;
  delayed_count: number | null;
  poll_count: number;
  worker_alive: boolean;
  worker_exit_code: number | null;
  worker_signal: NodeJS.Signals | null;
};
type CasePrincipalObservation = {
  founder_principal_exact: boolean;
  advisor_principal_exact: boolean;
  founder_login_completed: boolean;
  founder_auth_status: number | null;
  founder_auth_json_parseable: boolean;
  advisor_login_completed: boolean;
  advisor_auth_status: number | null;
  advisor_auth_json_parseable: boolean;
};
type CaseFixtureObservation = {
  request_started: boolean;
  response_received: boolean;
  http_status: number | null;
  json_parseable: boolean;
  exact_case_envelope: boolean;
};

test("DOC-02 uploads, scans, recovers and downloads through real local HTTP dependencies", {
  timeout: 600_000,
}, async () => {
  RUNTIME_PRIVATE_VALUES.clear();
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const postgresName = `tianxing-doc02-http-pg17-${suffix}`;
  const localstackName = `tianxing-doc02-http-localstack-${suffix}`;
  const clamavName = `tianxing-doc02-http-clamav-${suffix}`;
  const volumeName = `tianxing-doc02-http-secret-${suffix}`;
  const applicationPassword = randomBytes(32).toString("hex");
  const passwords = new Map<Role, string>(NEON_TEST_PRINCIPALS.map((principalValue) => [
    principalValue.role as Role,
    randomBytes(32).toString("base64url"),
  ]));
  let stage = "runtime_preflight";
  let postgresStarted = false;
  let localstackStarted = false;
  let clamavStarted = false;
  let volumeCreated = false;
  let appDirectory = "";
  let devServer: ChildProcess | undefined;
  let worker: ChildProcess | undefined;
  let workerForLogs: ChildProcess | undefined;
  let pool: Pool | undefined;
  let sqs: SQSClient | undefined;
  let s3: S3Client | undefined;
  let queueUrl = "";
  let deadLetterQueueUrl = "";
  let failureStage: string | null = null;
  const cleanup = {
    worker_stopped: false,
    dev_stopped: false,
    app_removed: false,
    postgres_removed: false,
    localstack_removed: false,
    clamav_removed: false,
    volume_removed: false,
  };
  const evidence: Record<string, unknown> = {};
  const workerRuntimeEvidence = {
    main_get_queue_url_completed: false,
    main_queue_url_strict: false,
    dlq_get_queue_url_completed: false,
    dlq_queue_url_strict: false,
    attributes_fetch_completed: false,
    visibility_exact_180: false,
    redrive_max_3: false,
    spawn_pid_positive: false,
    exit_before_ready: false,
    exit_code: null as number | null,
    signal: null as NodeJS.Signals | null,
    ready_marker: false,
  };
  evidence.worker_runtime = workerRuntimeEvidence;
  const s3TestEventEvidence = {
    requested_count: null as number | null,
    completed_count: null as number | null,
    acknowledged: false,
    final_marker_accounted: false,
  };
  evidence.s3_test_event = s3TestEventEvidence;
  const casePrincipalEvidence: CasePrincipalObservation = {
    founder_principal_exact: false,
    advisor_principal_exact: false,
    founder_login_completed: false,
    founder_auth_status: null,
    founder_auth_json_parseable: false,
    advisor_login_completed: false,
    advisor_auth_status: null,
    advisor_auth_json_parseable: false,
  };
  const firstCaseFixtureEvidence = createCaseFixtureObservation();
  const secondCaseFixtureEvidence = createCaseFixtureObservation();
  evidence.case_fixture_principals = casePrincipalEvidence;
  evidence.case_fixture_first = firstCaseFixtureEvidence;
  evidence.case_fixture_second = secondCaseFixtureEvidence;

  try {
    await Promise.all([
      runDocker(["image", "inspect", POSTGRES_IMAGE], stage),
      runDocker(["image", "inspect", LOCALSTACK_IMAGE], stage),
      runDocker(["image", "inspect", CLAMAV_IMAGE], stage),
    ]);
    const httpPort = await reserveLoopbackPort();
    const browserOrigin = `http://127.0.0.1:${httpPort}`;

    stage = "postgres_setup";
    await runDocker(["volume", "create", volumeName], stage);
    volumeCreated = true;
    await runDocker([
      "run", "--rm", "--interactive", "--pull=never",
      "--volume", `${volumeName}:/run/secrets`, POSTGRES_IMAGE,
      "/bin/sh", "-c",
      "umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password",
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
      stage,
    );
    const target = localTarget(postgresPort, applicationPassword);

    stage = "localstack_setup";
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", localstackName,
      "--env", "SERVICES=s3,sqs", "--env", `AWS_DEFAULT_REGION=${REGION}`,
      "--env", "AWS_ACCESS_KEY_ID=test", "--env", "AWS_SECRET_ACCESS_KEY=test",
      "--env", "SQS_ENDPOINT_STRATEGY=path",
      "--env", `LOCALSTACK_S3_BUCKET=${BUCKET}`,
      "--env", `LOCALSTACK_SQS_QUEUE=${QUEUE}`,
      "--env", `LOCALSTACK_SQS_DLQ=${DLQ}`,
      "--env", `LOCALSTACK_BROWSER_ORIGIN=${browserOrigin}`,
      "--volume", `${resolve("infra/local/localstack/init")}:/etc/localstack/init/ready.d:ro`,
      "--publish", "127.0.0.1::4566", LOCALSTACK_IMAGE,
    ], stage);
    localstackStarted = true;
    const localstackPort = await waitForPublishedPort(localstackName, "4566/tcp", stage);
    await waitForLocalStack(localstackName);
    const localstackEndpoint = `http://127.0.0.1:${localstackPort}`;

    stage = "clamav_setup";
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", clamavName,
      "--env", "CLAMD_STARTUP_TIMEOUT=300", "--publish", "127.0.0.1::3310", CLAMAV_IMAGE,
    ], stage);
    clamavStarted = true;
    const clamavPort = await waitForPublishedPort(clamavName, "3310/tcp", stage);
    await waitForClamAv(clamavPort);

    stage = "clamav_eicar_probe";
    const clamavEicarProbe = {
      runtime_generated: EICAR_BYTES.equals(Buffer.from(EICAR_MARKER, "ascii")),
      byte_length: EICAR_BYTES.length,
      checksum_contract: /^[a-f0-9]{64}$/u.test(sha256Hex(EICAR_BYTES)),
      command_completed: false,
      response_received: false,
      response_parseable: false,
      found: false,
      verdict_malicious: false,
    };
    evidence.clamav_eicar_probe = clamavEicarProbe;
    await probeClamAvEicar(clamavPort, EICAR_BYTES, clamavEicarProbe);
    assert.deepEqual(clamavEicarProbe, {
      runtime_generated: true,
      byte_length: 68,
      checksum_contract: true,
      command_completed: true,
      response_received: true,
      response_parseable: true,
      found: true,
      verdict_malicious: true,
    });

    stage = "baseline_seed";
    const build = await verifyCommittedOneRoleBaseline();
    assert.equal(build.files.length, 36);
    const manifestSha256 = createHash("sha256").update(build.manifestJson).digest("hex");
    const baseline = await executeOneRoleBaselineRun({
      mode: "apply",
      target,
      build,
      dependencies: baselineDependencies(target),
    });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.generated_files, 36);
    assertDatabaseContract(await inspectBaselineWithNewClient(target), target, manifestSha256);
    assert.equal((await seedNeonTestRelease1(target, "apply")).status, "pass");
    evidence.baseline = Object.freeze({ postgres_major: 17, source: 35, generated: 36 });

    stage = "identity_provision";
    for (const principalValue of NEON_TEST_PRINCIPALS) {
      assert.equal(
        await provision(target, principalValue.email, passwords.get(principalValue.role as Role)!),
        "created",
      );
    }

    stage = "next_dev";
    const runtime = Object.freeze({
      connectionString: target.connectionString,
      localstackEndpoint,
      clamavPort,
    });
    appDirectory = await createIsolatedAppDirectory();
    devServer = startNextDev(appDirectory, httpPort, runtime);
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    await waitForNextDev(baseUrl, devServer);

    stage = "worker_queue_urls";
    const sqsClient = sqs = localSqsClient(localstackEndpoint);
    const mainQueueResult = await sqsClient.send(new GetQueueUrlCommand({ QueueName: QUEUE }));
    workerRuntimeEvidence.main_get_queue_url_completed = true;
    queueUrl = validateLocalQueueUrl(
      mainQueueResult.QueueUrl,
      localstackEndpoint,
      REGION,
      QUEUE,
    );
    workerRuntimeEvidence.main_queue_url_strict = true;
    const deadLetterQueueResult = await sqsClient.send(new GetQueueUrlCommand({ QueueName: DLQ }));
    workerRuntimeEvidence.dlq_get_queue_url_completed = true;
    deadLetterQueueUrl = validateLocalQueueUrl(
      deadLetterQueueResult.QueueUrl,
      localstackEndpoint,
      REGION,
      DLQ,
    );
    workerRuntimeEvidence.dlq_queue_url_strict = true;

    stage = "worker_queue_attributes";
    const queueAttributes = await sqsClient.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["VisibilityTimeout", "RedrivePolicy"],
    }));
    workerRuntimeEvidence.attributes_fetch_completed = true;
    workerRuntimeEvidence.visibility_exact_180 =
      queueAttributes.Attributes?.VisibilityTimeout === "180";
    workerRuntimeEvidence.redrive_max_3 =
      /"maxReceiveCount":"3"/u.test(queueAttributes.Attributes?.RedrivePolicy ?? "");
    assert.equal(workerRuntimeEvidence.visibility_exact_180, true);
    assert.equal(workerRuntimeEvidence.redrive_max_3, true);

    stage = "worker_runtime_construct_or_spawn";
    pool = new Pool({ connectionString: target.connectionString, max: 5 });
    const dependencies = createScanDependencies(pool, runtime);
    const s3Client = s3 = localS3Client(localstackEndpoint);
    worker = startDocumentWorker(appDirectory, runtime);
    workerForLogs = worker;
    workerRuntimeEvidence.spawn_pid_positive =
      Number.isSafeInteger(worker.pid) && (worker.pid ?? 0) > 0;
    assert.equal(workerRuntimeEvidence.spawn_pid_positive, true);

    stage = "worker_ready";
    try {
      await waitForProcessLog(worker, WORKER_READY_MARKER, stage);
      workerRuntimeEvidence.exit_before_ready = processExited(worker);
      workerRuntimeEvidence.exit_code = safeProcessExitCode(worker);
      workerRuntimeEvidence.signal = safeProcessSignal(worker);
      assert.equal(workerRuntimeEvidence.exit_before_ready, false);
      workerRuntimeEvidence.ready_marker = true;
    } catch {
      workerRuntimeEvidence.exit_before_ready = processExited(worker);
      workerRuntimeEvidence.exit_code = safeProcessExitCode(worker);
      workerRuntimeEvidence.signal = safeProcessSignal(worker);
      throw new HarnessError(stage);
    }

    stage = "s3_test_event_acknowledged";
    await waitForS3TestEventAcknowledgement(worker, s3TestEventEvidence);
    assert.equal(s3TestEventEvidence.requested_count, 1);
    assert.equal(s3TestEventEvidence.completed_count, 1);
    assert.equal(s3TestEventEvidence.acknowledged, true);

    stage = "login";
    const cookies = new Map<Role, string>();
    for (const principalValue of NEON_TEST_PRINCIPALS) {
      const role = principalValue.role as Role;
      const cookie = await login(baseUrl, principalValue.email, passwords.get(role)!);
      cookies.set(role, cookie);
      if (role === "founder") casePrincipalEvidence.founder_login_completed = true;
      if (role === "advisor") casePrincipalEvidence.advisor_login_completed = true;
      const auth = await getJson(baseUrl, "/api/v1/auth/me", cookie);
      if (role === "founder") {
        casePrincipalEvidence.founder_auth_status = auth.response.status;
        casePrincipalEvidence.founder_auth_json_parseable = true;
      }
      if (role === "advisor") {
        casePrincipalEvidence.advisor_auth_status = auth.response.status;
        casePrincipalEvidence.advisor_auth_json_parseable = true;
      }
      assert.equal(auth.response.status, 200);
    }

    stage = "case_fixture_principal_contract";
    casePrincipalEvidence.founder_principal_exact =
      FOUNDER.role === "founder" && requiredUuid(FOUNDER.roleBindingId) === FOUNDER.roleBindingId;
    casePrincipalEvidence.advisor_principal_exact =
      ADVISOR.role === "advisor" && requiredUuid(ADVISOR.roleBindingId) === ADVISOR.roleBindingId;
    assert.equal(casePrincipalEvidence.founder_principal_exact, true);
    assert.equal(casePrincipalEvidence.advisor_principal_exact, true);

    stage = "case_fixture_login_contract";
    assert.equal(casePrincipalEvidence.founder_login_completed, true);
    assert.equal(casePrincipalEvidence.founder_auth_status, 200);
    assert.equal(casePrincipalEvidence.founder_auth_json_parseable, true);
    assert.equal(casePrincipalEvidence.advisor_login_completed, true);
    assert.equal(casePrincipalEvidence.advisor_auth_status, 200);
    assert.equal(casePrincipalEvidence.advisor_auth_json_parseable, true);

    stage = "case_fixture_first_transport";
    const founderCaseId = await createCase(
      baseUrl,
      cookies.get("founder")!,
      NEON_TEST_STUDENTS[0]!.id,
      ADVISOR.roleBindingId,
      2051,
      `doc02-founder-case-${suffix}`,
      firstCaseFixtureEvidence,
      (nextStage) => { stage = nextStage; },
      "case_fixture_first",
    );
    stage = "case_fixture_second_transport";
    const advisorCaseId = await createCase(
      baseUrl,
      cookies.get("advisor")!,
      NEON_TEST_STUDENTS[1]!.id,
      ADVISOR.roleBindingId,
      2052,
      `doc02-advisor-case-${suffix}`,
      secondCaseFixtureEvidence,
      (nextStage) => { stage = nextStage; },
      "case_fixture_second",
    );

    stage = "strict_contract";
    const strictDocument = await registerDocument(
      baseUrl,
      cookies.get("founder")!,
      founderCaseId,
      "Synthetic DOC-02 strict evidence",
      `doc02-strict-document-${suffix}`,
    );
    assertApiError(await rawPost(
      baseUrl,
      versionPath(founderCaseId, strictDocument.id),
      cookies.get("founder")!,
      `doc02-duplicate-json-${suffix}`,
      `{"checksum_sha256":"${sha256Hex(CLEAN_BYTES)}","checksum_sha256":"${sha256Hex(CLEAN_BYTES)}","size_bytes":${CLEAN_BYTES.length},"content_type":"application/pdf","expected_document_record_version":1}`,
    ), 422, "VALIDATION_FAILED");
    for (const invalidBody of [
      versionBody(Buffer.alloc(0), "application/pdf", 1),
      versionBody(CLEAN_BYTES, "text/plain" as never, 1),
      { ...versionBody(CLEAN_BYTES, "application/pdf", 1), extra: true },
    ]) {
      assertApiError(await postJson(
        baseUrl,
        versionPath(founderCaseId, strictDocument.id),
        cookies.get("founder")!,
        `doc02-invalid-${randomBytes(4).toString("hex")}`,
        invalidBody,
      ), 422, "VALIDATION_FAILED");
    }
    assertApiError(await postJson(
      baseUrl,
      versionPath(founderCaseId, strictDocument.id),
      "",
      `doc02-unauthenticated-version-${suffix}`,
      versionBody(CLEAN_BYTES, "application/pdf", 1),
    ), 401, "UNAUTHENTICATED");
    assertApiError(await postJsonNoKey(
      baseUrl,
      downloadIntentPath(founderCaseId, strictDocument.id),
      "",
      {},
    ), 401, "UNAUTHENTICATED");
    assertApiError(await postJson(
      baseUrl,
      versionPath(founderCaseId, strictDocument.id),
      cookies.get("founder")!,
      `doc02-stale-version-${suffix}`,
      versionBody(CLEAN_BYTES, "application/pdf", 99),
    ), 409, "STALE_VERSION");
    await prepareForeignDocumentFixture(target);
    assertApiError(await postJson(
      baseUrl,
      versionPath(FOREIGN_CASE_ID, FOREIGN_DOCUMENT_ID),
      cookies.get("founder")!,
      `doc02-cross-tenant-version-${suffix}`,
      versionBody(CLEAN_BYTES, "application/pdf", 1),
    ), 404, "NOT_FOUND");
    assertApiError(await postJsonNoKey(
      baseUrl,
      downloadIntentPath(FOREIGN_CASE_ID, FOREIGN_DOCUMENT_ID),
      cookies.get("founder")!,
      {},
    ), 404, "NOT_FOUND");

    stage = "clean_upload";
    const cleanDocument = await registerDocument(
      baseUrl,
      cookies.get("founder")!,
      founderCaseId,
      "Synthetic DOC-02 clean evidence",
      `doc02-clean-document-${suffix}`,
    );
    const cleanKey = `doc02-clean-version-${suffix}`;
    const cleanVersion = assertVersionReceipt(await postJson(
      baseUrl,
      versionPath(founderCaseId, cleanDocument.id),
      cookies.get("founder")!,
      cleanKey,
      versionBody(CLEAN_BYTES, "application/pdf", cleanDocument.recordVersion),
    ), 201, 1);
    const cleanReplay = assertVersionReceipt(await postJson(
      baseUrl,
      versionPath(founderCaseId, cleanDocument.id),
      cookies.get("founder")!,
      cleanKey,
      versionBody(CLEAN_BYTES, "application/pdf", cleanDocument.recordVersion),
    ), 201, 1);
    assert.deepEqual(cleanReplay, cleanVersion);
    assertApiError(await postJson(
      baseUrl,
      versionPath(founderCaseId, cleanDocument.id),
      cookies.get("founder")!,
      cleanKey,
      versionBody(NEWER_BYTES, "application/pdf", cleanDocument.recordVersion),
    ), 409, "CONFLICT");
    const cleanPending = assertDocumentDetail(await getJson(
      baseUrl,
      documentPath(founderCaseId, cleanDocument.id),
      cookies.get("founder")!,
    ));
    assert.deepEqual(cleanPending.pending, cleanVersion);
    assert.equal(cleanPending.state, "pending_upload");
    const cleanObjectKey = objectKey(cleanDocument.id, cleanVersion.id);
    const cleanIntent = assertUploadIntent(await postJsonNoKey(
      baseUrl,
      uploadIntentPath(founderCaseId, cleanDocument.id, cleanVersion.id),
      cookies.get("founder")!,
      { expected_record_version: 1 },
    ), localstackEndpoint, cleanObjectKey, "application/pdf", CLEAN_BYTES);
    const unboundProviderEvidence = {
      repeated_capability_puts: 0,
      provider_versions_distinct: false,
      database: {
        scan_results: null as number | null,
        cleanup_audit: null as number | null,
        cleanup_outbox: null as number | null,
        authoritative_bound_present: false,
      },
      classification: {
        bound_choice_present: false,
        unbound_choice_present: false,
        provider_version_total_count: null as number | null,
        delete_marker_count: null as number | null,
      },
      bound_object_present: false,
      unbound_object_absent: false,
      queue_empty: false,
      queue: {
        delete_requested_count: null,
        delete_completed_count: null,
        attributes_complete: false,
        visible_count: null,
        not_visible_count: null,
        delayed_count: null,
        poll_count: 0,
        worker_alive: false,
        worker_exit_code: null,
        worker_signal: null,
      } satisfies QueueDrainObservation,
      replay: {
        bound_process_completed: false,
        bound_status: null as "duplicate" | "other" | null,
        unbound_process_completed: false,
        unbound_status: null as "removed" | "other" | null,
        delete_result: null as "deleted" | "already_absent" | "other" | null,
        error_category: null as
          | "RETRYABLE"
          | "DEAD_LETTER"
          | "OBJECT_STORE"
          | "RECEIPT"
          | "OTHER"
          | null,
        database_read_completed: false,
        bound_matches: false,
        state: null as "available" | "other" | null,
        scan_results: null as number | null,
        cleanup_audit: null as number | null,
        cleanup_outbox: null as number | null,
      },
      replay_zero_extra: false,
      bound_download_bytes_exact: false,
    };
    evidence.unbound_provider_version_cleanup = unboundProviderEvidence;
    assertApiError(await postJsonNoKey(
      baseUrl,
      downloadIntentPath(founderCaseId, cleanDocument.id),
      cookies.get("founder")!,
      {},
    ), 409, "CONFLICT");
    stage = "unbound_provider_version_setup";
    const cleanUploads = await Promise.all([
      putObject(cleanIntent, CLEAN_BYTES),
      putObject(cleanIntent, CLEAN_BYTES),
    ]);
    const cleanProviderVersions = cleanUploads.flatMap((upload) =>
      upload.providerVersionId ? [upload.providerVersionId] : []);
    unboundProviderEvidence.repeated_capability_puts = cleanProviderVersions.length;
    assert.equal(cleanProviderVersions.length, 2);
    unboundProviderEvidence.provider_versions_distinct =
      cleanProviderVersions[0] !== cleanProviderVersions[1];
    assert.notEqual(cleanProviderVersions[0], cleanProviderVersions[1]);
    await waitForDocumentState(
      baseUrl,
      cookies.get("founder")!,
      founderCaseId,
      cleanDocument.id,
      "available",
      true,
    );
    stage = "cleanup_database_authority";
    const unboundCleanup = await waitForUnboundProviderCleanup(
      target,
      cleanVersion.id,
      cleanProviderVersions,
      unboundProviderEvidence.database,
    );
    stage = "cleanup_version_classification";
    const cleanBoundProviderVersion = unboundCleanup.boundProviderVersion;
    unboundProviderEvidence.classification.bound_choice_present =
      cleanProviderVersions.includes(cleanBoundProviderVersion);
    const cleanUnboundProviderVersion = cleanProviderVersions.find(
      (value) => value !== cleanBoundProviderVersion,
    );
    unboundProviderEvidence.classification.unbound_choice_present =
      cleanUnboundProviderVersion !== undefined;
    assert.notEqual(cleanUnboundProviderVersion, undefined);
    const cleanInventory = await objectVersionInventory(s3Client, cleanObjectKey);
    unboundProviderEvidence.classification.provider_version_total_count =
      cleanInventory.providerVersionCount;
    unboundProviderEvidence.classification.delete_marker_count = cleanInventory.deleteMarkerCount;
    assert.equal(cleanInventory.providerVersionCount, 1);
    assert.equal(cleanInventory.deleteMarkerCount, 0);
    stage = "cleanup_bound_object_preserved";
    unboundProviderEvidence.bound_object_present = await exactObjectVersionsPresent(
      s3Client,
      cleanObjectKey,
      [cleanBoundProviderVersion],
    );
    assert.equal(unboundProviderEvidence.bound_object_present, true);
    stage = "cleanup_unbound_object_absent";
    unboundProviderEvidence.unbound_object_absent = await exactObjectVersionsAbsent(
      s3Client,
      cleanObjectKey,
      [cleanUnboundProviderVersion!],
    );
    assert.equal(unboundProviderEvidence.unbound_object_absent, true);
    stage = "cleanup_queue_drained";
    unboundProviderEvidence.queue_empty = await waitForQueueEmpty(
      sqsClient,
      queueUrl,
      worker,
      unboundProviderEvidence.queue,
    );
    assert.ok((unboundProviderEvidence.queue.delete_requested_count ?? 0) >= 2);
    assert.equal(
      unboundProviderEvidence.queue.delete_completed_count,
      unboundProviderEvidence.queue.delete_requested_count,
    );
    s3TestEventEvidence.final_marker_accounted =
      (unboundProviderEvidence.queue.delete_completed_count ?? 0) >=
      (s3TestEventEvidence.completed_count ?? 0) + 2;
    assert.equal(s3TestEventEvidence.final_marker_accounted, true);
    assert.equal(unboundProviderEvidence.queue.attributes_complete, true);
    assert.equal(unboundProviderEvidence.queue.visible_count, 0);
    assert.equal(unboundProviderEvidence.queue.not_visible_count, 0);
    assert.equal(unboundProviderEvidence.queue.delayed_count, 0);
    assert.equal(
      unboundProviderEvidence.queue.poll_count,
      QUEUE_CONVERGENCE_POLL_COUNT,
    );
    assert.equal(unboundProviderEvidence.queue.worker_alive, true);
    assert.equal(unboundProviderEvidence.queue.worker_exit_code, null);
    assert.equal(unboundProviderEvidence.queue.worker_signal, null);
    assert.equal(unboundProviderEvidence.queue_empty, true);
    assert.equal(await stopProcess(worker), true);
    worker = undefined;
    const cleanDownload = assertDownloadIntent(await postJsonNoKey(
      baseUrl,
      downloadIntentPath(founderCaseId, cleanDocument.id),
      cookies.get("founder")!,
      {},
    ), localstackEndpoint, cleanObjectKey, cleanBoundProviderVersion);
    assert.deepEqual(await downloadObject(cleanDownload), CLEAN_BYTES);
    unboundProviderEvidence.bound_download_bytes_exact = true;
    stage = "cleanup_bound_replay";
    try {
      const duplicateResult = await processDocumentObjectCreated({
        eventId: randomUUID(),
        requestId: randomUUID(),
        bucket: BUCKET,
        key: cleanObjectKey,
        versionId: cleanBoundProviderVersion,
        scanPolicyVersion: "clamav-release1-v1",
        deliveryAttempt: 2,
      }, dependencies);
      unboundProviderEvidence.replay.bound_process_completed = true;
      unboundProviderEvidence.replay.bound_status =
        duplicateResult.status === "duplicate" ? "duplicate" : "other";
      assert.equal(duplicateResult.status, "duplicate");
    } catch (error) {
      unboundProviderEvidence.replay.error_category = replayErrorCategory(error);
      throw error;
    }
    stage = "cleanup_unbound_replay_delete";
    try {
      const unboundReplay = await processDocumentObjectCreated({
        eventId: randomUUID(),
        requestId: randomUUID(),
        bucket: BUCKET,
        key: cleanObjectKey,
        versionId: cleanUnboundProviderVersion!,
        scanPolicyVersion: "clamav-release1-v1",
        deliveryAttempt: 2,
      }, {
        ...dependencies,
        objectCleaner: Object.freeze({
          async deleteExact(
            input: Parameters<ScanDependencies["objectCleaner"]["deleteExact"]>[0],
          ) {
            const result = await dependencies.objectCleaner.deleteExact(input);
            unboundProviderEvidence.replay.delete_result = result === "deleted"
              ? "deleted"
              : result === "already_absent" ? "already_absent" : "other";
            stage = "cleanup_unbound_replay_effect";
            return result;
          },
        }),
      });
      unboundProviderEvidence.replay.unbound_process_completed = true;
      unboundProviderEvidence.replay.unbound_status =
        unboundReplay.status === "unbound_provider_version_removed" ? "removed" : "other";
      assert.equal(unboundReplay.status, "unbound_provider_version_removed");
    } catch (error) {
      unboundProviderEvidence.replay.error_category = replayErrorCategory(error);
      throw error;
    }
    stage = "cleanup_replay_database_authority";
    let unboundReplayCounts: Awaited<ReturnType<typeof unboundProviderCleanupCounts>>;
    try {
      unboundReplayCounts = await unboundProviderCleanupCounts(target, cleanVersion.id);
      unboundProviderEvidence.replay.database_read_completed = true;
      unboundProviderEvidence.replay.bound_matches =
        unboundReplayCounts.boundProviderVersion === cleanBoundProviderVersion;
      unboundProviderEvidence.replay.state =
        unboundReplayCounts.versionState === "available" ? "available" : "other";
      unboundProviderEvidence.replay.scan_results = unboundReplayCounts.scan_results;
      unboundProviderEvidence.replay.cleanup_audit = unboundReplayCounts.cleanup_audit;
      unboundProviderEvidence.replay.cleanup_outbox = unboundReplayCounts.cleanup_outbox;
      assert.deepEqual(unboundReplayCounts, {
        boundProviderVersion: cleanBoundProviderVersion,
        versionState: "available",
        scan_results: 1,
        cleanup_audit: 1,
        cleanup_outbox: 1,
      });
    } catch (error) {
      unboundProviderEvidence.replay.error_category = replayErrorCategory(error);
      throw error;
    }
    unboundProviderEvidence.replay_zero_extra = true;
    assert.deepEqual(await scanFactCounts(target, cleanVersion.id), {
      scan_results: 1,
      scan_claim_audit: 1,
      scan_claim_outbox: 1,
      scan_clean_audit: 1,
      scan_clean_outbox: 1,
    });
    evidence.clean = Object.freeze({
      exact_replay: true,
      changed_conflict: true,
      pending_reference: true,
      preclean_download_409: true,
      worker_available: true,
      exact_download_bytes: true,
      duplicate_event_one_scan: true,
    });
    const formatEvidence = {
      jpeg: {
        registration: createReceiptObservation(),
        scan: createScanScenarioObservation(),
      },
      png: {
        registration: createReceiptObservation(),
        scan: createScanScenarioObservation(),
      },
      mime_mismatch: {
        registration: createReceiptObservation(),
        scan: createScanScenarioObservation(),
        scan_results: null as number | null,
        scan_claim_audit: null as number | null,
        scan_claim_outbox: null as number | null,
        scan_clean_audit: null as number | null,
        scan_clean_outbox: null as number | null,
        claim_only_scan_facts_exact: false,
        download_denial: createIntentObservation(),
      },
      eicar: {
        scan: createScanScenarioObservation(),
        authoritative: createAuthorityObservation(),
        new_version_receipt_exact: false,
        old_download_intent: createIntentObservation(),
        old_download: createObjectReadObservation(),
        old_bytes_exact: false,
      },
    };
    evidence.formats = formatEvidence;

    stage = "jpeg_register";
    const jpegDocument = await registerDocumentObserved(
      baseUrl,
      cookies.get("founder")!,
      founderCaseId,
      "Synthetic DOC-02 jpeg evidence",
      `doc02-jpeg-document-${suffix}`,
      formatEvidence.jpeg.registration,
    );
    await createUploadAndProcessObserved({
      label: "jpeg",
      setStage: (value) => { stage = value; },
      evidence: formatEvidence.jpeg.scan,
      baseUrl,
      cookie: cookies.get("founder")!,
      caseId: founderCaseId,
      document: jpegDocument,
      bytes: JPEG_BYTES,
      contentType: "image/jpeg",
      localstackEndpoint,
      sqs: sqsClient,
      queueUrl,
      dependencies,
      expectedState: "available",
      expectedHasActive: true,
    });

    stage = "png_register";
    const pngDocument = await registerDocumentObserved(
      baseUrl,
      cookies.get("founder")!,
      founderCaseId,
      "Synthetic DOC-02 png evidence",
      `doc02-png-document-${suffix}`,
      formatEvidence.png.registration,
    );
    await createUploadAndProcessObserved({
      label: "png",
      setStage: (value) => { stage = value; },
      evidence: formatEvidence.png.scan,
      baseUrl,
      cookie: cookies.get("founder")!,
      caseId: founderCaseId,
      document: pngDocument,
      bytes: PNG_BYTES,
      contentType: "image/png",
      localstackEndpoint,
      sqs: sqsClient,
      queueUrl,
      dependencies,
      expectedState: "available",
      expectedHasActive: true,
    });

    stage = "mime_mismatch_register";
    const mimeMismatchDocument = await registerDocumentObserved(
      baseUrl,
      cookies.get("founder")!,
      founderCaseId,
      "Synthetic DOC-02 MIME mismatch evidence",
      `doc02-mime-mismatch-document-${suffix}`,
      formatEvidence.mime_mismatch.registration,
    );
    const mimeMismatch = await createUploadAndProcessObserved({
      label: "mime_mismatch",
      setStage: (value) => { stage = value; },
      evidence: formatEvidence.mime_mismatch.scan,
      baseUrl,
      cookie: cookies.get("founder")!,
      caseId: founderCaseId,
      document: mimeMismatchDocument,
      bytes: CLEAN_BYTES,
      contentType: "image/png",
      localstackEndpoint,
      sqs: sqsClient,
      queueUrl,
      dependencies,
      expectedState: "rejected",
      expectedHasActive: false,
    });
    stage = "mime_mismatch_scan_facts";
    const mimeMismatchScanFacts = await scanFactCounts(target, mimeMismatch.version.id);
    Object.assign(formatEvidence.mime_mismatch, mimeMismatchScanFacts);
    formatEvidence.mime_mismatch.claim_only_scan_facts_exact =
      mimeMismatchScanFacts.scan_results === 1 &&
      mimeMismatchScanFacts.scan_claim_audit === 1 &&
      mimeMismatchScanFacts.scan_claim_outbox === 1 &&
      mimeMismatchScanFacts.scan_clean_audit === 0 &&
      mimeMismatchScanFacts.scan_clean_outbox === 0;
    assert.deepEqual(mimeMismatchScanFacts, {
      scan_results: 1,
      scan_claim_audit: 1,
      scan_claim_outbox: 1,
      scan_clean_audit: 0,
      scan_clean_outbox: 0,
    });
    stage = "mime_mismatch_download_denial";
    const mimeMismatchDownload = await postJsonNoKey(
      baseUrl,
      downloadIntentPath(founderCaseId, mimeMismatchDocument.id),
      cookies.get("founder")!,
      {},
    );
    formatEvidence.mime_mismatch.download_denial.request_completed = true;
    formatEvidence.mime_mismatch.download_denial.response_completed = true;
    formatEvidence.mime_mismatch.download_denial.http_status = mimeMismatchDownload.response.status;
    assertApiError(mimeMismatchDownload, 409, "CONFLICT");
    formatEvidence.mime_mismatch.download_denial.exact_dto = true;

    const malicious = await createUploadAndProcessObserved({
      label: "eicar",
      setStage: (value) => { stage = value; },
      evidence: formatEvidence.eicar.scan,
      baseUrl,
      cookie: cookies.get("founder")!,
      caseId: founderCaseId,
      document: { ...cleanDocument, recordVersion: 3 },
      bytes: EICAR_BYTES,
      contentType: "application/pdf",
      localstackEndpoint,
      sqs: sqsClient,
      queueUrl,
      dependencies,
      expectedState: "rejected",
      expectedHasActive: true,
    });
    stage = "eicar_authority_confirmation";
    const eicarAuthorityResult = await getJson(
      baseUrl,
      documentPath(founderCaseId, cleanDocument.id),
      cookies.get("founder")!,
    );
    formatEvidence.eicar.authoritative.request_completed = true;
    formatEvidence.eicar.authoritative.response_completed = true;
    formatEvidence.eicar.authoritative.http_status = eicarAuthorityResult.response.status;
    const eicarAuthority = assertDocumentDetail(eicarAuthorityResult);
    recordAuthority(formatEvidence.eicar.authoritative, eicarAuthority);
    assert.equal(eicarAuthority.state, "rejected");
    assert.equal(eicarAuthority.hasActive, true);

    stage = "eicar_old_download_intent";
    const eicarDownloadResult = await postJsonNoKey(
      baseUrl,
      downloadIntentPath(founderCaseId, cleanDocument.id),
      cookies.get("founder")!,
      {},
    );
    formatEvidence.eicar.old_download_intent.request_completed = true;
    formatEvidence.eicar.old_download_intent.response_completed = true;
    formatEvidence.eicar.old_download_intent.http_status = eicarDownloadResult.response.status;
    const eicarDownloadIntent = assertDownloadIntent(
      eicarDownloadResult,
      localstackEndpoint,
      cleanObjectKey,
      cleanBoundProviderVersion,
    );
    formatEvidence.eicar.old_download_intent.exact_dto = true;
    stage = "eicar_old_download";
    const eicarOldBytes = await downloadObject(eicarDownloadIntent, formatEvidence.eicar.old_download);
    formatEvidence.eicar.old_bytes_exact = eicarOldBytes.equals(CLEAN_BYTES);
    assert.deepEqual(eicarOldBytes, CLEAN_BYTES);
    formatEvidence.eicar.new_version_receipt_exact = malicious.version.recordVersion === 1;
    assert.equal(malicious.version.recordVersion, 1);

    const pendingRecoveryEvidence = createPendingRecoveryObservation();
    evidence.pending_recovery = pendingRecoveryEvidence;
    stage = "pending_recovery_register";
    const recoveryDocument = await registerDocumentObserved(
      baseUrl,
      cookies.get("founder")!,
      founderCaseId,
      "Synthetic DOC-02 recovery evidence",
      `doc02-recovery-document-${suffix}`,
      pendingRecoveryEvidence.registration,
    );
    stage = "pending_recovery_version";
    const recoveryVersionResult = await postJson(
      baseUrl,
      versionPath(founderCaseId, recoveryDocument.id),
      cookies.get("founder")!,
      `doc02-recovery-version-${suffix}`,
      versionBody(NEWER_BYTES, "application/pdf", 1),
    );
    pendingRecoveryEvidence.version.request_completed = true;
    pendingRecoveryEvidence.version.response_completed = true;
    pendingRecoveryEvidence.version.http_status = recoveryVersionResult.response.status;
    const recoveryVersion = assertVersionReceipt(recoveryVersionResult, 201, 1);
    pendingRecoveryEvidence.version.exact_dto = true;
    pendingRecoveryEvidence.version.record_version = recoveryVersion.recordVersion;
    stage = "pending_recovery_authority";
    const recoveryAuthorityResult = await getJson(
      baseUrl,
      documentPath(founderCaseId, recoveryDocument.id),
      cookies.get("founder")!,
    );
    pendingRecoveryEvidence.authority.request_completed = true;
    pendingRecoveryEvidence.authority.response_completed = true;
    pendingRecoveryEvidence.authority.http_status = recoveryAuthorityResult.response.status;
    const recoveryAuthority = assertDocumentDetail(recoveryAuthorityResult);
    recordAuthority(pendingRecoveryEvidence.authority, recoveryAuthority);
    pendingRecoveryEvidence.pending_exact = recoveryAuthority.pending?.id === recoveryVersion.id &&
      recoveryAuthority.pending.recordVersion === recoveryVersion.recordVersion;
    assert.deepEqual(recoveryAuthority.pending, recoveryVersion);
    stage = "pending_recovery_upload_intent";
    const recoveredIntentResult = await postJsonNoKey(
      baseUrl,
      uploadIntentPath(founderCaseId, recoveryDocument.id, recoveryVersion.id),
      cookies.get("founder")!,
      { expected_record_version: 1 },
    );
    pendingRecoveryEvidence.upload_intent.request_completed = true;
    pendingRecoveryEvidence.upload_intent.response_completed = true;
    pendingRecoveryEvidence.upload_intent.http_status = recoveredIntentResult.response.status;
    const recoveredIntent = assertUploadIntent(
      recoveredIntentResult,
      localstackEndpoint,
      objectKey(recoveryDocument.id, recoveryVersion.id),
      "application/pdf",
      NEWER_BYTES,
    );
    pendingRecoveryEvidence.upload_intent.exact_dto = true;
    pendingRecoveryEvidence.checksum_contract = recoveredIntent.checksumBase64 ===
      createHash("sha256").update(NEWER_BYTES).digest("base64");
    assert.equal(pendingRecoveryEvidence.checksum_contract, true);
    stage = "pending_recovery_stale_abandonment";
    const staleAbandonmentResult = await postJson(
      baseUrl,
      abandonmentPath(founderCaseId, recoveryDocument.id, recoveryVersion.id),
      cookies.get("founder")!,
      `doc02-recovery-stale-${suffix}`,
      { expected_document_record_version: 1, expected_version_record_version: 1 },
    );
    pendingRecoveryEvidence.stale_abandonment.request_completed = true;
    pendingRecoveryEvidence.stale_abandonment.response_completed = true;
    pendingRecoveryEvidence.stale_abandonment.http_status = staleAbandonmentResult.response.status;
    pendingRecoveryEvidence.stale_abandonment.code =
      staleAbandonmentResult.body.error?.code === "STALE_VERSION" ? "STALE_VERSION" : null;
    pendingRecoveryEvidence.stale_abandonment.private_echo = [
      ...PRIVATE_MARKERS,
      EICAR_MARKER,
      "X-Amz-Signature",
      ...RUNTIME_PRIVATE_VALUES,
    ].some((privateValue) => staleAbandonmentResult.text.includes(privateValue));
    assert.equal(pendingRecoveryEvidence.stale_abandonment.private_echo, false);
    assertApiError(staleAbandonmentResult, 409, "STALE_VERSION");
    pendingRecoveryEvidence.stale_abandonment.exact_dto = true;
    stage = "pending_recovery_post_stale_authority";
    const postStaleAuthorityResult = await getJson(
      baseUrl,
      documentPath(founderCaseId, recoveryDocument.id),
      cookies.get("founder")!,
    );
    pendingRecoveryEvidence.post_stale_authority.request_completed = true;
    pendingRecoveryEvidence.post_stale_authority.response_completed = true;
    pendingRecoveryEvidence.post_stale_authority.http_status = postStaleAuthorityResult.response.status;
    const postStaleAuthority = assertDocumentDetail(postStaleAuthorityResult);
    recordAuthority(pendingRecoveryEvidence.post_stale_authority, postStaleAuthority);
    pendingRecoveryEvidence.post_stale_pending_unchanged =
      postStaleAuthority.pending?.id === recoveryVersion.id &&
      postStaleAuthority.pending.recordVersion === recoveryVersion.recordVersion;
    assert.deepEqual(postStaleAuthority.pending, recoveryVersion);
    pendingRecoveryEvidence.completed = true;

    stage = "abandonment_and_late_objects";
    const activeBeforeAbandon = await currentActiveVersion(target, cleanDocument.id);
    assert.notEqual(activeBeforeAbandon, null);
    const pendingToAbandon = assertVersionReceipt(await postJson(
      baseUrl,
      versionPath(founderCaseId, cleanDocument.id),
      cookies.get("founder")!,
      `doc02-abandon-version-${suffix}`,
      versionBody(NEWER_BYTES, "application/pdf", 4),
    ), 201, 1);
    const lateObjectKey = objectKey(cleanDocument.id, pendingToAbandon.id);
    const lateCapability = assertUploadIntent(await postJsonNoKey(
      baseUrl,
      uploadIntentPath(founderCaseId, cleanDocument.id, pendingToAbandon.id),
      cookies.get("founder")!,
      { expected_record_version: 1 },
    ), localstackEndpoint, lateObjectKey, "application/pdf", NEWER_BYTES);
    const abandonmentKey = `doc02-abandon-${suffix}`;
    const abandoned = assertVersionReceipt(await postJson(
      baseUrl,
      abandonmentPath(founderCaseId, cleanDocument.id, pendingToAbandon.id),
      cookies.get("founder")!,
      abandonmentKey,
      { expected_document_record_version: 5, expected_version_record_version: 1 },
    ), 200, 2);
    assert.equal(abandoned.id, pendingToAbandon.id);
    assert.deepEqual(assertVersionReceipt(await postJson(
      baseUrl,
      abandonmentPath(founderCaseId, cleanDocument.id, pendingToAbandon.id),
      cookies.get("founder")!,
      abandonmentKey,
      { expected_document_record_version: 5, expected_version_record_version: 1 },
    ), 200, 2), abandoned);
    assertApiError(await postJson(
      baseUrl,
      abandonmentPath(founderCaseId, cleanDocument.id, pendingToAbandon.id),
      cookies.get("founder")!,
      abandonmentKey,
      { expected_document_record_version: 6, expected_version_record_version: 1 },
    ), 409, "CONFLICT");
    assertApiError(await postJson(
      baseUrl,
      abandonmentPath(founderCaseId, cleanDocument.id, pendingToAbandon.id),
      cookies.get("founder")!,
      `doc02-abandon-after-terminal-${suffix}`,
      { expected_document_record_version: 5, expected_version_record_version: 1 },
    ), 409, "CONFLICT");
    assert.equal(await currentActiveVersion(target, cleanDocument.id), activeBeforeAbandon);
    assert.deepEqual(await downloadObject(assertDownloadIntent(await postJsonNoKey(
      baseUrl,
      downloadIntentPath(founderCaseId, cleanDocument.id),
      cookies.get("founder")!,
      {},
    ), localstackEndpoint, cleanObjectKey, cleanBoundProviderVersion)), CLEAN_BYTES);

    const newer = await createUploadAndProcess({
      baseUrl,
      cookie: cookies.get("founder")!,
      caseId: founderCaseId,
      document: { ...cleanDocument, recordVersion: 6 },
      bytes: NEWER_BYTES,
      contentType: "application/pdf",
      localstackEndpoint,
      sqs: sqsClient,
      queueUrl,
      dependencies,
      expectedState: "available",
      expectedHasActive: true,
    });
    const newerActive = await currentActiveVersion(target, cleanDocument.id);
    assert.equal(newerActive, newer.version.id);
    const latePuts = await Promise.all([
      putObject(lateCapability, NEWER_BYTES),
      putObject(lateCapability, NEWER_BYTES),
    ]);
    const lateProviderVersions = latePuts.flatMap((value) =>
      value.providerVersionId === null ? [] : [value.providerVersionId]);
    assert.equal(lateProviderVersions.length, 2);
    assert.equal(new Set(lateProviderVersions).size, 2);
    assert.equal(await exactObjectVersionsPresent(s3Client, lateObjectKey, lateProviderVersions), true);
    for (let index = 0; index < 2; index += 1) {
      const message = await receiveMessage(sqsClient, queueUrl);
      assert.equal(await documentMessageDisposition(
        message,
        BUCKET,
        (event) => processDocumentObjectCreated(event, dependencies),
      ), "delete");
      await deleteMessage(sqsClient, queueUrl, message);
    }
    assert.equal(await exactObjectVersionsAbsent(s3Client, lateObjectKey, lateProviderVersions), true);
    const abandonmentDb = await abandonmentDatabaseEvidence(
      target,
      cleanDocument.id,
      pendingToAbandon.id,
      newer.version.id,
      abandonmentKey,
    );
    assert.deepEqual(abandonmentDb, {
      scan_results: 0,
      cleanup_audit: 2,
      cleanup_outbox: 2,
      scan_audit: 0,
      scan_outbox: 0,
      abandonment_audit: 1,
      abandonment_outbox: 1,
      abandonment_receipt: 1,
      abandoned_unbound: 1,
      active_newer: 1,
    });
    assert.equal(await currentActiveVersion(target, cleanDocument.id), newer.version.id);
    assert.deepEqual(await downloadObject(assertDownloadIntent(await postJsonNoKey(
      baseUrl,
      downloadIntentPath(founderCaseId, cleanDocument.id),
      cookies.get("founder")!,
      {},
    ), localstackEndpoint, objectKey(cleanDocument.id, newer.version.id), newer.providerVersionId)), NEWER_BYTES);
    evidence.abandonment = Object.freeze({
      replay_exact: true,
      old_active_retained: true,
      late_provider_versions_distinct: true,
      cleanup_effects: 2,
      no_scan_effects: true,
      newer_active_isolated: true,
    });

    stage = "advisor_and_denied_roles";
    const advisorDocument = await registerDocument(
      baseUrl,
      cookies.get("advisor")!,
      advisorCaseId,
      "Synthetic DOC-02 Advisor evidence",
      `doc02-advisor-document-${suffix}`,
    );
    const advisorUpload = await createUploadAndProcess({
      baseUrl,
      cookie: cookies.get("advisor")!,
      caseId: advisorCaseId,
      document: advisorDocument,
      bytes: CLEAN_BYTES,
      contentType: "application/pdf",
      localstackEndpoint,
      sqs: sqsClient,
      queueUrl,
      dependencies,
      expectedState: "available",
      expectedHasActive: true,
    });
    assert.deepEqual(await downloadObject(assertDownloadIntent(await postJsonNoKey(
      baseUrl,
      downloadIntentPath(advisorCaseId, advisorDocument.id),
      cookies.get("advisor")!,
      {},
    ), localstackEndpoint, advisorUpload.objectKey, advisorUpload.providerVersionId)), CLEAN_BYTES);

    assertApiError(await postJsonNoKey(
      baseUrl,
      downloadIntentPath(founderCaseId, cleanDocument.id),
      cookies.get("advisor")!,
      {},
    ), 404, "NOT_FOUND");
    assertApiError(await postJson(
      baseUrl,
      versionPath(founderCaseId, cleanDocument.id),
      cookies.get("advisor")!,
      `doc02-advisor-unassigned-version-${suffix}`,
      versionBody(CLEAN_BYTES, "application/pdf", 8),
    ), 404, "NOT_FOUND");
    assertApiError(await postJsonNoKey(
      baseUrl,
      uploadIntentPath(founderCaseId, cleanDocument.id, newer.version.id),
      cookies.get("advisor")!,
      { expected_record_version: 1 },
    ), 404, "NOT_FOUND");
    assertApiError(await postJson(
      baseUrl,
      abandonmentPath(founderCaseId, cleanDocument.id, newer.version.id),
      cookies.get("advisor")!,
      `doc02-advisor-unassigned-abandon-${suffix}`,
      { expected_document_record_version: 1, expected_version_record_version: 1 },
    ), 404, "NOT_FOUND");

    assertApiError(await postJson(
      baseUrl,
      versionPath(founderCaseId, advisorDocument.id),
      cookies.get("founder")!,
      `doc02-cross-case-version-${suffix}`,
      versionBody(CLEAN_BYTES, "application/pdf", 1),
    ), 404, "NOT_FOUND");
    assertApiError(await postJsonNoKey(
      baseUrl,
      uploadIntentPath(founderCaseId, advisorDocument.id, advisorUpload.version.id),
      cookies.get("founder")!,
      { expected_record_version: 1 },
    ), 404, "NOT_FOUND");
    assertApiError(await postJson(
      baseUrl,
      abandonmentPath(founderCaseId, advisorDocument.id, advisorUpload.version.id),
      cookies.get("founder")!,
      `doc02-cross-case-abandon-${suffix}`,
      { expected_document_record_version: 1, expected_version_record_version: 1 },
    ), 404, "NOT_FOUND");
    assertApiError(await postJsonNoKey(
      baseUrl,
      downloadIntentPath(founderCaseId, advisorDocument.id),
      cookies.get("founder")!,
      {},
    ), 404, "NOT_FOUND");

    for (const role of ["admin", "data_reviewer", "contractor"] as const) {
      assertApiError(await postJson(
        baseUrl,
        versionPath(founderCaseId, cleanDocument.id),
        cookies.get(role)!,
        `doc02-denied-${role}-${suffix}`,
        versionBody(CLEAN_BYTES, "application/pdf", 1),
      ), 403, "FORBIDDEN");
      assertApiError(await postJsonNoKey(
        baseUrl,
        uploadIntentPath(founderCaseId, cleanDocument.id, newer.version.id),
        cookies.get(role)!,
        { expected_record_version: 1 },
      ), 403, "FORBIDDEN");
      assertApiError(await postJson(
        baseUrl,
        abandonmentPath(founderCaseId, cleanDocument.id, newer.version.id),
        cookies.get(role)!,
        `doc02-denied-${role}-abandon-${suffix}`,
        { expected_document_record_version: 1, expected_version_record_version: 1 },
      ), 403, "FORBIDDEN");
      assertApiError(await postJsonNoKey(
        baseUrl,
        downloadIntentPath(founderCaseId, cleanDocument.id),
        cookies.get(role)!,
        {},
      ), 403, "FORBIDDEN");
    }
    evidence.authorization = Object.freeze({
      unauthenticated_401: 2,
      cross_tenant_404: 2,
      advisor_assigned: true,
      advisor_assigned_download: true,
      advisor_unassigned_404: 4,
      cross_case_404: 4,
      denied_403: 12,
    });

    const scanFailureEvidence = createScanFailureObservation();
    evidence.scan_failure = scanFailureEvidence;
    stage = "scan_failed_setup_register";
    const failedDocument = await registerDocumentObserved(
      baseUrl,
      cookies.get("founder")!,
      founderCaseId,
      "Synthetic DOC-02 scan failed evidence",
      `doc02-failed-document-${suffix}`,
      scanFailureEvidence.registration,
    );
    stage = "scan_failed_setup_version_put";
    const failedVersion = await createVersionAndPut({
      baseUrl,
      cookie: cookies.get("founder")!,
      caseId: founderCaseId,
      document: failedDocument,
      bytes: CLEAN_BYTES,
      contentType: "application/pdf",
      localstackEndpoint,
    });
    scanFailureEvidence.version_put_completed = true;
    stage = "scan_failed_setup_scanner";
    const unavailableScanner = new LocalClamavDocumentScanner({
      reader: dependencies.objectReader,
      bucket: BUCKET,
      host: "127.0.0.1",
      port: await reserveLoopbackPort(),
      timeoutMs: 500,
    });
    scanFailureEvidence.scanner_constructed = true;
    const failedDependencies = Object.freeze({ ...dependencies, scanner: unavailableScanner });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const attemptEvidence = scanFailureEvidence.attempts[attempt - 1]!;
      stage = `scan_failed_attempt_${attempt}_receive`;
      const message = await receiveMessage(sqsClient, queueUrl);
      attemptEvidence.receive_completed = true;
      attemptEvidence.receive_count = observedCount(message.Attributes?.ApproximateReceiveCount);
      assert.equal(message.Attributes?.ApproximateReceiveCount, String(attempt));
      stage = `scan_failed_attempt_${attempt}_process`;
      const disposition = await documentMessageDisposition(
        message,
        BUCKET,
        (event) => processDocumentObjectCreated(event, failedDependencies),
      );
      attemptEvidence.disposition = disposition;
      assert.equal(disposition, "retain");
      stage = `scan_failed_attempt_${attempt}_visibility`;
      await makeVisible(sqsClient, queueUrl, message);
      attemptEvidence.visibility_reset = true;
    }
    stage = "scan_failed_main_empty";
    const mainAfterRetries = await receiveMessageOrNull(sqsClient, queueUrl, 3);
    scanFailureEvidence.main_empty = mainAfterRetries === null;
    assert.equal(mainAfterRetries, null);
    stage = "scan_failed_ordinary_dlq_receive";
    const ordinaryDeadLetter = await receiveMessage(sqsClient, deadLetterQueueUrl);
    scanFailureEvidence.ordinary_dlq_received = true;
    stage = "scan_failed_ordinary_dlq_disposition";
    const ordinaryDisposition = await documentDeadLetterMessageDisposition(
      ordinaryDeadLetter,
      BUCKET,
      (event) => processDocumentCleanupFromDeadLetter(event, {
        receiptService: dependencies.receiptService,
        objectCleaner: dependencies.objectCleaner,
      }),
    );
    scanFailureEvidence.ordinary_dlq_disposition = ordinaryDisposition;
    assert.equal(ordinaryDisposition, "retain");
    stage = "scan_failed_authority";
    const failedAuthorityResult = await getJson(
      baseUrl,
      documentPath(founderCaseId, failedDocument.id),
      cookies.get("founder")!,
    );
    scanFailureEvidence.authority.request_completed = true;
    scanFailureEvidence.authority.response_completed = true;
    scanFailureEvidence.authority.http_status = failedAuthorityResult.response.status;
    const failedAuthority = assertDocumentDetail(failedAuthorityResult);
    recordAuthority(scanFailureEvidence.authority, failedAuthority);
    assert.equal(failedAuthority.state, "scan_failed");
    assert.equal(failedAuthority.hasActive, false);
    stage = "scan_failed_download_denial";
    const failedDownload = await postJsonNoKey(
      baseUrl,
      downloadIntentPath(founderCaseId, failedDocument.id),
      cookies.get("founder")!,
      {},
    );
    scanFailureEvidence.download_request_completed = true;
    scanFailureEvidence.download_http_status = failedDownload.response.status;
    assertApiError(failedDownload, 409, "CONFLICT");
    scanFailureEvidence.download_code = "CONFLICT";
    stage = "scan_failed_durable_attempt";
    const durableAttempt = await durableScanAttempt(target, failedVersion.version.id);
    scanFailureEvidence.durable_attempt_count = observedCount(durableAttempt);
    assert.equal(durableAttempt, 3);
    await assertAbandonedCleanupDlq({
      baseUrl,
      cookie: cookies.get("founder")!,
      caseId: founderCaseId,
      suffix,
      localstackEndpoint,
      target,
      sqs: sqsClient,
      s3: s3Client,
      queueUrl,
      deadLetterQueueUrl,
      dependencies,
      ordinaryDeadLetter,
      setStage: (value) => { stage = value; },
      observation: scanFailureEvidence.cleanup,
    });
    scanFailureEvidence.completed = true;

    const recoveryEvidence = {
      receipt_rollback: createRecoveryScenarioObservation(),
      claim_rollback: createRecoveryScenarioObservation(),
      receipt_wins_abandonment: createRecoveryScenarioObservation(),
      cleanup_crash_recovery: createRecoveryScenarioObservation(),
      missed_event_reconciliation: createMissedEventRecoveryObservation(),
      crash_after_claim_recovery: createStuckScanRecoveryObservation(),
    };
    evidence.recovery = recoveryEvidence;
    await assertReceiptRollback(
      pool, target, s3Client, sqsClient, queueUrl, runtime, baseUrl, cookies.get("founder")!, founderCaseId, suffix,
      (value) => { stage = value; }, recoveryEvidence.receipt_rollback,
    );
    await assertClaimRollback(
      pool, target, s3Client, sqsClient, queueUrl, runtime, baseUrl, cookies.get("founder")!, founderCaseId, suffix,
      (value) => { stage = value; }, recoveryEvidence.claim_rollback,
    );
    await assertReceiptWinsAbandonment(
      pool, sqsClient, queueUrl, runtime, baseUrl, cookies.get("founder")!, founderCaseId, suffix,
      (value) => { stage = value; }, recoveryEvidence.receipt_wins_abandonment,
    );
    await assertCleanupCrashRecovery(
      pool, s3Client, sqsClient, queueUrl, runtime, target, baseUrl, cookies.get("founder")!, founderCaseId, suffix,
      (value) => { stage = value; }, recoveryEvidence.cleanup_crash_recovery,
    );
    await assertMissedEventReconciliation(
      pool, target, sqsClient, queueUrl, runtime, baseUrl, cookies.get("founder")!, founderCaseId, suffix,
      (value) => { stage = value; }, recoveryEvidence.missed_event_reconciliation,
    );
    await assertCrashAfterClaimRecovery(
      pool, target, s3Client, sqsClient, queueUrl, runtime, baseUrl, cookies.get("founder")!, founderCaseId, suffix,
      (value) => { stage = value; }, recoveryEvidence.crash_after_claim_recovery,
    );
    const privacyEvidence = {
      private_matches: null as number | null,
      forbidden_key_matches: null as number | null,
      next_log_matches: null as SensitiveLogCounts | null,
      worker_log_matches: null as SensitiveLogCounts | null,
    };
    evidence.privacy = privacyEvidence;
    const sensitiveValues = [...new Set([
      ...PRIVATE_MARKERS,
      BUCKET,
      "application/pdf",
      "image/jpeg",
      "image/png",
      sha256Hex(CLEAN_BYTES),
      sha256Hex(NEWER_BYTES),
      queueUrl,
      deadLetterQueueUrl,
      cleanObjectKey,
      ...cleanProviderVersions,
      cleanIntent.url,
      cleanDownload.url,
      recoveredIntent.url,
      lateObjectKey,
      ...lateProviderVersions,
      newer.objectKey,
      newer.providerVersionId,
      failedVersion.objectKey,
      failedVersion.providerVersionId,
      "X-Amz-Signature",
      ...RUNTIME_PRIVATE_VALUES,
    ])];
    stage = "privacy_db_values";
    const privateMatches = await privateEvidenceMatches(target, sensitiveValues);
    privacyEvidence.private_matches = privateMatches;
    assert.equal(privateMatches, 0);
    stage = "privacy_forbidden_shape";
    const forbiddenKeyMatches = await forbiddenEvidenceShapeMatches(target);
    privacyEvidence.forbidden_key_matches = forbiddenKeyMatches;
    assert.equal(forbiddenKeyMatches, 0);
    const processMarkers: SensitiveLogMarker[] = [
      ...PRIVATE_MARKERS.map((value) => ({ category: "fixture_bytes" as const, value })),
      { category: "object_coordinate", value: BUCKET },
      { category: "content_contract", value: "application/pdf" },
      { category: "content_contract", value: "image/jpeg" },
      { category: "content_contract", value: "image/png" },
      { category: "content_contract", value: sha256Hex(CLEAN_BYTES) },
      { category: "content_contract", value: sha256Hex(NEWER_BYTES) },
      { category: "service_coordinate", value: queueUrl },
      { category: "service_coordinate", value: deadLetterQueueUrl },
      { category: "object_coordinate", value: cleanObjectKey },
      ...cleanProviderVersions.map((value) => ({ category: "object_coordinate" as const, value })),
      { category: "signed_capability", value: cleanIntent.url },
      { category: "signed_capability", value: cleanDownload.url },
      { category: "signed_capability", value: recoveredIntent.url },
      { category: "object_coordinate", value: lateObjectKey },
      ...lateProviderVersions.map((value) => ({ category: "object_coordinate" as const, value })),
      { category: "object_coordinate", value: newer.objectKey },
      { category: "object_coordinate", value: newer.providerVersionId },
      { category: "object_coordinate", value: failedVersion.objectKey },
      { category: "object_coordinate", value: failedVersion.providerVersionId },
      { category: "signed_capability", value: "X-Amz-Signature" },
      { category: "database_endpoint", value: "postgresql://" },
      ...[...RUNTIME_PRIVATE_VALUES].map((value) => ({
        category: "runtime_private" as const,
        value,
      })),
    ];
    stage = "privacy_next_logs";
    const nextLogMatches = sensitiveProcessLogMatches(devServer, processMarkers);
    privacyEvidence.next_log_matches = nextLogMatches;
    assert.equal(nextLogMatches.total, 0);
    stage = "privacy_worker_logs";
    const workerLogMatches = sensitiveProcessLogMatches(workerForLogs, processMarkers);
    privacyEvidence.worker_log_matches = workerLogMatches;
    assert.equal(workerLogMatches.total, 0);

    stage = "complete";
  } catch {
    failureStage = stage;
  } finally {
    sqs?.destroy();
    s3?.destroy();
    await pool?.end().catch(() => undefined);
    cleanup.worker_stopped = await stopProcess(worker);
    cleanup.dev_stopped = await stopProcess(devServer);
    cleanup.app_removed = await removeDirectory(appDirectory);
    cleanup.postgres_removed = !postgresStarted || await removeContainer(postgresName);
    cleanup.localstack_removed = !localstackStarted || await removeContainer(localstackName);
    cleanup.clamav_removed = !clamavStarted || await removeContainer(clamavName);
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
  if (failureStage !== null || !cleanupComplete) throw new HarnessError(failureStage ?? "cleanup");
});

function principal(role: Role) {
  const value = NEON_TEST_PRINCIPALS.find((candidate) => candidate.role === role);
  if (!value) throw new Error("Synthetic principal contract is incomplete.");
  return value;
}

function versionPath(caseId: string, documentId: string): string {
  return `/api/v1/cases/${caseId}/documents/${documentId}/versions`;
}

function documentPath(caseId: string, documentId: string): string {
  return `/api/v1/cases/${caseId}/documents/${documentId}`;
}

function uploadIntentPath(caseId: string, documentId: string, versionId: string): string {
  return `${versionPath(caseId, documentId)}/${versionId}/upload-intents`;
}

function abandonmentPath(caseId: string, documentId: string, versionId: string): string {
  return `${versionPath(caseId, documentId)}/${versionId}/abandonments`;
}

function downloadIntentPath(caseId: string, documentId: string): string {
  return `${documentPath(caseId, documentId)}/download-intents`;
}

function objectKey(documentId: string, versionId: string): string {
  return `documents/${documentId}/versions/${versionId}`;
}

function versionBody(
  bytes: Uint8Array,
  contentType: "application/pdf" | "image/jpeg" | "image/png",
  expectedDocumentRecordVersion: number,
) {
  return Object.freeze({
    checksum_sha256: sha256Hex(bytes),
    size_bytes: bytes.length,
    content_type: contentType,
    expected_document_record_version: expectedDocumentRecordVersion,
  });
}

async function createCase(
  baseUrl: string,
  cookie: string,
  studentId: string,
  bindingId: string,
  intakeYear: number,
  idempotencyKey: string,
  observation: CaseFixtureObservation,
  setStage: (stage: string) => void,
  stagePrefix: "case_fixture_first" | "case_fixture_second",
): Promise<string> {
  observation.request_started = true;
  const response = await fetch(`${baseUrl}/api/v1/cases`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      student_id: studentId,
      intake_year: intakeYear,
      admission_type: "transfer",
      primary_role_binding_id: bindingId,
      manifest_id: NEON_TEST_MANIFEST_ID,
    }),
    credentials: "omit",
    redirect: "error",
  });
  observation.response_received = true;
  setStage(`${stagePrefix}_status`);
  observation.http_status = response.status;
  assert.equal(response.status, 200);
  setStage(`${stagePrefix}_json`);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
    observation.json_parseable = true;
  } catch {
    throw new HarnessError("http_json");
  }
  setStage(`${stagePrefix}_envelope`);
  if (!isRecord(body)) throw new HarnessError("http_shape");
  const result: HttpResult = Object.freeze({ response, body, text });
  const data = requiredData(result);
  assert.deepEqual(Object.keys(data).sort(), ["id", "record_version"]);
  const id = requiredUuid(data.id);
  assert.equal(data.record_version, 2);
  const authority = await getJson(baseUrl, `/api/v1/cases/${id}`, cookie);
  assert.equal(authority.response.status, 200);
  const created = requiredRecord(requiredData(authority).case);
  assert.equal(created.id, id);
  assert.equal(created.studentId, studentId);
  assert.equal(created.stage, "background_collection");
  assert.equal(created.workflowStatus, "active");
  assert.equal(created.recordVersion, 2);
  observation.exact_case_envelope = true;
  return id;
}

async function registerDocument(
  baseUrl: string,
  cookie: string,
  caseId: string,
  displayName: string,
  idempotencyKey: string,
): Promise<Readonly<{ id: string; recordVersion: number }>> {
  const result = await postJson(
    baseUrl,
    `/api/v1/cases/${caseId}/documents`,
    cookie,
    idempotencyKey,
    { display_name: displayName, classification: "identity_and_case_evidence" },
  );
  return assertVersionReceipt(result, 201, 1);
}

async function registerDocumentObserved(
  baseUrl: string,
  cookie: string,
  caseId: string,
  displayName: string,
  idempotencyKey: string,
  observation: ReceiptObservation,
): Promise<VersionReceipt> {
  const result = await postJson(
    baseUrl,
    `/api/v1/cases/${caseId}/documents`,
    cookie,
    idempotencyKey,
    { display_name: displayName, classification: "identity_and_case_evidence" },
  );
  observation.request_completed = true;
  observation.response_completed = true;
  observation.http_status = result.response.status;
  const receipt = assertVersionReceipt(result, 201, 1);
  observation.exact_dto = true;
  observation.record_version = receipt.recordVersion;
  return receipt;
}

function createCaseFixtureObservation(): CaseFixtureObservation {
  return {
    request_started: false,
    response_received: false,
    http_status: null,
    json_parseable: false,
    exact_case_envelope: false,
  };
}

function createReceiptObservation(): ReceiptObservation {
  return {
    request_completed: false,
    response_completed: false,
    http_status: null,
    exact_dto: false,
    record_version: null,
  };
}

function createIntentObservation(): IntentObservation {
  return {
    request_completed: false,
    response_completed: false,
    http_status: null,
    exact_dto: false,
  };
}

function createTransferObservation(): TransferObservation {
  return {
    request_completed: false,
    response_completed: false,
    http_status: null,
    provider_version_present: false,
  };
}

function createObjectReadObservation(): ObjectReadObservation {
  return {
    request_completed: false,
    response_completed: false,
    http_status: null,
  };
}

function createAuthorityObservation(): AuthorityObservation {
  return {
    request_completed: false,
    response_completed: false,
    http_status: null,
    exact_dto: false,
    state: null,
    has_active: null,
  };
}

function createScanScenarioObservation(): ScanScenarioObservation {
  return {
    version: createReceiptObservation(),
    upload_intent: createIntentObservation(),
    put: createTransferObservation(),
    message_received: false,
    process_result: null,
    process_error: null,
    disposition: null,
    delete_completed: false,
    authority: createAuthorityObservation(),
  };
}

function createRecoveryScenarioObservation(): RecoveryScenarioObservation {
  return {
    registration: createReceiptObservation(),
    version_put_completed: false,
    head_completed: false,
    message_received: false,
    receipt_status: null,
    claim_status: null,
    injected_disposition: null,
    rollback_db_exact: false,
    version_state: null,
    scan_state: null,
    bound_count: null,
    scan_count: null,
    attempt_count: null,
    audit_count: null,
    outbox_count: null,
    conflict_http_status: null,
    conflict_exact: false,
    object_absent: null,
    redelivery_received: false,
    redelivery_count: null,
    recovered_disposition: null,
    overlap_disposition: null,
    delete_completed: false,
    authority: createAuthorityObservation(),
    reconcile_exact: false,
    reconcile_inspected: null,
    reconcile_requeued: null,
    reconcile_dead_lettered: null,
    reconcile_ignored: null,
    effect_audit_count: null,
    effect_outbox_count: null,
    scan_results_count: null,
    scan_claim_audit_count: null,
    scan_claim_outbox_count: null,
    scan_clean_audit_count: null,
    scan_clean_outbox_count: null,
    completed: false,
  };
}

function createMissedEventRecoveryObservation(): MissedEventRecoveryObservation {
  return {
    ...createRecoveryScenarioObservation(),
    publish_started: false,
    publish_completed: false,
    reconcile_call_completed: false,
  };
}

function createStuckScanRecoveryObservation(): StuckScanRecoveryObservation {
  return {
    ...createRecoveryScenarioObservation(),
    readiness_candidate_count: null,
    readiness_exact_target: false,
    readiness_kind_stuck_scan: false,
    reconcile_call_completed: false,
  };
}

function createQueueAttemptObservation(): QueueAttemptObservation {
  return {
    receive_completed: false,
    receive_count: null,
    disposition: null,
    visibility_reset: false,
  };
}

function createAbandonedCleanupDlqObservation(): AbandonedCleanupDlqObservation {
  return {
    registration: createReceiptObservation(),
    version_put_completed: false,
    abandonment_http_status: null,
    abandonment_exact: false,
    attempts: [
      createQueueAttemptObservation(),
      createQueueAttemptObservation(),
      createQueueAttemptObservation(),
    ],
    main_empty: false,
    cleanup_dlq_received: false,
    cleanup_dlq_disposition: null,
    cleanup_dlq_deleted: false,
    object_absent: null,
    audit_count: null,
    outbox_count: null,
    ordinary_restored: false,
    ordinary_received: false,
    ordinary_same_message: false,
    ordinary_disposition: null,
    completed: false,
  };
}

function createScanFailureObservation(): ScanFailureObservation {
  return {
    registration: createReceiptObservation(),
    version_put_completed: false,
    scanner_constructed: false,
    attempts: [
      createQueueAttemptObservation(),
      createQueueAttemptObservation(),
      createQueueAttemptObservation(),
    ],
    main_empty: false,
    ordinary_dlq_received: false,
    ordinary_dlq_disposition: null,
    authority: createAuthorityObservation(),
    download_request_completed: false,
    download_http_status: null,
    download_code: null,
    durable_attempt_count: null,
    cleanup: createAbandonedCleanupDlqObservation(),
    completed: false,
  };
}

function createPendingRecoveryObservation(): PendingRecoveryObservation {
  return {
    registration: createReceiptObservation(),
    version: createReceiptObservation(),
    authority: createAuthorityObservation(),
    pending_exact: false,
    upload_intent: createIntentObservation(),
    checksum_contract: false,
    stale_abandonment: {
      request_completed: false,
      response_completed: false,
      http_status: null,
      exact_dto: false,
      code: null,
      private_echo: null,
    },
    post_stale_authority: createAuthorityObservation(),
    post_stale_pending_unchanged: false,
    completed: false,
  };
}

function recordAuthority(
  observation: AuthorityObservation,
  authority: DocumentAuthority,
): void {
  observation.exact_dto = true;
  observation.state = authority.state as AuthorityObservation["state"];
  observation.has_active = authority.hasActive;
}

function observedVersionState(value: unknown): RecoveryScenarioObservation["version_state"] {
  return (DOCUMENT_VERSION_STATES as readonly unknown[]).includes(value)
    ? value as RecoveryScenarioObservation["version_state"]
    : null;
}

function observedScanState(value: unknown): RecoveryScenarioObservation["scan_state"] {
  return ["queued", "running", "clean", "rejected", "failed"].includes(String(value))
    ? value as RecoveryScenarioObservation["scan_state"]
    : null;
}

function observedCount(value: unknown): number | null {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function replayErrorCategory(error: unknown):
  | "RETRYABLE"
  | "DEAD_LETTER"
  | "OBJECT_STORE"
  | "RECEIPT"
  | "OTHER" {
  if (error instanceof DocumentScanRetryableWorkerError) return "RETRYABLE";
  if (error instanceof DocumentScanDeadLetterWorkerError) return "DEAD_LETTER";
  if (error instanceof LocalDocumentObjectStoreUnavailable) return "OBJECT_STORE";
  if (isDocumentObjectReceiptError(error)) return "RECEIPT";
  return "OTHER";
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new HarnessError("login_cookie");
  assert.match(cookie, /; HttpOnly/iu);
  assert.match(cookie, /; SameSite=Lax/iu);
  assert.doesNotMatch(cookie, /; Secure/iu);
  return cookie.split(";", 1)[0]!;
}

async function getJson(baseUrl: string, path: string, cookie: string): Promise<HttpResult> {
  return readHttp(await fetch(`${baseUrl}${path}`, {
    headers: cookie ? { cookie } : {},
    credentials: "omit",
    redirect: "error",
  }));
}

async function postJson(
  baseUrl: string,
  path: string,
  cookie: string,
  idempotencyKey: string,
  body: unknown,
): Promise<HttpResult> {
  return readHttp(await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
    credentials: "omit",
    redirect: "error",
  }));
}

async function postJsonNoKey(
  baseUrl: string,
  path: string,
  cookie: string,
  body: unknown,
): Promise<HttpResult> {
  return readHttp(await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    redirect: "error",
  }));
}

async function rawPost(
  baseUrl: string,
  path: string,
  cookie: string,
  idempotencyKey: string,
  body: string,
): Promise<HttpResult> {
  return readHttp(await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body,
    credentials: "omit",
    redirect: "error",
  }));
}

async function readHttp(response: Response): Promise<HttpResult> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new HarnessError("http_json");
  }
  if (!isRecord(body)) throw new HarnessError("http_shape");
  return Object.freeze({ response, body, text });
}

function requiredData(result: HttpResult): Record<string, unknown> {
  assert.deepEqual(Object.keys(result.body).sort(), ["api_version", "data", "request_id"]);
  assert.equal(result.body.api_version, "v1");
  const requestId = requiredString(result.body.request_id);
  assert.match(requestId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("x-request-id"), requestId);
  return requiredRecord(result.body.data);
}

function assertVersionReceipt(
  result: HttpResult,
  expectedStatus: number,
  expectedRecordVersion: number,
): VersionReceipt {
  assert.equal(result.response.status, expectedStatus);
  const data = requiredData(result);
  assert.deepEqual(Object.keys(data).sort(), ["id", "record_version"]);
  const id = requiredUuid(data.id);
  assert.equal(data.record_version, expectedRecordVersion);
  return Object.freeze({ id, recordVersion: expectedRecordVersion });
}

function assertDocumentDetail(result: HttpResult): DocumentAuthority {
  assert.equal(result.response.status, 200);
  const data = requiredData(result);
  assert.deepEqual(Object.keys(data), ["document"]);
  const item = requiredRecord(data.document);
  assert.deepEqual(Object.keys(item).sort(), [
    "case_id", "case_number", "classification", "display_name", "has_active_version",
    "id", "latest_version_state", "lifecycle_state", "pending_upload", "record_version",
    "updated_at",
  ].sort());
  const pendingValue = item.pending_upload;
  let pending: VersionReceipt | null = null;
  if (pendingValue !== null) {
    const record = requiredRecord(pendingValue);
    assert.deepEqual(Object.keys(record).sort(), ["id", "record_version"]);
    pending = Object.freeze({
      id: requiredUuid(record.id),
      recordVersion: requiredPositiveInteger(record.record_version),
    });
  }
  const id = requiredUuid(item.id);
  const caseId = requiredUuid(item.case_id);
  requiredBoundedText(item.case_number, 100);
  requiredBoundedText(item.display_name, 200);
  assert.equal(
    (CASE_DOCUMENT_CLASSIFICATIONS as readonly unknown[]).includes(item.classification),
    true,
  );
  assert.equal(
    (VISIBLE_DOCUMENT_LIFECYCLE_STATES as readonly unknown[]).includes(item.lifecycle_state),
    true,
  );
  const state = item.latest_version_state;
  assert.equal(
    state === null || (DOCUMENT_VERSION_STATES as readonly unknown[]).includes(state),
    true,
  );
  assert.equal((state === "pending_upload") === (pending !== null), true);
  assert.equal(typeof item.has_active_version, "boolean");
  if (state === null) assert.equal(item.has_active_version, false);
  requiredIsoTimestamp(item.updated_at);
  return Object.freeze({
    id,
    caseId,
    state: state as string | null,
    pending,
    hasActive: item.has_active_version as boolean,
    recordVersion: requiredPositiveInteger(item.record_version),
  });
}

function assertApiError(result: HttpResult, status: number, code: string): void {
  assert.equal(result.response.status, status);
  assert.deepEqual(Object.keys(result.body).sort(), ["api_version", "error"]);
  assert.equal(result.body.api_version, "v1");
  const error = requiredRecord(result.body.error);
  assert.deepEqual(Object.keys(error).sort(), ["code", "details", "message", "request_id", "retryable"]);
  assert.equal(error.code, code);
  const contract = API_ERROR_CONTRACT[code as keyof typeof API_ERROR_CONTRACT];
  if (!contract) throw new HarnessError("http_error_contract");
  assert.equal(error.message, contract.message);
  assert.equal(error.retryable, contract.retryable);
  assert.deepEqual(error.details, {});
  const requestId = requiredString(error.request_id);
  assert.match(requestId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("x-request-id"), requestId);
  for (const privateValue of [...PRIVATE_MARKERS, EICAR_MARKER, "X-Amz-Signature"]) {
    assert.equal(result.text.includes(privateValue), false);
  }
}

function assertUploadIntent(
  result: HttpResult,
  expectedOrigin: string,
  expectedObjectKey: string,
  contentType: UploadIntent["contentType"],
  bytes: Uint8Array,
): UploadIntent {
  assert.equal(result.response.status, 200);
  const data = requiredData(result);
  assert.deepEqual(Object.keys(data).sort(), ["expires_at_ms", "headers", "method", "url"]);
  assert.equal(data.method, "PUT");
  const expiresAtMs = requiredPositiveInteger(data.expires_at_ms);
  const now = Date.now();
  assert.ok(expiresAtMs > now);
  assert.ok(expiresAtMs <= now + 600_000);
  const headers = requiredRecord(data.headers);
  assert.deepEqual(Object.keys(headers).sort(), ["content-type", "x-amz-checksum-sha256"]);
  const checksumBase64 = createHash("sha256").update(bytes).digest("base64");
  assert.equal(headers["content-type"], contentType);
  assert.equal(headers["x-amz-checksum-sha256"], checksumBase64);
  RUNTIME_PRIVATE_VALUES.add(checksumBase64);
  RUNTIME_PRIVATE_VALUES.add(sha256Hex(bytes));
  const url = assertSignedUrl(
    data.url,
    expectedOrigin,
    expectedObjectKey,
    "PUT",
    600,
    expiresAtMs,
  );
  return Object.freeze({ method: "PUT", expiresAtMs, url, contentType, checksumBase64 });
}

function assertDownloadIntent(
  result: HttpResult,
  expectedOrigin: string,
  expectedObjectKey: string,
  expectedProviderVersionId: string,
): DownloadIntent {
  assert.equal(result.response.status, 200);
  const data = requiredData(result);
  assert.deepEqual(Object.keys(data).sort(), ["download_name", "expires_at_ms", "method", "url"]);
  assert.equal(data.method, "GET");
  assert.equal(data.download_name, "document.pdf");
  const expiresAtMs = requiredPositiveInteger(data.expires_at_ms);
  const now = Date.now();
  assert.ok(expiresAtMs > now);
  assert.ok(expiresAtMs <= now + 300_000);
  const url = assertSignedUrl(
    data.url,
    expectedOrigin,
    expectedObjectKey,
    "GET",
    300,
    expiresAtMs,
    expectedProviderVersionId,
  );
  return Object.freeze({ method: "GET", expiresAtMs, url, downloadName: "document.pdf" });
}

function assertSignedUrl(
  value: unknown,
  expectedOrigin: string,
  expectedObjectKey: string,
  method: "GET" | "PUT",
  expectedExpires: number,
  expiresAtMs: number,
  expectedProviderVersionId?: string,
): string {
  const url = new URL(requiredString(value));
  const origin = new URL(expectedOrigin);
  assert.equal(origin.protocol, "http:");
  assert.equal(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname.toLowerCase()), true);
  assert.equal(url.origin, origin.origin);
  assert.equal(url.protocol, "http:");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.hash, "");
  assert.equal(
    url.pathname,
    `/${encodeURIComponent(BUCKET)}/${expectedObjectKey.split("/").map(encodeURIComponent).join("/")}`,
  );
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    assert.equal(seen.has(key), false);
    seen.add(key);
  }
  const baseQueryKeys = [
    "X-Amz-Algorithm",
    "X-Amz-Content-Sha256",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-Signature",
    "X-Amz-SignedHeaders",
    "x-id",
  ];
  const expectedQueryKeys = method === "PUT"
    ? baseQueryKeys
    : [...baseQueryKeys, "versionId", "x-amz-checksum-mode"];
  assert.deepEqual([...seen].sort(), expectedQueryKeys.sort());
  assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(url.searchParams.get("X-Amz-Content-Sha256"), "UNSIGNED-PAYLOAD");
  assert.match(url.searchParams.get("X-Amz-Credential") ?? "", /^[^\s/]+\/\d{8}\/ap-east-1\/s3\/aws4_request$/u);
  const signedAtMs = parseAmzDate(url.searchParams.get("X-Amz-Date"));
  assert.ok(Math.abs(Date.now() - signedAtMs) <= 5_000);
  assert.equal(url.searchParams.get("X-Amz-Expires"), String(expectedExpires));
  assert.ok(Math.abs(expiresAtMs - (signedAtMs + expectedExpires * 1_000)) <= 5_000);
  assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[a-f0-9]{64}$/u);
  if (method === "PUT") {
    assert.equal(
      url.searchParams.get("X-Amz-SignedHeaders"),
      "content-type;host;x-amz-checksum-sha256",
    );
    assert.equal(url.searchParams.get("x-id"), "PutObject");
    assert.equal(url.searchParams.has("x-amz-checksum-sha256"), false);
    assert.equal(url.searchParams.has("X-Amz-Checksum-Sha256"), false);
  } else {
    assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
    assert.equal(url.searchParams.get("x-id"), "GetObject");
    assert.equal(url.searchParams.get("x-amz-checksum-mode"), "ENABLED");
    assert.equal(url.searchParams.get("versionId"), expectedProviderVersionId);
  }
  const signedUrl = url.toString();
  RUNTIME_PRIVATE_VALUES.add(BUCKET);
  RUNTIME_PRIVATE_VALUES.add(expectedObjectKey);
  RUNTIME_PRIVATE_VALUES.add(signedUrl);
  if (expectedProviderVersionId) RUNTIME_PRIVATE_VALUES.add(expectedProviderVersionId);
  return signedUrl;
}

async function putObject(
  intent: UploadIntent,
  bytes: Uint8Array,
  observation?: TransferObservation,
): Promise<Readonly<{ status: number; providerVersionId: string | null }>> {
  const response = await fetch(intent.url, {
    method: "PUT",
    headers: {
      "content-type": intent.contentType,
      "x-amz-checksum-sha256": intent.checksumBase64,
    },
    body: Uint8Array.from(bytes),
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  if (observation) {
    observation.request_completed = true;
    observation.response_completed = true;
    observation.http_status = response.status;
  }
  assert.ok(response.status >= 200 && response.status < 300);
  const value = response.headers.get("x-amz-version-id");
  const providerVersionId = value !== null && /^\S{1,1024}$/u.test(value) ? value : null;
  if (observation) observation.provider_version_present = providerVersionId !== null;
  assert.notEqual(providerVersionId, null);
  RUNTIME_PRIVATE_VALUES.add(providerVersionId!);
  return Object.freeze({ status: response.status, providerVersionId });
}

async function downloadObject(
  intent: DownloadIntent,
  observation?: ObjectReadObservation,
): Promise<Buffer> {
  const response = await fetch(intent.url, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  if (observation) {
    observation.request_completed = true;
    observation.response_completed = true;
    observation.http_status = response.status;
  }
  assert.equal(response.status, 200);
  assert.equal(response.url, intent.url);
  return Buffer.from(await response.arrayBuffer());
}

async function createVersionAndPut(input: {
  readonly baseUrl: string;
  readonly cookie: string;
  readonly caseId: string;
  readonly document: Readonly<{ id: string; recordVersion: number }>;
  readonly bytes: Uint8Array;
  readonly contentType: UploadIntent["contentType"];
  readonly localstackEndpoint: string;
}): Promise<Readonly<{
  version: VersionReceipt;
  providerVersionId: string;
  objectKey: string;
}>> {
  const version = assertVersionReceipt(await postJson(
    input.baseUrl,
    versionPath(input.caseId, input.document.id),
    input.cookie,
    `doc02-version-${randomUUID()}`,
    versionBody(input.bytes, input.contentType, input.document.recordVersion),
  ), 201, 1);
  const key = objectKey(input.document.id, version.id);
  const intent = assertUploadIntent(await postJsonNoKey(
    input.baseUrl,
    uploadIntentPath(input.caseId, input.document.id, version.id),
    input.cookie,
    { expected_record_version: 1 },
  ), input.localstackEndpoint, key, input.contentType, input.bytes);
  const uploaded = await putObject(intent, input.bytes);
  return Object.freeze({ version, providerVersionId: uploaded.providerVersionId!, objectKey: key });
}

async function createUploadAndProcessObserved(input: {
  readonly label: "jpeg" | "png" | "mime_mismatch" | "eicar";
  readonly setStage: (value: string) => void;
  readonly evidence: ScanScenarioObservation;
  readonly baseUrl: string;
  readonly cookie: string;
  readonly caseId: string;
  readonly document: Readonly<{ id: string; recordVersion: number }>;
  readonly bytes: Uint8Array;
  readonly contentType: UploadIntent["contentType"];
  readonly localstackEndpoint: string;
  readonly sqs: SQSClient;
  readonly queueUrl: string;
  readonly dependencies: ScanDependencies;
  readonly expectedState: "available" | "rejected";
  readonly expectedHasActive: boolean;
}) {
  input.setStage(`${input.label}_version`);
  const versionResult = await postJson(
    input.baseUrl,
    versionPath(input.caseId, input.document.id),
    input.cookie,
    `doc02-version-${randomUUID()}`,
    versionBody(input.bytes, input.contentType, input.document.recordVersion),
  );
  input.evidence.version.request_completed = true;
  input.evidence.version.response_completed = true;
  input.evidence.version.http_status = versionResult.response.status;
  const version = assertVersionReceipt(versionResult, 201, 1);
  input.evidence.version.exact_dto = true;
  input.evidence.version.record_version = version.recordVersion;

  const key = objectKey(input.document.id, version.id);
  input.setStage(`${input.label}_upload_intent`);
  const intentResult = await postJsonNoKey(
    input.baseUrl,
    uploadIntentPath(input.caseId, input.document.id, version.id),
    input.cookie,
    { expected_record_version: 1 },
  );
  input.evidence.upload_intent.request_completed = true;
  input.evidence.upload_intent.response_completed = true;
  input.evidence.upload_intent.http_status = intentResult.response.status;
  const intent = assertUploadIntent(
    intentResult,
    input.localstackEndpoint,
    key,
    input.contentType,
    input.bytes,
  );
  input.evidence.upload_intent.exact_dto = true;

  input.setStage(`${input.label}_put`);
  const uploaded = await putObject(intent, input.bytes, input.evidence.put);

  input.setStage(`${input.label}_message`);
  const message = await receiveMessage(input.sqs, input.queueUrl);
  input.evidence.message_received = true;

  input.setStage(`${input.label}_process`);
  const disposition = await documentMessageDisposition(
    message,
    BUCKET,
    async (event) => {
      try {
        const result = await processDocumentObjectCreated(event, input.dependencies);
        input.evidence.process_result = result.status;
        return result;
      } catch (error) {
        input.evidence.process_error = classifyProcessError(error);
        throw error;
      }
    },
  );
  input.evidence.disposition = disposition;
  assert.equal(disposition, "delete");

  input.setStage(`${input.label}_delete`);
  await deleteMessage(input.sqs, input.queueUrl, message);
  input.evidence.delete_completed = true;

  input.setStage(`${input.label}_authority`);
  const authority = await waitForDocumentState(
    input.baseUrl,
    input.cookie,
    input.caseId,
    input.document.id,
    input.expectedState,
    input.expectedHasActive,
    (result, observedAuthority) => {
      input.evidence.authority.request_completed = true;
      input.evidence.authority.response_completed = true;
      input.evidence.authority.http_status = result.response.status;
      if (observedAuthority) recordAuthority(input.evidence.authority, observedAuthority);
    },
  );
  return Object.freeze({
    version,
    providerVersionId: uploaded.providerVersionId!,
    objectKey: key,
    authority,
  });
}

function classifyProcessError(error: unknown): Exclude<ObservedProcessError, null> {
  if (error instanceof DocumentScanRetryableWorkerError) return "RETRYABLE";
  if (error instanceof DocumentScanDeadLetterWorkerError) return "DEAD_LETTER";
  return "OTHER";
}

async function createUploadAndProcess(input: {
  readonly baseUrl: string;
  readonly cookie: string;
  readonly caseId: string;
  readonly document: Readonly<{ id: string; recordVersion: number }>;
  readonly bytes: Uint8Array;
  readonly contentType: UploadIntent["contentType"];
  readonly localstackEndpoint: string;
  readonly sqs: SQSClient;
  readonly queueUrl: string;
  readonly dependencies: ScanDependencies;
  readonly expectedState: "available" | "rejected";
  readonly expectedHasActive: boolean;
}) {
  const created = await createVersionAndPut(input);
  const message = await receiveMessage(input.sqs, input.queueUrl);
  assert.equal(await documentMessageDisposition(
    message,
    BUCKET,
    (event) => processDocumentObjectCreated(event, input.dependencies),
  ), "delete");
  await deleteMessage(input.sqs, input.queueUrl, message);
  const authority = await waitForDocumentState(
    input.baseUrl,
    input.cookie,
    input.caseId,
    input.document.id,
    input.expectedState,
    input.expectedHasActive,
  );
  return Object.freeze({ ...created, authority });
}

async function waitForDocumentState(
  baseUrl: string,
  cookie: string,
  caseId: string,
  documentId: string,
  expectedState: string,
  expectedHasActive: boolean,
  observe?: (result: HttpResult, authority: DocumentAuthority | null) => void,
): Promise<DocumentAuthority> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await getJson(baseUrl, documentPath(caseId, documentId), cookie);
    observe?.(result, null);
    if (result.response.status === 200) {
      const authority = assertDocumentDetail(result);
      observe?.(result, authority);
      if (authority.state === expectedState && authority.hasActive === expectedHasActive) return authority;
    }
    await delay(250);
  }
  throw new HarnessError("document_authority");
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HarnessError("http_shape");
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new HarnessError("http_shape");
  return value;
}

function requiredBoundedText(value: unknown, maximumLength: number): string {
  const stringValue = requiredString(value);
  if (stringValue !== stringValue.trim() || stringValue.length < 1 || stringValue.length > maximumLength) {
    throw new HarnessError("http_shape");
  }
  return stringValue;
}

function requiredIsoTimestamp(value: unknown): string {
  const stringValue = requiredString(value);
  const parsed = Date.parse(stringValue);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== stringValue) {
    throw new HarnessError("http_shape");
  }
  return stringValue;
}

function parseAmzDate(value: string | null): number {
  if (value === null) throw new HarnessError("signed_url_contract");
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(value);
  if (!match) throw new HarnessError("signed_url_contract");
  const parsed = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  if (!Number.isFinite(parsed)) throw new HarnessError("signed_url_contract");
  return parsed;
}

function requiredUuid(value: unknown): string {
  const stringValue = requiredString(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(stringValue)) {
    throw new HarnessError("http_shape");
  }
  return stringValue;
}

function requiredPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new HarnessError("http_shape");
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function createScanDependencies(pool: Pool, runtime: RuntimeEnvironment): ScanDependencies {
  const runner = createTenantTransactionRunner(pool as unknown as DatabasePool, {
    expectedLoginUser: ONE_ROLE_CANONICAL_ROLE,
  });
  const objectStore = new LocalSyntheticDocumentObjectStore({
    endpoint: runtime.localstackEndpoint,
    bucket: BUCKET,
    requestTimeoutMs: 2_000,
  });
  const repository = new PostgresqlDocumentScanRepository(runner, {
    organizationId: ORGANIZATION_ID,
    workerContextId: WORKER_CONTEXT_ID,
  });
  return Object.freeze({
    objectReader: objectStore,
    objectCleaner: objectStore,
    receiptService: new DocumentObjectReceiptService({ repository, organizationId: ORGANIZATION_ID }),
    service: new DocumentScanService({
      repository,
      requeuePublisher: new LocalSyntheticDocumentScanRequeuePublisher({
        endpoint: runtime.localstackEndpoint,
        region: REGION,
        queue: QUEUE,
        bucket: BUCKET,
        requestTimeoutMs: 2_000,
      }),
    }),
    scanner: new LocalClamavDocumentScanner({
      reader: objectStore,
      bucket: BUCKET,
      host: "127.0.0.1",
      port: runtime.clamavPort,
    }),
  });
}

function createHookedScanDependencies(
  pool: Pool,
  runtime: RuntimeEnvironment,
  failBeforeCommit: (operation: string) => void,
): ScanDependencies {
  const runner = createTenantTransactionRunner(pool as unknown as DatabasePool, {
    expectedLoginUser: ONE_ROLE_CANONICAL_ROLE,
  });
  const objectStore = new LocalSyntheticDocumentObjectStore({
    endpoint: runtime.localstackEndpoint,
    bucket: BUCKET,
    requestTimeoutMs: 2_000,
  });
  const repository = new PostgresqlDocumentScanRepository(runner, {
    organizationId: ORGANIZATION_ID,
    workerContextId: WORKER_CONTEXT_ID,
    hooks: { failBeforeCommit },
  });
  return Object.freeze({
    objectReader: objectStore,
    objectCleaner: objectStore,
    receiptService: new DocumentObjectReceiptService({ repository, organizationId: ORGANIZATION_ID }),
    service: new DocumentScanService({ repository }),
    scanner: new LocalClamavDocumentScanner({
      reader: objectStore,
      bucket: BUCKET,
      host: "127.0.0.1",
      port: runtime.clamavPort,
    }),
  });
}

function localSqsClient(endpoint: string): SQSClient {
  return new SQSClient({
    region: REGION,
    endpoint,
    useQueueUrlAsEndpoint: false,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

function localS3Client(endpoint: string): S3Client {
  return new S3Client({
    region: REGION,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

async function receiveMessage(client: SQSClient, queueUrl: string): Promise<Message> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      MaxNumberOfMessages: 1,
      VisibilityTimeout: 180,
      WaitTimeSeconds: 1,
    }));
    const message = result.Messages?.[0];
    if (message) {
      assert.equal(typeof message.MessageId, "string");
      assert.equal(typeof message.ReceiptHandle, "string");
      return message;
    }
  }
  throw new HarnessError("sqs_receive");
}

async function receiveMessageOrNull(
  client: SQSClient,
  queueUrl: string,
  attempts = 5,
): Promise<Message | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      MaxNumberOfMessages: 1,
      VisibilityTimeout: 180,
      WaitTimeSeconds: 1,
    }));
    if (result.Messages?.[0]) return result.Messages[0];
  }
  return null;
}

async function deleteMessage(client: SQSClient, queueUrl: string, message: Message): Promise<void> {
  const receiptHandle = requiredString(message.ReceiptHandle);
  await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}

async function makeVisible(client: SQSClient, queueUrl: string, message: Message): Promise<void> {
  const receiptHandle = requiredString(message.ReceiptHandle);
  await client.send(new ChangeMessageVisibilityCommand({
    QueueUrl: queueUrl,
    ReceiptHandle: receiptHandle,
    VisibilityTimeout: 0,
  }));
}

async function exactObjectVersionsPresent(
  client: S3Client,
  key: string,
  expectedVersionIds: readonly string[],
): Promise<boolean> {
  const result = await client.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }));
  const versions = (result.Versions ?? []).filter((item) => item.Key === key)
    .flatMap((item) => typeof item.VersionId === "string" ? [item.VersionId] : []);
  const markers = (result.DeleteMarkers ?? []).filter((item) => item.Key === key);
  return versions.length === expectedVersionIds.length && markers.length === 0 &&
    expectedVersionIds.every((versionId) => versions.includes(versionId));
}

async function objectVersionInventory(
  client: S3Client,
  key: string,
): Promise<Readonly<{ providerVersionCount: number; deleteMarkerCount: number }>> {
  const result = await client.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }));
  return Object.freeze({
    providerVersionCount: (result.Versions ?? []).filter((item) => item.Key === key).length,
    deleteMarkerCount: (result.DeleteMarkers ?? []).filter((item) => item.Key === key).length,
  });
}

async function exactObjectVersionsAbsent(
  client: S3Client,
  key: string,
  expectedVersionIds: readonly string[],
): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await client.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }));
    const versions = (result.Versions ?? []).filter((item) => item.Key === key)
      .flatMap((item) => typeof item.VersionId === "string" ? [item.VersionId] : []);
    const markers = (result.DeleteMarkers ?? []).filter((item) => item.Key === key);
    if (markers.length === 0 && expectedVersionIds.every((versionId) => !versions.includes(versionId))) {
      return true;
    }
    await delay(100);
  }
  return false;
}

async function currentActiveVersion(
  target: OneRoleBaselineTarget,
  documentId: string,
): Promise<string | null> {
  return tenantRead(target, async (client) => {
    const result = await client.query<{ active_document_version_id: string | null }>(
      `SELECT active_document_version_id FROM documents_documents
       WHERE organization_id=$1 AND id=$2`,
      [ORGANIZATION_ID, documentId],
    );
    assert.equal(result.rowCount, 1);
    return result.rows[0]?.active_document_version_id ?? null;
  });
}

async function durableScanAttempt(
  target: OneRoleBaselineTarget,
  documentVersionId: string,
): Promise<number> {
  return tenantRead(target, async (client) => {
    const result = await client.query<{ attempt_count: number; state: string }>(
      `SELECT attempt_count,state FROM documents_scan_results
       WHERE organization_id=$1 AND document_version_id=$2`,
      [ORGANIZATION_ID, documentVersionId],
    );
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0]?.state, "failed");
    return Number(result.rows[0]?.attempt_count);
  });
}

async function scanFactCounts(
  target: OneRoleBaselineTarget,
  documentVersionId: string,
) {
  return tenantRead(target, async (client) => {
    const result = await client.query<{
      scan_results: number;
      scan_claim_audit: number;
      scan_claim_outbox: number;
      scan_clean_audit: number;
      scan_clean_outbox: number;
    }>(`SELECT
      (SELECT count(*)::int FROM documents_scan_results
        WHERE organization_id=$1 AND document_version_id=$2) AS scan_results,
      (SELECT count(*)::int FROM audit_events
        WHERE organization_id=$1 AND resource_id=$2
          AND event_type='documents.scan_claimed') AS scan_claim_audit,
      (SELECT count(*)::int FROM audit_outbox
        WHERE organization_id=$1 AND aggregate_id=$2
          AND event_type='documents.scan_claimed') AS scan_claim_outbox,
      (SELECT count(*)::int FROM audit_events
        WHERE organization_id=$1 AND resource_id=$2
          AND event_type='documents.scan_clean') AS scan_clean_audit,
      (SELECT count(*)::int FROM audit_outbox
        WHERE organization_id=$1 AND aggregate_id=$2
          AND event_type='documents.scan_clean') AS scan_clean_outbox`, [
      ORGANIZATION_ID,
      documentVersionId,
    ]);
    const row = result.rows[0];
    if (!row) throw new HarnessError("scan_fact_counts");
    return Object.freeze({
      scan_results: Number(row.scan_results),
      scan_claim_audit: Number(row.scan_claim_audit),
      scan_claim_outbox: Number(row.scan_claim_outbox),
      scan_clean_audit: Number(row.scan_clean_audit),
      scan_clean_outbox: Number(row.scan_clean_outbox),
    });
  });
}

async function unboundProviderCleanupCounts(
  target: OneRoleBaselineTarget,
  documentVersionId: string,
) {
  return tenantRead(target, async (client) => {
    const result = await client.query<{
      bound_provider_version: string;
      version_state: string;
      scan_results: number;
      cleanup_audit: number;
      cleanup_outbox: number;
    }>(`SELECT
      version.object_version_id AS bound_provider_version,
      version.state AS version_state,
      (SELECT count(*)::int FROM documents_scan_results AS scan
        WHERE scan.organization_id=version.organization_id
          AND scan.document_version_id=version.id) AS scan_results,
      (SELECT count(*)::int FROM audit_events AS audit
        WHERE audit.organization_id=version.organization_id
          AND audit.resource_id=version.id
          AND audit.event_type='documents.unbound_provider_version_removed') AS cleanup_audit,
      (SELECT count(*)::int FROM audit_outbox AS outbox
        WHERE outbox.organization_id=version.organization_id
          AND outbox.aggregate_id=version.id
          AND outbox.event_type='documents.unbound_provider_version_removed') AS cleanup_outbox
      FROM documents_document_versions AS version
      WHERE version.organization_id=$1 AND version.id=$2`, [
      ORGANIZATION_ID,
      documentVersionId,
    ]);
    const row = result.rows[0];
    if (!row || typeof row.bound_provider_version !== "string") {
      throw new HarnessError("unbound_provider_cleanup_counts");
    }
    return Object.freeze({
      boundProviderVersion: row.bound_provider_version,
      versionState: row.version_state,
      scan_results: Number(row.scan_results),
      cleanup_audit: Number(row.cleanup_audit),
      cleanup_outbox: Number(row.cleanup_outbox),
    });
  });
}

async function waitForUnboundProviderCleanup(
  target: OneRoleBaselineTarget,
  documentVersionId: string,
  providerVersions: readonly string[],
  observation: {
    scan_results: number | null;
    cleanup_audit: number | null;
    cleanup_outbox: number | null;
    authoritative_bound_present: boolean;
  },
) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const counts = await unboundProviderCleanupCounts(target, documentVersionId);
    observation.scan_results = counts.scan_results;
    observation.cleanup_audit = counts.cleanup_audit;
    observation.cleanup_outbox = counts.cleanup_outbox;
    observation.authoritative_bound_present =
      providerVersions.includes(counts.boundProviderVersion);
    if (providerVersions.includes(counts.boundProviderVersion) &&
        counts.versionState === "available" && counts.scan_results === 1 &&
        counts.cleanup_audit === 1 && counts.cleanup_outbox === 1) {
      return counts;
    }
    await delay(250);
  }
  throw new HarnessError("unbound_provider_version_cleanup");
}

async function waitForQueueEmpty(
  client: SQSClient,
  queueUrl: string,
  worker: ChildProcess,
  observation: QueueDrainObservation,
): Promise<boolean> {
  for (let attempt = 0; attempt < QUEUE_CONVERGENCE_POLL_COUNT; attempt += 1) {
    recordWorkerQueueEvidence(worker, observation);
    if (!observation.worker_alive) return false;
    try {
      const result = await client.send(new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
          "ApproximateNumberOfMessagesDelayed",
        ],
      }));
      observation.poll_count += 1;
      const attributes = result.Attributes;
      const visible = boundedQueueObservation(attributes?.ApproximateNumberOfMessages);
      const notVisible = boundedQueueObservation(attributes?.ApproximateNumberOfMessagesNotVisible);
      const delayed = boundedQueueObservation(attributes?.ApproximateNumberOfMessagesDelayed);
      observation.attributes_complete = visible !== null && notVisible !== null && delayed !== null;
      observation.visible_count = visible;
      observation.not_visible_count = notVisible;
      observation.delayed_count = delayed;
    } catch {
      observation.poll_count += 1;
      observation.attributes_complete = false;
      observation.visible_count = null;
      observation.not_visible_count = null;
      observation.delayed_count = null;
    }
    if (attempt + 1 < QUEUE_CONVERGENCE_POLL_COUNT) {
      await delay(QUEUE_CONVERGENCE_POLL_INTERVAL_MS);
    }
  }
  recordWorkerQueueEvidence(worker, observation);
  return observation.worker_alive && observation.attributes_complete &&
    observation.visible_count === 0 && observation.not_visible_count === 0 &&
    observation.delayed_count === 0;
}

function recordWorkerQueueEvidence(
  worker: ChildProcess,
  observation: QueueDrainObservation,
): void {
  observation.delete_requested_count = fixedProcessMarkerCount(
    worker,
    DOCUMENT_WORKER_MAIN_DELETE_REQUESTED_MARKER,
  );
  observation.delete_completed_count = fixedProcessMarkerCount(
    worker,
    DOCUMENT_WORKER_MAIN_DELETE_COMPLETED_MARKER,
  );
  observation.worker_alive = !processExited(worker);
  observation.worker_exit_code = safeProcessExitCode(worker);
  observation.worker_signal = safeProcessSignal(worker);
}

function fixedProcessMarkerCount(child: ChildProcess, marker: string): number | null {
  const logs = PROCESS_LOGS.get(child);
  if (!logs) return null;
  const count = logs.stdout.split(/\r?\n/u).filter((line) => line === marker).length;
  return Number.isSafeInteger(count) && count >= 0 && count <= MAX_QUEUE_OBSERVATION_COUNT
    ? count
    : null;
}

async function waitForS3TestEventAcknowledgement(
  worker: ChildProcess,
  observation: {
    requested_count: number | null;
    completed_count: number | null;
    acknowledged: boolean;
  },
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (processExited(worker)) throw new HarnessError("s3_test_event_acknowledged");
    observation.requested_count = fixedProcessMarkerCount(
      worker,
      DOCUMENT_WORKER_MAIN_DELETE_REQUESTED_MARKER,
    );
    observation.completed_count = fixedProcessMarkerCount(
      worker,
      DOCUMENT_WORKER_MAIN_DELETE_COMPLETED_MARKER,
    );
    if (observation.requested_count === 1 && observation.completed_count === 1) {
      observation.acknowledged = true;
      return;
    }
    await delay(250);
  }
  throw new HarnessError("s3_test_event_acknowledged");
}

function boundedQueueObservation(value: string | undefined): number | null {
  if (value === undefined || !/^(?:0|[1-9]\d{0,4})$/u.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count <= MAX_QUEUE_OBSERVATION_COUNT ? count : null;
}

async function abandonmentDatabaseEvidence(
  target: OneRoleBaselineTarget,
  documentId: string,
  abandonedVersionId: string,
  newerVersionId: string,
  abandonmentKey: string,
) {
  return tenantRead(target, async (client) => {
    const result = await client.query<{
      scan_results: number;
      cleanup_audit: number;
      cleanup_outbox: number;
      scan_audit: number;
      scan_outbox: number;
      abandonment_audit: number;
      abandonment_outbox: number;
      abandonment_receipt: number;
      abandoned_unbound: number;
      active_newer: number;
    }>(`SELECT
      (SELECT count(*)::int FROM documents_scan_results
        WHERE organization_id=$1 AND document_version_id=$3) AS scan_results,
      (SELECT count(*)::int FROM audit_events
        WHERE organization_id=$1 AND resource_id=$3
          AND event_type='documents.abandoned_object_removed') AS cleanup_audit,
      (SELECT count(*)::int FROM audit_outbox
        WHERE organization_id=$1 AND aggregate_id=$3
          AND event_type='documents.abandoned_object_removed') AS cleanup_outbox,
      (SELECT count(*)::int FROM audit_events
        WHERE organization_id=$1 AND resource_id=$3
          AND (event_type LIKE 'documents.scan_%'
            OR event_type IN ('documents.object_received','documents.object_rejected'))) AS scan_audit,
      (SELECT count(*)::int FROM audit_outbox
        WHERE organization_id=$1 AND aggregate_id=$3
          AND (event_type LIKE 'documents.scan_%'
            OR event_type IN ('documents.object_received','documents.object_rejected'))) AS scan_outbox,
      (SELECT count(*)::int FROM audit_events
        WHERE organization_id=$1 AND resource_id=$3
          AND event_type='documents.pending_upload_abandoned') AS abandonment_audit,
      (SELECT count(*)::int FROM audit_outbox
        WHERE organization_id=$1 AND aggregate_id=$3
          AND event_type='documents.pending_upload_abandoned') AS abandonment_outbox,
      (SELECT count(*)::int FROM shared_idempotency_records
        WHERE organization_id=$1 AND actor_user_id=$5
          AND operation='documents.abandon_pending_upload'
          AND idempotency_key=$6 AND state='completed') AS abandonment_receipt,
      (SELECT count(*)::int FROM documents_document_versions
        WHERE organization_id=$1 AND document_id=$2 AND id=$3
          AND state='abandoned' AND object_version_id IS NULL) AS abandoned_unbound,
      (SELECT count(*)::int FROM documents_documents
        WHERE organization_id=$1 AND id=$2 AND active_document_version_id=$4) AS active_newer`, [
      ORGANIZATION_ID,
      documentId,
      abandonedVersionId,
      newerVersionId,
      FOUNDER.userId,
      abandonmentKey,
    ]);
    const row = result.rows[0];
    if (!row) throw new HarnessError("abandonment_database");
    return Object.freeze({
      scan_results: Number(row.scan_results),
      cleanup_audit: Number(row.cleanup_audit),
      cleanup_outbox: Number(row.cleanup_outbox),
      scan_audit: Number(row.scan_audit),
      scan_outbox: Number(row.scan_outbox),
      abandonment_audit: Number(row.abandonment_audit),
      abandonment_outbox: Number(row.abandonment_outbox),
      abandonment_receipt: Number(row.abandonment_receipt),
      abandoned_unbound: Number(row.abandoned_unbound),
      active_newer: Number(row.active_newer),
    });
  });
}

async function privateEvidenceMatches(
  target: OneRoleBaselineTarget,
  privateValues: readonly string[],
): Promise<number> {
  return tenantRead(target, async (client) => {
    const result = await client.query<{ matches: number }>(`SELECT (
      (SELECT count(*) FROM audit_events AS event
        WHERE event.organization_id=$1 AND EXISTS (
          SELECT 1 FROM unnest($2::text[]) AS private_value
           WHERE private_value<>'' AND event.metadata::text LIKE '%' || private_value || '%'
        )) +
      (SELECT count(*) FROM audit_outbox AS message
        WHERE message.organization_id=$1 AND EXISTS (
          SELECT 1 FROM unnest($2::text[]) AS private_value
           WHERE private_value<>'' AND message.payload::text LIKE '%' || private_value || '%'
        ))
    )::int AS matches`, [ORGANIZATION_ID, privateValues]);
    return Number(result.rows[0]?.matches ?? -1);
  });
}

async function forbiddenEvidenceShapeMatches(target: OneRoleBaselineTarget): Promise<number> {
  return tenantRead(target, async (client) => {
    const forbiddenKeyPattern = [
      "bucket",
      "object_bucket",
      "objectBucket",
      "key",
      "object_key",
      "objectKey",
      "object_version_id",
      "objectVersionId",
      "provider_version_id",
      "providerVersionId",
      "checksum",
      "checksum_sha256",
      "checksumSha256",
      "checksumBase64",
      "content_type",
      "contentType",
      "mime",
      "mimeType",
      "size",
      "size_bytes",
      "sizeBytes",
      "url",
      "downloadUrl",
      "signed_url",
      "signedUrl",
      "signature",
      "filename",
      "file_name",
      "fileName",
      "bytes",
      "rawBytes",
      "body",
      "scanner_detail",
      "scanner_signature",
    ].join("|");
    const result = await client.query<{ matches: number }>(`SELECT (
      (SELECT count(*) FROM audit_events
        WHERE organization_id=$1
          AND event_type LIKE 'documents.%'
          AND metadata::text ~ ('\"(' || $2 || ')\"[[:space:]]*:')) +
      (SELECT count(*) FROM audit_outbox
        WHERE organization_id=$1
          AND event_type LIKE 'documents.%'
          AND payload::text ~ ('\"(' || $2 || ')\"[[:space:]]*:'))
    )::int AS matches`, [ORGANIZATION_ID, forbiddenKeyPattern]);
    return Number(result.rows[0]?.matches ?? -1);
  });
}

async function prepareForeignDocumentFixture(target: OneRoleBaselineTarget): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
    await client.query("SELECT set_config('app.organization_id',$1,true)", [ORGANIZATION_ID]);
    await client.query(`UPDATE access_organizations
      SET status='disabled',record_version=record_version+1,updated_at=transaction_timestamp()
      WHERE id=$1`, [ORGANIZATION_ID]);
    await client.query(`INSERT INTO access_organizations
      (id,display_name,status,created_by_user_id)
      VALUES ($1,'DOC02 Synthetic Foreign Organization','active',$2)`, [
      FOREIGN_ORGANIZATION_ID,
      FOUNDER.userId,
    ]);
    await client.query("SELECT set_config('app.organization_id',$1,true)", [FOREIGN_ORGANIZATION_ID]);
    await client.query(`INSERT INTO access_organization_memberships
      (id,organization_id,user_id,status,created_by_user_id)
      VALUES ($1,$2,$3,'active',$3)`, [
      FOREIGN_MEMBERSHIP_ID,
      FOREIGN_ORGANIZATION_ID,
      FOUNDER.userId,
    ]);
    await client.query(`INSERT INTO access_role_bindings
      (id,organization_id,membership_id,user_id,role,status,created_by_user_id)
      VALUES ($1,$2,$3,$4,'advisor','active',$4)`, [
      FOREIGN_ROLE_BINDING_ID,
      FOREIGN_ORGANIZATION_ID,
      FOREIGN_MEMBERSHIP_ID,
      FOUNDER.userId,
    ]);
    await client.query(`INSERT INTO crm_students
      (id,organization_id,display_name,status)
      VALUES ($1,$2,'DOC02 Synthetic Foreign Student','active')`, [
      FOREIGN_STUDENT_ID,
      FOREIGN_ORGANIZATION_ID,
    ]);
    await client.query(`INSERT INTO crm_guardians
      (id,organization_id,display_name,email,status)
      VALUES ($1,$2,'DOC02 Synthetic Foreign Guardian',
        'doc02-foreign-guardian@example.invalid','active')`, [
      FOREIGN_GUARDIAN_ID,
      FOREIGN_ORGANIZATION_ID,
    ]);
    await client.query(`INSERT INTO crm_student_guardian_relationships
      (id,organization_id,student_id,guardian_id,relationship_type,
       is_legal_guardian,is_primary_contact,is_emergency_contact,is_billing_contact,
       notification_consent,starts_at)
      VALUES ($1,$2,$3,$4,'other_guardian',true,true,false,false,false,
        transaction_timestamp())`, [
      FOREIGN_RELATIONSHIP_ID,
      FOREIGN_ORGANIZATION_ID,
      FOREIGN_STUDENT_ID,
      FOREIGN_GUARDIAN_ID,
    ]);
    await client.query(`INSERT INTO cases_service_cases
      (id,organization_id,student_id,case_number,application_type,intake_year,
       admission_type,primary_role_binding_id,primary_membership_id,primary_user_id,
       primary_role,stage,workflow_status,record_version)
      VALUES ($1,$2,$3,'DOC02-FOREIGN','k12',2054,'transfer',$4,$5,$6,
        'advisor','signed','active',1)`, [
      FOREIGN_CASE_ID,
      FOREIGN_ORGANIZATION_ID,
      FOREIGN_STUDENT_ID,
      FOREIGN_ROLE_BINDING_ID,
      FOREIGN_MEMBERSHIP_ID,
      FOUNDER.userId,
    ]);
    const advanced = await client.query<{ decision: string; result_stage: string; result_record_version: string }>(
      "SELECT * FROM cases_advance_new_service_case($1,'advisor',$2,transaction_timestamp())",
      [FOREIGN_CASE_ID, FOREIGN_CASE_TRANSITION_FACT_ID],
    );
    assert.deepEqual(advanced.rows, [{
      decision: "allowed",
      result_stage: "background_collection",
      result_record_version: "2",
    }]);
    await client.query(`INSERT INTO documents_documents
      (id,organization_id,owner_kind,service_case_id,display_name,classification,
       lifecycle_state,legal_hold)
      VALUES ($1,$2,'case',$3,'DOC02 Synthetic Foreign Document',
        'operational_attachment','active',false)`, [
      FOREIGN_DOCUMENT_ID,
      FOREIGN_ORGANIZATION_ID,
      FOREIGN_CASE_ID,
    ]);
    await client.query(`UPDATE access_organizations
      SET status='disabled',record_version=record_version+1,updated_at=transaction_timestamp()
      WHERE id=$1`, [FOREIGN_ORGANIZATION_ID]);
    await client.query("SELECT set_config('app.organization_id',$1,true)", [ORGANIZATION_ID]);
    await client.query(`UPDATE access_organizations
      SET status='active',record_version=record_version+1,updated_at=transaction_timestamp()
      WHERE id=$1`, [ORGANIZATION_ID]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function tenantRead<Result>(
  target: OneRoleBaselineTarget,
  operation: (client: Client) => Promise<Result>,
): Promise<Result> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [ORGANIZATION_ID]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER.userId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function assertReceiptRollback(
  pool: Pool,
  target: OneRoleBaselineTarget,
  s3: S3Client,
  sqs: SQSClient,
  queueUrl: string,
  runtime: RuntimeEnvironment,
  baseUrl: string,
  cookie: string,
  caseId: string,
  suffix: string,
  setStage: (value: string) => void,
  observation: RecoveryScenarioObservation,
): Promise<void> {
  setStage("receipt_rollback_register");
  const document = await registerDocumentObserved(
    baseUrl,
    cookie,
    caseId,
    "Synthetic DOC-02 receipt rollback evidence",
    `doc02-receipt-rollback-document-${suffix}`,
    observation.registration,
  );
  setStage("receipt_rollback_version_put");
  const created = await createVersionAndPut({
    baseUrl,
    cookie,
    caseId,
    document,
    bytes: CLEAN_BYTES,
    contentType: "application/pdf",
    localstackEndpoint: runtime.localstackEndpoint,
  });
  observation.version_put_completed = true;
  setStage("receipt_rollback_head");
  await s3.send(new HeadObjectCommand({
    Bucket: BUCKET,
    Key: created.objectKey,
    VersionId: created.providerVersionId,
  }));
  observation.head_completed = true;
  setStage("receipt_rollback_message");
  const message = await receiveMessage(sqs, queueUrl);
  observation.message_received = true;
  const failing = createHookedScanDependencies(pool, runtime, (operation) => {
    if (operation === "receipt") throw new Error("synthetic receipt rollback");
  });
  setStage("receipt_rollback_injected_disposition");
  const injectedDisposition = await documentMessageDisposition(
    message,
    BUCKET,
    (event) => processDocumentObjectCreated(event, failing),
  );
  observation.injected_disposition = injectedDisposition;
  assert.equal(injectedDisposition, "retain");
  setStage("receipt_rollback_db_state");
  const rollbackState = await receiptRollbackState(target, created.version.id);
  observation.version_state = observedVersionState(rollbackState.state);
  observation.bound_count = observedCount(rollbackState.bound);
  observation.scan_count = observedCount(rollbackState.scans);
  observation.audit_count = observedCount(rollbackState.receipt_audit);
  observation.outbox_count = observedCount(rollbackState.receipt_outbox);
  observation.rollback_db_exact =
    rollbackState.state === "pending_upload"
    && rollbackState.bound === 0
    && rollbackState.scans === 0
    && rollbackState.receipt_audit === 0
    && rollbackState.receipt_outbox === 0;
  assert.deepEqual(rollbackState, {
    state: "pending_upload",
    bound: 0,
    scans: 0,
    receipt_audit: 0,
    receipt_outbox: 0,
  });
  setStage("receipt_rollback_redelivery");
  await makeVisible(sqs, queueUrl, message);
  const retry = await receiveMessage(sqs, queueUrl);
  observation.redelivery_received = true;
  observation.redelivery_count = observedCount(retry.Attributes?.ApproximateReceiveCount);
  const recovered = createScanDependencies(pool, runtime);
  setStage("receipt_rollback_recovered_disposition");
  const recoveredDisposition = await documentMessageDisposition(
    retry,
    BUCKET,
    (event) => processDocumentObjectCreated(event, recovered),
  );
  observation.recovered_disposition = recoveredDisposition;
  assert.equal(recoveredDisposition, "delete");
  setStage("receipt_rollback_delete");
  await deleteMessage(sqs, queueUrl, retry);
  observation.delete_completed = true;
  setStage("receipt_rollback_authority");
  await waitForDocumentState(
    baseUrl, cookie, caseId, document.id, "available", true,
    (result, authority) => {
      observation.authority.request_completed = true;
      observation.authority.response_completed = true;
      observation.authority.http_status = result.response.status;
      if (authority) recordAuthority(observation.authority, authority);
    },
  );
  observation.completed = true;
}

async function assertClaimRollback(
  pool: Pool,
  target: OneRoleBaselineTarget,
  s3: S3Client,
  sqs: SQSClient,
  queueUrl: string,
  runtime: RuntimeEnvironment,
  baseUrl: string,
  cookie: string,
  caseId: string,
  suffix: string,
  setStage: (value: string) => void,
  observation: RecoveryScenarioObservation,
): Promise<void> {
  setStage("claim_rollback_register");
  const document = await registerDocumentObserved(
    baseUrl,
    cookie,
    caseId,
    "Synthetic DOC-02 claim rollback evidence",
    `doc02-claim-rollback-document-${suffix}`,
    observation.registration,
  );
  setStage("claim_rollback_version_put");
  const created = await createVersionAndPut({
    baseUrl,
    cookie,
    caseId,
    document,
    bytes: CLEAN_BYTES,
    contentType: "application/pdf",
    localstackEndpoint: runtime.localstackEndpoint,
  });
  observation.version_put_completed = true;
  setStage("claim_rollback_head");
  await s3.send(new HeadObjectCommand({
    Bucket: BUCKET,
    Key: created.objectKey,
    VersionId: created.providerVersionId,
  }));
  observation.head_completed = true;
  setStage("claim_rollback_message");
  const message = await receiveMessage(sqs, queueUrl);
  observation.message_received = true;
  const event = parseDocumentObjectCreatedMessage(message, BUCKET);
  const ready = createScanDependencies(pool, runtime);
  setStage("claim_rollback_receipt");
  const receiptResult = await ready.receiptService.receive(event, (signal) => ready.objectReader.headExact({
      bucket: event.bucket,
      key: event.key,
      providerVersionId: event.versionId,
      signal,
    }));
  observation.receipt_status = receiptResult.status === "ready" ? "ready" : null;
  assert.deepEqual(receiptResult, { status: "ready" });
  const failing = createHookedScanDependencies(pool, runtime, (operation) => {
    if (operation === "claim") throw new Error("synthetic claim rollback");
  });
  setStage("claim_rollback_injected_disposition");
  const injectedDisposition = await documentMessageDisposition(
    message,
    BUCKET,
    (delivery) => processDocumentObjectCreated(delivery, failing),
  );
  observation.injected_disposition = injectedDisposition;
  assert.equal(injectedDisposition, "retain");
  setStage("claim_rollback_db_state");
  const rollbackState = await unclaimedScanState(target, created.version.id);
  observation.version_state = observedVersionState(rollbackState.version_state);
  observation.scan_state = observedScanState(rollbackState.scan_state);
  observation.attempt_count = observedCount(rollbackState.attempt_count);
  observation.audit_count = observedCount(rollbackState.claim_audit);
  observation.outbox_count = observedCount(rollbackState.claim_outbox);
  observation.rollback_db_exact =
    rollbackState.version_state === "quarantined"
    && rollbackState.scan_state === "queued"
    && rollbackState.attempt_count === 0
    && rollbackState.claim_audit === 0
    && rollbackState.claim_outbox === 0;
  assert.deepEqual(rollbackState, {
    version_state: "quarantined",
    scan_state: "queued",
    attempt_count: 0,
    claim_audit: 0,
    claim_outbox: 0,
  });
  setStage("claim_rollback_redelivery");
  await makeVisible(sqs, queueUrl, message);
  const retry = await receiveMessage(sqs, queueUrl);
  observation.redelivery_received = true;
  observation.redelivery_count = observedCount(retry.Attributes?.ApproximateReceiveCount);
  assert.equal(retry.Attributes?.ApproximateReceiveCount, "2");
  setStage("claim_rollback_recovered_disposition");
  const recoveredDisposition = await documentMessageDisposition(
    retry,
    BUCKET,
    (delivery) => processDocumentObjectCreated(delivery, ready),
  );
  observation.recovered_disposition = recoveredDisposition;
  assert.equal(recoveredDisposition, "delete");
  setStage("claim_rollback_delete");
  await deleteMessage(sqs, queueUrl, retry);
  observation.delete_completed = true;
  setStage("claim_rollback_authority");
  await waitForDocumentState(
    baseUrl, cookie, caseId, document.id, "available", true,
    (result, authority) => {
      observation.authority.request_completed = true;
      observation.authority.response_completed = true;
      observation.authority.http_status = result.response.status;
      if (authority) recordAuthority(observation.authority, authority);
    },
  );
  observation.completed = true;
}

async function unclaimedScanState(target: OneRoleBaselineTarget, documentVersionId: string) {
  return tenantRead(target, async (client) => {
    const result = await client.query<{
      version_state: string;
      scan_state: string;
      attempt_count: number;
      claim_audit: number;
      claim_outbox: number;
    }>(`SELECT version.state AS version_state,scan.state AS scan_state,scan.attempt_count,
        (SELECT count(*)::int FROM audit_events event
          WHERE event.organization_id=version.organization_id AND event.resource_id=version.id
            AND event.event_type='documents.scan_claimed') AS claim_audit,
        (SELECT count(*)::int FROM audit_outbox message
          WHERE message.organization_id=version.organization_id AND message.aggregate_id=version.id
            AND message.event_type='documents.scan_claimed') AS claim_outbox
      FROM documents_document_versions version
      JOIN documents_scan_results scan
        ON scan.organization_id=version.organization_id AND scan.document_version_id=version.id
      WHERE version.organization_id=$1 AND version.id=$2`, [ORGANIZATION_ID, documentVersionId]);
    const row = result.rows[0];
    if (!row) throw new HarnessError("unclaimed_scan_state");
    return Object.freeze({
      version_state: row.version_state,
      scan_state: row.scan_state,
      attempt_count: Number(row.attempt_count),
      claim_audit: Number(row.claim_audit),
      claim_outbox: Number(row.claim_outbox),
    });
  });
}

async function assertReceiptWinsAbandonment(
  pool: Pool,
  sqs: SQSClient,
  queueUrl: string,
  runtime: RuntimeEnvironment,
  baseUrl: string,
  cookie: string,
  caseId: string,
  suffix: string,
  setStage: (value: string) => void,
  observation: RecoveryScenarioObservation,
): Promise<void> {
  setStage("receipt_wins_abandonment_register");
  const document = await registerDocumentObserved(
    baseUrl,
    cookie,
    caseId,
    "Synthetic DOC-02 receipt-first evidence",
    `doc02-receipt-first-document-${suffix}`,
    observation.registration,
  );
  setStage("receipt_wins_abandonment_version_put");
  const created = await createVersionAndPut({
    baseUrl,
    cookie,
    caseId,
    document,
    bytes: CLEAN_BYTES,
    contentType: "application/pdf",
    localstackEndpoint: runtime.localstackEndpoint,
  });
  observation.version_put_completed = true;
  setStage("receipt_wins_abandonment_message");
  const message = await receiveMessage(sqs, queueUrl);
  observation.message_received = true;
  const event = parseDocumentObjectCreatedMessage(message, BUCKET);
  const dependencies = createScanDependencies(pool, runtime);
  setStage("receipt_wins_abandonment_receipt");
  const receiptResult = await dependencies.receiptService.receive(
    event,
    (signal) => dependencies.objectReader.headExact({
      bucket: event.bucket,
      key: event.key,
      providerVersionId: event.versionId,
      signal,
    }),
  );
  observation.receipt_status = receiptResult.status === "ready" ? "ready" : null;
  assert.deepEqual(receiptResult, { status: "ready" });
  setStage("receipt_wins_abandonment_conflict");
  const conflictResult = await postJson(
    baseUrl,
    abandonmentPath(caseId, document.id, created.version.id),
    cookie,
    `doc02-receipt-first-abandon-${suffix}`,
    { expected_document_record_version: 2, expected_version_record_version: 2 },
  );
  observation.conflict_http_status = conflictResult.response.status;
  assertApiError(conflictResult, 409, "CONFLICT");
  observation.conflict_exact = true;
  setStage("receipt_wins_abandonment_process");
  const recoveredDisposition = await documentMessageDisposition(
    message,
    BUCKET,
    (delivery) => processDocumentObjectCreated(delivery, dependencies),
  );
  observation.recovered_disposition = recoveredDisposition;
  assert.equal(recoveredDisposition, "delete");
  setStage("receipt_wins_abandonment_delete");
  await deleteMessage(sqs, queueUrl, message);
  observation.delete_completed = true;
  setStage("receipt_wins_abandonment_authority");
  await waitForDocumentState(
    baseUrl, cookie, caseId, document.id, "available", true,
    (result, authority) => {
      observation.authority.request_completed = true;
      observation.authority.response_completed = true;
      observation.authority.http_status = result.response.status;
      if (authority) recordAuthority(observation.authority, authority);
    },
  );
  observation.completed = true;
}

async function assertCleanupCrashRecovery(
  pool: Pool,
  s3: S3Client,
  sqs: SQSClient,
  queueUrl: string,
  runtime: RuntimeEnvironment,
  target: OneRoleBaselineTarget,
  baseUrl: string,
  cookie: string,
  caseId: string,
  suffix: string,
  setStage: (value: string) => void,
  observation: RecoveryScenarioObservation,
): Promise<void> {
  setStage("cleanup_crash_recovery_register");
  const document = await registerDocumentObserved(
    baseUrl,
    cookie,
    caseId,
    "Synthetic DOC-02 cleanup crash evidence",
    `doc02-cleanup-crash-document-${suffix}`,
    observation.registration,
  );
  setStage("cleanup_crash_recovery_version_put");
  const created = await createVersionAndPut({
    baseUrl,
    cookie,
    caseId,
    document,
    bytes: NEWER_BYTES,
    contentType: "application/pdf",
    localstackEndpoint: runtime.localstackEndpoint,
  });
  observation.version_put_completed = true;
  setStage("cleanup_crash_recovery_abandonment");
  const abandonmentResult = await postJson(
    baseUrl,
    abandonmentPath(caseId, document.id, created.version.id),
    cookie,
    `doc02-cleanup-crash-abandon-${suffix}`,
    { expected_document_record_version: 2, expected_version_record_version: 1 },
  );
  observation.conflict_http_status = abandonmentResult.response.status;
  assertVersionReceipt(abandonmentResult, 200, 2);
  observation.conflict_exact = true;
  setStage("cleanup_crash_recovery_message");
  const message = await receiveMessage(sqs, queueUrl);
  observation.message_received = true;
  const failing = createHookedScanDependencies(pool, runtime, (operation) => {
    if (operation === "abandoned_cleanup") throw new Error("synthetic cleanup effect rollback");
  });
  setStage("cleanup_crash_recovery_injected_disposition");
  const injectedDisposition = await documentMessageDisposition(
    message,
    BUCKET,
    (delivery) => processDocumentObjectCreated(delivery, failing),
  );
  observation.injected_disposition = injectedDisposition;
  assert.equal(injectedDisposition, "retain");
  setStage("cleanup_crash_recovery_object_absent");
  const objectAbsent = await exactObjectVersionsAbsent(
    s3,
    created.objectKey,
    [created.providerVersionId],
  );
  observation.object_absent = objectAbsent;
  assert.equal(objectAbsent, true);
  setStage("cleanup_crash_recovery_zero_effects");
  const rollbackEffects = await cleanupEffectCount(target, created.version.id);
  observation.audit_count = observedCount(rollbackEffects.audit);
  observation.outbox_count = observedCount(rollbackEffects.outbox);
  observation.rollback_db_exact = rollbackEffects.audit === 0 && rollbackEffects.outbox === 0;
  assert.deepEqual(rollbackEffects, { audit: 0, outbox: 0 });
  setStage("cleanup_crash_recovery_redelivery");
  await makeVisible(sqs, queueUrl, message);
  const retry = await receiveMessage(sqs, queueUrl);
  observation.redelivery_received = true;
  observation.redelivery_count = observedCount(retry.Attributes?.ApproximateReceiveCount);
  assert.equal(retry.Attributes?.ApproximateReceiveCount, "2");
  const dependencies = createScanDependencies(pool, runtime);
  setStage("cleanup_crash_recovery_disposition");
  const recoveredDisposition = await documentMessageDisposition(
    retry,
    BUCKET,
    (delivery) => processDocumentObjectCreated(delivery, dependencies),
  );
  observation.recovered_disposition = recoveredDisposition;
  assert.equal(recoveredDisposition, "delete");
  setStage("cleanup_crash_recovery_delete");
  await deleteMessage(sqs, queueUrl, retry);
  observation.delete_completed = true;
  setStage("cleanup_crash_recovery_effects");
  const terminalEffects = await cleanupEffectCount(target, created.version.id);
  observation.effect_audit_count = observedCount(terminalEffects.audit);
  observation.effect_outbox_count = observedCount(terminalEffects.outbox);
  assert.deepEqual(terminalEffects, { audit: 1, outbox: 1 });
  const scanFacts = await scanFactCounts(target, created.version.id);
  observation.scan_results_count = observedCount(scanFacts.scan_results);
  observation.scan_claim_audit_count = observedCount(scanFacts.scan_claim_audit);
  observation.scan_claim_outbox_count = observedCount(scanFacts.scan_claim_outbox);
  observation.scan_clean_audit_count = observedCount(scanFacts.scan_clean_audit);
  observation.scan_clean_outbox_count = observedCount(scanFacts.scan_clean_outbox);
  assert.deepEqual(scanFacts, {
    scan_results: 0,
    scan_claim_audit: 0,
    scan_claim_outbox: 0,
    scan_clean_audit: 0,
    scan_clean_outbox: 0,
  });
  observation.completed = true;
}

async function assertMissedEventReconciliation(
  pool: Pool,
  target: OneRoleBaselineTarget,
  sqs: SQSClient,
  queueUrl: string,
  runtime: RuntimeEnvironment,
  baseUrl: string,
  cookie: string,
  caseId: string,
  suffix: string,
  setStage: (value: string) => void,
  observation: MissedEventRecoveryObservation,
): Promise<void> {
  setStage("missed_event_reconciliation_register");
  const document = await registerDocumentObserved(
    baseUrl,
    cookie,
    caseId,
    "Synthetic DOC-02 missed event evidence",
    `doc02-missed-event-document-${suffix}`,
    observation.registration,
  );
  setStage("missed_event_reconciliation_version_put");
  const created = await createVersionAndPut({
    baseUrl,
    cookie,
    caseId,
    document,
    bytes: NEWER_BYTES,
    contentType: "application/pdf",
    localstackEndpoint: runtime.localstackEndpoint,
  });
  observation.version_put_completed = true;
  setStage("missed_event_reconciliation_message");
  const original = await receiveMessage(sqs, queueUrl);
  observation.message_received = true;
  const event = parseDocumentObjectCreatedMessage(original, BUCKET);
  assert.equal(event.key, created.objectKey);
  assert.equal(event.versionId, created.providerVersionId);
  const dependencies = createScanDependencies(pool, runtime);
  setStage("missed_event_reconciliation_receipt");
  const receiptResult = await dependencies.receiptService.receive(
    event,
    (signal) => dependencies.objectReader.headExact({
      bucket: event.bucket,
      key: event.key,
      providerVersionId: event.versionId,
      signal,
    }),
  );
  observation.receipt_status = receiptResult.status === "ready" ? "ready" : null;
  assert.deepEqual(receiptResult, { status: "ready" });
  setStage("missed_event_reconciliation_original_delete");
  await deleteMessage(sqs, queueUrl, original);
  observation.delete_completed = true;
  setStage("missed_event_reconciliation_queued_state");
  const queuedState = await unclaimedScanState(target, created.version.id);
  observation.version_state = observedVersionState(queuedState.version_state);
  observation.scan_state = observedScanState(queuedState.scan_state);
  observation.attempt_count = observedCount(queuedState.attempt_count);
  observation.audit_count = observedCount(queuedState.claim_audit);
  observation.outbox_count = observedCount(queuedState.claim_outbox);
  observation.rollback_db_exact =
    queuedState.version_state === "quarantined"
    && queuedState.scan_state === "queued"
    && queuedState.attempt_count === 0
    && queuedState.claim_audit === 0
    && queuedState.claim_outbox === 0;
  assert.deepEqual(queuedState, {
    version_state: "quarantined",
    scan_state: "queued",
    attempt_count: 0,
    claim_audit: 0,
    claim_outbox: 0,
  });

  const runner = createTenantTransactionRunner(pool as unknown as DatabasePool, {
    expectedLoginUser: ONE_ROLE_CANONICAL_ROLE,
  });
  const repository = new PostgresqlDocumentScanRepository(runner, {
    organizationId: ORGANIZATION_ID,
    workerContextId: WORKER_CONTEXT_ID,
  });
  const publisher = new LocalSyntheticDocumentScanRequeuePublisher({
    endpoint: runtime.localstackEndpoint,
    region: REGION,
    queue: QUEUE,
    bucket: BUCKET,
    requestTimeoutMs: 2_000,
  });
  const service = new DocumentScanService({
    repository,
    requeuePublisher: {
      async publish(candidate) {
        observation.publish_started = true;
        await publisher.publish(candidate);
        observation.publish_completed = true;
      },
    },
  });
  setStage("missed_event_reconciliation_readiness");
  await waitForMissedEventCandidate(repository, created.version.id);
  setStage("missed_event_reconciliation_reconcile");
  const reconcileResult = await service.reconcileDocumentScans({ staleAfterMs: 1, limit: 10 });
  observation.reconcile_call_completed = true;
  observation.reconcile_inspected = observedCount(reconcileResult.inspected);
  observation.reconcile_requeued = observedCount(reconcileResult.requeued);
  observation.reconcile_dead_lettered = observedCount(reconcileResult.deadLettered);
  observation.reconcile_ignored = observedCount(reconcileResult.ignored);
  observation.reconcile_exact =
    reconcileResult.inspected === 1
    && reconcileResult.requeued === 1
    && reconcileResult.deadLettered === 0
    && reconcileResult.ignored === 0;
  assert.deepEqual(reconcileResult, { inspected: 1, requeued: 1, deadLettered: 0, ignored: 0 });
  setStage("missed_event_reconciliation_redelivery");
  const replacement = await receiveMessage(sqs, queueUrl);
  observation.redelivery_received = true;
  observation.redelivery_count = observedCount(replacement.Attributes?.ApproximateReceiveCount);
  const replacementEvent = parseDocumentObjectCreatedMessage(replacement, BUCKET);
  assert.equal(replacementEvent.key, event.key);
  assert.equal(replacementEvent.versionId, event.versionId);
  const recoveredDisposition = await documentMessageDisposition(
    replacement,
    BUCKET,
    (delivery) => processDocumentObjectCreated(delivery, dependencies),
  );
  observation.recovered_disposition = recoveredDisposition;
  assert.equal(recoveredDisposition, "delete");
  setStage("missed_event_reconciliation_delete");
  await deleteMessage(sqs, queueUrl, replacement);
  setStage("missed_event_reconciliation_authority");
  await waitForDocumentState(
    baseUrl, cookie, caseId, document.id, "available", true,
    (result, authority) => {
      observation.authority.request_completed = true;
      observation.authority.response_completed = true;
      observation.authority.http_status = result.response.status;
      if (authority) recordAuthority(observation.authority, authority);
    },
  );
  setStage("missed_event_reconciliation_effects");
  const effectCounts = await reconciliationEffectCounts(target, created.version.id);
  observation.effect_audit_count = observedCount(effectCounts.audit);
  observation.effect_outbox_count = observedCount(effectCounts.outbox);
  assert.deepEqual(effectCounts, {
    audit: 1,
    outbox: 1,
  });
  observation.completed = true;
}

async function waitForMissedEventCandidate(
  repository: PostgresqlDocumentScanRepository,
  documentVersionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const candidates = await repository.findReconciliationCandidates({
      nowMs: Date.now(),
      staleAfterMs: 1,
      limit: 10,
    });
    if (candidates.some((candidate) =>
      candidate.kind === "missed_event" && candidate.documentVersionId === documentVersionId)) {
      return;
    }
    await delay(25);
  }
  throw new HarnessError("missed_event_reconciliation_readiness");
}

async function reconciliationEffectCounts(target: OneRoleBaselineTarget, documentVersionId: string) {
  return tenantRead(target, async (client) => {
    const result = await client.query<{ audit: number; outbox: number }>(`SELECT
      (SELECT count(*)::int FROM audit_events
        WHERE organization_id=$1 AND resource_id=$2
          AND event_type='documents.scan_reconciled') AS audit,
      (SELECT count(*)::int FROM audit_outbox
        WHERE organization_id=$1 AND aggregate_id=$2
          AND event_type='documents.scan_reconciled') AS outbox`, [ORGANIZATION_ID, documentVersionId]);
    const row = result.rows[0];
    if (!row) throw new HarnessError("reconciliation_effect_counts");
    return Object.freeze({ audit: Number(row.audit), outbox: Number(row.outbox) });
  });
}

async function assertCrashAfterClaimRecovery(
  pool: Pool,
  target: OneRoleBaselineTarget,
  s3: S3Client,
  sqs: SQSClient,
  queueUrl: string,
  runtime: RuntimeEnvironment,
  baseUrl: string,
  cookie: string,
  caseId: string,
  suffix: string,
  setStage: (value: string) => void,
  observation: StuckScanRecoveryObservation,
): Promise<void> {
  setStage("crash_after_claim_recovery_register");
  const document = await registerDocumentObserved(
    baseUrl,
    cookie,
    caseId,
    "Synthetic DOC-02 claim crash evidence",
    `doc02-claim-crash-document-${suffix}`,
    observation.registration,
  );
  setStage("crash_after_claim_recovery_version_put");
  const created = await createVersionAndPut({
    baseUrl,
    cookie,
    caseId,
    document,
    bytes: NEWER_BYTES,
    contentType: "application/pdf",
    localstackEndpoint: runtime.localstackEndpoint,
  });
  observation.version_put_completed = true;
  setStage("crash_after_claim_recovery_head");
  await s3.send(new HeadObjectCommand({
    Bucket: BUCKET,
    Key: created.objectKey,
    VersionId: created.providerVersionId,
  }));
  observation.head_completed = true;
  const dependencies = createScanDependencies(pool, runtime);
  setStage("crash_after_claim_recovery_message");
  const first = await receiveMessage(sqs, queueUrl);
  observation.message_received = true;
  const event = parseDocumentObjectCreatedMessage(first, BUCKET);
  setStage("crash_after_claim_recovery_receipt");
  const receiptResult = await dependencies.receiptService.receive(
    event,
    (signal) => dependencies.objectReader.headExact({
      bucket: event.bucket,
      key: event.key,
      providerVersionId: event.versionId,
      signal,
    }),
  );
  observation.receipt_status = receiptResult.status === "ready" ? "ready" : null;
  assert.deepEqual(receiptResult, { status: "ready" });
  setStage("crash_after_claim_recovery_claim");
  const claim = await dependencies.service.claimScanWork(event);
  observation.claim_status = claim.status === "claimed" ? "claimed" : null;
  assert.equal(claim.status, "claimed");
  const claimedState = await crashState(target, created.version.id);
  observation.version_state = observedVersionState(claimedState.version_state);
  observation.scan_state = observedScanState(claimedState.scan_state);
  observation.attempt_count = observedCount(claimedState.attempt_count);
  assert.equal(claimedState.version_state, "scanning");

  setStage("crash_after_claim_recovery_overlap");
  await makeVisible(sqs, queueUrl, first);
  const overlap = await receiveMessage(sqs, queueUrl);
  observation.redelivery_received = true;
  observation.redelivery_count = observedCount(overlap.Attributes?.ApproximateReceiveCount);
  const overlapDisposition = await documentMessageDisposition(
    overlap,
    BUCKET,
    (redelivery) => processDocumentObjectCreated(redelivery, dependencies),
  );
  observation.overlap_disposition = overlapDisposition;
  assert.equal(overlapDisposition, "retain");
  assert.equal((await crashState(target, created.version.id)).version_state, "scanning");

  const runner = createTenantTransactionRunner(pool as unknown as DatabasePool, {
    expectedLoginUser: ONE_ROLE_CANONICAL_ROLE,
  });
  const repository = new PostgresqlDocumentScanRepository(runner, {
    organizationId: ORGANIZATION_ID,
    workerContextId: WORKER_CONTEXT_ID,
  });
  const reconciliation = new DocumentScanService({ repository });
  setStage("crash_after_claim_recovery_readiness");
  const readiness = await waitForStuckScanCandidate(repository, created.version.id);
  observation.readiness_candidate_count = readiness.candidateCount;
  observation.readiness_exact_target = readiness.exactTarget;
  observation.readiness_kind_stuck_scan = readiness.kindStuckScan;
  setStage("crash_after_claim_recovery_reconcile");
  const reconcileResult = await reconciliation.reconcileDocumentScans({ staleAfterMs: 1, limit: 10 });
  observation.reconcile_call_completed = true;
  observation.reconcile_inspected = observedCount(reconcileResult.inspected);
  observation.reconcile_requeued = observedCount(reconcileResult.requeued);
  observation.reconcile_dead_lettered = observedCount(reconcileResult.deadLettered);
  observation.reconcile_ignored = observedCount(reconcileResult.ignored);
  observation.reconcile_exact =
    reconcileResult.inspected === 1
    && reconcileResult.requeued === 1
    && reconcileResult.deadLettered === 0
    && reconcileResult.ignored === 0;
  assert.deepEqual(reconcileResult, { inspected: 1, requeued: 1, deadLettered: 0, ignored: 0 });
  const reconciledState = await crashState(target, created.version.id);
  observation.version_state = observedVersionState(reconciledState.version_state);
  observation.scan_state = observedScanState(reconciledState.scan_state);
  observation.attempt_count = observedCount(reconciledState.attempt_count);
  assert.equal(reconciledState.version_state, "scan_failed");
  setStage("crash_after_claim_recovery_redelivery");
  await makeVisible(sqs, queueUrl, overlap);
  const retry = await receiveMessage(sqs, queueUrl);
  observation.redelivery_count = observedCount(retry.Attributes?.ApproximateReceiveCount);
  const recoveredDisposition = await documentMessageDisposition(
    retry,
    BUCKET,
    (redelivery) => processDocumentObjectCreated(redelivery, dependencies),
  );
  observation.recovered_disposition = recoveredDisposition;
  assert.equal(recoveredDisposition, "delete");
  setStage("crash_after_claim_recovery_delete");
  await deleteMessage(sqs, queueUrl, retry);
  observation.delete_completed = true;
  setStage("crash_after_claim_recovery_authority");
  await waitForDocumentState(
    baseUrl, cookie, caseId, document.id, "available", true,
    (result, authority) => {
      observation.authority.request_completed = true;
      observation.authority.response_completed = true;
      observation.authority.http_status = result.response.status;
      if (authority) recordAuthority(observation.authority, authority);
    },
  );
  setStage("crash_after_claim_recovery_terminal");
  const terminal = await crashState(target, created.version.id);
  observation.version_state = observedVersionState(terminal.version_state);
  observation.scan_state = observedScanState(terminal.scan_state);
  observation.attempt_count = observedCount(terminal.attempt_count);
  assert.equal(terminal.version_state, "available");
  assert.equal(terminal.scan_state, "clean");
  assert.equal(terminal.attempt_count, 2);
  observation.completed = true;
}

async function waitForStuckScanCandidate(
  repository: PostgresqlDocumentScanRepository,
  documentVersionId: string,
): Promise<Readonly<{
  candidateCount: number;
  exactTarget: boolean;
  kindStuckScan: boolean;
}>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const candidates = await repository.findReconciliationCandidates({
      nowMs: Date.now(),
      staleAfterMs: 1,
      limit: 10,
    });
    const candidate = candidates[0];
    const exactTarget = candidate?.documentVersionId === documentVersionId;
    const kindStuckScan = candidate?.kind === "stuck_scan";
    if (candidates.length === 1 && exactTarget && kindStuckScan) {
      return Object.freeze({ candidateCount: 1, exactTarget, kindStuckScan });
    }
    await delay(25);
  }
  throw new HarnessError("crash_after_claim_recovery_readiness");
}

async function assertAbandonedCleanupDlq(input: {
  readonly baseUrl: string;
  readonly cookie: string;
  readonly caseId: string;
  readonly suffix: string;
  readonly localstackEndpoint: string;
  readonly target: OneRoleBaselineTarget;
  readonly sqs: SQSClient;
  readonly s3: S3Client;
  readonly queueUrl: string;
  readonly deadLetterQueueUrl: string;
  readonly dependencies: ScanDependencies;
  readonly ordinaryDeadLetter: Message;
  readonly setStage: (value: string) => void;
  readonly observation: AbandonedCleanupDlqObservation;
}): Promise<void> {
  input.setStage("abandoned_cleanup_dlq_register");
  const document = await registerDocumentObserved(
    input.baseUrl,
    input.cookie,
    input.caseId,
    "Synthetic DOC-02 cleanup DLQ evidence",
    `doc02-cleanup-dlq-document-${input.suffix}`,
    input.observation.registration,
  );
  input.setStage("abandoned_cleanup_dlq_version_put");
  const created = await createVersionAndPut({
    baseUrl: input.baseUrl,
    cookie: input.cookie,
    caseId: input.caseId,
    document,
    bytes: NEWER_BYTES,
    contentType: "application/pdf",
    localstackEndpoint: input.localstackEndpoint,
  });
  input.observation.version_put_completed = true;
  input.setStage("abandoned_cleanup_dlq_abandonment");
  const abandonmentResult = await postJson(
    input.baseUrl,
    abandonmentPath(input.caseId, document.id, created.version.id),
    input.cookie,
    `doc02-cleanup-dlq-abandon-${input.suffix}`,
    { expected_document_record_version: 2, expected_version_record_version: 1 },
  );
  input.observation.abandonment_http_status = abandonmentResult.response.status;
  assertVersionReceipt(abandonmentResult, 200, 2);
  input.observation.abandonment_exact = true;

  const deleteFailure = Object.freeze({
    ...input.dependencies,
    objectCleaner: Object.freeze({
      async deleteExact() {
        throw new Error("synthetic bounded delete failure");
      },
    }),
  }) as unknown as ScanDependencies;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const attemptEvidence = input.observation.attempts[attempt - 1]!;
    input.setStage(`abandoned_cleanup_dlq_attempt_${attempt}_receive`);
    const message = await receiveMessage(input.sqs, input.queueUrl);
    attemptEvidence.receive_completed = true;
    attemptEvidence.receive_count = observedCount(message.Attributes?.ApproximateReceiveCount);
    assert.equal(message.Attributes?.ApproximateReceiveCount, String(attempt));
    input.setStage(`abandoned_cleanup_dlq_attempt_${attempt}_process`);
    const disposition = await documentMessageDisposition(
      message,
      BUCKET,
      (event) => processDocumentObjectCreated(event, deleteFailure),
    );
    attemptEvidence.disposition = disposition;
    assert.equal(disposition, "retain");
    input.setStage(`abandoned_cleanup_dlq_attempt_${attempt}_visibility`);
    await makeVisible(input.sqs, input.queueUrl, message);
    attemptEvidence.visibility_reset = true;
  }
  input.setStage("abandoned_cleanup_dlq_main_empty");
  const mainAfterRetries = await receiveMessageOrNull(input.sqs, input.queueUrl, 3);
  input.observation.main_empty = mainAfterRetries === null;
  assert.equal(mainAfterRetries, null);
  input.setStage("abandoned_cleanup_dlq_receive");
  const cleanupDeadLetter = await receiveMessage(input.sqs, input.deadLetterQueueUrl);
  input.observation.cleanup_dlq_received = true;
  input.setStage("abandoned_cleanup_dlq_disposition");
  const cleanupDisposition = await documentDeadLetterMessageDisposition(
    cleanupDeadLetter,
    BUCKET,
    (event) => processDocumentCleanupFromDeadLetter(event, {
      receiptService: input.dependencies.receiptService,
      objectCleaner: input.dependencies.objectCleaner,
    }),
  );
  input.observation.cleanup_dlq_disposition = cleanupDisposition;
  assert.equal(cleanupDisposition, "delete");
  input.setStage("abandoned_cleanup_dlq_delete");
  await deleteMessage(input.sqs, input.deadLetterQueueUrl, cleanupDeadLetter);
  input.observation.cleanup_dlq_deleted = true;
  input.setStage("abandoned_cleanup_dlq_object_absent");
  const objectAbsent = await exactObjectVersionsAbsent(
    input.s3,
    created.objectKey,
    [created.providerVersionId],
  );
  input.observation.object_absent = objectAbsent;
  assert.equal(objectAbsent, true);
  input.setStage("abandoned_cleanup_dlq_effects");
  const effectCounts = await cleanupEffectCount(input.target, created.version.id);
  input.observation.audit_count = observedCount(effectCounts.audit);
  input.observation.outbox_count = observedCount(effectCounts.outbox);
  assert.deepEqual(effectCounts, {
    audit: 1,
    outbox: 1,
  });

  input.setStage("abandoned_cleanup_dlq_restore_ordinary");
  await makeVisible(input.sqs, input.deadLetterQueueUrl, input.ordinaryDeadLetter);
  input.observation.ordinary_restored = true;
  input.setStage("abandoned_cleanup_dlq_receive_ordinary");
  const ordinaryAgain = await receiveMessage(input.sqs, input.deadLetterQueueUrl);
  input.observation.ordinary_received = true;
  input.observation.ordinary_same_message = ordinaryAgain.MessageId === input.ordinaryDeadLetter.MessageId;
  assert.equal(input.observation.ordinary_same_message, true);
  input.setStage("abandoned_cleanup_dlq_ordinary_disposition");
  const ordinaryDisposition = await documentDeadLetterMessageDisposition(
    ordinaryAgain,
    BUCKET,
    (event) => processDocumentCleanupFromDeadLetter(event, {
      receiptService: input.dependencies.receiptService,
      objectCleaner: input.dependencies.objectCleaner,
    }),
  );
  input.observation.ordinary_disposition = ordinaryDisposition;
  assert.equal(ordinaryDisposition, "retain");
  input.observation.completed = true;
}

async function receiptRollbackState(target: OneRoleBaselineTarget, documentVersionId: string) {
  return tenantRead(target, async (client) => {
    const result = await client.query<{
      state: string;
      bound: number;
      scans: number;
      receipt_audit: number;
      receipt_outbox: number;
    }>(`SELECT version.state,
      (version.object_version_id IS NOT NULL)::int AS bound,
      (SELECT count(*)::int FROM documents_scan_results scan
        WHERE scan.organization_id=version.organization_id
          AND scan.document_version_id=version.id) AS scans,
      (SELECT count(*)::int FROM audit_events event
        WHERE event.organization_id=version.organization_id AND event.resource_id=version.id
          AND event.event_type IN ('documents.object_received','documents.object_rejected')) AS receipt_audit,
      (SELECT count(*)::int FROM audit_outbox message
        WHERE message.organization_id=version.organization_id AND message.aggregate_id=version.id
          AND message.event_type IN ('documents.object_received','documents.object_rejected')) AS receipt_outbox
      FROM documents_document_versions version
      WHERE version.organization_id=$1 AND version.id=$2`, [ORGANIZATION_ID, documentVersionId]);
    const row = result.rows[0];
    if (!row) throw new HarnessError("receipt_rollback_state");
    return Object.freeze({
      state: row.state,
      bound: Number(row.bound),
      scans: Number(row.scans),
      receipt_audit: Number(row.receipt_audit),
      receipt_outbox: Number(row.receipt_outbox),
    });
  });
}

async function crashState(target: OneRoleBaselineTarget, documentVersionId: string) {
  return tenantRead(target, async (client) => {
    const result = await client.query<{
      version_state: string;
      scan_state: string;
      attempt_count: number;
    }>(`SELECT version.state AS version_state,scan.state AS scan_state,scan.attempt_count
      FROM documents_document_versions version
      JOIN documents_scan_results scan
        ON scan.organization_id=version.organization_id AND scan.document_version_id=version.id
      WHERE version.organization_id=$1 AND version.id=$2`, [ORGANIZATION_ID, documentVersionId]);
    const row = result.rows[0];
    if (!row) throw new HarnessError("crash_state");
    return Object.freeze({
      version_state: row.version_state,
      scan_state: row.scan_state,
      attempt_count: Number(row.attempt_count),
    });
  });
}

async function cleanupEffectCount(
  target: OneRoleBaselineTarget,
  documentVersionId: string,
): Promise<Readonly<{ audit: number; outbox: number }>> {
  return tenantRead(target, async (client) => {
    const result = await client.query<{ audit: number; outbox: number }>(`SELECT
      (SELECT count(*)::int FROM audit_events
        WHERE organization_id=$1 AND resource_id=$2
          AND event_type='documents.abandoned_object_removed') AS audit,
      (SELECT count(*)::int FROM audit_outbox
        WHERE organization_id=$1 AND aggregate_id=$2
          AND event_type='documents.abandoned_object_removed') AS outbox`, [
      ORGANIZATION_ID,
      documentVersionId,
    ]);
    const row = result.rows[0];
    if (!row) throw new HarnessError("cleanup_effect_counts");
    return Object.freeze({ audit: Number(row.audit), outbox: Number(row.outbox) });
  });
}

async function createIsolatedAppDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tianxing-doc02-http-next-"));
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
    throw new HarnessError("next_dev");
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
    SQS_ENDPOINT_STRATEGY: "path",
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
  child.stdout?.on("data", (chunk: string) => {
    logs.stdout = boundedLog(`${logs.stdout}${chunk}`);
  });
  child.stderr?.on("data", (chunk: string) => {
    logs.stderr = boundedLog(`${logs.stderr}${chunk}`);
  });
  PROCESS_LOGS.set(child, logs);
}

function boundedLog(value: string): string {
  return value.length <= 1_000_000 ? value : value.slice(value.length - 1_000_000);
}

function sensitiveProcessLogMatches(
  child: ChildProcess | undefined,
  forbidden: readonly SensitiveLogMarker[],
): SensitiveLogCounts {
  assert.notEqual(child, undefined);
  const logs = PROCESS_LOGS.get(child!);
  assert.notEqual(logs, undefined);
  const deduplicated = new Map<string, SensitiveLogCategory>();
  for (const marker of forbidden) {
    if (marker.value !== "" && !deduplicated.has(marker.value)) {
      deduplicated.set(marker.value, marker.category);
    }
  }
  const stdout = emptySensitiveLogCategoryCounts();
  const stderr = emptySensitiveLogCategoryCounts();
  for (const [value, category] of deduplicated) {
    if (logs!.stdout.includes(value)) stdout[category] += 1;
    if (logs!.stderr.includes(value)) stderr[category] += 1;
  }
  const total = SENSITIVE_LOG_CATEGORIES.reduce(
    (sum, category) => sum + stdout[category] + stderr[category],
    0,
  );
  return Object.freeze({
    stdout: Object.freeze(stdout),
    stderr: Object.freeze(stderr),
    total,
  });
}

function emptySensitiveLogCategoryCounts(): Record<SensitiveLogCategory, number> {
  return {
    fixture_bytes: 0,
    object_coordinate: 0,
    content_contract: 0,
    service_coordinate: 0,
    signed_capability: 0,
    database_endpoint: 0,
    runtime_private: 0,
  };
}

async function waitForProcessLog(
  child: ChildProcess,
  marker: string,
  stage: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (processExited(child)) throw new HarnessError(stage);
    const logs = PROCESS_LOGS.get(child);
    if (logs?.stdout.includes(marker) || logs?.stderr.includes(marker)) return;
    await delay(250);
  }
  throw new HarnessError(stage);
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  child.stdout?.resume();
  child.stderr?.resume();
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (processExited(child)) throw new HarnessError("next_dev");
    try {
      if ((await fetch(`${baseUrl}/api/v1/auth/me`)).status === 401) return;
    } catch {}
    await delay(500);
  }
  throw new HarnessError("next_dev");
}

async function stopProcess(child: ChildProcess | undefined): Promise<boolean> {
  if (!child) return true;
  const pid = child.pid;
  if (pid === undefined) return processExited(child);
  const closed = processExited(child)
    ? Promise.resolve(true)
    : new Promise<boolean>((resolveStopped) => child.once("close", () => resolveStopped(true)));
  signalProcessGroup(pid, "SIGTERM", child);
  await Promise.race([closed, delay(15_000).then(() => false)]);
  if (processGroupAlive(pid)) {
    signalProcessGroup(pid, "SIGKILL", child);
    await Promise.race([closed, delay(5_000).then(() => false)]);
  }
  for (let attempt = 0; attempt < 50 && processGroupAlive(pid); attempt += 1) await delay(100);
  return processExited(child) && !processGroupAlive(pid);
}

function processExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function safeProcessExitCode(child: ChildProcess): number | null {
  const exitCode = child.exitCode;
  return exitCode !== null && (SAFE_WORKER_EXIT_CODES as readonly number[]).includes(exitCode)
    ? exitCode
    : null;
}

function safeProcessSignal(child: ChildProcess): NodeJS.Signals | null {
  const signal = child.signalCode;
  return signal !== null && (SAFE_WORKER_EXIT_SIGNALS as readonly NodeJS.Signals[]).includes(signal)
    ? signal
    : null;
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

async function removeDirectory(directory: string): Promise<boolean> {
  if (!directory) return true;
  try {
    await rm(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
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
  } catch {
    throw new HarnessError("baseline_inspection");
  } finally {
    await client.end().catch(() => {});
  }
}

function assertDatabaseContract(
  state: OneRoleBaselineDatabaseState,
  target: OneRoleBaselineTarget,
  manifestSha256: string,
): void {
  assertOneRoleBaselinePostflight({ state, target, mode: "apply", manifestSha256 });
  assert.equal(state.marker?.baselineId, ONE_ROLE_BASELINE_ID);
  assert.equal(state.marker?.transformVersion, ONE_ROLE_TRANSFORM_VERSION);
  assert.equal(state.marker?.sourceMigrationCount, ONE_ROLE_SOURCE_COUNT);
  assert.equal(state.marker?.manifestSha256, manifestSha256);
  assert.equal(state.userName, ONE_ROLE_CANONICAL_ROLE);
  assert.equal(state.databaseOwner, ONE_ROLE_CANONICAL_ROLE);
  assert.equal(state.login, true);
  assert.equal(state.superuser, false);
  assert.equal(state.createDatabase, false);
  assert.equal(state.createRole, false);
  assert.equal(state.inherit, false);
  assert.equal(state.replication, false);
  assert.equal(state.bypassRls, false);
  assert.equal(state.grantedRoleCount, 0);
  assert.equal(state.publicWrongOwnerCount, 0);
  assert.equal(state.rlsNotForcedCount, 0);
  assert.equal(state.unsafeSecurityDefinerCount, 0);
  assert.equal(state.migrationSchemaPresent, false);
  assert.equal(state.migrationLedgerPresent, false);
  assert.equal(state.staleDryRunSchemaCount, 0);
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
  throw new HarnessError("postgres_setup");
}

async function waitForPublishedPort(
  containerName: string,
  containerPort: string,
  stage: string,
): Promise<number> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await runDocker(["port", containerName, containerPort], stage, undefined, true);
    if (result.exitCode === 0 && result.stdout.trim() !== "") {
      return readLoopbackPort(result.stdout, stage);
    }
    await delay(250);
  }
  throw new HarnessError(stage);
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
  throw new HarnessError("localstack_setup");
}

async function waitForClamAv(port: number): Promise<void> {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    if (await pingClamAv(port)) return;
    await delay(500);
  }
  throw new HarnessError("clamav_setup");
}

async function probeClamAvEicar(
  port: number,
  bytes: Uint8Array,
  observation: {
    runtime_generated: boolean;
    byte_length: number;
    checksum_contract: boolean;
    command_completed: boolean;
    response_received: boolean;
    response_parseable: boolean;
    found: boolean;
    verdict_malicious: boolean;
  },
): Promise<void> {
  if (
    !observation.runtime_generated
    || observation.byte_length !== 68
    || !observation.checksum_contract
    || bytes.length !== 68
  ) {
    throw new HarnessError("clamav_eicar_probe");
  }
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = Buffer.alloc(0);
    let settled = false;
    const deadline = setTimeout(() => finish(false), 5_000);
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      response.fill(0);
      response = Buffer.alloc(0);
      socket.destroy();
      if (success) resolveProbe();
      else rejectProbe(new HarnessError("clamav_eicar_probe"));
    };
    const parseResponse = () => {
      if (!observation.command_completed) return;
      const terminator = response.indexOf(0);
      if (terminator < 0) return;
      if (response.subarray(terminator + 1).length !== 0) return finish(false);
      const line = response.subarray(0, terminator).toString("utf8");
      observation.response_parseable =
        line === "stream: OK" || /^stream: .+ FOUND$/u.test(line);
      observation.found = /^stream: .+ FOUND$/u.test(line);
      observation.verdict_malicious = observation.found;
      finish(observation.response_parseable && observation.verdict_malicious);
    };
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.on("data", (chunk: Buffer) => {
      if (response.length + chunk.length > 4_096) return finish(false);
      observation.response_received = true;
      response = Buffer.concat([response, chunk]);
      parseResponse();
    });
    socket.once("connect", () => {
      void (async () => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        await writeProbeFrame(socket, Buffer.from("zINSTREAM\0", "ascii"));
        await writeProbeFrame(socket, length);
        await writeProbeFrame(socket, bytes);
        await writeProbeFrame(socket, Buffer.alloc(4));
        observation.command_completed = true;
        parseResponse();
      })().catch(() => finish(false));
    });
  });
}

function writeProbeFrame(socket: Socket, value: Uint8Array): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    socket.write(value, (error) => {
      if (error) rejectWrite(new HarnessError("clamav_eicar_probe"));
      else resolveWrite();
    });
  });
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

function readLoopbackPort(output: string, stage: string): number {
  const port = Number(/^127\.0\.0\.1:([0-9]+)\s*$/u.exec(output)?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new HarnessError(stage);
  return port;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => reject(new HarnessError("runtime_preflight")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error
        ? reject(new HarnessError("runtime_preflight"))
        : resolvePort(port));
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class HarnessError extends Error {
  readonly stage: string;

  constructor(stage: string) {
    super(`DOC-02 HTTP gate failed at ${stage}.`);
    this.name = "HarnessError";
    this.stage = stage;
  }
}

async function runDocker(
  arguments_: readonly string[],
  stage: string,
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
    child.once("error", () => reject(new HarnessError(stage)));
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !allowFailure) reject(new HarnessError(stage));
      else resolveRun(Object.freeze({ exitCode, stdout }));
    });
    child.stdin.end(input);
  });
}
