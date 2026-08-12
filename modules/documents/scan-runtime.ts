import type { DocumentScanService } from "./scan-service.ts";

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
  readonly service: DocumentScanService;
  readonly scanner: DocumentScanner;
}

export class DocumentScanRuntimeUnavailable extends Error {
  constructor() {
    super("Document scan runtime is not configured.");
    this.name = "DocumentScanRuntimeUnavailable";
  }
}

/** HK RDS, private S3 reads, and the approved scanner must be composed together. */
export function getDocumentScanRuntime(): DocumentScanRuntime {
  throw new DocumentScanRuntimeUnavailable();
}
