import { AccessScopeService } from "./service.ts";

export interface AccessScopeRuntime {
  readonly service: AccessScopeService;
}

export class AccessScopeRuntimeUnavailable extends Error {
  constructor() {
    super("Access scope runtime is not configured.");
    this.name = "AccessScopeRuntimeUnavailable";
  }
}

/**
 * The approved HK RDS composition root must provide the only runtime adapter.
 * This module intentionally has no local, JSON, or legacy-Neon write fallback.
 */
export function getAccessScopeRuntime(): AccessScopeRuntime {
  throw new AccessScopeRuntimeUnavailable();
}
