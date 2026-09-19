import "server-only";

import { loadTrialPrincipal } from '../../access/server.ts';
import type { TenantTransaction } from '../../shared/server.ts';

/** Separate administrative reads from the internal Founder-only delivery path. */
export async function hasCurrentEmailAccess(
  transaction: TenantTransaction,
  organizationId: string,
  actorUserId: string,
  purpose: 'manage' | 'delivery',
): Promise<boolean> {
  const principal = await loadTrialPrincipal({
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      return transaction.query<Row>({ text, values });
    },
  }, { organizationId, userId: actorUserId, lock: true });
  if (principal && (!principal.active || principal.level !== 'founder')) return false;
  const role = principal !== null || purpose === 'delivery' ? 'founder' : 'admin';
  const result = await transaction.query<{ id: string }>({
    text: `SELECT b.id FROM access_organization_memberships m
      JOIN identity_users u ON u.id=m.user_id
      JOIN access_organizations o ON o.id=m.organization_id
      JOIN access_role_bindings b ON b.organization_id=m.organization_id
        AND b.membership_id=m.id AND b.user_id=m.user_id
      WHERE m.organization_id=$1 AND m.user_id=$2
        AND m.status='active' AND u.status='active' AND o.status='active'
        AND b.status='active' AND b.role=$3
        AND ($4::boolean OR NOT EXISTS (
          SELECT 1 FROM access_trial_members t
          WHERE t.organization_id=m.organization_id AND t.user_id=m.user_id))
      LIMIT 1 FOR SHARE OF m,u,o,b`,
    values: [organizationId, actorUserId, role, principal !== null],
  });
  return result.rows.length === 1;
}
