import {
  decodeDeletionRequestLocator,
  DELETION_ENTITY_TYPES,
  DeletionReviewError,
  PENDING_DELETE_REASON,
  isDeletionReviewError,
  isDeletionReviewRuntimeUnavailable,
  type DeletionEntityType,
  type DeletionRequestReceipt,
  type DeletionRequestSummary,
} from "../../../../modules/crm/server.ts";
import { createApiError } from "../../../../modules/shared/public.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function parseDeletionRequest(
  request: Request,
  entityType: DeletionEntityType,
  entityId: string,
  requestId: string,
) {
  if (!UUID.test(entityId)) invalid();
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  )
    invalid();
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    invalid();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "expected_record_version,reason_code"
  ) {
    invalid();
  }
  const body = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(body.expected_record_version) ||
    Number(body.expected_record_version) < 1 ||
    body.reason_code !== PENDING_DELETE_REASON
  ) {
    invalid();
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) invalid();
  return {
    entityType,
    entityId,
    expectedRecordVersion: body.expected_record_version as number,
    reasonCode: PENDING_DELETE_REASON,
    requestId,
    idempotencyKey,
  } as const;
}

export async function parseDeletionDecision(
  request: Request,
  requestId: string,
  correlationRequestId: string,
) {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  ) {
    invalid();
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    invalid();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "decision,expected_record_version"
  ) {
    invalid();
  }
  const body = value as Record<string, unknown>;
  if (
    (body.decision !== "approve" && body.decision !== "reject") ||
    !Number.isSafeInteger(body.expected_record_version) ||
    Number(body.expected_record_version) < 1
  ) {
    invalid();
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) invalid();
  let locator: Readonly<{
    entityType: "student" | "guardian";
    entityId: string;
  }>;
  try {
    locator = decodeDeletionRequestLocator(requestId);
  } catch {
    invalid();
  }
  return {
    entityType: locator.entityType,
    entityId: locator.entityId,
    decision: body.decision,
    expectedRecordVersion: body.expected_record_version as number,
    correlationRequestId,
    idempotencyKey,
  } as const;
}

export function parseDeletionQueueQuery(
  request: Request,
): DeletionEntityType | null {
  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  if (keys.length === 0) return null;
  if (keys.length !== 1 || keys[0] !== "entity_type") invalid();
  const value = params.get("entity_type");
  if (!isEntityType(value)) invalid();
  return value;
}

export function deletionReceiptData(item: DeletionRequestReceipt) {
  return {
    entity_type: item.entityType,
    entity_id: item.entityId,
    status: item.status,
    deletion_requested_at: item.deletionRequestedAt,
    record_version: item.recordVersion,
  } as const;
}

export function deletionSummaryData(item: DeletionRequestSummary) {
  return {
    request_id: item.requestId,
    entity_type: item.entityType,
    entity_id: item.entityId,
    display_label: item.displayLabel,
    status: item.status,
    deletion_requested_at: item.deletionRequestedAt,
    record_version: item.recordVersion,
  } as const;
}

export function deletionDecisionData(item: {
  readonly entityType: DeletionEntityType;
  readonly entityId: string;
  readonly status: "deleted" | "active";
  readonly recordVersion: number;
  readonly occurredAt: string;
}) {
  return {
    entity_type: item.entityType,
    entity_id: item.entityId,
    status: item.status,
    record_version: item.recordVersion,
    occurred_at: item.occurredAt,
  } as const;
}
export function mapDeletionReviewError(error: unknown): unknown {
  if (isDeletionReviewRuntimeUnavailable(error))
    return createApiError("SERVICE_UNAVAILABLE");
  if (!isDeletionReviewError(error)) return error;
  switch (error.code) {
    case "DELETION_REVIEW_FORBIDDEN":
      return createApiError("FORBIDDEN");
    case "DELETION_REVIEW_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "DELETION_REVIEW_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "DELETION_REVIEW_STALE":
      return createApiError("STALE_VERSION");
    case "DELETION_REVIEW_CONFLICT":
      return createApiError("CONFLICT");
    case "DELETION_REVIEW_IDEMPOTENCY_KEY_REUSED":
    case "DELETION_REVIEW_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
    case "DELETION_REVIEW_UNAVAILABLE":
      return createApiError("SERVICE_UNAVAILABLE");
  }
}
function isEntityType(value: unknown): value is DeletionEntityType {
  return (
    typeof value === "string" &&
    (DELETION_ENTITY_TYPES as readonly string[]).includes(value)
  );
}
function invalid(): never {
  throw new DeletionReviewError("DELETION_REVIEW_INVALID");
}
