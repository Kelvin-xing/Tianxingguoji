import assert from "node:assert/strict";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { Message } from "@aws-sdk/client-sqs";

import {
  DocumentScanService,
  type DocumentScanEvent,
  type DocumentScanRepository,
  type DocumentScanWork,
} from "../../../modules/documents/application/scan-service.ts";
import { createOpaqueDocumentObjectKey } from "../../../modules/documents/domain/contract.ts";
import {
  processDocumentAbandonedCleanup,
  processDocumentCleanupFromDeadLetter,
  DocumentScanRetryableWorkerError,
  processDocumentObjectCreated,
  processDocumentScanEvent,
  processDocumentUnboundProviderVersionCleanup,
} from "../../../workers/scan-document.ts";
import {
  DOCUMENT_WORKER_MAIN_DELETE_COMPLETED_MARKER,
  DOCUMENT_WORKER_MAIN_DELETE_REQUESTED_MARKER,
  DocumentWorkerUnavailable,
  documentDeadLetterMessageDisposition,
  documentMessageDisposition,
  emitDocumentWorkerSafeEvidence,
  isDirectDocumentWorkerEntry,
  isDocumentS3TestEventMessage,
  parseDocumentObjectCreatedMessage,
  validateLocalQueueUrl,
} from "../../../workers/document-worker.ts";

const IDS = Object.freeze({
  organization: "51000000-0000-4000-8000-000000000001",
  document: "81000000-0000-4000-8000-000000000001",
  version: "81000000-0000-4000-8000-000000000002",
  work: "81000000-0000-4000-8000-000000000003",
});
const BUCKET = "tianxing-documents-local";
const KEY = createOpaqueDocumentObjectKey(IDS.document, IDS.version);

test("emits only fixed main delete evidence behind the exact local test switch", () => {
  const emitted: string[] = [];
  const write = (value: string) => { emitted.push(value); };
  const enabled = Object.freeze({
    APP_RUNTIME_MODE: "local-synthetic",
    LOCAL_SYNTHETIC_DOCUMENT_WORKER_SAFE_EVIDENCE: "1",
  });

  emitDocumentWorkerSafeEvidence(
    DOCUMENT_WORKER_MAIN_DELETE_REQUESTED_MARKER,
    enabled,
    write,
  );
  emitDocumentWorkerSafeEvidence(
    DOCUMENT_WORKER_MAIN_DELETE_COMPLETED_MARKER,
    enabled,
    write,
  );
  assert.deepEqual(emitted, [
    `${DOCUMENT_WORKER_MAIN_DELETE_REQUESTED_MARKER}\n`,
    `${DOCUMENT_WORKER_MAIN_DELETE_COMPLETED_MARKER}\n`,
  ]);

  for (const environment of [
    { ...enabled, APP_RUNTIME_MODE: "production-aws" },
    { ...enabled, LOCAL_SYNTHETIC_DOCUMENT_WORKER_SAFE_EVIDENCE: "0" },
    { APP_RUNTIME_MODE: "local-synthetic" },
  ]) {
    emitDocumentWorkerSafeEvidence(
      DOCUMENT_WORKER_MAIN_DELETE_REQUESTED_MARKER,
      environment,
      write,
    );
  }
  emitDocumentWorkerSafeEvidence("document-worker-private-value", enabled, write);
  assert.equal(emitted.length, 2);
});

