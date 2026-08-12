import type { PortalRepository } from "./repository.ts";

export interface PortalRuntime {
  readonly repository: PortalRepository;
}

export class PortalRuntimeUnavailable extends Error {
  readonly code = "PORTAL_RUNTIME_UNAVAILABLE" as const;

  constructor() {
    super("External portal runtime is not configured.");
    this.name = "PortalRuntimeUnavailable";
  }
}

export function createPortalRuntime(repository: PortalRepository): PortalRuntime {
  if (!repository || typeof repository !== "object") {
    throw new PortalRuntimeUnavailable();
  }
  return Object.freeze({ repository });
}

/** R1X-09 must install the HK RDS adapter; no local or Neon fallback exists. */
export function getPortalRuntime(): PortalRuntime {
  throw new PortalRuntimeUnavailable();
}
