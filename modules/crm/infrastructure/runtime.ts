import "server-only";

import { GuardianRelationshipService } from "../application/guardian-relationship-service.ts";
import { StudentReadService } from "../application/read-service.ts";
import { StudentCreateService } from "../application/student-create-service.ts";
import { ProfileMaintenanceService } from "../application/profile-maintenance-service.ts";
import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { PostgresqlStudentReadRepository } from "./postgresql-read-repository.ts";
import { PostgresqlStudentCreateRepository } from "./postgresql-student-create-repository.ts";
import { PostgresqlGuardianRelationshipRepository } from "./postgresql-guardian-relationship-repository.ts";
import { PostgresqlProfileMaintenanceRepository } from "./postgresql-profile-maintenance-repository.ts";

export interface GuardianRelationshipRuntime {
  readonly service: GuardianRelationshipService;
}

export class GuardianRelationshipRuntimeUnavailable extends Error {
  constructor() {
    super("Guardian relationship runtime is not configured.");
    this.name = "GuardianRelationshipRuntimeUnavailable";
  }
}

export function getGuardianRelationshipRuntime(): GuardianRelationshipRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new GuardianRelationshipRuntimeUnavailable();
  const runtimes = globalForCrm.__txGuardianRelationshipRuntimes ??
    new Map<string, GuardianRelationshipRuntime>();
  globalForCrm.__txGuardianRelationshipRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    try {
      runtime = Object.freeze({
        service: new GuardianRelationshipService(
          new PostgresqlGuardianRelationshipRepository(getApplicationTenantRunner()),
        ),
      });
    } catch {
      throw new GuardianRelationshipRuntimeUnavailable();
    }
    runtimes.set(mode, runtime);
  }
  return runtime;
}

export interface StudentReadRuntime {
  readonly service: StudentReadService;
}

export interface StudentCreateRuntime {
  readonly service: StudentCreateService;
}

export interface ProfileMaintenanceRuntime {
  readonly service: ProfileMaintenanceService;
}

export class ProfileMaintenanceRuntimeUnavailable extends Error {
  constructor() {
    super("Profile maintenance runtime is not configured.");
    this.name = "ProfileMaintenanceRuntimeUnavailable";
  }
}

export function isProfileMaintenanceRuntimeUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === "ProfileMaintenanceRuntimeUnavailable";
}

export class StudentCreateRuntimeUnavailable extends Error {
  constructor() {
    super("Student create runtime is not configured.");
    this.name = "StudentCreateRuntimeUnavailable";
  }
}

const globalForCrm = globalThis as typeof globalThis & {
  __txGuardianRelationshipRuntimes?: Map<string, GuardianRelationshipRuntime>;
  __txStudentReadRuntimes?: Map<string, StudentReadRuntime>;
  __txStudentCreateRuntimes?: Map<string, StudentCreateRuntime>;
  __txProfileMaintenanceRuntimes?: Map<string, ProfileMaintenanceRuntime>;
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

export function getProfileMaintenanceRuntime(): ProfileMaintenanceRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new ProfileMaintenanceRuntimeUnavailable();
  const runtimes = globalForCrm.__txProfileMaintenanceRuntimes ??
    new Map<string, ProfileMaintenanceRuntime>();
  globalForCrm.__txProfileMaintenanceRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    try {
      runtime = Object.freeze({
        service: new ProfileMaintenanceService(
          new PostgresqlProfileMaintenanceRepository(getApplicationTenantRunner()),
        ),
      });
    } catch {
      throw new ProfileMaintenanceRuntimeUnavailable();
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
