import "server-only";

import type { PlatformBillingRepository } from "./repository.ts";

export interface PlatformBillingRuntime {
  readonly repository: PlatformBillingRepository;
}

export class PlatformBillingRuntimeUnavailable extends Error {
  readonly code = "BILLING_RUNTIME_UNAVAILABLE" as const;

  constructor() {
    super("PlatformBilling runtime is not configured.");
    this.name = "PlatformBillingRuntimeUnavailable";
  }
}

export function createPlatformBillingRuntime(
  repository: PlatformBillingRepository,
): PlatformBillingRuntime {
  if (!repository || typeof repository !== "object") {
    throw new PlatformBillingRuntimeUnavailable();
  }
  return Object.freeze({ repository });
}

/** R1X-09 must install the HK RDS platform transaction adapter. */
export function getPlatformBillingRuntime(): PlatformBillingRuntime {
  throw new PlatformBillingRuntimeUnavailable();
}
