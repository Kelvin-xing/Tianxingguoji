import "server-only";

import type { CognitoManagedLoginVerifier } from "./cognito-adapter.ts";
import type { IdentityService } from "./service.ts";

export interface IdentityRuntime {
  readonly service: IdentityService;
  readonly managedLoginVerifier: CognitoManagedLoginVerifier;
}

export class IdentityRuntimeUnavailable extends Error {
  constructor() {
    super("Identity runtime is not configured.");
    this.name = "IdentityRuntimeUnavailable";
  }
}

/**
 * P1-03 deliberately has no default local-password, Neon, or cloud fallback.
 * The RDS IAM and Cognito adapters are installed only by the HK runtime
 * composition root after its exact cloud payload has been approved.
 */
export function getIdentityRuntime(): IdentityRuntime {
  throw new IdentityRuntimeUnavailable();
}
