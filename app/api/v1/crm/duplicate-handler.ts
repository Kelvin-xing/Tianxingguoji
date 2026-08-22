import {
  DUPLICATE_CANDIDATE_STATUSES,
  DUPLICATE_REVIEW_ENTITY_TYPES,
  DuplicateReviewError,
  isDuplicateReviewError,
  isDuplicateReviewRuntimeUnavailable,
  type DuplicateCandidateDetail,
  type DuplicateCandidateSummary,
  type DuplicateCandidateStatus,
  type DuplicateCorrectionAcknowledgement,
  type DuplicateMergeAcknowledgement,
  type DuplicateMergeReceipt,
  type DuplicateRecordSearchItem,
  type DuplicateReviewEntityType,
} from "../../../../modules/crm/server.ts";
import { createApiError } from "../../../../modules/shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCandidateQuery(request: Request) {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes("entity_type") || !keys.includes("status")) invalid();
  const entityType = url.searchParams.get("entity_type"); const status = url.searchParams.get("status");
  if (!isEntityType(entityType) || !isCandidateStatus(status)) invalid();
  return { entityType, status } as const;
}

export async function parseRecordSearch(request: Request) {
  const body = await exactJson(request, ["entity_type", "query"]);
  if (!isEntityType(body.entity_type) || typeof body.query !== "string") invalid();
  const query = body.query.trim();
  if (query.length < 2 || query.length > 100) invalid();
  return { entityType: body.entity_type, query } as const;
}

export async function parseCandidateCreate(request: Request, requestId: string) {
  const body = await exactJson(request, ["entity_type", "left_record_id", "right_record_id"]);
  const key = idempotencyKey(request);
  if (!isEntityType(body.entity_type) ||
      !isUuid(body.left_record_id) || !isUuid(body.right_record_id)) invalid();
  return { entityType: body.entity_type, leftRecordId: body.left_record_id,
    rightRecordId: body.right_record_id, requestId, idempotencyKey: key } as const;
}

export async function parseMergeCreate(request: Request, candidateId: string, requestId: string) {
  if (!UUID.test(candidateId)) invalid();
  const body = await exactJson(request, ["source_record_id", "canonical_record_id",
    "expected_candidate_record_version", "expected_source_record_version",
    "expected_canonical_record_version", "field_selections", "reason_code"]);
  if (!isUuid(body.source_record_id) || !isUuid(body.canonical_record_id) ||
      !version(body.expected_candidate_record_version) || !version(body.expected_source_record_version) ||
      !version(body.expected_canonical_record_version) || body.reason_code !== "duplicate.confirmed" ||
      !Array.isArray(body.field_selections)) invalid();
  const fieldSelections = body.field_selections.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).sort().join(",") !== "field_name,source_record_id") invalid();
    const record = item as Record<string, unknown>;
    if (typeof record.field_name !== "string" || !isUuid(record.source_record_id)) invalid();
    return { fieldName: record.field_name, sourceRecordId: record.source_record_id };
  });
  return { candidateId, sourceRecordId: body.source_record_id, canonicalRecordId: body.canonical_record_id,
    expectedCandidateRecordVersion: body.expected_candidate_record_version,
    expectedSourceRecordVersion: body.expected_source_record_version,
    expectedCanonicalRecordVersion: body.expected_canonical_record_version, fieldSelections,
    reasonCode: body.reason_code, requestId, idempotencyKey: idempotencyKey(request) } as const;
}

export async function parseCorrectionCreate(request: Request, mergeId: string, requestId: string) {
  if (!UUID.test(mergeId)) invalid();
  const body = await exactJson(request, ["expected_merge_record_version", "reason_code"]);
  if (!version(body.expected_merge_record_version) || body.reason_code !== "duplicate.merge.corrected") invalid();
  return { mergeId, expectedMergeRecordVersion: body.expected_merge_record_version,
    reasonCode: body.reason_code, requestId, idempotencyKey: idempotencyKey(request) } as const;
}

