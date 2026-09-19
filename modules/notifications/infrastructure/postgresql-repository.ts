import "server-only";

import {
  claimAuditOutboxRow,
  completeAuditOutboxRow,
  deadLetterAuditOutboxRow,
  releaseAuditOutboxRowForNextRecipient,
  retryAuditOutboxRow,
  runSupportingModuleTransaction,
  SupportingRepositoryError,
} from "../../audit/server.ts";
import type { TenantDatabaseContext, TenantTransactionRunner } from "../../shared/server.ts";
import {
  MAX_IN_APP_DELIVERY_ATTEMPTS,
  type InAppDeliveryClaim,
  type InAppDeliveryCompletion,
  type InAppDeliveryFailure,
  type InAppNotificationRepository,
} from "../application/service.ts";
import type { DeliveryReceipt, NotificationRecord } from "../domain/contract.ts";
import { currentNotificationRecipient } from "./current-recipient.ts";

type Row = Record<string, unknown>;

const RECIPIENT_LATERAL = `
  CROSS JOIN LATERAL (
    SELECT DISTINCT candidate.recipient_user_id,
      md5(concat_ws(':', o.aggregate_id::text, o.event_type,
        to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), o.event_version::text,
        candidate.recipient_user_id::text)) AS effect_idempotency_key
    FROM (
      SELECT CASE
        WHEN o.event_type IN ('tasks.due_3d','tasks.due_1d','tasks.overdue')
          THEN task.assignee_user_id
        WHEN o.event_type = 'tasks.task_transitioned'
          AND transition_receipt.to_state = 'awaiting_reassignment'
          THEN service_case.primary_user_id
        ELSE task.assignee_user_id
      END AS recipient_user_id
      WHERE o.event_type LIKE 'tasks.%'
      UNION ALL
      SELECT service_case.primary_user_id
       WHERE o.event_type IN ('tasks.due_3d','tasks.due_1d','tasks.overdue',
                             'cases.candidate_list_approved','cases.candidate_list_rejected',
                             'cases.service_case_stage_transitioned','cases.service_case_closed')
      UNION ALL
      SELECT binding.user_id
        FROM access_role_bindings AS binding
        JOIN access_organization_memberships AS membership
          ON membership.id=binding.membership_id AND membership.organization_id=binding.organization_id
         AND membership.user_id=binding.user_id
        JOIN identity_users AS user_row
          ON user_row.id=binding.user_id
       WHERE binding.organization_id=o.organization_id
         AND binding.status='active' AND membership.status='active' AND user_row.status='active'
         AND binding.role='founder'
         AND o.event_type IN ('tasks.overdue','cases.candidate_list_submitted',
                              'cases.service_case_stage_transitioned','cases.service_case_closed')
    ) AS candidate
   WHERE candidate.recipient_user_id IS NOT NULL
  ) AS recipient`;

const SOURCE_JOINS = `
        LEFT JOIN audit_events AS source_event
          ON source_event.id=o.audit_event_id AND source_event.organization_id=o.organization_id
        LEFT JOIN tasks_tasks AS task
          ON o.aggregate_type='Task' AND task.id=o.aggregate_id AND task.organization_id=o.organization_id
        LEFT JOIN cases_candidate_school_list_versions AS candidate_list
          ON o.aggregate_type='CandidateSchoolListVersion'
         AND candidate_list.id=o.aggregate_id AND candidate_list.organization_id=o.organization_id
        LEFT JOIN cases_service_cases AS service_case
          ON service_case.organization_id=o.organization_id
         AND service_case.id=CASE
           WHEN o.aggregate_type='Task' THEN task.service_case_id
           WHEN o.aggregate_type='CandidateSchoolListVersion' THEN candidate_list.service_case_id
           ELSE o.aggregate_id
         END
        LEFT JOIN tasks_task_transition_receipts AS transition_receipt
          ON transition_receipt.task_id=task.id
         AND transition_receipt.organization_id=task.organization_id
         AND transition_receipt.result_record_version=task.record_version`;

