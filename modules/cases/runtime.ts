import "server-only";

import type { AssessmentService } from "./assessment-service.ts";
import type { CaseService } from "./service.ts";

export interface CaseRuntime {
  readonly service: CaseService;
  readonly assessmentService: AssessmentService;
}

export class CaseRuntimeUnavailable extends Error {
  constructor() {
    super("Case runtime is not configured.");
    this.name = "CaseRuntimeUnavailable";
  }
}

/**
 * The production composition root is installed with the approved HK RDS
 * adapter only. There is no local or legacy-Neon fallback for case writes.
 */
export function getCaseRuntime(): CaseRuntime {
  throw new CaseRuntimeUnavailable();
}
