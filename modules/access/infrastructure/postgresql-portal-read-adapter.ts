import "server-only";

import type { TenantTransaction } from "../../shared/server.ts";
import type { AccessPortalActorFacts, AccessPortalReadPort } from "../application/portal-read-port.ts";

export class PostgreSqlAccessPortalReadAdapter implements AccessPortalReadPort {
  async readActorFacts(transaction: TenantTransaction, input: { organizationId: string; actorUserId: string }): Promise<AccessPortalActorFacts | null> {
    const result = await transaction.query<AccessPortalActorFacts>({
      text: `SELECT organization.status AS "organizationStatus", user_row.status AS "userStatus",
        membership.status AS "membershipStatus",
        EXISTS (SELECT 1 FROM access_role_bindings AS binding
          WHERE binding.organization_id=$1 AND binding.user_id=$2
            AND binding.role='founder' AND binding.status='active') AS "isFounder"
        FROM access_organizations AS organization
        JOIN identity_users AS user_row ON user_row.id=$2
        JOIN access_organization_memberships AS membership
          ON membership.organization_id=$1 AND membership.user_id=$2
        WHERE organization.id=$1`,
      values: [input.organizationId, input.actorUserId],
    });
    return result.rows[0] ?? null;
  }
}
