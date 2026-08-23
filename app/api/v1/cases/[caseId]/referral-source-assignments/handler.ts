import {
  CaseReferralSourceError,
  isCaseReferralSourceError,
  isCaseReferralSourceRuntimeUnavailable,
  type CaseReferralSourceAcknowledgement,
  type CaseReferralSourceAssignmentView,
  type CaseReferralSourceAssignmentsView,
} from "../../../../../../modules/cases/server.ts";
import { createApiError, type JsonValue } from "../../../../../../modules/shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function parseCaseReferralSourceAssignment(request: Request, caseId: string, requestId: string) {
  if (!UUID.test(caseId) || request.headers.get("content-type")?.split(";",1)[0]?.trim() !== "application/json") invalid();
  let value: unknown; try { value = await request.json(); } catch { invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "expected_current_assignment_record_version,referral_source_id") invalid();
  const body = value as Record<string, unknown>;
  if (!UUID.test(String(body.referral_source_id)) ||
      (body.expected_current_assignment_record_version !== null &&
       (!Number.isSafeInteger(body.expected_current_assignment_record_version) ||
        Number(body.expected_current_assignment_record_version) < 1))) invalid();
  const key = request.headers.get("idempotency-key"); if (!key) invalid();
  return Object.freeze({ caseId, referralSourceId: String(body.referral_source_id),
    expectedCurrentAssignmentRecordVersion: body.expected_current_assignment_record_version === null ? null :
      Number(body.expected_current_assignment_record_version), requestId, idempotencyKey: key });
}
export function assignmentsData(value: CaseReferralSourceAssignmentsView): JsonValue {
  return { current: value.current ? assignmentData(value.current) : null,
    history: value.history.map(assignmentData) };
}
export function assignmentData(value: CaseReferralSourceAssignmentView): JsonValue {
  return { id: value.id, referral_source_id: value.referralSourceId,
    source_display_name: value.sourceDisplayName, source_type: value.sourceType,
    source_record_version: value.sourceRecordVersion, starts_at: value.startsAt,
    ends_at: value.endsAt, record_version: value.recordVersion };
}
export function assignmentAcknowledgementData(value: CaseReferralSourceAcknowledgement): JsonValue {
  return { id: value.id, record_version: value.recordVersion };
}
export function mapCaseReferralSourceError(error: unknown): unknown {
  if (isCaseReferralSourceRuntimeUnavailable(error)) return createApiError("SERVICE_UNAVAILABLE");
  if (!isCaseReferralSourceError(error)) return error;
  switch (error.code) {
    case "CASE_REFERRAL_SOURCE_FORBIDDEN": return createApiError("FORBIDDEN");
    case "CASE_REFERRAL_SOURCE_INVALID": return createApiError("VALIDATION_FAILED");
    case "CASE_REFERRAL_SOURCE_NOT_FOUND": return createApiError("NOT_FOUND");
    case "CASE_REFERRAL_SOURCE_STALE": return createApiError("STALE_VERSION");
    case "CASE_REFERRAL_SOURCE_CONFLICT": return createApiError("CONFLICT");
    case "CASE_REFERRAL_SOURCE_UNAVAILABLE": return createApiError("SERVICE_UNAVAILABLE");
  }
}
function invalid(): never { throw new CaseReferralSourceError("CASE_REFERRAL_SOURCE_INVALID"); }
