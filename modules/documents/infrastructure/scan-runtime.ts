import "server-only";

import { loadLocalSyntheticConfig } from "../../../lib/runtime/local-synthetic-config.ts";
import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { DocumentObjectReceiptService } from "../application/object-receipt-service.ts";
import { DocumentScanService } from "../application/scan-service.ts";
import { LocalClamavDocumentScanner } from "./clamav-scanner.ts";
import { LocalSyntheticDocumentObjectStore } from "./local-object-store.ts";
import { LocalSyntheticDocumentScanRequeuePublisher } from "./local-scan-requeue-publisher.ts";
import { PostgresqlDocumentScanRepository } from "./postgresql-scan-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE1_SYNTHETIC_ORGANIZATION_ID = "51000000-0000-4000-8000-000000000001";
const LOCAL_WORKER_CONTEXT_ID = "10000000-0000-4000-8000-000000000901";

export interface DocumentScanner {
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
  readonly objectStore: LocalSyntheticDocumentObjectStore;
}

export class DocumentScanRuntimeUnavailable extends Error {
  constructor() {
    super("Document scan runtime is not configured.");
    this.name = "DocumentScanRuntimeUnavailable";
  }
}

const globalForDocumentScan = globalThis as typeof globalThis & {
  __txDocumentScanRuntime?: DocumentScanRuntime;
};

export function getDocumentScanRuntime(): DocumentScanRuntime {
  try {
    if (loadRuntimeEnvironment().appRuntimeMode !== "local-synthetic") {
      throw new DocumentScanRuntimeUnavailable();
    }
    const organizationId = requiredUuid(
      "LOCAL_SYNTHETIC_ORGANIZATION_ID",
      RELEASE1_SYNTHETIC_ORGANIZATION_ID,
    );
    const workerContextId = requiredUuid(
      "LOCAL_SYNTHETIC_DOCUMENT_WORKER_CONTEXT_ID",
      LOCAL_WORKER_CONTEXT_ID,
    );
    if (workerContextId === organizationId) throw new DocumentScanRuntimeUnavailable();
    if (globalForDocumentScan.__txDocumentScanRuntime) {
      return globalForDocumentScan.__txDocumentScanRuntime;
    }
    const config = loadLocalSyntheticConfig();
    const objectStore = new LocalSyntheticDocumentObjectStore({
      endpoint: config.localstack.endpoint,
      bucket: config.localstack.bucket,
      requestTimeoutMs: config.dependencyTimeoutMs,
    });
    const repository = new PostgresqlDocumentScanRepository(
      getApplicationTenantRunner(),
      { organizationId, workerContextId },
    );
    const runtime = Object.freeze({
      objectStore,
      receiptService: new DocumentObjectReceiptService({ repository, organizationId }),
      service: new DocumentScanService({
        repository,
        requeuePublisher: new LocalSyntheticDocumentScanRequeuePublisher({
          endpoint: config.localstack.endpoint,
          region: config.localstack.region,
          queue: config.localstack.queue,
          bucket: config.localstack.bucket,
          requestTimeoutMs: config.dependencyTimeoutMs,
        }),
      }),
      scanner: new LocalClamavDocumentScanner({
        reader: objectStore,
        bucket: config.localstack.bucket,
        host: config.clamav.host,
        port: config.clamav.port,
      }),
    });
    globalForDocumentScan.__txDocumentScanRuntime = runtime;
    return runtime;
  } catch (error) {
    if (error instanceof DocumentScanRuntimeUnavailable) throw error;
    throw new DocumentScanRuntimeUnavailable();
  }
}

function requiredUuid(variable: string, expected?: string): string {
  const value = process.env[variable]?.trim();
  if (!value || !UUID.test(value) || (expected !== undefined && value !== expected)) {
    throw new DocumentScanRuntimeUnavailable();
  }
  return value;
}
