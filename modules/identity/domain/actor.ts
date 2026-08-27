import type { OrganizationRole, WorkspaceCapability } from "../../access/public.ts";

/** Canonical identity result. Access resolves organization and roles separately. */
export interface IdentityPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly capturedSessionVersion: number;
  readonly reauthenticatedAtMs: number | null;
  readonly organizationId: string;
  readonly membershipId: string;
}

/**
 * Compatibility shape for pre-P1-BE-02 consumers. New authorization code must
 * use IdentityPrincipal and resolve AccessContext on every request.
 */
export interface IdentitySessionActor {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: OrganizationRole;
  readonly sessionId: string;
  readonly capturedSessionVersion: number;
  readonly reauthenticatedAtMs: number | null;
  /** Request-time Access union attached by module web boundaries. */
  readonly roles?: readonly OrganizationRole[];
  readonly workspaceCapabilities?: readonly WorkspaceCapability[];
}

export type CanonicalIdentitySessionActor = IdentitySessionActor & IdentityPrincipal;
