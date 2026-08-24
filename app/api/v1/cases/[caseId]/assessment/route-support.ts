import {
  isAssessmentServiceError,
  isCaseRuntimeUnavailable,
} from "@/modules/cases/server";
import {
  ApiContractError,
  createApiError,
} from "@/modules/shared/public";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertAssessmentCaseId(caseId: string): void {
  if (!UUID.test(caseId)) throw createApiError("INVALID_REQUEST");
}

export function requireAssessmentIdempotencyKey(request: Request): string {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw createApiError("INVALID_REQUEST");
  }
  return idempotencyKey;
}

export function mapAssessmentError(error: unknown): ApiContractError | unknown {
  if (error instanceof ApiContractError) return error;
  if (isCaseRuntimeUnavailable(error)) return createApiError("SERVICE_UNAVAILABLE");
  if (!isAssessmentServiceError(error)) return error;

  switch (error.code) {
    case "ASSESSMENT_ANSWER_INVALID":
    case "ASSESSMENT_STATUS_INVALID":
    case "ASSESSMENT_STATUS_BLOCKERS_INCOMPLETE":
      return createApiError("VALIDATION_FAILED");
    case "ASSESSMENT_ANSWER_STALE_VERSION":
    case "ASSESSMENT_STATUS_STALE_VERSION":
      return createApiError("STALE_VERSION", {
        details: {
          current_version: error.currentRecordVersion ?? 0,
        },
      });
    case "ASSESSMENT_ANSWER_IDEMPOTENCY_KEY_REUSED":
    case "ASSESSMENT_ANSWER_IDEMPOTENCY_IN_PROGRESS":
    case "ASSESSMENT_STATUS_IDEMPOTENCY_KEY_REUSED":
    case "ASSESSMENT_STATUS_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
    case "ASSESSMENT_CASE_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "ASSESSMENT_READ_FORBIDDEN":
    case "ASSESSMENT_WRITE_FORBIDDEN":
      return createApiError("FORBIDDEN");
    case "ASSESSMENT_SCHEMA_INVALID":
      return createApiError("SERVICE_UNAVAILABLE");
  }
}
