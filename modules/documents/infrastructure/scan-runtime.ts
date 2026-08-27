import "server-only";

import { loadDocumentTransportConfig } from "../../../lib/runtime/document-transport-config.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { DocumentObjectReceiptService } from "../application/object-receipt-service.ts";
import { DocumentScanService, type DocumentScanEvent } from "../application/scan-service.ts";
import { DOCUMENT_SCAN_POLICY_VERSION } from "../domain/contract.ts";
import { DeterministicFakeDocumentScanner } from "./deterministic-fake-scanner.ts";
import { getDeterministicFakeDocumentTransport } from "./deterministic-fake-transport.ts";
import type { DocumentObjectCleaner, DocumentObjectReader } from "./object-transport-port.ts";
import { PostgresqlDocumentScanRepository } from "./postgresql-scan-repository.ts";

export interface DocumentScanner {
  readonly scannerVersion?: "clamav-release1" | "deterministic-fake-release1";
  scan(input: {
    readonly requestId: string;
    readonly objectKey: string;
    readonly objectVersionId: string;
  }): Promise<{
    readonly requestId: string;
    readonly objectKey: string;
    readonly objectVersionId: string;
    readonly verdict: "clean" | "malicious" | "failed";
    readonly scannerVersion: string;
  }>;
}

export interface DocumentScanRuntime {
  readonly receiptService: DocumentObjectReceiptService;
  readonly service: DocumentScanService;
  readonly scanner: DocumentScanner;
  readonly objectStore: DocumentObjectReader & DocumentObjectCleaner;
  readonly queue: DeterministicFakeDocumentScanQueue;
}

export class DocumentScanRuntimeUnavailable extends Error {
  constructor() {
    super("Document scan runtime is not configured.");
    this.name = "DocumentScanRuntimeUnavailable";
  }
}

export class DeterministicFakeDocumentScanQueue {
  private readonly runtime: Omit<DocumentScanRuntime, "queue">;

  constructor(runtime: Omit<DocumentScanRuntime, "queue">) {
    this.runtime = runtime;
  }

  async publish(event: DocumentScanEvent): Promise<"available" | "rejected" | "duplicate"> {
    const receipt = await this.runtime.receiptService.receive(event, (signal) =>
      this.runtime.objectStore.headExact({
        bucket: event.bucket,
        key: event.key,
        providerVersionId: event.versionId,
        signal,
      }));
    if (receipt.status === "abandoned_cleanup" ||
        receipt.status === "unbound_provider_version_cleanup") {
      await this.runtime.objectStore.deleteExact({
        bucket: event.bucket,
        key: event.key,
        providerVersionId: event.versionId,
      });
      if (receipt.status === "abandoned_cleanup") {
        await this.runtime.receiptService.recordAbandonedObjectRemoval(event, receipt.documentVersionId);
      } else {
        await this.runtime.receiptService.recordUnboundProviderVersionRemoval(
          event,
          receipt.documentVersionId,
        );
      }
      return "rejected";
    }
    if (receipt.status === "in_progress") throw new DocumentScanRuntimeUnavailable();
    if (receipt.status === "rejected") return "rejected";

    const claim = await this.runtime.service.claimScanWork(event);
    if (claim.status === "duplicate") {
      if (claim.terminalState === "clean") return "available";
      if (claim.terminalState === "rejected") return "rejected";
      throw new DocumentScanRuntimeUnavailable();
    }
    let scan;
    try {
      scan = await this.runtime.scanner.scan({
        requestId: event.requestId,
        objectKey: event.key,
        objectVersionId: event.versionId,
      });
    } catch {
      await this.runtime.service.failScanWork({
        event,
        work: claim.work,
        scannerEngine: "deterministic-fake-release1",
      });
      throw new DocumentScanRuntimeUnavailable();
    }
    if (scan.scannerVersion !== "deterministic-fake-release1" || scan.verdict === "failed") {
      await this.runtime.service.failScanWork({
        event,
        work: claim.work,
        scannerEngine: "deterministic-fake-release1",
      });
      throw new DocumentScanRuntimeUnavailable();
    }
    const completed = await this.runtime.service.completeScanWork({
      event,
      work: claim.work,
      verdict: scan.verdict,
      scannerEngine: "deterministic-fake-release1",
    });
    return completed.status;
  }
}

const globalForDocumentScan = globalThis as typeof globalThis & {
  __txDocumentScanRuntime?: Readonly<{ signature: string; runtime: DocumentScanRuntime }>;
};

export function getDocumentScanRuntime(): DocumentScanRuntime {
  try {
    const config = loadDocumentTransportConfig();
    if (config.mode !== "deterministic-fake") throw new DocumentScanRuntimeUnavailable();
    const signature = `${config.bucket}\0${config.organizationId}\0${config.workerContextId}`;
    if (globalForDocumentScan.__txDocumentScanRuntime?.signature === signature) {
      return globalForDocumentScan.__txDocumentScanRuntime.runtime;
    }
    const objectStore = getDeterministicFakeDocumentTransport();
    const repository = new PostgresqlDocumentScanRepository(getApplicationTenantRunner(), {
      organizationId: config.organizationId,
      workerContextId: config.workerContextId,
    });
    const base = Object.freeze({
      objectStore,
      receiptService: new DocumentObjectReceiptService({
        repository,
        organizationId: config.organizationId,
      }),
      service: new DocumentScanService({ repository }),
      scanner: new DeterministicFakeDocumentScanner({ reader: objectStore, bucket: config.bucket }),
    });
    const runtime = Object.freeze({ ...base, queue: new DeterministicFakeDocumentScanQueue(base) });
    globalForDocumentScan.__txDocumentScanRuntime = Object.freeze({ signature, runtime });
    return runtime;
  } catch (error) {
    if (error instanceof DocumentScanRuntimeUnavailable) throw error;
    throw new DocumentScanRuntimeUnavailable();
  }
}

export function deterministicFakeScanEvent(input: {
  readonly bucket: string;
  readonly key: string;
  readonly providerVersionId: string;
  readonly eventId: string;
  readonly requestId: string;
}): DocumentScanEvent {
  return Object.freeze({
    eventId: input.eventId,
    requestId: input.requestId,
    bucket: input.bucket,
    key: input.key,
    versionId: input.providerVersionId,
    scanPolicyVersion: DOCUMENT_SCAN_POLICY_VERSION,
    deliveryAttempt: 1,
  });
}
