import type { OrganizationRole } from "../access/contract.ts";

export interface IdentitySessionActor {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: OrganizationRole;
  readonly sessionId: string;
  readonly capturedSessionVersion: number;
  readonly reauthenticatedAtMs: number | null;
}
