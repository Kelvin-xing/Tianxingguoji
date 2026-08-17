import "server-only";

import type { CaseReconstructionService } from "../../application/reconstruction/service.ts";

export interface CaseReconstructionRuntime {
  readonly service: CaseReconstructionService;
}

export class CaseReconstructionRuntimeUnavailable extends Error {
  constructor() {
    super("Case reconstruction runtime is not configured.");
    this.name = "CaseReconstructionRuntimeUnavailable";
  }
}

/** P3-08 must install the HK RDS transaction adapter; no local fallback exists. */
export function getCaseReconstructionRuntime(): CaseReconstructionRuntime {
  throw new CaseReconstructionRuntimeUnavailable();
}
