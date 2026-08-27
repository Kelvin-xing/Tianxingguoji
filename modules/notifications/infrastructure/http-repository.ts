import "server-only";

import { runSupportingModuleTransaction } from "../../audit/server.ts";
import type { TenantDatabaseContext, TenantTransactionRunner } from "../../shared/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import { randomUUID } from "node:crypto";

export interface NotificationHttpRow {
  readonly id: string;
  readonly content_code: "PENDING_ITEM";
  readonly status: "unread" | "read";
  readonly created_at: string;
  readonly read_at: string | null;
  readonly record_version: number;
  readonly target_kind: string | null;
  readonly target_opaque_id: string | null;
  readonly target_action: string | null;
}

export class NotificationHttpRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  async list(input: { readonly organizationId: string; readonly userId: string; readonly limit: number }): Promise<readonly NotificationHttpRow[]> {
    return runSupportingModuleTransaction({
      runner: this.runner, module: "notifications", context: context(input.organizationId, input.userId),
      operation: async (tx) => {
        const rows = await tx.query<NotificationHttpRow>({
          text: `SELECT id, content_code, status, created_at, read_at, record_version,
                        target_kind, target_opaque_id, target_action
                   FROM notifications_notifications
                  WHERE organization_id=$1 AND recipient_user_id=$2
                    AND status IN ('unread','read')
                  ORDER BY created_at DESC, id DESC LIMIT $3`,
          values: [input.organizationId, input.userId, input.limit],
        });
        return rows.map(normalize);
      },
    });
  }

  async unreadCount(input: { readonly organizationId: string; readonly userId: string }): Promise<number> {
    return runSupportingModuleTransaction({
      runner: this.runner, module: "notifications", context: context(input.organizationId, input.userId),
      operation: async (tx) => {
        const rows = await tx.query<{ count: string }>({
          text: `SELECT count(*)::text AS count FROM notifications_notifications
                  WHERE organization_id=$1 AND recipient_user_id=$2 AND status='unread'`,
          values: [input.organizationId, input.userId],
        });
        return Number(rows[0]?.count ?? 0);
      },
    });
  }

  async markRead(input: { readonly organizationId: string; readonly userId: string; readonly notificationId: string; readonly expectedRecordVersion: number; readonly idempotencyKey: string }): Promise<NotificationHttpRow> {
    return runSupportingModuleTransaction({
      runner: this.runner, module: "notifications", context: context(input.organizationId, input.userId),
      operation: async (tx) => {
        const requestHash = hashRequestPayload({ notification_id: input.notificationId, expected_record_version: input.expectedRecordVersion });
        const existing = await tx.query<{ state: string; request_hash: string; result_reference: string | null }>({
          text: `SELECT state, request_hash, result_reference FROM shared_idempotency_records
                  WHERE organization_id=$1 AND actor_kind='user' AND actor_opaque_id=$2
                    AND operation='notifications.read' AND idempotency_key=$3 FOR UPDATE`,
          values: [input.organizationId, input.userId, input.idempotencyKey],
        });
        if (existing[0] && existing[0].request_hash !== requestHash) throw new NotificationHttpError("CONFLICT");
        if (!existing[0]) {
          await tx.query({
            text: `INSERT INTO shared_idempotency_records
              (id, organization_id, actor_user_id, actor_kind, actor_opaque_id, operation,
               idempotency_key, request_hash, state, record_version)
              VALUES ($1,$2,$3,'user',$3,'notifications.read',$4,$5,'in_progress',1)`,
            values: [randomUUID(), input.organizationId, input.userId, input.idempotencyKey, requestHash],
          });
        } else if (existing[0].state === "completed") {
          const replay = await tx.query<NotificationHttpRow>({
            text: `SELECT id, content_code, status, created_at, read_at, record_version,
                          target_kind, target_opaque_id, target_action
                     FROM notifications_notifications
                    WHERE id=$1 AND organization_id=$2 AND recipient_user_id=$3`,
            values: [input.notificationId, input.organizationId, input.userId],
          });
          if (!replay[0]) throw new NotificationHttpError("NOT_FOUND");
          return normalize(replay[0]);
        }
        const current = await tx.query<NotificationHttpRow>({
          text: `SELECT id, content_code, status, created_at, read_at, record_version,
                        target_kind, target_opaque_id, target_action
                   FROM notifications_notifications
                  WHERE id=$1 AND organization_id=$2 AND recipient_user_id=$3
                    AND status IN ('unread','read') FOR UPDATE`,
          values: [input.notificationId, input.organizationId, input.userId],
        });
        const row = current[0];
        if (!row) throw new NotificationHttpError("NOT_FOUND");
        if (Number(row.record_version) !== input.expectedRecordVersion && row.status === "unread") {
          throw new NotificationHttpError("STALE_VERSION");
        }
        if (row.status === "read") {
          await tx.query({
            text: `UPDATE shared_idempotency_records
                      SET state='completed', result_reference=$1, response_hash=$2,
                          record_version=record_version+1, updated_at=transaction_timestamp()
                    WHERE organization_id=$3 AND actor_kind='user' AND actor_opaque_id=$4
                      AND operation='notifications.read' AND idempotency_key=$5 AND state='in_progress'`,
            values: [input.notificationId, hashRequestPayload({ id: row.id, record_version: Number(row.record_version) }), input.organizationId, input.userId, input.idempotencyKey],
          });
          return normalize(row);
        }
        const updated = await tx.query<NotificationHttpRow>({
          text: `UPDATE notifications_notifications
                    SET status='read', read_at=transaction_timestamp(),
                        record_version=record_version+1, updated_at=transaction_timestamp()
                  WHERE id=$1 AND organization_id=$2 AND recipient_user_id=$3
                    AND status='unread' AND record_version=$4
              RETURNING id, content_code, status, created_at, read_at, record_version,
                        target_kind, target_opaque_id, target_action`,
          values: [input.notificationId, input.organizationId, input.userId, input.expectedRecordVersion],
        });
        if (!updated[0]) throw new NotificationHttpError("STALE_VERSION");
        await tx.query({
          text: `UPDATE shared_idempotency_records
                    SET state='completed', result_reference=$1, response_hash=$2,
                        record_version=record_version+1, updated_at=transaction_timestamp()
                  WHERE organization_id=$3 AND actor_kind='user' AND actor_opaque_id=$4
                    AND operation='notifications.read' AND idempotency_key=$5 AND state='in_progress'`,
          values: [input.notificationId, hashRequestPayload({ id: updated[0].id, record_version: Number(updated[0].record_version) }), input.organizationId, input.userId, input.idempotencyKey],
        });
        return normalize(updated[0]);
      },
    });
  }
}

export type NotificationHttpErrorCode = "NOT_FOUND" | "STALE_VERSION" | "CONFLICT";
export class NotificationHttpError extends Error {
  readonly code: NotificationHttpErrorCode;

  constructor(code: NotificationHttpErrorCode) {
    super(code);
    this.name = "NotificationHttpError";
    this.code = code;
  }
}

function context(organizationId: string, actorUserId: string): TenantDatabaseContext {
  return { organizationId, actorUserId };
}

function normalize(row: NotificationHttpRow): NotificationHttpRow {
  return Object.freeze({
    id: String(row.id), content_code: "PENDING_ITEM", status: row.status === "read" ? "read" : "unread",
    created_at: new Date(String(row.created_at)).toISOString(),
    read_at: row.read_at === null ? null : new Date(String(row.read_at)).toISOString(),
    record_version: Number(row.record_version), target_kind: row.target_kind ?? null,
    target_opaque_id: row.target_opaque_id ?? null, target_action: row.target_action ?? null,
  });
}
