import {
  MAX_IN_APP_DELIVERY_ATTEMPTS,
  type InAppNotificationService,
} from "../modules/notifications/server.ts";
import { getInAppNotificationRuntime } from "../modules/notifications/server.ts";

export class InAppDeliveryRetryableWorkerError extends Error {
  readonly retryable = true;

  constructor() {
    super("In-app notification delivery requires a bounded retry.");
    this.name = "InAppDeliveryRetryableWorkerError";
  }
}

/** This error lets the configured HK queue redrive policy retain the final failure in its DLQ. */
export class InAppDeliveryDeadLetterWorkerError extends Error {
  readonly retryable = false;

  constructor() {
    super("In-app notification delivery reached the configured DLQ boundary.");
    this.name = "InAppDeliveryDeadLetterWorkerError";
  }
}

export type InAppDeliveryWorkerResult =
  | { readonly status: "idle"; readonly outboxId: null; readonly receiptId: null }
  | { readonly status: "duplicate" | "delivered" | "suppressed"; readonly outboxId: string; readonly receiptId: string };

/** Processes one leased P1-13/P1-14 effect; no external notification provider is involved. */
export async function deliverNextInAppNotification(
  input: { readonly workerId: string; readonly outboxId?: string },
  dependencies: { readonly service: InAppNotificationService } = getInAppNotificationRuntime(),
): Promise<InAppDeliveryWorkerResult> {
  const claim = await dependencies.service.claimNextDelivery(input);
  if (claim.status === "idle") {
    return { status: "idle", outboxId: null, receiptId: null };
  }
  if (claim.status === "duplicate") {
    return { status: "duplicate", outboxId: claim.outboxId, receiptId: claim.receipt.id };
  }

  try {
    const completion = await dependencies.service.completeDelivery(claim.work);
    return {
      status: completion.status,
      outboxId: claim.work.outboxId,
      receiptId: completion.receipt.id,
    };
  } catch {
    const failure = await dependencies.service.failDelivery(claim.work);
    if (failure.status === "dead_letter") throw new InAppDeliveryDeadLetterWorkerError();
    if (claim.work.attemptCount < MAX_IN_APP_DELIVERY_ATTEMPTS) {
      throw new InAppDeliveryRetryableWorkerError();
    }
    throw new InAppDeliveryDeadLetterWorkerError();
  }
}
