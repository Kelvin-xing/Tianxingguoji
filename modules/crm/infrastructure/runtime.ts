import "server-only";

import type { GuardianRelationshipService } from "../application/guardian-relationship-service.ts";
import { StudentReadService } from "../application/read-service.ts";
import { isLocalSyntheticMode } from "../../../lib/runtime/local-synthetic-config.ts";
import { getLocalApplicationTenantRunner } from "../../shared/server.ts";
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
  __txLocalStudentReadRuntime?: StudentReadRuntime;
};

export function getStudentReadRuntime(): StudentReadRuntime {
  if (!isLocalSyntheticMode()) throw new GuardianRelationshipRuntimeUnavailable();
  if (!globalForCrmRead.__txLocalStudentReadRuntime) {
    globalForCrmRead.__txLocalStudentReadRuntime = Object.freeze({
      service: new StudentReadService(
        new PostgresqlStudentReadRepository(getLocalApplicationTenantRunner()),
      ),
    });
  }
  return globalForCrmRead.__txLocalStudentReadRuntime;
}
