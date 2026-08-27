import type { TenantTransaction } from "../../shared/server.ts";

export interface CrmPortalRelationshipFacts { readonly active: boolean; readonly studentId: string; }
export interface CrmPortalReadPort {
  readGuardianRelationship(transaction: TenantTransaction, input: Readonly<{ organizationId: string; relationshipId: string; studentId: string }>): Promise<CrmPortalRelationshipFacts | null>;
}
