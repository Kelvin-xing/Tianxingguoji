import "server-only";

import { GuardianRelationshipService } from "../application/guardian-relationship-service.ts";
import { StudentReadService } from "../application/read-service.ts";
import { StudentCreateService } from "../application/student-create-service.ts";
import { ProfileMaintenanceService } from "../application/profile-maintenance-service.ts";
import { DeletionReviewService } from "../application/deletion-review-service.ts";
import { ReferralSourceService } from "../application/referral-source-service.ts";
import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { PostgresqlStudentReadRepository } from "./postgresql-read-repository.ts";
import { PostgresqlStudentCreateRepository } from "./postgresql-student-create-repository.ts";
import { PostgresqlGuardianRelationshipRepository } from "./postgresql-guardian-relationship-repository.ts";
import { PostgresqlProfileMaintenanceRepository } from "./postgresql-profile-maintenance-repository.ts";
import { PostgresqlDeletionReviewRepository } from "./postgresql-deletion-review-repository.ts";
import { PostgresqlReferralSourceRepository } from "./postgresql-referral-source-repository.ts";
import { PostgresqlCustomerDeletionGuard } from "../../cases/server.ts";
import { PotentialDuplicateService } from "../application/potential-duplicate-service.ts";
import { PostgresqlPotentialDuplicateRepository } from "./postgresql-potential-duplicate-repository.ts";
import { potentialDuplicateTokenCodec } from "./potential-duplicate-token-codec.ts";
export interface PotentialDuplicateRuntime { readonly service: PotentialDuplicateService }
export function getPotentialDuplicateRuntime(): PotentialDuplicateRuntime { const mode = loadRuntimeEnvironment().appRuntimeMode; if (mode === "production-aws") throw new Error("Potential duplicate unavailable"); const map = globalForCrm.__txPotentialDuplicateRuntimes ?? new Map<string, PotentialDuplicateRuntime>(); globalForCrm.__txPotentialDuplicateRuntimes = map; let runtime = map.get(mode); if (!runtime) { runtime = Object.freeze({ service: new PotentialDuplicateService(new PostgresqlPotentialDuplicateRepository(getApplicationTenantRunner()), potentialDuplicateTokenCodec) }); map.set(mode, runtime); } return runtime; }

export interface ReferralSourceRuntime { readonly service: ReferralSourceService }
export class ReferralSourceRuntimeUnavailable extends Error {
  constructor() { super("Referral source runtime is not configured."); this.name = "ReferralSourceRuntimeUnavailable"; }
}
export function isReferralSourceRuntimeUnavailable(value: unknown): value is ReferralSourceRuntimeUnavailable {
  return value instanceof Error && value.name === "ReferralSourceRuntimeUnavailable";
}
export function getReferralSourceRuntime(): ReferralSourceRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new ReferralSourceRuntimeUnavailable();
  const runtimes = globalForCrm.__txReferralSourceRuntimes ?? new Map<string, ReferralSourceRuntime>();
  globalForCrm.__txReferralSourceRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    try { runtime = Object.freeze({ service: new ReferralSourceService(
      new PostgresqlReferralSourceRepository(getApplicationTenantRunner())) }); }
    catch { throw new ReferralSourceRuntimeUnavailable(); }
    runtimes.set(mode, runtime);
  }
  return runtime;
}

export interface DeletionReviewRuntime { readonly service: DeletionReviewService }
export class DeletionReviewRuntimeUnavailable extends Error {
  constructor() { super("Deletion review runtime is not configured."); this.name = "DeletionReviewRuntimeUnavailable"; }
}
export function isDeletionReviewRuntimeUnavailable(value: unknown): value is DeletionReviewRuntimeUnavailable {
  return value instanceof Error && value.name === "DeletionReviewRuntimeUnavailable";
}
export function getDeletionReviewRuntime(): DeletionReviewRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new DeletionReviewRuntimeUnavailable();
  const runtimes = globalForCrm.__txDeletionReviewRuntimes ?? new Map<string, DeletionReviewRuntime>();
  globalForCrm.__txDeletionReviewRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    try { runtime = Object.freeze({ service: new DeletionReviewService(
      new PostgresqlDeletionReviewRepository(getApplicationTenantRunner(),
        new PostgresqlCustomerDeletionGuard())) }); }
    catch { throw new DeletionReviewRuntimeUnavailable(); }
    runtimes.set(mode, runtime);
  }
  return runtime;
}

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
  __txReferralSourceRuntimes?: Map<string, ReferralSourceRuntime>;
  __txGuardianRelationshipRuntimes?: Map<string, GuardianRelationshipRuntime>;
  __txDeletionReviewRuntimes?: Map<string, DeletionReviewRuntime>;
  __txStudentReadRuntimes?: Map<string, StudentReadRuntime>;
  __txStudentCreateRuntimes?: Map<string, StudentCreateRuntime>;
  __txProfileMaintenanceRuntimes?: Map<string, ProfileMaintenanceRuntime>;
  __txPotentialDuplicateRuntimes?: Map<string, PotentialDuplicateRuntime>;
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
