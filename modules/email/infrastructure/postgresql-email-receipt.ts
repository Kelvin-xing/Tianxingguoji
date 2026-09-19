import "server-only";

import type { TenantTransaction } from '../../shared/server.ts';

/** Rebuild a completed mutation from its immutable audit, never from retry time. */
export async function readEmailMutationReceipt(transaction: TenantTransaction, input: {
  organizationId: string; actorUserId: string; idempotencyKey: string;
}, operation: 'email.update_provider_settings' | 'email.update_template') {
  const result = await transaction.query<{
    audit_id: string; record_version: string; occurred_at: Date | string;
  }>({
    text: `SELECT a.id AS audit_id,a.metadata->>'record_version' AS record_version,a.occurred_at
      FROM shared_idempotency_records i JOIN audit_events a
        ON a.id::text=i.result_reference AND a.organization_id=i.organization_id
        AND a.actor_user_id=i.actor_user_id
      WHERE i.organization_id=$1 AND i.actor_kind='user' AND i.actor_opaque_id=$2
        AND i.operation=$3 AND i.idempotency_key=$4 AND i.state='completed'
        AND a.resource_id=$1 AND a.event_type=$5`,
    values: [input.organizationId, input.actorUserId, operation, input.idempotencyKey,
      operation === 'email.update_provider_settings' ? 'email.provider_settings.updated' : 'email.template.updated'],
  });
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  const recordVersion = Number(row.record_version);
  const updatedAt = new Date(row.occurred_at).toISOString();
  if (!Number.isSafeInteger(recordVersion) || recordVersion < 1) throw new Error('Invalid email mutation receipt');
  return { auditId: row.audit_id, recordVersion, updatedAt };
}
