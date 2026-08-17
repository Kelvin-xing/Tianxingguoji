import "server-only";

import type { SchoolGovernanceService } from "./governance-service.ts";

export interface SchoolGovernanceRuntime {
  readonly service: SchoolGovernanceService;
}

export class SchoolGovernanceRuntimeUnavailable extends Error {
  constructor() {
    super("School governance runtime is not configured.");
    this.name = "SchoolGovernanceRuntimeUnavailable";
  }
}

/**
 * Only the approved HK RDS composition root may install this runtime. There
 * is no local, crawler snapshot, JSON, legacy Neon, or admin UI fallback.
 */
export function getSchoolGovernanceRuntime(): SchoolGovernanceRuntime {
  throw new SchoolGovernanceRuntimeUnavailable();
}
