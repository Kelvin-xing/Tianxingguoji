import "server-only";

import type { ResolvedSchoolViewService } from "../application/resolved-view.ts";

export interface ResolvedSchoolViewRuntime {
  readonly service: ResolvedSchoolViewService;
}

export class ResolvedSchoolViewRuntimeUnavailable extends Error {
  constructor() {
    super("Resolved school view runtime is not configured.");
    this.name = "ResolvedSchoolViewRuntimeUnavailable";
  }
}

/** The approved HK RDS composition root is the only allowed runtime adapter. */
export function getResolvedSchoolViewRuntime(): ResolvedSchoolViewRuntime {
  throw new ResolvedSchoolViewRuntimeUnavailable();
}
