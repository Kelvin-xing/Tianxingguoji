import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { CaseTransitionService } from "../application/transition-service.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
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
  __txCaseTransitionRuntimes?: Map<string, CaseTransitionRuntime>;
};

export function getCaseTransitionRuntime(): CaseTransitionRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new CaseTransitionRuntimeUnavailable();
  const runtimes = globalForCaseTransition.__txCaseTransitionRuntimes ??
    new Map<string, CaseTransitionRuntime>();
  globalForCaseTransition.__txCaseTransitionRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    const adapter = createPostgreSqlAdapter(getApplicationTenantRunner());
    runtime = Object.freeze({
      service: new CaseTransitionService({
        repository: new PostgresqlCaseTransitionRepository(adapter),
      }),
    });
    runtimes.set(mode, runtime);
  }
  return runtime;
}
