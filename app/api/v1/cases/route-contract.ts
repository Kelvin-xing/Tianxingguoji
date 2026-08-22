import {
  isCaseRuntimeUnavailable,
  isCaseWorkspaceError,
  type CaseWorkspaceErrorCode,
} from "../../../../modules/cases/server.ts";
import { createApiError } from "../../../../modules/shared/public.ts";

const CREATE_CASE_FIELDS = Object.freeze([
  "admission_type",
  "intake_year",
  "manifest_id",
  "primary_role_binding_id",
  "student_id",
] as const);

export interface CaseCreateCommand {
  readonly studentId: string;
  readonly intakeYear: number;
  readonly admissionType: string;
  readonly primaryRoleBindingId: string;
  readonly manifestId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export async function parseCaseCreateRequest(
  request: Request,
  requestId: string,
): Promise<CaseCreateCommand> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw createApiError("INVALID_REQUEST");
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) throw createApiError("INVALID_REQUEST");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (!isExactRecord(body, CREATE_CASE_FIELDS)) throw createApiError("INVALID_REQUEST");
  if (
    typeof body.student_id !== "string" ||
    typeof body.intake_year !== "number" ||
    typeof body.admission_type !== "string" ||
    typeof body.primary_role_binding_id !== "string" ||
    typeof body.manifest_id !== "string"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }
  return Object.freeze({
    studentId: body.student_id,
    intakeYear: body.intake_year,
    admissionType: body.admission_type,
    primaryRoleBindingId: body.primary_role_binding_id,
    manifestId: body.manifest_id,
    requestId,
    idempotencyKey,
  });
}

export function mapCaseWorkspaceCollectionError(error: unknown): unknown {
  if (isCaseRuntimeUnavailable(error)) return createApiError("SERVICE_UNAVAILABLE");
  if (!isCaseWorkspaceError(error)) return error;
  return mapKnownCaseWorkspaceError(error.code, false);
}

export function mapCaseWorkspaceDetailError(error: unknown): unknown {
  if (isCaseRuntimeUnavailable(error)) return createApiError("SERVICE_UNAVAILABLE");
  if (!isCaseWorkspaceError(error)) return error;
  return mapKnownCaseWorkspaceError(error.code, true);
}

function mapKnownCaseWorkspaceError(
  code: CaseWorkspaceErrorCode,
  invalidAsNotFound: boolean,
) {
  switch (code) {
    case "CASE_WORKSPACE_FORBIDDEN": return createApiError("FORBIDDEN");
    case "CASE_WORKSPACE_STUDENT_NOT_FOUND": return createApiError("NOT_FOUND");
    case "CASE_WORKSPACE_DUPLICATE":
    case "CASE_WORKSPACE_IDEMPOTENCY_CONFLICT":
    case "CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS": return createApiError("CONFLICT");
    case "CASE_WORKSPACE_BINDING_INACTIVE":
    case "CASE_WORKSPACE_MANIFEST_NOT_APPROVED": return createApiError("VALIDATION_FAILED");
    case "CASE_WORKSPACE_INVALID": return createApiError(
      invalidAsNotFound ? "NOT_FOUND" : "VALIDATION_FAILED",
    );
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
