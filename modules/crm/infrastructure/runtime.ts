import "server-only";

import type { GuardianRelationshipService } from "../application/guardian-relationship-service.ts";
import { StudentReadService } from "../application/read-service.ts";
import { StudentCreateService } from "../application/student-create-service.ts";
import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { PostgresqlStudentReadRepository } from "./postgresql-read-repository.ts";
import { PostgresqlStudentCreateRepository } from "./postgresql-student-create-repository.ts";

export interface GuardianRelationshipRuntime {
  readonly service: GuardianRelationshipService;
}

export class GuardianRelationshipRuntimeUnavailable extends Error {
  constructor() {
    super("Guardian relationship runtime is not configured.");
    this.name = "GuardianRelationshipRuntimeUnavailable";
  }
}

/** General Guardian relationship changes remain unavailable; CRM-01 creation uses its own runtime. */
export function getGuardianRelationshipRuntime(): GuardianRelationshipRuntime {
  throw new GuardianRelationshipRuntimeUnavailable();
}

export interface StudentReadRuntime {
  readonly service: StudentReadService;
}

export interface StudentCreateRuntime {
  readonly service: StudentCreateService;
}

export class StudentCreateRuntimeUnavailable extends Error {
  constructor() {
    super("Student create runtime is not configured.");
    this.name = "StudentCreateRuntimeUnavailable";
  }
}

const globalForCrm = globalThis as typeof globalThis & {
  __txStudentReadRuntimes?: Map<string, StudentReadRuntime>;
  __txStudentCreateRuntimes?: Map<string, StudentCreateRuntime>;
};

export function getStudentReadRuntime(): StudentReadRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new GuardianRelationshipRuntimeUnavailable();
  const runtimes = globalForCrm.__txStudentReadRuntimes ?? new Map<string, StudentReadRuntime>();
  globalForCrm.__txStudentReadRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    try {
      runtime = Object.freeze({
        service: new StudentReadService(
          new PostgresqlStudentReadRepository(getApplicationTenantRunner()),
        ),
      });
    } catch {
      throw new GuardianRelationshipRuntimeUnavailable();
    }
    runtimes.set(mode, runtime);
  }
  return runtime;
}

export function getStudentCreateRuntime(): StudentCreateRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new StudentCreateRuntimeUnavailable();
  const runtimes = globalForCrm.__txStudentCreateRuntimes ??
    new Map<string, StudentCreateRuntime>();
  globalForCrm.__txStudentCreateRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    try {
      const runner = getApplicationTenantRunner();
      runtime = Object.freeze({
        service: new StudentCreateService(
          new PostgresqlStudentCreateRepository(runner),
        ),
      });
    } catch {
      throw new StudentCreateRuntimeUnavailable();
    }
    runtimes.set(mode, runtime);
  }
  return runtime;
}
