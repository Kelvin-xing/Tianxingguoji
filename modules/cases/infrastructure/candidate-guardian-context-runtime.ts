import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { CandidateGuardianContextService } from "../application/candidate-guardian-context-service.ts";
import { PostgresqlCandidateGuardianContextRepository } from "./postgresql-candidate-guardian-context-repository.ts";

export interface CandidateGuardianContextRuntime { readonly service: CandidateGuardianContextService }
export class CandidateGuardianContextRuntimeUnavailable extends Error {
  constructor() { super("Candidate Guardian context runtime is not configured."); this.name = "CandidateGuardianContextRuntimeUnavailable"; }
}

const globalForContext = globalThis as typeof globalThis & {
  __txCandidateGuardianContextRuntimes?: Map<string, CandidateGuardianContextRuntime>;
};

export function getCandidateGuardianContextRuntime(): CandidateGuardianContextRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new CandidateGuardianContextRuntimeUnavailable();
  const runtimes = globalForContext.__txCandidateGuardianContextRuntimes ??
    new Map<string, CandidateGuardianContextRuntime>();
  globalForContext.__txCandidateGuardianContextRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    runtime = Object.freeze({
      service: new CandidateGuardianContextService(
        new PostgresqlCandidateGuardianContextRepository(getApplicationTenantRunner()),
      ),
    });
    runtimes.set(mode,runtime);
  }
  return runtime;
}
