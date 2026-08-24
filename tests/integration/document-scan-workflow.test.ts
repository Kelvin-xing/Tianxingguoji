import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateDocumentVersionDownload,
  createOpaqueDocumentObjectKey,
  type DocumentRecord,
  type DocumentVersionRecord,
} from "../../modules/documents/domain/contract.ts";
import {
  DocumentScanRuntimeUnavailable,
  getDocumentScanRuntime,
} from "../../modules/documents/infrastructure/scan-runtime.ts";
import { DocumentScanService } from "../../modules/documents/application/scan-service.ts";
import {
  DocumentScanDeadLetterWorkerError,
  DocumentScanRetryableWorkerError,
  processDocumentScanEvent,
} from "../../workers/scan-document.ts";
import { reconcileDocumentScans } from "../../workers/reconcile-documents.ts";
import { SyntheticScannerFake } from "../fakes/scanner.ts";
import { InMemoryDocumentScanRepository } from "../fakes/document-scan.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const BUCKET = "synthetic-private-document-bucket";
const VERSION_ID = "s3-version-01";
const POLICY = "scanner-v1";

class FixedClock {
  nowMs(): number {
    return 1_785_600_000_000;
  }
}

function createEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "s3-event-p1-11-001",
    requestId: "document-scan-p1-11-001",
    bucket: BUCKET,
    key: createOpaqueDocumentObjectKey(DOCUMENT_ID, DOCUMENT_VERSION_ID),
    versionId: VERSION_ID,
    scanPolicyVersion: POLICY,
    deliveryAttempt: 1,
    ...overrides,
  };
}

function createService(
  repository: InMemoryDocumentScanRepository,
  publish: () => Promise<void> = async () => undefined,
) {
  let nextId = 500;
  return new DocumentScanService({
    repository,
    requeuePublisher: { publish },
    clock: new FixedClock(),
    createId: () => {
      nextId += 1;
      return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
    },
  });
}

function readyRepository(): InMemoryDocumentScanRepository {
  const repository = new InMemoryDocumentScanRepository();
  repository.registerQuarantinedVersion({
    organizationId: ORGANIZATION_ID,
    documentVersionId: DOCUMENT_VERSION_ID,
    bucket: BUCKET,
    key: createOpaqueDocumentObjectKey(DOCUMENT_ID, DOCUMENT_VERSION_ID),
    versionId: VERSION_ID,
  });
  return repository;
}

test("only a clean result can make a quarantined version available, and an exact duplicate scans once", async () => {
  const repository = readyRepository();
  const service = createService(repository);
  const scanner = new SyntheticScannerFake("clean");
  const event = createEvent();

  assert.deepEqual(downloadDecision("quarantined"), {
    allowed: false,
    code: "DOCUMENT_VERSION_NOT_AVAILABLE",
  });
  const result = await processDocumentScanEvent(event, { service, scanner });
  assert.deepEqual(result, { status: "available", workId: result.workId });
  assert.equal(repository.state(event), "available");
  assert.equal(scanner.calls().length, 1);

  const duplicate = await processDocumentScanEvent(event, { service, scanner });
  assert.deepEqual(duplicate, { status: "duplicate", workId: result.workId });
  assert.equal(scanner.calls().length, 1);
  assert.deepEqual(repository.snapshot(), {
    versions: 1,
    works: 1,
    audits: 2,
    outbox: 2,
  });
});

test("malicious output is rejected and never becomes downloadable", async () => {
  const repository = readyRepository();
  const service = createService(repository);
  const result = await processDocumentScanEvent(createEvent(), {
    service,
    scanner: new SyntheticScannerFake("malicious"),
  });

  assert.equal(result.status, "rejected");
  assert.equal(repository.state(createEvent()), "rejected");
  assert.deepEqual(downloadDecision("rejected"), {
    allowed: false,
    code: "DOCUMENT_VERSION_NOT_AVAILABLE",
  });
});

