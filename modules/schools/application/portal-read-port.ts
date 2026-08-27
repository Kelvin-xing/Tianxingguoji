import type { TenantTransaction } from "../../shared/server.ts";

export interface SchoolsPortalReadPort {
  readLabels(transaction: TenantTransaction, input: Readonly<{ organizationId: string; schoolIds: readonly string[] }>): Promise<ReadonlyMap<string, string>>;
}
