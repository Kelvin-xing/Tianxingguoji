import type { CaseDashboardProjectionService } from "./case-dashboard-projection.ts";

export interface CaseDashboardRuntime {
  readonly service: CaseDashboardProjectionService;
}

export class CaseDashboardRuntimeUnavailable extends Error {
  constructor() {
    super("Case dashboard HK RDS runtime is not configured.");
    this.name = "CaseDashboardRuntimeUnavailable";
  }
}

/** Only the approved HK RDS composition root may install dashboard reads. */
export function getCaseDashboardRuntime(): CaseDashboardRuntime {
  throw new CaseDashboardRuntimeUnavailable();
}
