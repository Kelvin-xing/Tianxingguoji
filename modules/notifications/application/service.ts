import { randomUUID } from "node:crypto";

import {
  buildDeliveryReceipt,
  buildPendingItemNotification,
  type DeliveryReceipt,
  type NotificationRecord,
} from "../domain/contract.ts";
import { APPROVED_NOTIFICATION_EFFECTS, isApprovedNotificationEffect } from "../domain/p4-be-07-policy.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ELIGIBLE_OUTBOX_EVENTS = new Set([
  "tasks.task_transitioned",
  "cases.service_case_stage_transitioned",
  "tasks.task_created",
  "cases.candidate_list_submitted",
  "cases.candidate_list_approved",
  "cases.candidate_list_rejected",
  "tasks.due_3d",
  "tasks.due_1d",
  "tasks.overdue",
  "cases.service_case_closed",
]);
export const MAX_IN_APP_DELIVERY_ATTEMPTS = 3;
export const IN_APP_DELIVERY_LEASE_MS = 30_000;

export interface InAppNotificationClock {
  nowMs(): number;
}

/** An opaque leased work item; no case, task, document, or reason data leaves the repository. */
export interface InAppDeliveryWork {
  readonly outboxId: string;
  readonly organizationId: string;
  readonly recipientUserId: string;
  readonly eventType: string;
  readonly effectIdempotencyKey: string;
  readonly attemptCount: number;
  readonly leaseVersion: number;
}

export type InAppDeliveryClaim =
  | { readonly status: "idle" }
  | {
      readonly status: "duplicate";
      readonly outboxId: string;
      readonly receipt: DeliveryReceipt;
    }
  | { readonly status: "claimed"; readonly work: InAppDeliveryWork };

export type InAppDeliveryCompletion = {
  readonly status: "delivered" | "suppressed" | "duplicate";
  readonly notification: NotificationRecord;
  readonly receipt: DeliveryReceipt;
};

export interface InAppDeliveryFailure {
  readonly status: "retry" | "dead_letter";
  readonly outboxId: string;
  readonly attemptCount: number;
  readonly receipt: DeliveryReceipt | null;
}

export interface InAppNotificationRepository {
  /**
   * Production implementations select exactly one eligible P1-13/P1-14
   * outbox row with a lease. They must not expose aggregate payload data to
   * the worker and must return an existing delivery receipt as a duplicate.
   */
  claimNextInAppDelivery(input: {
    readonly workerId: string;
    readonly outboxId: string | null;
    readonly claimedAtMs: number;
    readonly leaseUntilMs: number;
  }): Promise<InAppDeliveryClaim>;

  /**
   * In one transaction, lock the leased outbox row, re-evaluate the proposed
   * recipient's current access, and write exactly one notification/receipt.
   * Lost access returns the supplied suppressed result and writes only a
   * compensated receipt with a null notification id, then completes the
   * outbox without exposing a notice.
   */
  completeInAppDelivery(input: {
    readonly work: InAppDeliveryWork;
    readonly completedAtMs: number;
    readonly deliveredNotification: NotificationRecord;
    readonly deliveredReceipt: DeliveryReceipt;
    readonly suppressedNotification: NotificationRecord;
    readonly suppressedReceipt: DeliveryReceipt;
  }): Promise<InAppDeliveryCompletion>;

  /**
   * A failure changes only worker/outbox delivery state. On the final bounded
   * attempt it atomically writes a failed receipt with a null notification id
   * before marking the outbox dead-lettered; it never touches the P1-13/P1-14
   * producer fact or producer audit record.
   */
  failInAppDelivery(input: {
    readonly work: InAppDeliveryWork;
    readonly failedAtMs: number;
    readonly terminalNotification: NotificationRecord | null;
    readonly terminalReceipt: DeliveryReceipt | null;
  }): Promise<InAppDeliveryFailure>;
}

export type InAppNotificationErrorCode =
  | "IN_APP_DELIVERY_INVALID"
  | "IN_APP_DELIVERY_RESULT_INVALID";

export class InAppNotificationError extends Error {
  readonly code: InAppNotificationErrorCode;

  constructor(code: InAppNotificationErrorCode) {
    super(`In-app notification delivery rejected ${code}.`);
    this.name = "InAppNotificationError";
    this.code = code;
  }
}

