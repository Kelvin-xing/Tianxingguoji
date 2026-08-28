import "server-only";

import { getApplicationTenantRunner } from "../../shared/server.ts";
import { MemberManagementService } from "../application/member-management.ts";
import { PostgresqlMemberManagementRepository } from "./postgresql-member-management-repository.ts";

export interface MemberManagementRuntime {
  readonly service: MemberManagementService;
}

export class MemberManagementRuntimeUnavailable extends Error {
  constructor() {
    super("Member management runtime is unavailable.");
    this.name = "MemberManagementRuntimeUnavailable";
  }
}

export function isMemberManagementRuntimeUnavailable(
  error: unknown,
): error is MemberManagementRuntimeUnavailable {
  return error instanceof MemberManagementRuntimeUnavailable;
}

let runtime: MemberManagementRuntime | null = null;

export function getMemberManagementRuntime(): MemberManagementRuntime {
  if (runtime) return runtime;
  try {
    runtime = Object.freeze({
      service: new MemberManagementService({
        repository: new PostgresqlMemberManagementRepository(getApplicationTenantRunner()),
      }),
    });
    return runtime;
  } catch {
    throw new MemberManagementRuntimeUnavailable();
  }
}
