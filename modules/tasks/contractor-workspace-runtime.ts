import type { ContractorTaskWorkspaceService } from "./contractor-workspace.ts";

export interface ContractorTaskWorkspaceRuntime {
  readonly service: ContractorTaskWorkspaceService;
}

export class ContractorTaskWorkspaceRuntimeUnavailable extends Error {
  constructor() {
    super("Contractor task workspace runtime is not configured.");
    this.name = "ContractorTaskWorkspaceRuntimeUnavailable";
  }
}

/**
 * Production reads require the approved HK RDS transaction adapter. There is
 * deliberately no local, JSON, mock, legacy-Neon, or case-workspace fallback.
 */
export function getContractorTaskWorkspaceRuntime(): ContractorTaskWorkspaceRuntime {
  throw new ContractorTaskWorkspaceRuntimeUnavailable();
}