export interface InAppNotificationServiceOptions {
  readonly repository: InAppNotificationRepository;
  readonly clock?: InAppNotificationClock;
  readonly createId?: () => string;
}

/** Notification owns delivery receipts, never the Task or ServiceCase fact that produced an outbox row. */
export class InAppNotificationService {
  private readonly repository: InAppNotificationRepository;
  private readonly clock: InAppNotificationClock;
  private readonly createId: () => string;

  constructor(options: InAppNotificationServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async claimNextDelivery(input: {
    readonly workerId: string;
    readonly outboxId?: string;
  }): Promise<InAppDeliveryClaim> {
    assertUuid(input.workerId);
    if (input.outboxId !== undefined) assertUuid(input.outboxId);
    const claimedAtMs = this.now();
    const leaseUntilMs = claimedAtMs + IN_APP_DELIVERY_LEASE_MS;
    const claim = await this.repository.claimNextInAppDelivery({
      workerId: input.workerId,
      outboxId: input.outboxId ?? null,
      claimedAtMs,
      leaseUntilMs,
    });
    assertClaim(claim);
    return claim;
  }

  async completeDelivery(work: InAppDeliveryWork): Promise<InAppDeliveryCompletion> {
    assertWork(work);
    const completedAtMs = this.now();
    const notificationId = this.id();
    const deliveredReceiptId = this.id();
    const suppressedReceiptId = this.id();
    const createdAt = new Date(completedAtMs).toISOString();

    const deliveredNotification = buildPendingItemNotification({
      id: notificationId,
      organizationId: work.organizationId,
      recipientUserId: work.recipientUserId,
      outboxId: work.outboxId,
      effectType: notificationEffectForEvent(work.eventType),
      effectIdempotencyKey: work.effectIdempotencyKey,
      createdAt,
    });
    const suppressedNotification = buildPendingItemNotification({
      ...deliveredNotification,
      status: "suppressed",
    });
    const deliveredReceipt = buildDeliveryReceipt({
      id: deliveredReceiptId,
      organizationId: work.organizationId,
      outboxId: work.outboxId,
      notificationId,
      recipientUserId: work.recipientUserId,
      effectType: notificationEffectForEvent(work.eventType),
      effectIdempotencyKey: work.effectIdempotencyKey,
      outcome: "delivered",
      attemptCount: work.attemptCount,
      createdAt,
    });
    const suppressedReceipt = buildDeliveryReceipt({
      ...deliveredReceipt,
      id: suppressedReceiptId,
      notificationId: null,
      outcome: "compensated",
    });

    const result = await this.repository.completeInAppDelivery({
      work,
      completedAtMs,
      deliveredNotification,
      deliveredReceipt,
      suppressedNotification,
      suppressedReceipt,
    });
    assertCompletion(result, work);
    return result;
  }

  async failDelivery(work: InAppDeliveryWork): Promise<InAppDeliveryFailure> {
    assertWork(work);
    const failedAtMs = this.now();
    const terminal = work.attemptCount === MAX_IN_APP_DELIVERY_ATTEMPTS;
    let terminalNotification: NotificationRecord | null = null;
    let terminalReceipt: DeliveryReceipt | null = null;
    if (terminal) {
      const receiptId = this.id();
      const createdAt = new Date(failedAtMs).toISOString();
      terminalReceipt = buildDeliveryReceipt({
        id: receiptId,
        organizationId: work.organizationId,
        outboxId: work.outboxId,
        notificationId: null,
        recipientUserId: work.recipientUserId,
        effectType: notificationEffectForEvent(work.eventType),
        effectIdempotencyKey: work.effectIdempotencyKey,
        outcome: "failed",
        attemptCount: work.attemptCount,
        createdAt,
      });
    }
    const result = await this.repository.failInAppDelivery({
      work,
      failedAtMs,
      terminalNotification,
      terminalReceipt,
    });
    if (
      result.outboxId !== work.outboxId ||
      result.attemptCount !== work.attemptCount ||
      (terminal
        ? result.status !== "dead_letter" || result.receipt?.outcome !== "failed"
        : result.status !== "retry" || result.receipt !== null)
    ) {
      throw new InAppNotificationError("IN_APP_DELIVERY_RESULT_INVALID");
    }
    return result;
  }

  private now(): number {
    const now = this.clock.nowMs();
    if (!Number.isSafeInteger(now) || now <= 0) {
      throw new InAppNotificationError("IN_APP_DELIVERY_INVALID");
    }
    return now;
  }

  private id(): string {
    const id = this.createId();
    assertUuid(id);
    return id;
  }
}

function assertClaim(claim: InAppDeliveryClaim): void {
  if (claim.status === "idle") return;
  if (claim.status === "claimed") {
    assertWork(claim.work);
    return;
  }
  assertUuid(claim.outboxId);
  assertReceipt(claim.receipt);
}

function assertWork(work: InAppDeliveryWork): void {
  for (const id of [work.outboxId, work.organizationId, work.recipientUserId]) assertUuid(id);
  if (!ELIGIBLE_OUTBOX_EVENTS.has(work.eventType)) {
    throw new InAppNotificationError("IN_APP_DELIVERY_INVALID");
  }
  if (
    typeof work.effectIdempotencyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(work.effectIdempotencyKey) ||
    !Number.isSafeInteger(work.attemptCount) ||
    work.attemptCount < 1 ||
    work.attemptCount > MAX_IN_APP_DELIVERY_ATTEMPTS ||
    !Number.isSafeInteger(work.leaseVersion) ||
    work.leaseVersion < 1
  ) {
    throw new InAppNotificationError("IN_APP_DELIVERY_INVALID");
  }
}

function assertCompletion(result: InAppDeliveryCompletion, work: InAppDeliveryWork): void {
  if (!['delivered', 'suppressed', 'duplicate'].includes(result.status)) {
    throw new InAppNotificationError("IN_APP_DELIVERY_RESULT_INVALID");
  }
  assertReceipt(result.receipt);
  if (
    result.notification.organizationId !== work.organizationId ||
    result.notification.recipientUserId !== work.recipientUserId ||
    result.notification.outboxId !== work.outboxId ||
    result.notification.effectType !== notificationEffectForEvent(work.eventType) ||
    result.notification.effectIdempotencyKey !== work.effectIdempotencyKey ||
    result.receipt.organizationId !== work.organizationId ||
    result.receipt.outboxId !== work.outboxId ||
    result.receipt.effectType !== notificationEffectForEvent(work.eventType) ||
    result.receipt.effectIdempotencyKey !== work.effectIdempotencyKey
  ) {
    throw new InAppNotificationError("IN_APP_DELIVERY_RESULT_INVALID");
  }
  if (
    (result.status === "delivered" &&
      (result.notification.status !== "unread" || result.receipt.outcome !== "delivered")) ||
      (result.status === "suppressed" &&
      (result.notification.status !== "suppressed" || result.receipt.outcome !== "compensated"))
  ) {
    throw new InAppNotificationError("IN_APP_DELIVERY_RESULT_INVALID");
  }
}

function assertReceipt(receipt: DeliveryReceipt): void {
  for (const id of [receipt.id, receipt.organizationId, receipt.outboxId]) {
    assertUuid(id);
  }
  if (receipt.notificationId !== null) assertUuid(receipt.notificationId);
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new InAppNotificationError("IN_APP_DELIVERY_INVALID");
}

/** Maps producer events to the nine approved effects without exposing payload text. */
export function notificationEffectForEvent(
  eventType: string,
): (typeof APPROVED_NOTIFICATION_EFFECTS)[number] {
  if (isApprovedNotificationEffect(eventType)) return eventType;
  if (eventType === "tasks.task_transitioned" || eventType === "tasks.task_created") return "task_assigned";
  if (eventType === "cases.service_case_stage_transitioned" || eventType === "cases.service_case_closed") {
    return "case_closure_choice_required";
  }
  if (eventType === "cases.candidate_list_submitted") return "candidate_list_review_requested";
  if (eventType === "cases.candidate_list_approved" || eventType === "cases.candidate_list_rejected") {
    return "candidate_list_reviewed";
  }
  if (eventType === "tasks.due_3d") return "task_due_in_3_days";
  if (eventType === "tasks.due_1d") return "task_due_in_1_day";
  if (eventType === "tasks.overdue") return "task_overdue_daily";
  throw new InAppNotificationError("IN_APP_DELIVERY_INVALID");
}
