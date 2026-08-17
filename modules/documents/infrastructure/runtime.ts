import "server-only";

import type { DocumentUploadService } from "../application/upload-service.ts";

export interface DocumentUploadRuntime {
  readonly uploadService: DocumentUploadService;
}

export class DocumentUploadRuntimeUnavailable extends Error {
  constructor() {
    super("Document upload runtime is not configured.");
    this.name = "DocumentUploadRuntimeUnavailable";
  }
}

/**
 * Production composition must provide one HK RDS repository and one private
 * S3 signer. There is intentionally no local, public, or legacy fallback.
 */
export function getDocumentUploadRuntime(): DocumentUploadRuntime {
  throw new DocumentUploadRuntimeUnavailable();
}
