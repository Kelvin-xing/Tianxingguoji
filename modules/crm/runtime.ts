import type { GuardianRelationshipService } from "./guardian-relationship-service.ts";

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
