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

export interface ReferralSourceListFilter {
  readonly query: string | null;
  readonly status: ReferralSourceStatus | null;
  readonly sourceType: ReferralSourceType | null;
  readonly limit: number;
  readonly cursor: string | null;
}

export function parseReferralSourceListFilter(request: Request): ReferralSourceListFilter {
  let url: URL; try { url = new URL(request.url); } catch { invalid(); }
  const keys = [...url.searchParams.keys()];
  const allowed = new Set(["q", "status", "source_type", "limit", "cursor"]);
  if (keys.some((key) => !allowed.has(key)) || keys.some((key) => url.searchParams.getAll(key).length > 1)) invalid();
  const statusValue = url.searchParams.get("status");
  if (statusValue !== null && !(REFERRAL_SOURCE_STATUSES as readonly unknown[]).includes(statusValue)) invalid();
  const sourceTypeValue = url.searchParams.get("source_type");
  if (sourceTypeValue !== null && !(REFERRAL_SOURCE_TYPES as readonly unknown[]).includes(sourceTypeValue)) invalid();
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 25 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
  const query = url.searchParams.get("q");
  if (query !== null && query.trim().length === 0) invalid();
  return { query: query?.trim() || null, status: statusValue as ReferralSourceStatus | null,
    sourceType: sourceTypeValue as ReferralSourceType | null, limit, cursor: url.searchParams.get("cursor") };
}

export async function parseReferralSourceCreate(request: Request, requestId: string) {
  const body = await exactJson(request, ["description", "display_name", "source_type"]);
  if (typeof body.display_name !== "string" ||
      (body.description !== null && typeof body.description !== "string") ||
      !(REFERRAL_SOURCE_TYPES as readonly unknown[]).includes(body.source_type)) invalid();
  const sourceType = body.source_type as ReferralSourceType;
  const description = body.description as string | null;
  if ((sourceType === "other") !== (typeof description === "string" && description.trim().length > 0)) invalid();
  return Object.freeze({ displayName: body.display_name, sourceType,
    description,
    requestId, idempotencyKey: idempotencyKey(request) });
}

export async function parseReferralSourceUpdate(request: Request, sourceId: string, requestId: string) {
  if (!UUID.test(sourceId)) invalid();
  const body = await exactJson(request, ["description", "display_name", "expected_record_version", "source_type"]);
  if (typeof body.display_name !== "string" ||
      (body.description !== null && typeof body.description !== "string") ||
      !Number.isSafeInteger(body.expected_record_version) ||
      Number(body.expected_record_version) < 1 ||
      !(REFERRAL_SOURCE_TYPES as readonly unknown[]).includes(body.source_type)) invalid();
  const sourceType = body.source_type as ReferralSourceType;
  const description = body.description as string | null;
  if ((sourceType === "other") !== (typeof description === "string" && description.trim().length > 0)) invalid();
  return Object.freeze({ sourceId, displayName: body.display_name,
    description,
    expectedRecordVersion: Number(body.expected_record_version), sourceType,
    requestId, idempotencyKey: idempotencyKey(request) });
}

export async function parseReferralSourceDeactivate(request: Request, sourceId: string, requestId: string) {
  if (!UUID.test(sourceId)) invalid();
  const body = await exactJson(request, ["expected_record_version", "reason_code"]);
  if (!Number.isSafeInteger(body.expected_record_version) || Number(body.expected_record_version) < 1 ||
      body.reason_code !== "record.lifecycle.referral_source_deactivated") invalid();
  return Object.freeze({ sourceId, expectedRecordVersion: Number(body.expected_record_version),
    reasonCode: body.reason_code as "record.lifecycle.referral_source_deactivated", requestId, idempotencyKey: idempotencyKey(request) });
}

export function sourceData(source: ReferralSourceView): JsonValue {
  return { id: source.id, display_name: source.displayName, source_type: source.sourceType,
    description: source.description,
    status: source.status, record_version: source.recordVersion, updated_at: source.updatedAt };
}
export function acknowledgementData(value: ReferralSourceAcknowledgement): JsonValue {
  return { referral_source: { id: value.id, status: value.status,
    record_version: value.recordVersion, updated_at: value.updatedAt } };
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
