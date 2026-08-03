import { validateIdempotencyKey } from "../shared/idempotency.ts";

export const NOTIFICATION_CHANNELS = Object.freeze(["in_app"] as const);
export const MINIMAL_NOTIFICATION_CONTENT_CODE = "PENDING_ITEM" as const;
export const MINIMAL_NOTIFICATION_TEXT = "A pending item needs attention." as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationStatus = "unread" | "read" | "suppressed";
export type DeliveryOutcome = "delivered" | "failed" | "compensated";

export interface NotificationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly recipientUserId: string;
  readonly channel: "in_app";
  readonly contentCode: typeof MINIMAL_NOTIFICATION_CONTENT_CODE;
  readonly text: typeof MINIMAL_NOTIFICATION_TEXT;
  readonly outboxId: string;
  readonly effectType: string;
  readonly effectIdempotencyKey: string;
  readonly status: NotificationStatus;
  readonly createdAt: string;
}

export interface DeliveryReceipt {
  readonly id: string;
  readonly organizationId: string;
  readonly outboxId: string;
  readonly notificationId: string;
  readonly effectType: string;
  readonly effectIdempotencyKey: string;
  readonly outcome: DeliveryOutcome;
  readonly attemptCount: number;
  readonly createdAt: string;
}

export type NotificationDenialCode =
  | "NOTIFICATION_INVALID_INPUT"
  | "NOTIFICATION_CHANNEL_DISABLED"
  | "NOTIFICATION_CONTENT_NOT_MINIMAL"
  | "NOTIFICATION_EFFECT_KEY_INVALID"
  | "NOTIFICATION_ATTEMPT_INVALID";

export class NotificationContractError extends Error {
  readonly code: NotificationDenialCode;

  constructor(code: NotificationDenialCode) {
    super(code);
    this.name = "NotificationContractError";
    this.code = code;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EFFECT_TYPE_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;

export function buildPendingItemNotification(
  input: {
    readonly id: string;
    readonly organizationId: string;
    readonly recipientUserId: string;
    readonly outboxId: string;
    readonly effectType: string;
    readonly effectIdempotencyKey: string;
    readonly createdAt: string;
    readonly channel?: string;
    readonly contentCode?: string;
    readonly text?: string;
    readonly status?: NotificationStatus;
  },
): NotificationRecord {
  requireUuid(input.id);
  requireUuid(input.organizationId);
  requireUuid(input.recipientUserId);
  requireUuid(input.outboxId);
  requireEffectType(input.effectType);
  validateIdempotencyKey(input.effectIdempotencyKey);
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new NotificationContractError("NOTIFICATION_INVALID_INPUT");
  }
  if (input.channel !== undefined && input.channel !== "in_app") {
    throw new NotificationContractError("NOTIFICATION_CHANNEL_DISABLED");
  }
  if (input.contentCode !== undefined && input.contentCode !== MINIMAL_NOTIFICATION_CONTENT_CODE) {
    throw new NotificationContractError("NOTIFICATION_CONTENT_NOT_MINIMAL");
  }
  if (input.text !== undefined && input.text !== MINIMAL_NOTIFICATION_TEXT) {
    throw new NotificationContractError("NOTIFICATION_CONTENT_NOT_MINIMAL");
  }
  if (input.status !== undefined && !["unread", "read", "suppressed"].includes(input.status)) {
    throw new NotificationContractError("NOTIFICATION_INVALID_INPUT");
  }

  return deepFreeze({
    id: input.id,
    organizationId: input.organizationId,
    recipientUserId: input.recipientUserId,
    channel: "in_app",
    contentCode: MINIMAL_NOTIFICATION_CONTENT_CODE,
    text: MINIMAL_NOTIFICATION_TEXT,
    outboxId: input.outboxId,
    effectType: input.effectType,
    effectIdempotencyKey: input.effectIdempotencyKey,
    status: input.status ?? "unread",
    createdAt: input.createdAt,
  });
}

export function buildDeliveryReceipt(input: {
  readonly id: string;
  readonly organizationId: string;
  readonly outboxId: string;
  readonly notificationId: string;
  readonly effectType: string;
  readonly effectIdempotencyKey: string;
  readonly outcome: DeliveryOutcome;
  readonly attemptCount: number;
  readonly createdAt: string;
}): DeliveryReceipt {
  for (const id of [input.id, input.organizationId, input.outboxId, input.notificationId]) {
    requireUuid(id);
  }
  requireEffectType(input.effectType);
  validateIdempotencyKey(input.effectIdempotencyKey);
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 1) {
    throw new NotificationContractError("NOTIFICATION_ATTEMPT_INVALID");
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new NotificationContractError("NOTIFICATION_INVALID_INPUT");
  }
  if (!["delivered", "failed", "compensated"].includes(input.outcome)) {
    throw new NotificationContractError("NOTIFICATION_INVALID_INPUT");
  }
  return deepFreeze({ ...input });
}

export type DeliveryDecision =
  | { readonly action: "create" }
  | { readonly action: "replay"; readonly receiptId: string }
  | { readonly action: "conflict"; readonly code: "NOTIFICATION_EFFECT_CONFLICT" };

export function evaluateDeliveryEffect(input: {
  readonly effectType: string;
  readonly effectIdempotencyKey: string;
  readonly existingReceipt: DeliveryReceipt | null;
}): DeliveryDecision {
  requireEffectType(input.effectType);
  validateIdempotencyKey(input.effectIdempotencyKey);
  if (input.existingReceipt === null) return { action: "create" };
  if (
    input.existingReceipt.effectType !== input.effectType ||
    input.existingReceipt.effectIdempotencyKey !== input.effectIdempotencyKey
  ) {
    return { action: "conflict", code: "NOTIFICATION_EFFECT_CONFLICT" };
  }
  return { action: "replay", receiptId: input.existingReceipt.id };
}

function requireUuid(value: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new NotificationContractError("NOTIFICATION_INVALID_INPUT");
  }
}

function requireEffectType(value: string): void {
  if (typeof value !== "string" || !EFFECT_TYPE_PATTERN.test(value)) {
    throw new NotificationContractError("NOTIFICATION_EFFECT_KEY_INVALID");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
