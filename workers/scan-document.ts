import {
  type DocumentObjectCleaner,
  type DocumentObjectReader,
  type DocumentObjectReceiptService,
  type DocumentScanEvent,
  DOCUMENT_SCANNER_ENGINES,
  type DocumentScannerEngine,
  type DocumentScanService,
} from "../modules/documents/server.ts";
import {
  getDocumentScanRuntime,
  type DocumentScanner,
} from "../modules/documents/server.ts";

export class DocumentScanRetryableWorkerError extends Error {
  readonly retryable = true;

  constructor() {
    super("Document scan requires a bounded retry.");
    this.name = "DocumentScanRetryableWorkerError";
  }
}

/** Throwing this error lets the configured SQS redrive policy move attempt three to its DLQ. */
export class DocumentScanDeadLetterWorkerError extends Error {
  readonly retryable = false;

  constructor() {
    super("Document scan reached the configured DLQ boundary.");
    this.name = "DocumentScanDeadLetterWorkerError";
  }
}

export type DocumentScanWorkerResult =
  | { readonly status: "duplicate"; readonly workId: string }
  | { readonly status: "available" | "rejected"; readonly workId: string };

export type DocumentObjectWorkerResult =
  | DocumentScanWorkerResult
  | { readonly status: "receipt_rejected" }
  | { readonly status: "abandoned_removed" }
  | { readonly status: "unbound_provider_version_removed" };

export async function processDocumentObjectCreated(
  event: DocumentScanEvent,
  dependencies: {
    readonly receiptService: DocumentObjectReceiptService;
    readonly objectReader: DocumentObjectReader;
    readonly objectCleaner: DocumentObjectCleaner;
    readonly service: DocumentScanService;
    readonly scanner: DocumentScanner;
  } = (() => {
    const runtime = getDocumentScanRuntime();
    return {
      receiptService: runtime.receiptService,
      objectReader: runtime.objectStore,
      objectCleaner: runtime.objectStore,
      service: runtime.service,
      scanner: runtime.scanner,
    };
  })(),
): Promise<DocumentObjectWorkerResult> {
  const receipt = await dependencies.receiptService.receive(event, (signal) =>
    dependencies.objectReader.headExact({
      bucket: event.bucket,
      key: event.key,
      providerVersionId: event.versionId,
      signal,
    }));
  if (receipt.status === "abandoned_cleanup") {
    return processDocumentAbandonedCleanup(event, receipt.documentVersionId, dependencies);
  }
  if (receipt.status === "unbound_provider_version_cleanup") {
    return processDocumentUnboundProviderVersionCleanup(
      event,
      receipt.documentVersionId,
      dependencies,
    );
  }
  if (receipt.status === "in_progress") throw new DocumentScanRetryableWorkerError();
  if (receipt.status === "duplicate") return Object.freeze({ status: "duplicate", workId: "receipt" });
  if (receipt.status === "rejected") return Object.freeze({ status: "receipt_rejected" });
  return processDocumentScanEvent(event, dependencies);
}

export async function processDocumentUnboundProviderVersionCleanup(
  event: DocumentScanEvent,
  documentVersionId: string,
  dependencies: {
    readonly receiptService: DocumentObjectReceiptService;
    readonly objectCleaner: DocumentObjectCleaner;
  } = (() => {
    const runtime = getDocumentScanRuntime();
    return { receiptService: runtime.receiptService, objectCleaner: runtime.objectStore };
  })(),
): Promise<{ readonly status: "unbound_provider_version_removed" }> {
  const deletion = await dependencies.objectCleaner.deleteExact({
    bucket: event.bucket,
    key: event.key,
    providerVersionId: event.versionId,
  });
  if (deletion !== "deleted" && deletion !== "already_absent") {
    throw new DocumentScanRetryableWorkerError();
  }
  await dependencies.receiptService.recordUnboundProviderVersionRemoval(event, documentVersionId);
  return Object.freeze({ status: "unbound_provider_version_removed" });
}

