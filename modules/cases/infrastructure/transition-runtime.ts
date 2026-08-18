import "server-only";

import { isLocalSyntheticMode } from "../../../lib/runtime/local-synthetic-config.ts";
import { CaseTransitionService } from "../application/transition-service.ts";
import { getLocalApplicationTenantRunner } from "../../shared/server.ts";
import { createPostgreSqlAdapter } from "./postgresql.ts";
import { PostgresqlCaseTransitionRepository } from "./postgresql-transition-repository.ts";

export interface CaseTransitionRuntime {
  readonly service: CaseTransitionService;
}

export class CaseTransitionRuntimeUnavailable extends Error {
  constructor() {
    super("Case transition runtime is not configured.");
    this.name = "CaseTransitionRuntimeUnavailable";
  }
}

const globalForCaseTransition = globalThis as typeof globalThis & {
  __txLocalCaseTransitionRuntime?: CaseTransitionRuntime;
};

export function getCaseTransitionRuntime(): CaseTransitionRuntime {
  if (!isLocalSyntheticMode()) throw new CaseTransitionRuntimeUnavailable();
  if (!globalForCaseTransition.__txLocalCaseTransitionRuntime) {
    const adapter = createPostgreSqlAdapter(getLocalApplicationTenantRunner());
    globalForCaseTransition.__txLocalCaseTransitionRuntime = Object.freeze({
      service: new CaseTransitionService({
        repository: new PostgresqlCaseTransitionRepository(adapter),
      }),
    });
  }
  return globalForCaseTransition.__txLocalCaseTransitionRuntime;
}
