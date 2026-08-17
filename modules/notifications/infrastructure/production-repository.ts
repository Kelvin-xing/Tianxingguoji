import "server-only";

import type { DeliveryReceipt } from "../domain/contract.ts";
import type { TenantDatabaseContext, TenantTransactionRunner } from "../../shared/server.ts";
import { runSupportingModuleTransaction, SupportingRepositoryError } from "../../audit/server.ts";

/** Records one effect, or returns its exact prior receipt. A mismatched effect is never replayed. */
export async function recordNotificationEffect(input: {
  readonly runner: TenantTransactionRunner;
  readonly context: TenantDatabaseContext;
  readonly receipt: DeliveryReceipt;
}): Promise<{ readonly replayed: boolean; readonly receipt: DeliveryReceipt }> {
  return runSupportingModuleTransaction({
    runner: input.runner, module: "notifications", context: input.context,
    operation: async (transaction) => {
      const existing = await transaction.query<DeliveryReceipt>({
        text: `SELECT id, organization_id AS "organizationId", outbox_id AS "outboxId",
          notification_id AS "notificationId", effect_type AS "effectType",
          effect_idempotency_key AS "effectIdempotencyKey", outcome,
          attempt_count AS "attemptCount", created_at AS "createdAt"
          FROM notifications_delivery_receipts
          WHERE organization_id = $1 AND effect_type = $2 AND effect_idempotency_key = $3 FOR UPDATE`,
        values: [input.receipt.organizationId, input.receipt.effectType, input.receipt.effectIdempotencyKey],
      });
      if (existing.length === 1) {
        if (existing[0].outboxId !== input.receipt.outboxId ||
            existing[0].notificationId !== input.receipt.notificationId ||
            existing[0].id !== input.receipt.id ||
            existing[0].outcome !== input.receipt.outcome ||
            existing[0].attemptCount !== input.receipt.attemptCount ||
            existing[0].createdAt !== input.receipt.createdAt) {
          throw new SupportingRepositoryError("SUPPORTING_EFFECT_CONFLICT");
        }
        return Object.freeze({ replayed: true, receipt: Object.freeze({ ...existing[0] }) });
      }
      await transaction.query({
        text: `INSERT INTO notifications_delivery_receipts
          (id, organization_id, outbox_id, notification_id, effect_type,
           effect_idempotency_key, outcome, attempt_count, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        values: [input.receipt.id, input.receipt.organizationId, input.receipt.outboxId,
          input.receipt.notificationId, input.receipt.effectType, input.receipt.effectIdempotencyKey,
          input.receipt.outcome, input.receipt.attemptCount, input.receipt.createdAt],
      });
      return Object.freeze({ replayed: false, receipt: input.receipt });
    },
  });
}