/** PostgreSQL worker adapter. It resolves current recipients at claim/complete time. */
export class PostgresqlInAppNotificationRepository implements InAppNotificationRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly organizationId: string;

  constructor(input: { readonly runner: TenantTransactionRunner; readonly organizationId: string }) {
    this.runner = input.runner;
    this.organizationId = input.organizationId;
  }

  async claimNextInAppDelivery(input: Parameters<InAppNotificationRepository["claimNextInAppDelivery"]>[0]): Promise<InAppDeliveryClaim> {
    const context = workerContext(this.organizationId, input.workerId);
    return runSupportingModuleTransaction({
      runner: this.runner, module: "notifications", context,
      operation: async (tx) => {
        const row = await tx.query<Row>({
          text: `SELECT o.id, o.organization_id, o.event_type, o.idempotency_key,
                   o.attempt_count, o.lease_version, recipient.recipient_user_id,
                   recipient.effect_idempotency_key,
                   transition_receipt.from_state AS transition_from_state,
                   transition_receipt.to_state AS transition_to_state
              FROM audit_outbox AS o
              ${SOURCE_JOINS}
              ${RECIPIENT_LATERAL}
             WHERE o.organization_id = $1
               AND ($2::uuid IS NULL OR o.id = $2)
               AND o.status = 'pending'
               AND o.available_at <= transaction_timestamp()
               AND (o.leased_until IS NULL OR o.leased_until <= transaction_timestamp())
               AND o.event_type IN (
                 'tasks.task_created','tasks.task_transitioned','cases.service_case_stage_transitioned',
                 'cases.candidate_list_submitted','cases.candidate_list_approved',
                 'cases.candidate_list_rejected','tasks.due_3d','tasks.due_1d','tasks.overdue',
                 'cases.service_case_closed'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM notifications_delivery_receipts AS prior_receipt
                  WHERE prior_receipt.organization_id=o.organization_id
                    AND prior_receipt.outbox_id=o.id
                    AND prior_receipt.recipient_user_id=recipient.recipient_user_id
               )
             ORDER BY o.available_at, o.created_at
             FOR UPDATE OF o SKIP LOCKED LIMIT 1`,
          values: [this.organizationId, input.outboxId],
        });
        const candidate = row[0];
        if (!candidate || typeof candidate.id !== "string" || typeof candidate.recipient_user_id !== "string" ||
            typeof candidate.effect_idempotency_key !== "string") {
          return { status: "idle" } as const;
        }
        const existing = await tx.query<Row>({
          text: `SELECT id, organization_id AS "organizationId", outbox_id AS "outboxId",
            notification_id AS "notificationId", recipient_user_id AS "recipientUserId",
            effect_type AS "effectType", effect_idempotency_key AS "effectIdempotencyKey",
            outcome, attempt_count AS "attemptCount", created_at AS "createdAt"
            FROM notifications_delivery_receipts
           WHERE organization_id = $1 AND outbox_id = $2 AND recipient_user_id = $3
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          values: [this.organizationId, candidate.id, candidate.recipient_user_id],
        });
        if (existing[0]) {
          return { status: "duplicate", outboxId: candidate.id, receipt: toReceipt(existing[0]) } as const;
        }
        const updated = await claimAuditOutboxRow(tx, {
          id: candidate.id, organizationId: this.organizationId, leaseUntilMs: input.leaseUntilMs,
        });
        const claimed = updated[0];
        if (!claimed) return { status: "idle" } as const;
        return {
            status: "claimed",
          work: Object.freeze({
            outboxId: String(claimed.id), organizationId: this.organizationId,
            recipientUserId: String(candidate.recipient_user_id), eventType: String(claimed.event_type),
            effectIdempotencyKey: String(candidate.effect_idempotency_key),
            transitionFromState: candidate.transition_from_state == null ? null : String(candidate.transition_from_state),
            transitionToState: candidate.transition_to_state == null ? null : String(candidate.transition_to_state),
            attemptCount: Number(claimed.attempt_count),
            leaseVersion: Number(claimed.lease_version),
          }),
        } as const;
      },
    });
  }

  async completeInAppDelivery(input: Parameters<InAppNotificationRepository["completeInAppDelivery"]>[0]): Promise<InAppDeliveryCompletion> {
    const context = workerContext(input.work.organizationId, input.work.recipientUserId);
    return runSupportingModuleTransaction({
      runner: this.runner, module: "notifications", context,
      operation: async (tx) => {
        const duplicate = await tx.query<Row>({
          text: `SELECT id, organization_id AS "organizationId", outbox_id AS "outboxId",
              notification_id AS "notificationId", recipient_user_id AS "recipientUserId",
              effect_type AS "effectType", effect_idempotency_key AS "effectIdempotencyKey",
              outcome, attempt_count AS "attemptCount", created_at AS "createdAt"
            FROM notifications_delivery_receipts
           WHERE organization_id=$1 AND effect_idempotency_key=$2 FOR UPDATE`,
          values: [input.work.organizationId, input.work.effectIdempotencyKey],
        });
        if (duplicate[0]) {
          const receipt = toReceipt(duplicate[0]);
          if (receipt.outboxId !== input.work.outboxId) {
            const closed = await completeAuditOutboxRow(tx, {
              id: input.work.outboxId,
              organizationId: input.work.organizationId,
              leaseVersion: input.work.leaseVersion,
            });
            if (closed.length === 0) throw new SupportingRepositoryError("SUPPORTING_EFFECT_CONFLICT");
          }
          const notice = await tx.query<Row>({
            text: `SELECT id, organization_id AS "organizationId", recipient_user_id AS "recipientUserId",
              channel, content_code AS "contentCode", 'A pending item needs attention.' AS text,
              outbox_id AS "outboxId", effect_type AS "effectType", effect_idempotency_key AS "effectIdempotencyKey",
              status, created_at AS "createdAt", read_at AS "readAt", record_version AS "recordVersion",
              target_kind AS "targetKind", target_opaque_id AS "targetOpaqueId", target_action AS "targetAction"
            FROM notifications_notifications WHERE id=$1`, values: [receipt.notificationId],
          });
          const notification = receipt.outcome === "compensated"
            ? input.suppressedNotification
            : toNotification(notice[0] ?? input.deliveredNotification);
          return { status: "duplicate", notification, receipt };
        }
        const access = await currentNotificationRecipient(tx, input.work.organizationId, input.work.recipientUserId);
        const lease = await tx.query<Row>({
          text: `SELECT id FROM audit_outbox
                  WHERE id=$1 AND organization_id=$2 AND status='processing' AND lease_version=$3
                  FOR UPDATE`,
          values: [input.work.outboxId, input.work.organizationId, input.work.leaseVersion],
        });
        if (!lease[0]) throw new SupportingRepositoryError("SUPPORTING_EFFECT_CONFLICT");
        const caseEvent = input.work.eventType.startsWith("cases.");
        const delivered = access.allowed && !(access.taskOnly && caseEvent);
        const notification = delivered ? input.deliveredNotification : input.suppressedNotification;
        const receipt = delivered ? input.deliveredReceipt : input.suppressedReceipt;
        if (delivered) {
          await insertNotification(tx, notification);
        }
        await insertReceipt(tx, receipt);
        const pendingRecipient = await tx.query<Row>({
          text: `SELECT 1
                   FROM audit_outbox AS o
                   ${SOURCE_JOINS}
                   ${RECIPIENT_LATERAL}
                  WHERE o.id=$1 AND o.organization_id=$2 AND o.status='processing'
                    AND NOT EXISTS (
                      SELECT 1 FROM notifications_delivery_receipts AS prior_receipt
                       WHERE prior_receipt.organization_id=o.organization_id
                         AND prior_receipt.outbox_id=o.id
                         AND prior_receipt.recipient_user_id=recipient.recipient_user_id
                    )
                  LIMIT 1`,
          values: [input.work.outboxId, input.work.organizationId],
        });
        const advanced = pendingRecipient.length > 0
          ? await releaseAuditOutboxRowForNextRecipient(tx, {
            id: input.work.outboxId, organizationId: input.work.organizationId, leaseVersion: input.work.leaseVersion,
          })
          : await completeAuditOutboxRow(tx, {
            id: input.work.outboxId, organizationId: input.work.organizationId, leaseVersion: input.work.leaseVersion,
          });
        if (advanced.length === 0) throw new SupportingRepositoryError("SUPPORTING_EFFECT_CONFLICT");
        return { status: delivered ? "delivered" : "suppressed", notification, receipt };
      },
    });
  }

  async failInAppDelivery(input: Parameters<InAppNotificationRepository["failInAppDelivery"]>[0]): Promise<InAppDeliveryFailure> {
    const context = workerContext(input.work.organizationId, input.work.recipientUserId);
    return runSupportingModuleTransaction({
      runner: this.runner, module: "notifications", context,
      operation: async (tx) => {
        if (input.work.attemptCount < MAX_IN_APP_DELIVERY_ATTEMPTS) {
          const retried = await retryAuditOutboxRow(tx, { id: input.work.outboxId, organizationId: input.work.organizationId, leaseVersion: input.work.leaseVersion });
          if (retried.length === 0) throw new SupportingRepositoryError("SUPPORTING_EFFECT_CONFLICT");
          return { status: "retry", outboxId: input.work.outboxId, attemptCount: input.work.attemptCount, receipt: null };
        }
        if (input.terminalReceipt) await insertReceipt(tx, input.terminalReceipt);
        const deadLettered = await deadLetterAuditOutboxRow(tx, { id: input.work.outboxId, organizationId: input.work.organizationId, leaseVersion: input.work.leaseVersion });
        if (deadLettered.length === 0) throw new SupportingRepositoryError("SUPPORTING_EFFECT_CONFLICT");
        return { status: "dead_letter", outboxId: input.work.outboxId, attemptCount: input.work.attemptCount, receipt: input.terminalReceipt };
      },
    });
  }
}

function workerContext(organizationId: string, actorUserId: string): TenantDatabaseContext {
  return { organizationId, actorUserId };
}

async function insertNotification(tx: { query(input: { text: string; values?: readonly unknown[] }): Promise<readonly Row[]> }, notice: NotificationRecord): Promise<void> {
  await tx.query({
    text: `INSERT INTO notifications_notifications
      (id, organization_id, recipient_user_id, outbox_id, effect_type, effect_idempotency_key,
       channel, content_code, status, record_version, read_at, target_kind, target_opaque_id, target_action, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'in_app','PENDING_ITEM',$7,1,$8,$9,$10,$11,$12,$12)`,
    values: [notice.id, notice.organizationId, notice.recipientUserId, notice.outboxId,
      notice.effectType, notice.effectIdempotencyKey, notice.status, notice.readAt ?? null,
      notice.targetKind ?? "workspace", notice.targetOpaqueId ?? notice.outboxId,
      notice.targetAction ?? "resolve_target", notice.createdAt],
  });
}

async function insertReceipt(tx: { query(input: { text: string; values?: readonly unknown[] }): Promise<readonly Row[]> }, receipt: DeliveryReceipt): Promise<void> {
  await tx.query({
    text: `INSERT INTO notifications_delivery_receipts
      (id, organization_id, outbox_id, notification_id, recipient_user_id, effect_type,
       effect_idempotency_key, outcome, attempt_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
    values: [receipt.id, receipt.organizationId, receipt.outboxId, receipt.notificationId,
      receipt.recipientUserId, receipt.effectType, receipt.effectIdempotencyKey,
      receipt.outcome, receipt.attemptCount, receipt.createdAt],
  });
}

function toReceipt(row: Row): DeliveryReceipt {
  return Object.freeze({
    id: String(row.id), organizationId: String(row.organizationId), outboxId: String(row.outboxId),
    notificationId: row.notificationId === null ? null : String(row.notificationId),
    recipientUserId: row.recipientUserId === undefined ? undefined : String(row.recipientUserId),
    effectType: String(row.effectType), effectIdempotencyKey: String(row.effectIdempotencyKey),
    outcome: row.outcome as DeliveryReceipt["outcome"], attemptCount: Number(row.attemptCount),
    createdAt: new Date(String(row.createdAt)).toISOString(),
  });
}

function toNotification(row: Row): NotificationRecord {
  return Object.freeze({
    id: String(row.id), organizationId: String(row.organizationId), recipientUserId: String(row.recipientUserId),
    channel: "in_app", contentCode: "PENDING_ITEM", text: "A pending item needs attention.",
    outboxId: String(row.outboxId), effectType: String(row.effectType), effectIdempotencyKey: String(row.effectIdempotencyKey),
    status: row.status as NotificationRecord["status"], createdAt: new Date(String(row.createdAt)).toISOString(),
    readAt: row.readAt === null ? null : String(row.readAt), recordVersion: Number(row.recordVersion ?? 1),
    targetKind: row.targetKind === null ? null : String(row.targetKind), targetOpaqueId: row.targetOpaqueId === null ? null : String(row.targetOpaqueId),
    targetAction: row.targetAction === null ? null : String(row.targetAction),
  });
}