export async function processDocumentAbandonedCleanup(
  event: DocumentScanEvent,
  documentVersionId: string,
  dependencies: {
    readonly receiptService: DocumentObjectReceiptService;
    readonly objectCleaner: DocumentObjectCleaner;
  } = (() => {
    const runtime = getDocumentScanRuntime();
    return { receiptService: runtime.receiptService, objectCleaner: runtime.objectStore };
  })(),
): Promise<{ readonly status: "abandoned_removed" }> {
  const deletion = await dependencies.objectCleaner.deleteExact({
    bucket: event.bucket,
    key: event.key,
    providerVersionId: event.versionId,
  });
  if (deletion !== "deleted" && deletion !== "already_absent") {
    throw new DocumentScanRetryableWorkerError();
  }
  await dependencies.receiptService.recordAbandonedObjectRemoval(event, documentVersionId);
  return Object.freeze({ status: "abandoned_removed" });
}

export async function processDocumentCleanupFromDeadLetter(
  event: DocumentScanEvent,
  dependencies: {
    readonly receiptService: DocumentObjectReceiptService;
    readonly objectCleaner: DocumentObjectCleaner;
  } = (() => {
    const runtime = getDocumentScanRuntime();
    return { receiptService: runtime.receiptService, objectCleaner: runtime.objectStore };
  })(),
): Promise<{
  readonly status:
    | "abandoned_removed"
    | "unbound_provider_version_removed"
    | "not_cleanup";
}> {
  let receipt;
  try {
    receipt = await dependencies.receiptService.receive(event, async () => {
      throw new DocumentScanRetryableWorkerError();
    });
  } catch {
    return Object.freeze({ status: "not_cleanup" });
  }
  if (receipt.status === "abandoned_cleanup") {
    return processDocumentAbandonedCleanup(event, receipt.documentVersionId, dependencies);
  }
  if (receipt.status === "unbound_provider_version_cleanup") {
    return processDocumentUnboundProviderVersionCleanup(
      event,
      receipt.documentVersionId,
      dependencies,
    );
  }
  return Object.freeze({ status: "not_cleanup" });
}

export async function processDocumentScanEvent(
  event: DocumentScanEvent,
  dependencies: { readonly service: DocumentScanService; readonly scanner: DocumentScanner } =
    getDocumentScanRuntime(),
): Promise<DocumentScanWorkerResult> {
  const claim = await dependencies.service.claimScanWork(event);
  if (claim.status === "duplicate") {
    if (claim.terminalState === "running") throw new DocumentScanRetryableWorkerError();
    if (claim.terminalState === "failed") {
      if (claim.attemptCount >= 3 || event.deliveryAttempt >= 3) {
        throw new DocumentScanDeadLetterWorkerError();
      }
      throw new DocumentScanRetryableWorkerError();
    }
    return { status: "duplicate", workId: claim.workId };
  }

  let scan: Awaited<ReturnType<DocumentScanner["scan"]>>;
  try {
    scan = await dependencies.scanner.scan({
      requestId: event.requestId,
      objectKey: event.key,
      objectVersionId: event.versionId,
    });
  } catch {
    return handleFailure(event, claim.work, dependencies.service);
  }

  if (
    scan.requestId !== event.requestId ||
    scan.objectKey !== event.key ||
    scan.objectVersionId !== event.versionId ||
    !(DOCUMENT_SCANNER_ENGINES as readonly string[]).includes(scan.scannerVersion) ||
    (scan.verdict !== "clean" && scan.verdict !== "malicious" && scan.verdict !== "failed")
  ) {
    return handleFailure(event, claim.work, dependencies.service);
  }
  if (scan.verdict === "failed") {
    return handleFailure(
      event,
      claim.work,
      dependencies.service,
      scan.scannerVersion as DocumentScannerEngine,
    );
  }

  const result = await dependencies.service.completeScanWork({
    event,
    work: claim.work,
    verdict: scan.verdict,
    scannerEngine: scan.scannerVersion as DocumentScannerEngine,
  });
  return { status: result.status, workId: result.workId };
}

async function handleFailure(
  event: DocumentScanEvent,
  work: Parameters<DocumentScanService["failScanWork"]>[0]["work"],
  service: DocumentScanService,
  scannerEngine: DocumentScannerEngine = "clamav-release1",
): Promise<never> {
  const failure = await service.failScanWork({ event, work, scannerEngine });
  if (failure.status === "dead_letter") throw new DocumentScanDeadLetterWorkerError();
  throw new DocumentScanRetryableWorkerError();
}
