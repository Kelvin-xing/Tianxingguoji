import type { SchoolService } from "./service.ts";

export interface SchoolRuntime {
  readonly service: SchoolService;
}

export class SchoolRuntimeUnavailable extends Error {
  constructor() {
    super("School runtime is not configured.");
    this.name = "SchoolRuntimeUnavailable";
  }
}

/**
 * Only the approved HK RDS composition root may install this runtime. There
 * is deliberately no local, crawler-snapshot, JSON, or legacy-Neon fallback.
 */
export function getSchoolRuntime(): SchoolRuntime {
  throw new SchoolRuntimeUnavailable();
}
