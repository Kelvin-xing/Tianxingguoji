import { createHash } from "node:crypto";

import { validateIdempotencyKey } from "../shared/idempotency.ts";

export const AUDIT_OUTCOMES = Object.freeze(["succeeded", "denied", "failed"] as const);
export const AUDIT_ACTOR_KINDS = Object.freeze(["user", "system", "worker"] as const);
export const OUTBOX_STATES = Object.freeze([
  "pending",
  "processing",
  "delivered",
  "dead_letter",
] as const);

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];
export type OutboxState = (typeof OUTBOX_STATES)[number];
export type SafeScalar = string | number | boolean | null;
export type SafeRecord = Readonly<Record<string, SafeScalar>>;

export interface AuditEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserId: string | null;
  readonly actorKind: AuditActorKind;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly outcome: AuditOutcome;
  readonly requestId: string;
  readonly occurredAt: string;
  readonly beforeHashSha256: string | null;
  readonly afterHashSha256: string | null;
  readonly metadata: SafeRecord;
}

export interface OutboxMessage {
  readonly id: string;
  readonly auditEventId: string;
  readonly organizationId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly payload: SafeRecord;
  readonly status: "pending";
  readonly attemptCount: 0;
  readonly availableAt: string;
  readonly createdAt: string;
}

export interface MutationEffectBundle {
  readonly audit: AuditEvent;
  readonly outbox: OutboxMessage;
}

export interface TelemetryEvent {
  readonly eventName: string;
  readonly requestId: string;
  readonly operation: string;
  readonly outcome: "success" | "failure";
  readonly durationMs: number;
  readonly retryable: boolean;
  readonly errorCode: string | null;
  readonly organizationId: string | null;
}

export type AuditDenialCode =
  | "AUDIT_INVALID_INPUT"
  | "AUDIT_SENSITIVE_FIELD"
  | "AUDIT_FIELD_NOT_ALLOWED"
  | "AUDIT_HASH_INVALID"
  | "AUDIT_CONTEXT_MISMATCH"
  | "OUTBOX_PAYLOAD_UNSAFE";

export class AuditContractError extends Error {
  readonly code: AuditDenialCode;

