import type { OutboxMessage } from "../../modules/audit/domain/contract.ts";
import type {
  DeliveryReceipt,
  NotificationRecord,
} from "../../modules/notifications/domain/contract.ts";
import {
  MAX_IN_APP_DELIVERY_ATTEMPTS,
  type InAppDeliveryClaim,
  type InAppDeliveryCompletion,
  type InAppDeliveryFailure,
  type InAppDeliveryWork,
  type InAppNotificationRepository,
} from "../../modules/notifications/application/service.ts";

type DeliveryOutboxState = "pending" | "processing" | "delivered" | "dead_letter";

interface StoredOutbox {
  readonly outbox: OutboxMessage;
  readonly businessFactId: string;
  readonly recipientUserId: string;
  readonly recipientHasAccess: boolean;
  readonly status: DeliveryOutboxState;
  readonly attemptCount: number;
  readonly leaseVersion: number;
}

/**
 * P1-15 deterministic transaction adapter. Producer facts are immutable test
 * fixtures; worker operations can change only their own outbox delivery,
 * notification, and receipt state.
 */
export class InMemoryInAppNotificationRepository implements InAppNotificationRepository {
  private outbox = new Map<string, StoredOutbox>();
  private notifications = new Map<string, NotificationRecord>();
  private receiptsByEffect = new Map<string, DeliveryReceipt>();
  private businessFacts = new Set<string>();
  private failCompletion = false;
  private revokeAfterNextClaim = false;

  seedProducerFact(input: {
    readonly businessFactId: string;
    readonly outbox: OutboxMessage;
    readonly recipientUserId: string;
    readonly recipientHasAccess?: boolean;
  }): void {
    this.businessFacts.add(input.businessFactId);
    this.outbox.set(input.outbox.id, {
      outbox: input.outbox,
      businessFactId: input.businessFactId,
      recipientUserId: input.recipientUserId,
      recipientHasAccess: input.recipientHasAccess ?? true,
      status: "pending",
      attemptCount: 0,
      leaseVersion: 1,
    });
  }

  failNextCompletion(): void {
    this.failCompletion = true;
  }

  revokeAccessAfterNextClaim(): void {
    this.revokeAfterNextClaim = true;
  }

  snapshot(): Readonly<{
    businessFacts: number;
    pendingOutbox: number;
    processingOutbox: number;
    deliveredOutbox: number;
    deadLetterOutbox: number;
    notifications: number;
    unreadNotifications: number;
    suppressedNotifications: number;
    receipts: number;
  }> {
    const values = [...this.outbox.values()];
    const notifications = [...this.notifications.values()];
    return Object.freeze({
      businessFacts: this.businessFacts.size,
      pendingOutbox: values.filter((item) => item.status === "pending").length,
      processingOutbox: values.filter((item) => item.status === "processing").length,
      deliveredOutbox: values.filter((item) => item.status === "delivered").length,
      deadLetterOutbox: values.filter((item) => item.status === "dead_letter").length,
      notifications: notifications.length,
      unreadNotifications: notifications.filter((item) => item.status === "unread").length,
      suppressedNotifications: notifications.filter((item) => item.status === "suppressed").length,
      receipts: this.receiptsByEffect.size,
    });
  }

  notificationForOutbox(outboxId: string): NotificationRecord | undefined {
    return [...this.notifications.values()].find((notification) => notification.outboxId === outboxId);
  }

  receiptForOutbox(outboxId: string): DeliveryReceipt | undefined {
    return [...this.receiptsByEffect.values()].find((receipt) => receipt.outboxId === outboxId);
  }

  async claimNextInAppDelivery(
    input: Parameters<InAppNotificationRepository["claimNextInAppDelivery"]>[0],
  ): Promise<InAppDeliveryClaim> {
    const stored = input.outboxId === null
      ? [...this.outbox.values()].find((candidate) => candidate.status === "pending")
      : this.outbox.get(input.outboxId);
    if (!stored) return { status: "idle" };
    const existing = this.receiptsByEffect.get(effectKey(stored));
    if (existing) {
      return { status: "duplicate", outboxId: stored.outbox.id, receipt: existing };
    }
    if (
      stored.status !== "pending" ||
      !isEligibleEvent(stored.outbox.eventType) ||
      input.leaseUntilMs <= input.claimedAtMs
    ) {
      return { status: "idle" };
    }

    const nextOutbox = new Map(this.outbox);
    const claimed: StoredOutbox = {
      ...stored,
      status: "processing",
      attemptCount: stored.attemptCount + 1,
      leaseVersion: stored.leaseVersion + 1,
    };
    nextOutbox.set(stored.outbox.id, claimed);
    if (this.revokeAfterNextClaim) {
      this.revokeAfterNextClaim = false;
      nextOutbox.set(stored.outbox.id, { ...claimed, recipientHasAccess: false });
    }
    this.outbox = nextOutbox;
    return {
      status: "claimed",
      work: toWork(nextOutbox.get(stored.outbox.id)!),
    };
  }

