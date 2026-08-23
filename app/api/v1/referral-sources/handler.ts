import {
  REFERRAL_SOURCE_STATUSES,
  REFERRAL_SOURCE_TYPES,
  ReferralSourceError,
  isReferralSourceError,
  isReferralSourceRuntimeUnavailable,
  type ReferralSourceAcknowledgement,
  type ReferralSourceStatus,
  type ReferralSourceType,
  type ReferralSourceView,
} from "../../../../modules/crm/server.ts";
import { createApiError, type JsonValue } from "../../../../modules/shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseReferralSourceListFilter(request: Request): ReferralSourceStatus | null {
  let url: URL; try { url = new URL(request.url); } catch { invalid(); }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "status") || url.searchParams.getAll("status").length > 1) invalid();
  if (!url.searchParams.has("status")) return null;
  const status = url.searchParams.get("status");
  if (!(REFERRAL_SOURCE_STATUSES as readonly unknown[]).includes(status)) invalid();
  return status as ReferralSourceStatus;
}

export async function parseReferralSourceCreate(request: Request, requestId: string) {
  const body = await exactJson(request, ["display_name", "source_type"]);
  if (typeof body.display_name !== "string" ||
      !(REFERRAL_SOURCE_TYPES as readonly unknown[]).includes(body.source_type)) invalid();
  return Object.freeze({ displayName: body.display_name, sourceType: body.source_type as ReferralSourceType,
    requestId, idempotencyKey: idempotencyKey(request) });
}

export async function parseReferralSourceUpdate(request: Request, sourceId: string, requestId: string) {
  if (!UUID.test(sourceId)) invalid();
  const body = await exactJson(request, ["display_name", "expected_record_version", "status"]);
  if (typeof body.display_name !== "string" || !Number.isSafeInteger(body.expected_record_version) ||
      Number(body.expected_record_version) < 1 ||
      !(REFERRAL_SOURCE_STATUSES as readonly unknown[]).includes(body.status)) invalid();
  return Object.freeze({ sourceId, displayName: body.display_name,
    expectedRecordVersion: Number(body.expected_record_version), status: body.status as ReferralSourceStatus,
    requestId, idempotencyKey: idempotencyKey(request) });
}

export function sourceData(source: ReferralSourceView): JsonValue {
  return { id: source.id, display_name: source.displayName, source_type: source.sourceType,
    status: source.status, record_version: source.recordVersion };
}
export function acknowledgementData(value: ReferralSourceAcknowledgement): JsonValue {
  return { id: value.id, record_version: value.recordVersion };
}
export function mapReferralSourceError(error: unknown): unknown {
  if (isReferralSourceRuntimeUnavailable(error)) return createApiError("SERVICE_UNAVAILABLE");
  if (!isReferralSourceError(error)) return error;
  switch (error.code) {
    case "REFERRAL_SOURCE_FORBIDDEN": return createApiError("FORBIDDEN");
    case "REFERRAL_SOURCE_INVALID": return createApiError("VALIDATION_FAILED");
    case "REFERRAL_SOURCE_NOT_FOUND": return createApiError("NOT_FOUND");
    case "REFERRAL_SOURCE_STALE": return createApiError("STALE_VERSION");
    case "REFERRAL_SOURCE_CONFLICT": return createApiError("CONFLICT");
    case "REFERRAL_SOURCE_UNAVAILABLE": return createApiError("SERVICE_UNAVAILABLE");
  }
}

async function exactJson(request: Request, keys: readonly string[]) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") invalid();
  let value: unknown; try { value = await request.json(); } catch { invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) invalid();
  return value as Record<string, unknown>;
}
function idempotencyKey(request: Request) { const value = request.headers.get("idempotency-key");
  if (!value) invalid(); return value; }
function invalid(): never { throw new ReferralSourceError("REFERRAL_SOURCE_INVALID"); }
