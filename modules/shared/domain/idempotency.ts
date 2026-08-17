import { createHash } from "node:crypto";

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type IdempotencyState = "in_progress" | "completed" | "failed";

export interface IdempotencyRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: string;
  readonly state: IdempotencyState;
  readonly resultReference: string | null;
  readonly responseHash: string | null;
  readonly recordVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type IdempotencyDecision =
  | { readonly action: "start" }
  | { readonly action: "in_progress"; readonly code: "IDEMPOTENCY_IN_PROGRESS" }
  | {
      readonly action: "replay";
      readonly state: "completed" | "failed";
      readonly resultReference: string | null;
    }
  | { readonly action: "conflict"; readonly code: "IDEMPOTENCY_KEY_REUSED" };

export type IdempotencyDenialCode =
  | "IDEMPOTENCY_ID_INVALID"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_HASH_INVALID"
  | "IDEMPOTENCY_OPERATION_INVALID"
  | "IDEMPOTENCY_RECORD_STATE_INVALID"
  | "IDEMPOTENCY_VERSION_INVALID"
  | "IDEMPOTENCY_RESULT_INVALID";

export class IdempotencyContractError extends Error {
  readonly code: IdempotencyDenialCode;

  constructor(code: IdempotencyDenialCode) {
    super(code);
    this.name = "IdempotencyContractError";
    this.code = code;
  }
}

export function hashRequestPayload(value: JsonValue): string {
  return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}

export function validateIdempotencyKey(key: string): string {
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new IdempotencyContractError("IDEMPOTENCY_KEY_INVALID");
  }
  return key;
}

export function createIdempotencyRecord(input: {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: string;
  readonly createdAt: string;
}): IdempotencyRecord {
  const operation = validateOperation(input.operation);
  const key = validateIdempotencyKey(input.key);
  validateHash(input.requestHash);
  validateTimestamp(input.createdAt);

  return deepFreeze({
    id: requireUuid(input.id),
    organizationId: requireUuid(input.organizationId),
    actorUserId: requireUuid(input.actorUserId),
    operation,
    key,
    requestHash: input.requestHash,
    state: "in_progress",
    resultReference: null,
    responseHash: null,
    recordVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

export function completeIdempotencyRecord(
  record: IdempotencyRecord,
  input: {
    readonly resultReference: string;
    readonly responseHash: string;
    readonly updatedAt: string;
  },
): IdempotencyRecord {
  if (record.state !== "in_progress") {
    throw new IdempotencyContractError("IDEMPOTENCY_RECORD_STATE_INVALID");
  }
  if (!Number.isSafeInteger(record.recordVersion) || record.recordVersion < 1) {
    throw new IdempotencyContractError("IDEMPOTENCY_VERSION_INVALID");
  }
  validateResultReference(input.resultReference);
  validateHash(input.responseHash);
  validateTimestamp(input.updatedAt);
  assertNonDecreasingTimestamp(record.updatedAt, input.updatedAt);

  return deepFreeze({
    ...record,
    state: "completed",
    resultReference: input.resultReference,
    responseHash: input.responseHash,
    recordVersion: record.recordVersion + 1,
    updatedAt: input.updatedAt,
  });
}

export function failIdempotencyRecord(
  record: IdempotencyRecord,
  input: { readonly resultReference: string; readonly responseHash: string; readonly updatedAt: string },
): IdempotencyRecord {
  if (record.state !== "in_progress") {
    throw new IdempotencyContractError("IDEMPOTENCY_RECORD_STATE_INVALID");
  }
  validateResultReference(input.resultReference);
  validateHash(input.responseHash);
  validateTimestamp(input.updatedAt);
  assertNonDecreasingTimestamp(record.updatedAt, input.updatedAt);

  return deepFreeze({
    ...record,
    state: "failed",
    resultReference: input.resultReference,
    responseHash: input.responseHash,
    recordVersion: record.recordVersion + 1,
    updatedAt: input.updatedAt,
  });
}

export function evaluateIdempotency(input: {
  readonly key: string;
  readonly requestHash: string;
  readonly existing: IdempotencyRecord | null;
}): IdempotencyDecision {
  validateIdempotencyKey(input.key);
  validateHash(input.requestHash);

  if (input.existing === null) return { action: "start" };
  if (input.existing.key !== input.key || input.existing.requestHash !== input.requestHash) {
    return { action: "conflict", code: "IDEMPOTENCY_KEY_REUSED" };
  }
  if (input.existing.state === "in_progress") {
    return { action: "in_progress", code: "IDEMPOTENCY_IN_PROGRESS" };
  }
  return {
    action: "replay",
    state: input.existing.state,
    resultReference: input.existing.resultReference,
  };
}

export function canonicalizeJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new IdempotencyContractError("IDEMPOTENCY_HASH_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalizeJson(nested)}`)
    .join(",")}}`;
}

function validateHash(value: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new IdempotencyContractError("IDEMPOTENCY_HASH_INVALID");
  }
}

function validateOperation(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._:-]{0,127}$/.test(value)) {
    throw new IdempotencyContractError("IDEMPOTENCY_OPERATION_INVALID");
  }
  return value;
}

function validateResultReference(value: string): void {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new IdempotencyContractError("IDEMPOTENCY_RESULT_INVALID");
  }
}

function validateTimestamp(value: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new IdempotencyContractError("IDEMPOTENCY_RECORD_STATE_INVALID");
  }
}

function assertNonDecreasingTimestamp(previous: string, next: string): void {
  if (Date.parse(next) < Date.parse(previous)) {
    throw new IdempotencyContractError("IDEMPOTENCY_RECORD_STATE_INVALID");
  }
}

function requireUuid(value: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new IdempotencyContractError("IDEMPOTENCY_ID_INVALID");
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
