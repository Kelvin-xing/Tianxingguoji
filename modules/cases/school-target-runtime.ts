import "server-only";

import type { SchoolTargetService } from "./school-target-service.ts";

export interface SchoolTargetRuntime {
  readonly service: SchoolTargetService;
}

export class SchoolTargetRuntimeUnavailable extends Error {
  constructor() {
    super("School target runtime is not configured.");
    this.name = "SchoolTargetRuntimeUnavailable";
  }
}

/** Only the approved HK RDS composition root may configure target writes. */
export function getSchoolTargetRuntime(): SchoolTargetRuntime {
  throw new SchoolTargetRuntimeUnavailable();
}