  async completeInAppDelivery(
    input: Parameters<InAppNotificationRepository["completeInAppDelivery"]>[0],
  ): Promise<InAppDeliveryCompletion> {
    const stored = this.requireLease(input.work);
    const existing = this.receiptsByEffect.get(effectKey(stored));
    if (existing) {
      const notification = this.notifications.get(existing.notificationId);
      if (!notification) throw new Error("synthetic receipt without notification");
      return { status: "duplicate", notification, receipt: existing };
    }
    if (this.failCompletion) {
      this.failCompletion = false;
      throw new Error("synthetic in-app delivery failure");
    }

    const delivered = stored.recipientHasAccess;
    const notification = delivered ? input.deliveredNotification : input.suppressedNotification;
    const receipt = delivered ? input.deliveredReceipt : input.suppressedReceipt;
    const nextOutbox = new Map(this.outbox);
    const nextNotifications = new Map(this.notifications);
    const nextReceipts = new Map(this.receiptsByEffect);
    nextOutbox.set(stored.outbox.id, { ...stored, status: "delivered" });
    nextNotifications.set(notification.id, notification);
    nextReceipts.set(effectKey(stored), receipt);

    this.outbox = nextOutbox;
    this.notifications = nextNotifications;
    this.receiptsByEffect = nextReceipts;
    return {
      status: delivered ? "delivered" : "suppressed",
      notification,
      receipt,
    };
  }

  async failInAppDelivery(
    input: Parameters<InAppNotificationRepository["failInAppDelivery"]>[0],
  ): Promise<InAppDeliveryFailure> {
    const stored = this.requireLease(input.work);
    const terminal = stored.attemptCount === MAX_IN_APP_DELIVERY_ATTEMPTS;
    if (terminal !== (input.terminalNotification !== null && input.terminalReceipt !== null)) {
      throw new Error("synthetic terminal receipt mismatch");
    }

    const nextOutbox = new Map(this.outbox);
    if (!terminal) {
      nextOutbox.set(stored.outbox.id, { ...stored, status: "pending" });
      this.outbox = nextOutbox;
      return {
        status: "retry",
        outboxId: stored.outbox.id,
        attemptCount: stored.attemptCount,
        receipt: null,
      };
    }

    const terminalNotification = input.terminalNotification!;
    const terminalReceipt = input.terminalReceipt!;
    const nextNotifications = new Map(this.notifications);
    const nextReceipts = new Map(this.receiptsByEffect);
    nextOutbox.set(stored.outbox.id, { ...stored, status: "dead_letter" });
    nextNotifications.set(terminalNotification.id, terminalNotification);
    nextReceipts.set(effectKey(stored), terminalReceipt);
    this.outbox = nextOutbox;
    this.notifications = nextNotifications;
    this.receiptsByEffect = nextReceipts;
    return {
      status: "dead_letter",
      outboxId: stored.outbox.id,
      attemptCount: stored.attemptCount,
      receipt: terminalReceipt,
    };
  }

  private requireLease(work: InAppDeliveryWork): StoredOutbox {
    const stored = this.outbox.get(work.outboxId);
    if (
      !stored ||
      stored.status !== "processing" ||
      stored.attemptCount !== work.attemptCount ||
      stored.leaseVersion !== work.leaseVersion
    ) {
      throw new Error("synthetic delivery lease mismatch");
    }
    return stored;
  }
}

function toWork(stored: StoredOutbox): InAppDeliveryWork {
  if (!isEligibleEvent(stored.outbox.eventType)) throw new Error("synthetic unsupported event");
  return Object.freeze({
    outboxId: stored.outbox.id,
    organizationId: stored.outbox.organizationId,
    recipientUserId: stored.recipientUserId,
    eventType: stored.outbox.eventType,
    effectIdempotencyKey: stored.outbox.idempotencyKey,
    attemptCount: stored.attemptCount,
    leaseVersion: stored.leaseVersion,
  });
}

function effectKey(stored: StoredOutbox): string {
  return `${stored.outbox.organizationId}:in_app.pending_item:${stored.outbox.idempotencyKey}`;
}

function isEligibleEvent(
  eventType: string,
): eventType is InAppDeliveryWork["eventType"] {
  return eventType === "tasks.task_transitioned" || eventType === "cases.service_case_stage_transitioned";
}