test("bounded retry treats an exact replay as a duplicate and sends the third failure to DLQ", async () => {
  const repository = readyRepository();
  const service = createService(repository);
  const scanner = new SyntheticScannerFake("timeout", "timeout", "timeout");
  const first = createEvent();

  await assert.rejects(
    processDocumentScanEvent(first, { service, scanner }),
    DocumentScanRetryableWorkerError,
  );
  assert.equal(repository.state(first), "scan_failed");
  assert.equal(repository.work(first)?.attemptCount, 1);
  assert.equal(scanner.calls().length, 1);

  await assert.rejects(
    processDocumentScanEvent(first, { service, scanner }),
    DocumentScanRetryableWorkerError,
  );
  assert.equal(scanner.calls().length, 1);

  await assert.rejects(
    processDocumentScanEvent(createEvent({ deliveryAttempt: 2 }), { service, scanner }),
    DocumentScanRetryableWorkerError,
  );
  await assert.rejects(
    processDocumentScanEvent(createEvent({ deliveryAttempt: 3 }), { service, scanner }),
    DocumentScanDeadLetterWorkerError,
  );
  assert.equal(repository.state(first), "scan_failed");
  assert.equal(repository.work(first)?.attemptCount, 3);
  assert.equal(repository.work(first)?.state, "failed");
  assert.equal(scanner.calls().length, 3);
  assert.deepEqual(downloadDecision("scan_failed"), {
    allowed: false,
    code: "DOCUMENT_VERSION_NOT_AVAILABLE",
  });
});

test("reconciliation finds missed and stuck work without unsafe availability", async () => {
  const repository = readyRepository();
  const service = createService(repository);
  const event = createEvent();
  repository.addReconciliationCandidate({
    kind: "missed_event",
    organizationId: ORGANIZATION_ID,
    documentVersionId: DOCUMENT_VERSION_ID,
    bucket: BUCKET,
    key: event.key,
    versionId: VERSION_ID,
    scanPolicyVersion: POLICY,
    attemptCount: 0,
    observedUpdatedAtMs: Date.UTC(2026, 7, 1),
  });
  const first = await reconcileDocumentScans(
    { staleAfterMs: 60_000, limit: 10 },
    { service },
  );
  assert.deepEqual(first, { inspected: 1, requeued: 1, deadLettered: 0, ignored: 0 });
  assert.equal(repository.state(event), "quarantined");

  await assert.rejects(
    processDocumentScanEvent(event, { service, scanner: new SyntheticScannerFake("timeout") }),
    DocumentScanRetryableWorkerError,
  );
  assert.equal(repository.state(event), "scan_failed");

  const stuckRepository = readyRepository();
  const stuckService = createService(stuckRepository);
  await stuckService.claimScanWork(event);
  assert.equal(stuckRepository.state(event), "scanning");
  stuckRepository.addReconciliationCandidate({
    kind: "stuck_scan",
    organizationId: ORGANIZATION_ID,
    documentVersionId: DOCUMENT_VERSION_ID,
    bucket: BUCKET,
    key: event.key,
    versionId: VERSION_ID,
    scanPolicyVersion: POLICY,
    attemptCount: 1,
    observedUpdatedAtMs: Date.UTC(2026, 7, 1),
  });
  const second = await reconcileDocumentScans(
    { staleAfterMs: 60_000, limit: 10 },
    { service: stuckService },
  );
  assert.deepEqual(second, { inspected: 1, requeued: 1, deadLettered: 0, ignored: 0 });
  assert.equal(stuckRepository.state(event), "scan_failed");
  assert.deepEqual(downloadDecision("scan_failed"), {
    allowed: false,
    code: "DOCUMENT_VERSION_NOT_AVAILABLE",
  });

  // A completed failed attempt is not a stuck scan, so this stale candidate is ignored.
  repository.addReconciliationCandidate({
    kind: "stuck_scan",
    organizationId: ORGANIZATION_ID,
    documentVersionId: DOCUMENT_VERSION_ID,
    bucket: BUCKET,
    key: event.key,
    versionId: VERSION_ID,
    scanPolicyVersion: POLICY,
    attemptCount: 1,
    observedUpdatedAtMs: Date.UTC(2026, 7, 1),
  });
  const ignored = await reconcileDocumentScans(
    { staleAfterMs: 60_000, limit: 10 },
    { service },
  );
  assert.deepEqual(ignored, { inspected: 1, requeued: 0, deadLettered: 0, ignored: 1 });
  assert.equal(repository.state(event), "scan_failed");
});

