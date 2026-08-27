import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { GuardianConfirmationOptionsService } from "../application/guardian-confirmation-options-service.ts";
import { PostgresqlGuardianConfirmationOptionsRepository } from "./postgresql-guardian-confirmation-options-repository.ts";

export interface GuardianConfirmationOptionsRuntime {
  readonly service: GuardianConfirmationOptionsService;
}
export class GuardianConfirmationOptionsRuntimeUnavailable extends Error {
  constructor() {
    super("Guardian confirmation options runtime is not configured.");
    this.name = "GuardianConfirmationOptionsRuntimeUnavailable";
  }
}

const globalForOptions = globalThis as typeof globalThis & {
  __txGuardianConfirmationOptionsRuntimes?: Map<string, GuardianConfirmationOptionsRuntime>;
};

export function getGuardianConfirmationOptionsRuntime(): GuardianConfirmationOptionsRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new GuardianConfirmationOptionsRuntimeUnavailable();
  const runtimes = globalForOptions.__txGuardianConfirmationOptionsRuntimes ??
    new Map<string, GuardianConfirmationOptionsRuntime>();
  globalForOptions.__txGuardianConfirmationOptionsRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    runtime = Object.freeze({
      service: new GuardianConfirmationOptionsService(
        new PostgresqlGuardianConfirmationOptionsRepository(getApplicationTenantRunner()),
      ),
    });
    runtimes.set(mode,runtime);
  }
  return runtime;
}
