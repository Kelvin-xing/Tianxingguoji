import type { TenantTransaction } from "../../shared/server.ts";

export interface AccessPortalActorFacts {
  readonly organizationStatus: "active" | "disabled";
  readonly userStatus: "active" | "invited" | "disabled";
  readonly membershipStatus: "active" | "invited" | "disabled";
  readonly isFounder: boolean;
}

export interface AccessPortalReadPort {
  readActorFacts(transaction: TenantTransaction, input: Readonly<{ organizationId: string; actorUserId: string }>): Promise<AccessPortalActorFacts | null>;
}
