import "server-only";

import type { GuardianRelationshipService } from "../application/guardian-relationship-service.ts";
import { StudentReadService } from "../application/read-service.ts";
import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { PostgresqlStudentReadRepository } from "./postgresql-read-repository.ts";

export interface GuardianRelationshipRuntime {
  readonly service: GuardianRelationshipService;
}

export class GuardianRelationshipRuntimeUnavailable extends Error {
  constructor() {
    super("Guardian relationship runtime is not configured.");
    this.name = "GuardianRelationshipRuntimeUnavailable";
  }
}

/**
 * Guardian relationship writes require the approved HK RDS repository. This
 * release intentionally has no local, in-memory, JSON, or legacy-Neon fallback.
 */
export function getGuardianRelationshipRuntime(): GuardianRelationshipRuntime {
  throw new GuardianRelationshipRuntimeUnavailable();
}

export interface StudentReadRuntime {
  readonly service: StudentReadService;
}

const globalForCrmRead = globalThis as typeof globalThis & {
  __txStudentReadRuntimes?: Map<string, StudentReadRuntime>;
};

export function getStudentReadRuntime(): StudentReadRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new GuardianRelationshipRuntimeUnavailable();
  const runtimes = globalForCrmRead.__txStudentReadRuntimes ?? new Map<string, StudentReadRuntime>();
  globalForCrmRead.__txStudentReadRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    runtime = Object.freeze({
      service: new StudentReadService(
        new PostgresqlStudentReadRepository(getApplicationTenantRunner()),
      ),
    });
    runtimes.set(mode, runtime);
  }
  return runtime;
}