test("recognizes canonical and aliased direct worker entry paths fail closed", async () => {
  const workerPath = resolve("workers/document-worker.ts");
  const workerUrl = pathToFileURL(workerPath).href;
  assert.equal(isDirectDocumentWorkerEntry(workerPath, workerUrl), true);
  assert.equal(isDirectDocumentWorkerEntry(undefined, workerUrl), false);
  assert.equal(
    isDirectDocumentWorkerEntry(resolve("package.json"), workerUrl),
    false,
  );
  assert.equal(
    isDirectDocumentWorkerEntry(resolve("workers/missing-document-worker.ts"), workerUrl),
    false,
  );

  const directory = await mkdtemp(join(tmpdir(), "document-worker-entry-"));
  const aliasPath = join(directory, "document-worker-alias.ts");
  try {
    await symlink(workerPath, aliasPath);
    assert.equal(
      isDirectDocumentWorkerEntry(
        aliasPath,
        pathToFileURL(realpathSync.native(aliasPath)).href,
      ),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an aliased worker executable enters main and fails with only its fixed category", async () => {
  const directory = await mkdtemp(join(tmpdir(), "document-worker-process-"));
  const aliasPath = join(directory, "document-worker-alias.ts");
  try {
    await symlink(resolve("workers/document-worker.ts"), aliasPath);
    const child = spawn(process.execPath, [
      "--no-warnings",
      "--conditions=react-server",
      aliasPath,
    ], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        APP_RUNTIME_MODE: "production-aws",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    assert.equal(code, 1);
    assert.equal(signal, null);
    assert.equal(stdout, "");
    assert.equal(stderr, "document-worker-unavailable\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parses only one exact S3 Put event and aligns provider version at 1..1024", () => {
  const longProviderVersion = `v${"x".repeat(256)}`;
  const parsed = parseDocumentObjectCreatedMessage(message(2, longProviderVersion), BUCKET);
  assert.equal(parsed.deliveryAttempt, 2);
  assert.equal(parsed.versionId, longProviderVersion);

  for (const invalid of ["", "has space", "x".repeat(1025)]) {
    assert.throws(
      () => parseDocumentObjectCreatedMessage(message(1, invalid), BUCKET),
      DocumentWorkerUnavailable,
    );
  }
  assert.throws(
    () => parseDocumentObjectCreatedMessage(message(4, "provider-v1"), BUCKET),
    DocumentWorkerUnavailable,
  );
});

test("acknowledges only the exact S3 test event without a business callback", async () => {
  const exact = testEventMessage();
  assert.equal(isDocumentS3TestEventMessage(exact, BUCKET), true);
  assert.equal(isDocumentS3TestEventMessage(message(1, "provider-v1"), BUCKET), false);
  let processed = 0;
  assert.equal(await documentMessageDisposition(
    exact,
    BUCKET,
    async () => {
      processed += 1;
      return { status: "duplicate", workId: IDS.work } as const;
    },
  ), "delete");
  assert.equal(processed, 0);

  const exactBody = s3TestEventBody();
  const malformedBodies = [
    { ...exactBody, Bucket: "wrong-bucket" },
    { ...exactBody, Service: "Unknown" },
    { ...exactBody, Event: "s3:UnknownEvent" },
    { ...exactBody, Time: "" },
    { ...exactBody, RequestId: "x".repeat(257) },
    { ...exactBody, extra: true },
    { Records: [] },
    { unknown: "event" },
  ];
  for (const body of malformedBodies) {
    assert.equal(await documentMessageDisposition(
      testEventMessage(body),
      BUCKET,
      async () => {
        processed += 1;
        return { status: "duplicate", workId: IDS.work } as const;
      },
    ), "retain");
  }
  assert.equal(await documentMessageDisposition(
    testEventMessage(exactBody, { Attributes: { ApproximateReceiveCount: "4" } }),
    BUCKET,
  ), "retain");
  assert.equal(await documentMessageDisposition(
    testEventMessage(exactBody, { ReceiptHandle: "" }),
    BUCKET,
  ), "retain");
  assert.equal(await documentMessageDisposition(
    testEventMessage(exactBody, { Body: "{" }),
    BUCKET,
  ), "retain");
  assert.equal(processed, 0);
});

test("validates the LocalStack queue URL against exact loopback origin and queue", () => {
  const canonical =
    "http://127.0.0.1:4566/queue/ap-east-1/000000000000/tianxing-document-scan";
  assert.equal(
    validateLocalQueueUrl(
      canonical,
      "http://127.0.0.1:4566",
      "ap-east-1",
      "tianxing-document-scan",
    ),
    canonical,
  );
  assert.equal(
    validateLocalQueueUrl(
      "http://localhost.localstack.cloud:4566/queue/ap-east-1/000000000000/tianxing-document-scan",
      "http://127.0.0.1:4566",
      "ap-east-1",
      "tianxing-document-scan",
    ),
    canonical,
  );
  for (const invalid of [
    "http://outside.invalid/queue/ap-east-1/000000000000/tianxing-document-scan",
    "http://localhost:4566/queue/ap-east-1/000000000000/tianxing-document-scan",
    "http://localhost.localstack.cloud:4567/queue/ap-east-1/000000000000/tianxing-document-scan",
    "https://localhost.localstack.cloud:4566/queue/ap-east-1/000000000000/tianxing-document-scan",
    "http://sqs.ap-east-1.localhost.localstack.cloud:4566/000000000000/tianxing-document-scan",
    "http://ap-east-1.queue.localhost.localstack.cloud:4566/000000000000/tianxing-document-scan",
    "http://user:secret@127.0.0.1:4566/queue/ap-east-1/000000000000/tianxing-document-scan",
    "http://127.0.0.1:4566/000000000000/tianxing-document-scan",
    "http://127.0.0.1:4566/queue/us-east-1/000000000000/tianxing-document-scan",
    "http://127.0.0.1:4566/queue/ap-east-1/00000000000/tianxing-document-scan",
    "http://127.0.0.1:4566/queue/ap-east-1/111111111111/tianxing-document-scan",
    "http://127.0.0.1:4566/queue/ap-east-1/000000000000/other",
    "http://127.0.0.1:4566/extra/queue/ap-east-1/000000000000/tianxing-document-scan",
    "http://127.0.0.1:4566/queue/ap-east-1/000000000000/%74ianxing-document-scan",
    "http://127.0.0.1:4566/queue/ap-east-1/000000000000/tianxing-document-scan/",
    "http://127.0.0.1:4566/queue/ap-east-1/000000000000/tianxing-document-scan?token=private",
  ]) {
    assert.throws(
      () => validateLocalQueueUrl(
        invalid,
        "http://127.0.0.1:4566",
        "ap-east-1",
        "tianxing-document-scan",
      ),
      DocumentWorkerUnavailable,
    );
  }
  assert.throws(
    () => validateLocalQueueUrl(
      "http://127.0.0.1:4566/queue/ap-east-1/000000000000/tianxing-document-scan",
      "http://127.0.0.1:4566",
      "ap-east-1",
      "*",
    ),
    DocumentWorkerUnavailable,
  );
  for (const invalidEndpoint of [
    "http://127.0.0.1",
    "https://127.0.0.1:4566",
    "http://outside.invalid:4566",
    "http://user:secret@127.0.0.1:4566",
    "http://127.0.0.1:4566/path",
    "http://127.0.0.1:4566?private=1",
  ]) {
    assert.throws(
      () => validateLocalQueueUrl(
        canonical,
        invalidEndpoint,
        "ap-east-1",
        "tianxing-document-scan",
      ),
      DocumentWorkerUnavailable,
    );
  }
});

test("retains every pre-terminal failure and deletes only a durable terminal outcome", async () => {
  const receiveTwo = message(2, "provider-v1");
  assert.equal(await documentMessageDisposition(
    receiveTwo,
    BUCKET,
    async () => { throw new Error("synthetic pre-receipt crash"); },
  ), "retain");
  assert.equal(await documentMessageDisposition(
    receiveTwo,
    BUCKET,
    async () => { throw new DocumentScanRetryableWorkerError(); },
  ), "retain");
  assert.equal(await documentMessageDisposition(
    receiveTwo,
    BUCKET,
    async () => ({ status: "duplicate", workId: IDS.work }),
  ), "delete");
});

test("abandoned receipt skips HEAD and scan, deletes the exact provider version, then records effects", async () => {
  const event = scanEvent(1);
  let heads = 0;
  let scans = 0;
  let effects = 0;
  const deleted: unknown[] = [];
  const result = await processDocumentObjectCreated(event, {
    receiptService: {
      async receive() {
        return { status: "abandoned_cleanup", documentVersionId: IDS.version } as const;
      },
      async recordAbandonedObjectRemoval() {
        effects += 1;
        return { status: "recorded" } as const;
      },
    } as never,
    objectReader: {
      async headExact() {
        heads += 1;
        throw new Error("HEAD must remain lazy");
      },
    } as never,
    objectCleaner: {
      async deleteExact(input: unknown) {
        deleted.push(input);
        return "deleted" as const;
      },
    },
    service: {
      async claimScanWork() {
        scans += 1;
        throw new Error("scan must not start");
      },
    } as never,
    scanner: {
      async scan() {
        scans += 1;
        throw new Error("scan must not start");
      },
    },
  });

  assert.deepEqual(result, { status: "abandoned_removed" });
  assert.equal(heads, 0);
  assert.equal(scans, 0);
  assert.equal(effects, 1);
  assert.deepEqual(deleted, [{
    bucket: BUCKET,
    key: KEY,
    providerVersionId: "provider-v1",
  }]);
});

test("unbound provider receipt deletes only the event version and records one durable effect", async () => {
  const event = scanEvent(2);
  let heads = 0;
  let scans = 0;
  let effects = 0;
  const deleted: unknown[] = [];
  const result = await processDocumentObjectCreated(event, {
    receiptService: {
      async receive() {
        return {
          status: "unbound_provider_version_cleanup",
          documentVersionId: IDS.version,
        } as const;
      },
      async recordUnboundProviderVersionRemoval() {
        effects += 1;
        return { status: "recorded" } as const;
      },
    } as never,
    objectReader: {
      async headExact() {
        heads += 1;
        throw new Error("HEAD must remain lazy");
      },
    } as never,
    objectCleaner: {
      async deleteExact(input: unknown) {
        deleted.push(input);
        return "deleted" as const;
      },
    },
    service: {
      async claimScanWork() {
        scans += 1;
        throw new Error("scan must not start");
      },
    } as never,
    scanner: {
      async scan() {
        scans += 1;
        throw new Error("scan must not start");
      },
    },
  });
  assert.deepEqual(result, { status: "unbound_provider_version_removed" });
  assert.equal(heads, 0);
  assert.equal(scans, 0);
  assert.equal(effects, 1);
  assert.deepEqual(deleted, [{ bucket: BUCKET, key: KEY, providerVersionId: "provider-v1" }]);
});

test("cleanup is crash-safe after delete and repeats through exact already-absent deletion", async () => {
  const event = scanEvent(3);
  const deletions: string[] = [];
  let effects = 0;
  const cleaner = {
    async deleteExact() {
      deletions.push(deletions.length === 0 ? "deleted" : "already_absent");
      return deletions.at(-1) as "deleted" | "already_absent";
    },
  };
  const receiptService = {
    async recordAbandonedObjectRemoval() {
      effects += 1;
      if (effects === 1) throw new Error("synthetic crash before durable cleanup effect");
      return { status: "duplicate" } as const;
    },
  } as never;

  await assert.rejects(
    () => processDocumentAbandonedCleanup(event, IDS.version, { receiptService, objectCleaner: cleaner }),
    /synthetic crash/u,
  );
  assert.deepEqual(
    await processDocumentAbandonedCleanup(event, IDS.version, { receiptService, objectCleaner: cleaner }),
    { status: "abandoned_removed" },
  );
  assert.deepEqual(deletions, ["deleted", "already_absent"]);
  assert.equal(effects, 2);
});

test("delete failure is retained and DLQ acknowledges only durable abandoned cleanup", async () => {
  const event = scanEvent(3);
  await assert.rejects(
    () => processDocumentAbandonedCleanup(event, IDS.version, {
      receiptService: {} as never,
      objectCleaner: { async deleteExact() { throw new Error("synthetic delete timeout"); } },
    }),
    /synthetic delete timeout/u,
  );

  const deadLetter = message(4, "provider-v1");
  assert.equal(await documentDeadLetterMessageDisposition(
    deadLetter,
    BUCKET,
    async () => ({ status: "not_cleanup" }),
  ), "retain");
  assert.equal(await documentDeadLetterMessageDisposition(
    deadLetter,
    BUCKET,
    async () => ({ status: "abandoned_removed" }),
  ), "delete");
  assert.equal(await documentDeadLetterMessageDisposition(
    deadLetter,
    BUCKET,
    async () => ({ status: "unbound_provider_version_removed" }),
  ), "delete");
  assert.equal(await documentDeadLetterMessageDisposition(
    deadLetter,
    BUCKET,
    async () => { throw new Error("synthetic cleanup effect failure"); },
  ), "retain");
});

test("DLQ classification never performs HEAD and leaves ordinary scan failures untouched", async () => {
  let receiptCalls = 0;
  let cleanupCalls = 0;
  let deleteCalls = 0;
  const ordinary = await processDocumentCleanupFromDeadLetter(scanEvent(3), {
    receiptService: {
      async receive(_event: unknown, loadHead: () => Promise<unknown>) {
        receiptCalls += 1;
        await assert.rejects(loadHead, DocumentScanRetryableWorkerError);
        return { status: "duplicate" } as const;
      },
      async recordAbandonedObjectRemoval() {
        cleanupCalls += 1;
        return { status: "recorded" } as const;
      },
    } as never,
    objectCleaner: {
      async deleteExact() {
        deleteCalls += 1;
        return "deleted" as const;
      },
    },
  });
  assert.deepEqual(ordinary, { status: "not_cleanup" });
  assert.equal(receiptCalls, 1);
  assert.equal(deleteCalls, 0);
  assert.equal(cleanupCalls, 0);
});

test("unbound cleanup is crash-safe and DLQ classification uses the exact event provider version", async () => {
  const event = scanEvent(3);
  const deletions: string[] = [];
  let effects = 0;
  const dependencies = {
    receiptService: {
      async receive() {
        return {
          status: "unbound_provider_version_cleanup",
          documentVersionId: IDS.version,
        } as const;
      },
      async recordUnboundProviderVersionRemoval() {
        effects += 1;
        if (effects === 1) throw new Error("synthetic effect crash");
        return { status: "duplicate" } as const;
      },
    } as never,
    objectCleaner: {
      async deleteExact(input: { providerVersionId: string }) {
        assert.equal(input.providerVersionId, event.versionId);
        const status = deletions.length === 0 ? "deleted" : "already_absent";
        deletions.push(status);
        return status as "deleted" | "already_absent";
      },
    },
  };
  await assert.rejects(
    () => processDocumentUnboundProviderVersionCleanup(event, IDS.version, dependencies),
    /synthetic effect crash/u,
  );
  assert.deepEqual(
    await processDocumentCleanupFromDeadLetter(event, dependencies),
    { status: "unbound_provider_version_removed" },
  );
  assert.deepEqual(deletions, ["deleted", "already_absent"]);
  assert.equal(effects, 2);
});

test("a running redelivery is retained and a scanner-version mismatch follows durable failure", async () => {
  const event = scanEvent(2);
  const runningService = {
    async claimScanWork() {
      return { status: "duplicate", workId: IDS.work, terminalState: "running", attemptCount: 1 } as const;
    },
  } as unknown as DocumentScanService;
  await assert.rejects(
    () => processDocumentScanEvent(event, {
      service: runningService,
      scanner: scanner("clamav-release1"),
    }),
    DocumentScanRetryableWorkerError,
  );

  let failed = 0;
  let completed = 0;
  const work = scanWork();
  const mismatchService = {
    async claimScanWork() { return { status: "claimed", work } as const; },
    async failScanWork() {
      failed += 1;
      return {
        status: "retry",
        workId: IDS.work,
        documentVersionId: IDS.version,
        attemptCount: 1,
      } as const;
    },
    async completeScanWork() {
      completed += 1;
      throw new Error("must not complete");
    },
  } as unknown as DocumentScanService;
  await assert.rejects(
    () => processDocumentScanEvent(scanEvent(1), {
      service: mismatchService,
      scanner: scanner("unexpected-scanner"),
    }),
    DocumentScanRetryableWorkerError,
  );
  assert.equal(failed, 1);
  assert.equal(completed, 0);
});

test("scan and reconciliation accept a 257-byte provider version and reject 1025 bytes", async () => {
  const providerVersion = `v${"x".repeat(256)}`;
  const candidate = Object.freeze({
    kind: "missed_event" as const,
    organizationId: IDS.organization,
    documentVersionId: IDS.version,
    bucket: BUCKET,
    key: KEY,
    versionId: providerVersion,
    scanPolicyVersion: "clamav-release1-v1",
    attemptCount: 0,
    observedUpdatedAtMs: 1_787_548_800_000,
  });
  let published = 0;
  const repository = {
    async claimScanWork() {
      return {
        status: "duplicate",
        workId: IDS.work,
        terminalState: "clean",
        attemptCount: 1,
      } as const;
    },
    async findReconciliationCandidates() { return [candidate]; },
    async reconcileScanCandidate(
      input: Parameters<DocumentScanRepository["reconcileScanCandidate"]>[0],
    ) {
      await input.publishMissedEvent?.();
      return "ignored" as const;
    },
  } as unknown as DocumentScanRepository;
  const service = new DocumentScanService({
    repository,
    requeuePublisher: { async publish() { published += 1; } },
    clock: { nowMs: () => 1_787_548_800_000 },
    createId: uuidSequence(),
  });
  const accepted = scanEvent(1, providerVersion);
  assert.equal((await service.claimScanWork(accepted)).status, "duplicate");
  assert.deepEqual(
    await service.reconcileDocumentScans({ staleAfterMs: 90_000, limit: 10 }),
    { inspected: 1, requeued: 0, deadLettered: 0, ignored: 1 },
  );
  assert.equal(published, 1);
  await assert.rejects(
    () => service.claimScanWork(scanEvent(1, "x".repeat(1025))),
    /DOCUMENT_SCAN_EVENT_INVALID/u,
  );
});

function message(receiveCount: number, providerVersion: string): Message {
  return {
    MessageId: "doc02-message-1",
    ReceiptHandle: "opaque-receipt",
    Attributes: { ApproximateReceiveCount: String(receiveCount) },
    Body: JSON.stringify({
      Records: [{
        eventSource: "aws:s3",
        eventName: "ObjectCreated:Put",
        awsRegion: "ap-east-1",
        s3: {
          bucket: { name: BUCKET },
          object: { key: KEY, versionId: providerVersion },
        },
      }],
    }),
  };
}

function testEventMessage(
  body: Readonly<Record<string, unknown>> = s3TestEventBody(),
  overrides: Partial<Message> = {},
): Message {
  return {
    MessageId: "doc02-test-event-message",
    ReceiptHandle: "opaque-test-event-receipt",
    Attributes: { ApproximateReceiveCount: "1" },
    Body: JSON.stringify(body),
    ...overrides,
  };
}

function s3TestEventBody(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    Service: "Amazon S3",
    Event: "s3:TestEvent",
    Time: "2026-08-24T00:00:00.000Z",
    Bucket: BUCKET,
    RequestId: "bounded-request",
    HostId: "bounded-host",
  });
}

function scanEvent(deliveryAttempt: number, versionId = "provider-v1"): DocumentScanEvent {
  return Object.freeze({
    eventId: "doc02-event-1",
    requestId: "doc02-request-1",
    bucket: BUCKET,
    key: KEY,
    versionId,
    scanPolicyVersion: "clamav-release1-v1",
    deliveryAttempt,
  });
}

function scanWork(): DocumentScanWork {
  return Object.freeze({
    id: IDS.work,
    organizationId: IDS.organization,
    documentVersionId: IDS.version,
    bucket: BUCKET,
    key: KEY,
    versionId: "provider-v1",
    scanPolicyVersion: "clamav-release1-v1",
    attemptCount: 1,
    state: "running",
  });
}

function scanner(scannerVersion: string) {
  return {
    async scan(input: { requestId: string; objectKey: string; objectVersionId: string }) {
      return Object.freeze({
        requestId: input.requestId,
        objectKey: input.objectKey,
        objectVersionId: input.objectVersionId,
        verdict: "clean" as const,
        scannerVersion,
      });
    },
  };
}

function uuidSequence(): () => string {
  let value = 20;
  return () => `82000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}