  constructor(code: AuditDenialCode) {
    super(code);
    this.name = "AuditContractError";
    this.code = code;
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_METADATA_KEYS = new Set([
  "record_version",
  "previous_version",
  "next_version",
  "reason_code",
  "effect_type",
  "request_id",
  "status",
  "retryable",
  "attempt_count",
]);
const SAFE_OUTBOX_KEYS = new Set([
  "aggregate_id",
  "record_version",
  "request_id",
  "effect_type",
  "operation",
  "status",
  "reason_code",
  "attempt_count",
  "retryable",
]);
const SENSITIVE_KEY_PATTERN =
  /(?:email|phone|name|birth|dob|address|token|secret|password|cookie|content|body|message|url|pii)/i;

export function buildAuditEvent(input: {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserId: string | null;
  readonly actorKind: AuditActorKind;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly outcome: AuditOutcome;
  readonly requestId: string;
  readonly occurredAt: string;
  readonly beforeHashSha256?: string | null;
  readonly afterHashSha256?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): AuditEvent {
  requireUuid(input.id);
  requireUuid(input.organizationId);
  if (input.actorUserId !== null) requireUuid(input.actorUserId);
  requireUuid(input.resourceId);
  requireName(input.eventType);
  requireName(input.action);
  requireName(input.resourceType);
  requireRequestId(input.requestId);
  requireTimestamp(input.occurredAt);
  if (!AUDIT_ACTOR_KINDS.includes(input.actorKind)) throw new AuditContractError("AUDIT_INVALID_INPUT");
  if (!AUDIT_OUTCOMES.includes(input.outcome)) throw new AuditContractError("AUDIT_INVALID_INPUT");
  if (input.actorKind === "user" && input.actorUserId === null) {
    throw new AuditContractError("AUDIT_INVALID_INPUT");
  }
  if (!Number.isSafeInteger(input.eventVersion) || input.eventVersion < 1) {
    throw new AuditContractError("AUDIT_INVALID_INPUT");
  }

  const beforeHashSha256 = validateOptionalHash(input.beforeHashSha256);
  const afterHashSha256 = validateOptionalHash(input.afterHashSha256);
  const metadata = redactSafeRecord(input.metadata ?? {}, "audit");

  return deepFreeze({
    id: input.id,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    actorKind: input.actorKind,
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    outcome: input.outcome,
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    beforeHashSha256,
    afterHashSha256,
    metadata,
  });
}

export function buildOutboxMessage(input: {
  readonly id: string;
  readonly auditEventId: string;
  readonly organizationId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly availableAt: string;
  readonly createdAt: string;
}): OutboxMessage {
  requireUuid(input.id);
  requireUuid(input.auditEventId);
  requireUuid(input.organizationId);
  requireUuid(input.aggregateId);
  requireName(input.aggregateType);
  requireName(input.eventType);
  requireRequestId(input.requestId);
  requireTimestamp(input.availableAt);
  requireTimestamp(input.createdAt);
  if (!Number.isSafeInteger(input.eventVersion) || input.eventVersion < 1) {
    throw new AuditContractError("AUDIT_INVALID_INPUT");
  }
  validateIdempotencyKey(input.idempotencyKey);

  const payload = redactSafeRecord(input.payload, "outbox");
  if (
    payload.aggregate_id !== input.aggregateId ||
    payload.request_id !== input.requestId
  ) {
    throw new AuditContractError("AUDIT_CONTEXT_MISMATCH");
  }

  return deepFreeze({
    id: input.id,
    auditEventId: input.auditEventId,
    organizationId: input.organizationId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    payload,
    status: "pending",
    attemptCount: 0,
    availableAt: input.availableAt,
    createdAt: input.createdAt,
  });
}

export function buildAtomicMutationEffects(input: {
  readonly audit: AuditEvent;
  readonly outbox: OutboxMessage;
}): MutationEffectBundle {
  if (
    input.audit.organizationId !== input.outbox.organizationId ||
    input.audit.id !== input.outbox.auditEventId ||
    input.audit.resourceId !== input.outbox.aggregateId ||
    input.audit.requestId !== input.outbox.requestId ||
    input.audit.eventType !== input.outbox.eventType ||
    input.audit.eventVersion !== input.outbox.eventVersion ||
    input.outbox.payload.aggregate_id !== input.outbox.aggregateId ||
    input.outbox.payload.request_id !== input.outbox.requestId
  ) {
    throw new AuditContractError("AUDIT_CONTEXT_MISMATCH");
  }
  return deepFreeze({ audit: input.audit, outbox: input.outbox });
}

export function hashRedactedSnapshot(snapshot: SafeRecord): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(redactSafeRecord(snapshot, "audit")).sort()),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export function buildTelemetryEvent(input: {
  readonly eventName: string;
  readonly requestId: string;
  readonly operation: string;
  readonly outcome: "success" | "failure";
  readonly durationMs: number;
  readonly retryable: boolean;
  readonly errorCode: string | null;
  readonly organizationId?: string | null;
}): TelemetryEvent {
  requireName(input.eventName);
  requireRequestId(input.requestId);
  requireName(input.operation);
  if (input.outcome !== "success" && input.outcome !== "failure") {
    throw new AuditContractError("AUDIT_INVALID_INPUT");
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new AuditContractError("AUDIT_INVALID_INPUT");
  }
  if (input.errorCode !== null) requireName(input.errorCode);
  if (input.organizationId !== undefined && input.organizationId !== null) {
    requireUuid(input.organizationId);
  }

  return deepFreeze({
    eventName: input.eventName,
    requestId: input.requestId,
    operation: input.operation,
    outcome: input.outcome,
    durationMs: input.durationMs,
    retryable: input.retryable,
    errorCode: input.errorCode,
    organizationId: input.organizationId ?? null,
  });
}

function redactSafeRecord(
  value: Readonly<Record<string, unknown>>,
  kind: "audit" | "outbox",
): SafeRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuditContractError(kind === "outbox" ? "OUTBOX_PAYLOAD_UNSAFE" : "AUDIT_INVALID_INPUT");
  }
  const allowedKeys = kind === "outbox" ? SAFE_OUTBOX_KEYS : SAFE_METADATA_KEYS;
  const safe: Record<string, SafeScalar> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) throw new AuditContractError("AUDIT_SENSITIVE_FIELD");
    if (!allowedKeys.has(key)) throw new AuditContractError("AUDIT_FIELD_NOT_ALLOWED");
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new AuditContractError(kind === "outbox" ? "OUTBOX_PAYLOAD_UNSAFE" : "AUDIT_INVALID_INPUT");
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new AuditContractError(kind === "outbox" ? "OUTBOX_PAYLOAD_UNSAFE" : "AUDIT_INVALID_INPUT");
    }
    if (typeof item === "string" && !SAFE_VALUE_PATTERN.test(item)) {
      throw new AuditContractError("AUDIT_SENSITIVE_FIELD");
    }
    safe[key] = item;
  }
  return deepFreeze(safe);
}

function requireUuid(value: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AuditContractError("AUDIT_INVALID_INPUT");
  }
}

function requireName(value: string): void {
  if (typeof value !== "string" || !SAFE_NAME_PATTERN.test(value)) {
    throw new AuditContractError("AUDIT_INVALID_INPUT");
  }
}

function requireRequestId(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new AuditContractError("AUDIT_INVALID_INPUT");
  }
}

function requireTimestamp(value: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new AuditContractError("AUDIT_INVALID_INPUT");
  }
}

function validateOptionalHash(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!SHA256_PATTERN.test(value)) throw new AuditContractError("AUDIT_HASH_INVALID");
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
