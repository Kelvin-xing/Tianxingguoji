import "server-only";

import type { AssessmentService } from "../application/assessment-service.ts";
import type { CaseService } from "../application/service.ts";
import { CaseWorkspaceService } from "../application/workspace-service.ts";
import { isLocalSyntheticMode } from "../../../lib/runtime/local-synthetic-config.ts";
import { getLocalApplicationTenantRunner } from "../../shared/server.ts";
import { createPostgreSqlAdapter } from "./postgresql.ts";
import { PostgresqlCaseWorkspaceRepository } from "./postgresql-workspace-repository.ts";

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

export interface CaseWorkspaceRuntime {
  readonly service: CaseWorkspaceService;
}

const globalForCaseWorkspace = globalThis as typeof globalThis & {
  __txLocalCaseWorkspaceRuntime?: CaseWorkspaceRuntime;
};

export function getCaseWorkspaceRuntime(): CaseWorkspaceRuntime {
  if (!isLocalSyntheticMode()) throw new CaseRuntimeUnavailable();
  if (!globalForCaseWorkspace.__txLocalCaseWorkspaceRuntime) {
    const adapter = createPostgreSqlAdapter(getLocalApplicationTenantRunner());
    globalForCaseWorkspace.__txLocalCaseWorkspaceRuntime = Object.freeze({
      service: new CaseWorkspaceService(new PostgresqlCaseWorkspaceRepository(adapter)),
    });
  }
  return globalForCaseWorkspace.__txLocalCaseWorkspaceRuntime;
}
