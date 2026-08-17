import "server-only";

import type { CaseTransitionService } from "../application/transition-service.ts";

export interface CaseTransitionRuntime {
  readonly service: CaseTransitionService;
}

export class CaseTransitionRuntimeUnavailable extends Error {
  constructor() {
    super("Case transition runtime is not configured.");
    this.name = "CaseTransitionRuntimeUnavailable";
  }
}

/**
 * The P1-14 route accepts no local, JSON, mock, or legacy-Neon fallback.
 * Production composition must install the approved HK RDS transaction port.
 */
export function getCaseTransitionRuntime(): CaseTransitionRuntime {
  throw new CaseTransitionRuntimeUnavailable();
}