test("missed-event reconciliation publishes before one durable effect and rolls back on publish failure", async () => {
  const repository = readyRepository();
  const event = createEvent();
  repository.addReconciliationCandidate({
    kind: "missed_event",
    organizationId: ORGANIZATION_ID,
    documentVersionId: DOCUMENT_VERSION_ID,
    bucket: BUCKET,
    key: event.key,
    versionId: VERSION_ID,
    scanPolicyVersion: POLICY,
    attemptCount: 0,
    observedUpdatedAtMs: Date.UTC(2026, 7, 1),
  });
  const failed = createService(repository, async () => {
    throw new Error("synthetic queue unavailable");
  });
  await assert.rejects(
    () => failed.reconcileDocumentScans({ staleAfterMs: 90_000, limit: 10 }),
    /synthetic queue unavailable/u,
  );
  assert.deepEqual(repository.snapshot(), { versions: 1, works: 0, audits: 0, outbox: 0 });

  let publishes = 0;
  const recovered = createService(repository, async () => { publishes += 1; });
  assert.deepEqual(
    await recovered.reconcileDocumentScans({ staleAfterMs: 90_000, limit: 10 }),
    { inspected: 1, requeued: 1, deadLettered: 0, ignored: 0 },
  );
  assert.equal(publishes, 1);
  assert.deepEqual(repository.snapshot(), { versions: 1, works: 0, audits: 1, outbox: 1 });
});

test("a repository failure commits no scan state, work, audit, or outbox facts", async () => {
  const repository = readyRepository();
  repository.failOnceBeforeCommit();
  const service = createService(repository);

  await assert.rejects(
    processDocumentScanEvent(createEvent(), { service, scanner: new SyntheticScannerFake("clean") }),
    /synthetic scan transaction failure/,
  );
  assert.equal(repository.state(createEvent()), "quarantined");
  assert.deepEqual(repository.snapshot(), { versions: 1, works: 0, audits: 0, outbox: 0 });
});

test("effects contain no object tuple, scanner detail, or document content and runtime fails closed", async () => {
  const repository = readyRepository();
  const service = createService(repository);
  await processDocumentScanEvent(createEvent(), { service, scanner: new SyntheticScannerFake("clean") });
  const effects = repository.effectPayload();
  assert.equal(effects.includes(BUCKET), false);
  assert.equal(effects.includes(VERSION_ID), false);
  assert.equal(effects.includes("scanner-v1"), false);
  assert.equal(effects.includes("documents/"), false);
  assert.throws(() => getDocumentScanRuntime(), DocumentScanRuntimeUnavailable);
});

function downloadDecision(state: DocumentVersionRecord["state"]) {
  const document: DocumentRecord = {
    id: DOCUMENT_ID,
    organizationId: ORGANIZATION_ID,
    owner: { kind: "case", id: "44444444-4444-4444-8444-444444444444" },
    classification: "application_material",
    lifecycleState: "active",
    activeVersionId: null,
    legalHold: false,
    legalHoldReason: null,
    softDeletedAt: null,
    retentionEndsAt: null,
    recordVersion: 1,
  };
  const version: DocumentVersionRecord = {
    id: DOCUMENT_VERSION_ID,
    organizationId: ORGANIZATION_ID,
    documentId: DOCUMENT_ID,
    object: {
      region: "ap-east-1",
      bucket: BUCKET,
      key: createOpaqueDocumentObjectKey(DOCUMENT_ID, DOCUMENT_VERSION_ID),
      versionId: VERSION_ID,
    },
    checksumSha256: "a".repeat(64),
    sizeBytes: 1,
    detectedContentType: "application/pdf",
    uploadedBy: "55555555-5555-4555-8555-555555555555",
    state,
    revokedAt: null,
    recordVersion: 1,
  };
  return evaluateDocumentVersionDownload({ document, version });
}
