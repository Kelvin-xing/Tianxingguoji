import "server-only";

import type { DocumentPolicyService } from "./policy.ts";

export interface DocumentPolicyRuntime {
  readonly policyService: DocumentPolicyService;
}

export class DocumentPolicyRuntimeUnavailable extends Error {
  constructor() {
    super("Document policy runtime is not configured.");
    this.name = "DocumentPolicyRuntimeUnavailable";
  }
}

/**
 * Production composition must inject an HK RDS repository that locks current
 * authorization, legal-hold, export-grant, audit/outbox, and region-health
 * facts together. A local fallback could accidentally issue an export grant,
 * so this module deliberately remains unavailable until composition exists.
 */
export function getDocumentPolicyRuntime(): DocumentPolicyRuntime {
  throw new DocumentPolicyRuntimeUnavailable();
}
