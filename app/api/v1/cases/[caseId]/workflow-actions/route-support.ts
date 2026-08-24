import {
  isCaseRuntimeUnavailable,
  isCaseWorkflowError,
  type ApplyCaseWorkflowActionCommand,
} from "../../../../../../modules/cases/server.ts";
import { ApiContractError, createApiError } from "../../../../../../modules/shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BODY_FIELDS = Object.freeze(["action", "expected_record_version", "reason"] as const);

export function assertWorkflowCaseId(caseId: string): void {
  if (!UUID.test(caseId)) throw createApiError("INVALID_REQUEST");
}

export async function parseCaseWorkflowActionRequest(
  request: Request,
  requestId: string,
): Promise<ApplyCaseWorkflowActionCommand> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw createApiError("INVALID_REQUEST");
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw createApiError("INVALID_REQUEST");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (!isExactRecord(body, BODY_FIELDS)) throw createApiError("INVALID_REQUEST");
  if (
    (body.action !== "pause" && body.action !== "resume") ||
    typeof body.expected_record_version !== "number" ||
    (body.reason !== null && typeof body.reason !== "string")
  ) {
    throw createApiError("VALIDATION_FAILED");
  }
  return Object.freeze({
    action: body.action,
    expectedRecordVersion: body.expected_record_version,
    reason: body.reason,
    requestId,
    idempotencyKey,
  });
}

export function mapCaseWorkflowError(error: unknown): ApiContractError | unknown {
  if (error instanceof ApiContractError) return error;
  if (isCaseRuntimeUnavailable(error)) return createApiError("SERVICE_UNAVAILABLE");
  if (!isCaseWorkflowError(error)) return error;
  switch (error.code) {
    case "CASE_WORKFLOW_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "CASE_WORKFLOW_FORBIDDEN":
      return createApiError("FORBIDDEN");
    case "CASE_WORKFLOW_CASE_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "CASE_WORKFLOW_STALE_VERSION":
      return createApiError("STALE_VERSION", {
        details: { current_version: error.currentRecordVersion ?? 0 },
      });
    case "CASE_WORKFLOW_CONFLICT":
    case "CASE_WORKFLOW_SUBMITTED_TARGET_EXISTS":
    case "CASE_WORKFLOW_IDEMPOTENCY_KEY_REUSED":
    case "CASE_WORKFLOW_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
  }
}

function isExactRecord<const Fields extends readonly string[]>(
  value: unknown,
  fields: Fields,
): value is Record<Fields[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === fields.length && fields.every((field, index) => field === keys[index]);
}
