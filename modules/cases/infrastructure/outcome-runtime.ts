import "server-only";

import type { CaseOutcomeService } from "../application/outcome-service.ts";

export interface CaseOutcomeRuntime {
  readonly service: CaseOutcomeService;
}

export class CaseOutcomeRuntimeUnavailable extends Error {
  constructor() {
    super("Case target and outcome runtime is not configured.");
    this.name = "CaseOutcomeRuntimeUnavailable";
  }
}

/** Production composition must provide the approved HK RDS transaction port. */
export function getCaseOutcomeRuntime(): CaseOutcomeRuntime {
  throw new CaseOutcomeRuntimeUnavailable();
}