export function mapDuplicateReviewError(error: unknown): unknown {
  if (isDuplicateReviewRuntimeUnavailable(error)) return createApiError("SERVICE_UNAVAILABLE");
  if (!isDuplicateReviewError(error)) return error;
  switch (error.code) {
    case "DUPLICATE_REVIEW_FORBIDDEN": return createApiError("FORBIDDEN");
    case "DUPLICATE_REVIEW_INVALID":
    case "DUPLICATE_REVIEW_NO_MATCH": return createApiError("VALIDATION_FAILED");
    case "DUPLICATE_REVIEW_NOT_FOUND": return createApiError("NOT_FOUND");
    case "DUPLICATE_REVIEW_STALE": return createApiError("STALE_VERSION");
    case "DUPLICATE_REVIEW_CONFLICT": return createApiError("CONFLICT");
    case "DUPLICATE_REVIEW_UNAVAILABLE": return createApiError("SERVICE_UNAVAILABLE");
  }
}

export function candidateData(item: DuplicateCandidateSummary) { return {
  id: item.candidateId, entity_type: item.entityType,
  left_record: { id: item.leftRecordId, display_label: item.leftDisplayLabel },
  right_record: { id: item.rightRecordId, display_label: item.rightDisplayLabel },
  matching_signals: item.matchingSignals,
  status: item.status, merge_id: item.mergeId, record_version: item.recordVersion,
}; }
export function searchItemData(item: DuplicateRecordSearchItem) { return {
  id: item.id, entity_type: item.entityType, display_label: item.displayLabel,
  contact_hint: item.contactHint,
}; }
export function detailData(detail: DuplicateCandidateDetail) { return {
  candidate: candidateData(detail.candidate), left_profile: profileData(detail.leftProfile),
  right_profile: profileData(detail.rightProfile), supported_fields: detail.supportedFields,
  merge: detail.merge ? mergeData(detail.merge) : null,
}; }
export function mergeData(item: DuplicateMergeAcknowledgement) { return {
  id: item.id,
  source_record_id: item.sourceRecordId, canonical_record_id: item.canonicalRecordId,
  provenance_revision_id: item.provenanceRevisionId, status: item.status,
  record_version: item.recordVersion, correction_id: item.correctionId,
}; }
export function mergeReceiptData(item: DuplicateMergeReceipt) { return {
  merge_id: item.mergeId, candidate_id: item.candidateId, entity_type: item.entityType,
  source_record_id: item.sourceRecordId, canonical_record_id: item.canonicalRecordId,
  provenance_revision_id: item.provenanceRevisionId, record_version: item.recordVersion,
}; }
export function correctionData(item: DuplicateCorrectionAcknowledgement) { return {
  corrective_revision_id: item.correctiveRevisionId, merge_id: item.mergeId,
  source_record_id: item.sourceRecordId, canonical_record_id: item.canonicalRecordId,
  restored_alias_target_id: item.restoredAliasTargetId, record_version: item.recordVersion,
}; }
function profileData(item: DuplicateCandidateDetail["leftProfile"]) { return {
  id: item.id, display_name: item.displayName,
  ...(item.entityType === "student" ? { date_of_birth: item.dateOfBirth ?? null,
    contact_email: item.contactEmail ?? null, contact_phone: item.contactPhone ?? null } :
    { email: item.email ?? null, phone: item.phone ?? null }), record_version: item.recordVersion,
}; }
async function exactJson(request: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") invalid();
  let value: unknown; try { value = await request.json(); } catch { invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) invalid();
  return value as Record<string, unknown>;
}
function idempotencyKey(request: Request): string { const key = request.headers.get("idempotency-key")?.trim();
  if (!key) invalid(); return key; }
function isUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function isEntityType(value: unknown): value is DuplicateReviewEntityType {
  return typeof value === "string" && (DUPLICATE_REVIEW_ENTITY_TYPES as readonly string[]).includes(value);
}
function isCandidateStatus(value: unknown): value is DuplicateCandidateStatus {
  return typeof value === "string" && (DUPLICATE_CANDIDATE_STATUSES as readonly string[]).includes(value);
}
function version(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function invalid(): never { throw new DuplicateReviewError("DUPLICATE_REVIEW_INVALID"); }
