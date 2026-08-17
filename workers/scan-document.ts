import {
  DocumentScanError,
  type DocumentScanEvent,
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

export async function processDocumentScanEvent(
  event: DocumentScanEvent,
  dependencies: { readonly service: DocumentScanService; readonly scanner: DocumentScanner } =
    getDocumentScanRuntime(),
): Promise<DocumentScanWorkerResult> {
  const claim = await dependencies.service.claimScanWork(event);
  if (claim.status === "duplicate") {
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
    (scan.verdict !== "clean" && scan.verdict !== "malicious" && scan.verdict !== "failed")
  ) {
    return handleFailure(event, claim.work, dependencies.service);
  }
  if (scan.verdict === "failed") return handleFailure(event, claim.work, dependencies.service);

  const result = await dependencies.service.completeScanWork({
    event,
    work: claim.work,
    verdict: scan.verdict,
  });
  return { status: result.status, workId: result.workId };
}

async function handleFailure(
  event: DocumentScanEvent,
  work: Parameters<DocumentScanService["failScanWork"]>[0]["work"],
  service: DocumentScanService,
): Promise<never> {
  const failure = await service.failScanWork({ event, work });
  if (failure.status === "dead_letter") throw new DocumentScanDeadLetterWorkerError();
  throw new DocumentScanRetryableWorkerError();
}
