import {
  CaseIntakeError,
  isCaseIntakeError,
  type CaseIntakeCommand,
  type CaseIntakeOptions,
  type CaseIntakeReceipt,
} from "../../../../modules/cases/public.ts";
import { createApiError, type ApiContractError, type JsonValue } from "../../../../modules/shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED_FIELDS = Object.freeze([
  "admission_type",
  "intake_year",
  "primary_advisor_role_binding_id",
  "signed_at",
  "student_id",
] as const);
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, "referral_source_id"]);

export async function parseCaseIntakeRequest(
  request: Request,
  requestId: string,
): Promise<CaseIntakeCommand> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    throw createApiError("INVALID_REQUEST");
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) throw createApiError("INVALID_REQUEST");

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (!isRecord(value)) throw createApiError("INVALID_REQUEST");
  const keys = Object.keys(value);
  if (
    keys.some((key) => !ALLOWED_FIELDS.has(key)) ||
    REQUIRED_FIELDS.some((key) => !keys.includes(key)) ||
    keys.length < REQUIRED_FIELDS.length ||
    keys.length > REQUIRED_FIELDS.length + 1
  ) {
    throw createApiError("INVALID_REQUEST");
  }

  if (
    typeof value.student_id !== "string" ||
    typeof value.primary_advisor_role_binding_id !== "string" ||
    typeof value.intake_year !== "number" ||
    typeof value.admission_type !== "string" ||
    typeof value.signed_at !== "string" ||
    (value.referral_source_id !== undefined && value.referral_source_id !== null &&
      typeof value.referral_source_id !== "string")
  ) {
    throw createApiError("VALIDATION_FAILED");
  }

  return Object.freeze({
    studentId: value.student_id,
    primaryAdvisorRoleBindingId: value.primary_advisor_role_binding_id,
    referralSourceId: value.referral_source_id ?? null,
    intakeYear: value.intake_year,
    admissionType: value.admission_type as CaseIntakeCommand["admissionType"],
    signedAt: value.signed_at,
    requestId,
    idempotencyKey,
  });
}

export interface CaseIntakeOptionFilters {
  readonly studentQuery: string | null;
  readonly advisorQuery: string | null;
  readonly referralSourceQuery: string | null;
}

export function parseCaseIntakeOptions(request: Request): CaseIntakeOptionFilters {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  const allowed = new Set(["student_q", "advisor_q", "source_q"]);
  const keys = [...url.searchParams.keys()];
  if (
    keys.some((key) => !allowed.has(key)) ||
    keys.some((key) => url.searchParams.getAll(key).length > 1)
  ) {
    throw createApiError("INVALID_REQUEST");
  }
  return Object.freeze({
    studentQuery: queryValue(url.searchParams.get("student_q")),
    advisorQuery: queryValue(url.searchParams.get("advisor_q")),
    referralSourceQuery: queryValue(url.searchParams.get("source_q")),
  });
}

export type CaseIntakeOptionsData = Readonly<{
  readonly students: readonly Readonly<{ id: string; display_name: string }>[];
  readonly advisors: readonly Readonly<{ id: string; display_name: string; role: "advisor" }>[];
  readonly referral_sources: readonly Readonly<{ id: string; display_name: string }>[];
}>;

export function caseIntakeOptionsData(options: CaseIntakeOptions): CaseIntakeOptionsData {
  return {
    students: options.students.map((option) => ({ id: option.id, display_name: option.displayName })),
    advisors: options.advisors.map((option) => ({
      id: option.id,
      display_name: option.displayName,
      role: option.role,
    })),
    referral_sources: options.referralSources.map((option) => ({
      id: option.id,
      display_name: option.displayName,
    })),
  };
}

export type CaseIntakeReceiptData = Readonly<{
  readonly case_id: string;
  readonly stage: "background_collection";
  readonly workflow_status: "active";
  readonly record_version: number;
  readonly assessment_manifest: Readonly<{ id: string; version: string }>;
  readonly assessment_url: string;
}>;

export function caseIntakeReceiptData(receipt: CaseIntakeReceipt): CaseIntakeReceiptData {
  return {
    case_id: receipt.caseId,
    stage: receipt.stage,
    workflow_status: receipt.workflowStatus,
    record_version: receipt.recordVersion,
    assessment_manifest: {
      id: receipt.assessmentManifest.id,
      version: receipt.assessmentManifest.version,
    },
    assessment_url: receipt.assessmentUrl,
  };
}

export function mapCaseIntakeError(error: unknown): unknown {
  if (!isCaseIntakeError(error)) return error;
  switch (error.code) {
    case "CASE_INTAKE_FORBIDDEN": return createApiError("FORBIDDEN");
    case "CASE_INTAKE_INVALID":
      return createApiError("VALIDATION_FAILED", { details: { field_errors: fieldErrors(error) } });
    case "CASE_INTAKE_STUDENT_NOT_FOUND":
    case "CASE_INTAKE_ADVISOR_NOT_FOUND":
    case "CASE_INTAKE_REFERRAL_SOURCE_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "CASE_INTAKE_MANIFEST_NOT_APPROVED":
      return createApiError("SERVICE_UNAVAILABLE");
    case "CASE_INTAKE_STALE_VERSION": return createApiError("STALE_VERSION");
    case "CASE_INTAKE_CONFLICT":
    case "CASE_INTAKE_IDEMPOTENCY_CONFLICT":
    case "CASE_INTAKE_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
    case "CASE_INTAKE_UNAVAILABLE": return createApiError("SERVICE_UNAVAILABLE");
  }
}

function fieldErrors(error: CaseIntakeError): JsonValue {
  const value = error.fieldErrors;
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).map(([key, message]) => [key, message]));
}

function queryValue(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length > 100) throw createApiError("VALIDATION_FAILED");
  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCaseIntakeUuid(value: string): boolean {
  return UUID.test(value);
}

export type CaseIntakeApiError = ApiContractError;
