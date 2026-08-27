export const CASE_INTAKE_ADMISSION_TYPES = Object.freeze(["entry", "transfer"] as const);

export type CaseIntakeAdmissionType = (typeof CASE_INTAKE_ADMISSION_TYPES)[number];

export interface CaseIntakeOption {
  readonly id: string;
  readonly displayName: string;
}

export interface CaseIntakeAdvisorOption extends CaseIntakeOption {
  readonly role: "advisor";
}

export interface CaseIntakeOptions {
  readonly students: readonly CaseIntakeOption[];
  readonly advisors: readonly CaseIntakeAdvisorOption[];
  readonly referralSources: readonly CaseIntakeOption[];
}

export interface CaseIntakeReceipt {
  readonly caseId: string;
  readonly stage: "background_collection";
  readonly workflowStatus: "active";
  readonly recordVersion: number;
  readonly assessmentManifest: Readonly<{ id: string; version: string }>;
  readonly assessmentUrl: string;
}

export interface CaseIntakeCommand {
  readonly studentId: string;
  readonly primaryAdvisorRoleBindingId: string;
  readonly referralSourceId: string | null;
  readonly intakeYear: number;
  readonly admissionType: CaseIntakeAdmissionType;
  readonly signedAt: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export type CaseIntakeErrorCode =
  | "CASE_INTAKE_FORBIDDEN"
  | "CASE_INTAKE_INVALID"
  | "CASE_INTAKE_STUDENT_NOT_FOUND"
  | "CASE_INTAKE_ADVISOR_NOT_FOUND"
  | "CASE_INTAKE_REFERRAL_SOURCE_NOT_FOUND"
  | "CASE_INTAKE_MANIFEST_NOT_APPROVED"
  | "CASE_INTAKE_CONFLICT"
  | "CASE_INTAKE_STALE_VERSION"
  | "CASE_INTAKE_IDEMPOTENCY_CONFLICT"
  | "CASE_INTAKE_IDEMPOTENCY_IN_PROGRESS"
  | "CASE_INTAKE_UNAVAILABLE";

const ERROR_CODES = new Set<CaseIntakeErrorCode>([
  "CASE_INTAKE_FORBIDDEN",
  "CASE_INTAKE_INVALID",
  "CASE_INTAKE_STUDENT_NOT_FOUND",
  "CASE_INTAKE_ADVISOR_NOT_FOUND",
  "CASE_INTAKE_REFERRAL_SOURCE_NOT_FOUND",
  "CASE_INTAKE_MANIFEST_NOT_APPROVED",
  "CASE_INTAKE_CONFLICT",
  "CASE_INTAKE_STALE_VERSION",
  "CASE_INTAKE_IDEMPOTENCY_CONFLICT",
  "CASE_INTAKE_IDEMPOTENCY_IN_PROGRESS",
  "CASE_INTAKE_UNAVAILABLE",
]);

export class CaseIntakeError extends Error {
  readonly code: CaseIntakeErrorCode;
  readonly fieldErrors?: Readonly<Record<string, string>>;

  constructor(code: CaseIntakeErrorCode, fieldErrors?: Readonly<Record<string, string>>) {
    super(`Case intake rejected ${code}.`);
    this.name = "CaseIntakeError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function isCaseIntakeError(
  value: unknown,
  code?: CaseIntakeErrorCode,
): value is CaseIntakeError {
  if (!(value instanceof Error) || value.name !== "CaseIntakeError") return false;
  const candidate = (value as Error & { readonly code?: unknown }).code;
  if (typeof candidate !== "string" || !ERROR_CODES.has(candidate as CaseIntakeErrorCode)) {
    return false;
  }
  return code === undefined || candidate === code;
}
