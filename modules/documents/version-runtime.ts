import "server-only";

import type { DocumentVersionService } from "./version-service.ts";

export interface DocumentVersionRuntime {
  readonly service: DocumentVersionService;
}

export class DocumentVersionRuntimeUnavailable extends Error {
  constructor() {
    super("Document version runtime is not configured.");
    this.name = "DocumentVersionRuntimeUnavailable";
  }
}

/**
 * Production composition must provide the HK RDS transaction repository. No
 * local, JSON, mock, legacy, or object-store fallback may mutate documents.
 */
export function getDocumentVersionRuntime(): DocumentVersionRuntime {
  throw new DocumentVersionRuntimeUnavailable();
}
