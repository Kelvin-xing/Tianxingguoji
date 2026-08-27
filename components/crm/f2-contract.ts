import {
  expectArray,
  expectNullableString,
  expectNumber,
  expectRecord,
  expectString,
  expectReceipt,
  requestApi,
  type ApiRequestBody,
} from "@/lib/api/client";

export type StudentStatus = "active" | "pending_delete";

export interface StudentListItemDto {
  readonly id: string;
  readonly display_name: string;
  readonly contact_hint: string | null;
  readonly status: StudentStatus;
  readonly updated_at: string;
}

export interface StudentDetailDto extends StudentListItemDto {
  readonly date_of_birth: string | null;
  readonly gender: "male" | "female" | "other" | "not_disclosed" | null;
  readonly contact_email: string | null;
  readonly contact_phone: string | null;
  readonly record_version: number;
  readonly primary_guardian: GuardianSummaryDto | null;
  readonly allowed_actions: readonly string[];
}

export interface GuardianSummaryDto {
  readonly id: string;
  readonly display_name: string;
  readonly relationship_type: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly flags: readonly string[];
  readonly record_version: number;
}

export interface DuplicateWarningDto {
  readonly warning_token: string;
  readonly candidates: readonly {
    readonly kind: "student" | "guardian";
    readonly id: string;
    readonly display_name: string;
    readonly matched_fields: readonly string[];
    readonly contact_hint: string | null;
  }[];
}

export interface IntakeOptionsDto {
  readonly students: readonly { readonly id: string; readonly display_name: string }[];
  readonly advisors: readonly { readonly id: string; readonly display_name: string }[];
  readonly referral_sources: readonly { readonly id: string; readonly display_name: string }[];
}

export interface CaseReceiptDto {
  readonly case_id: string;
  readonly stage: "background_collection";
  readonly workflow_status: "active";
  readonly record_version: number;
  readonly assessment_manifest: { readonly id: string; readonly version: string };
  readonly assessment_url: string;
}

export interface CaseListItemDto {
  readonly id: string;
  readonly case_number: string;
  readonly student_id: string;
  readonly student_name: string;
  readonly intake_year: number;
  readonly admission_type: string;
  readonly stage: string;
  readonly updated_at: string;
}

export interface ReferralSourceDto {
  readonly id: string;
  readonly display_name: string;
  readonly source_type: string;
  readonly description: string | null;
  readonly status: "active" | "inactive";
  readonly record_version: number;
  readonly updated_at: string;
}

export function decodeStudentList(value: unknown): readonly StudentListItemDto[] {
  const root = expectRecord(value);
  const items = root.items ?? root.students;
  return expectArray(items, decodeStudentListItem);
}

export function decodeStudentDetail(value: unknown): StudentDetailDto {
  const envelope = expectRecord(value);
  const root = envelope.student === undefined ? envelope : expectRecord(envelope.student);
  const guardians = root.guardians === undefined
    ? []
    : expectArray(root.guardians, decodeGuardianSummary);
  const primaryGuardian = guardians.find((guardian) => guardian.flags.includes("primary")) ?? guardians[0] ?? null;
  return {
    ...decodeStudentListItem(root),
    date_of_birth: nullableString(root.date_of_birth ?? root.dateOfBirth),
    gender: nullableEnum(root.gender, ["male", "female", "other", "not_disclosed"]),
    contact_email: nullableString(root.contact_email ?? root.contactEmail),
    contact_phone: nullableString(root.contact_phone ?? root.contactPhone),
    record_version: expectNumber(root.record_version ?? root.recordVersion),
    primary_guardian: root.primary_guardian === null || root.primary_guardian === undefined
      ? primaryGuardian
      : decodeGuardianSummary(root.primary_guardian),
    allowed_actions: decodeStringArray(root.allowed_actions ?? []),
  };
}

export function decodeDuplicateWarning(value: unknown): DuplicateWarningDto {
  const root = expectRecord(value);
  return {
    warning_token: expectString(root.warning_token),
    candidates: expectArray(root.candidates, (candidate) => {
      const item = expectRecord(candidate);
      const kind = expectString(item.kind);
      if (kind !== "student" && kind !== "guardian") throw new TypeError("Invalid duplicate kind.");
      return {
        kind,
        id: expectString(item.id),
        display_name: expectString(item.display_name),
        matched_fields: decodeStringArray(item.matched_fields),
        contact_hint: nullableString(item.contact_hint),
      };
    }),
  };
}

export function decodeIntakeOptions(value: unknown): IntakeOptionsDto {
  const root = expectRecord(value);
  return {
    students: decodeOptions(root.students),
    advisors: decodeOptions(root.advisors),
    referral_sources: decodeOptions(root.referral_sources),
  };
}

export function decodeCaseReceipt(value: unknown): CaseReceiptDto {
  const root = expectRecord(value);
  const manifest = expectRecord(root.assessment_manifest);
  const receipt = expectReceipt({ case_id: root.case_id, record_version: root.record_version });
  return {
    case_id: expectString(receipt.case_id),
    stage: root.stage === "background_collection" ? root.stage : invalid(),
    workflow_status: root.workflow_status === "active" ? root.workflow_status : invalid(),
    record_version: expectNumber(receipt.record_version),
    assessment_manifest: { id: expectString(manifest.id), version: expectString(manifest.version) },
    assessment_url: expectString(root.assessment_url),
  };
}

export function decodeReferralSources(value: unknown): readonly ReferralSourceDto[] {
  const root = expectRecord(value);
  return expectArray(root.items ?? root.referral_sources, decodeReferralSource);
}

export function decodeCaseList(value: unknown): readonly CaseListItemDto[] {
  const root = expectRecord(value);
  return expectArray(root.items ?? root.cases, (item) => {
    const row = expectRecord(item);
    return {
      id: expectString(row.id),
      case_number: expectString(row.case_number ?? row.caseNumber),
      student_id: expectString(row.student_id ?? row.studentId),
      student_name: expectString(row.student_name ?? row.studentName),
      intake_year: expectNumber(row.intake_year ?? row.intakeYear),
      admission_type: expectString(row.admission_type ?? row.admissionType),
      stage: expectString(row.stage),
      updated_at: expectString(row.updated_at ?? row.updatedAt),
    };
  });
}

export function decodeReferralSource(value: unknown): ReferralSourceDto {
  const root = expectRecord(value);
  const status = expectString(root.status);
  if (status !== "active" && status !== "inactive") throw new TypeError("Invalid referral source status.");
  return {
    id: expectString(root.id),
    display_name: expectString(root.display_name ?? root.displayName),
    source_type: expectString(root.source_type ?? root.sourceType),
    description: nullableString(root.description),
    status,
    record_version: expectNumber(root.record_version ?? root.recordVersion),
    updated_at: expectString(root.updated_at ?? root.updatedAt),
  };
}

export function listStudents(query: { readonly q?: string; readonly status?: StudentStatus; readonly cursor?: string } = {}) {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", "25");
  return requestApi({ path: `/api/v1/students?${params.toString()}` as `/${string}` }, decodeStudentList);
}

export function getStudent(studentId: string) {
  return requestApi({ path: `/api/v1/students/${encodeURIComponent(studentId)}` as `/${string}` }, decodeStudentDetail);
}

export function precheckPotentialDuplicates(body: ApiRequestBody) {
  return requestApi({ path: "/api/v1/crm/potential-duplicates", method: "POST", body, idempotencyKey: crypto.randomUUID() }, decodeDuplicateWarning);
}

export function createStudent(body: ApiRequestBody, idempotencyKey: string) {
  return requestApi({ path: "/api/v1/students", method: "POST", body, idempotencyKey }, decodeStudentCreateReceipt);
}

export function listIntakeOptions(query: { readonly student_q?: string; readonly advisor_q?: string; readonly source_q?: string } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value?.trim()) params.set(key, value.trim());
  return requestApi({ path: `/api/v1/cases/intake-options?${params.toString()}` as `/${string}` }, decodeIntakeOptions);
}

export function listCases() {
  return requestApi({ path: "/api/v1/cases" }, decodeCaseList);
}

export function createK12Case(body: ApiRequestBody, idempotencyKey: string) {
  return requestApi({ path: "/api/v1/cases", method: "POST", body, idempotencyKey }, decodeCaseReceipt);
}

export function listReferralSources(query: { readonly q?: string; readonly status?: "active" | "inactive" } = {}) {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.status) params.set("status", query.status);
  params.set("limit", "25");
  return requestApi({ path: `/api/v1/referral-sources?${params.toString()}` as `/${string}` }, decodeReferralSources);
}

export function listGuardians(studentId: string) {
  return requestApi({ path: `/api/v1/students/${encodeURIComponent(studentId)}/guardians` as `/${string}` }, (value) => {
    const root = expectRecord(value);
    return expectArray(root.relationships ?? root.items ?? root.guardians, decodeGuardianRelationship);
  });
}

export function attachGuardian(studentId: string, body: ApiRequestBody, idempotencyKey: string) {
  return requestApi({ path: `/api/v1/students/${encodeURIComponent(studentId)}/guardians`, method: "POST", body, idempotencyKey }, expectReceipt);
}

export function handoffPrimaryGuardian(studentId: string, body: ApiRequestBody, idempotencyKey: string, expectedRecordVersion: number) {
  return requestApi({ path: `/api/v1/students/${encodeURIComponent(studentId)}/guardians/primary-handoffs`, method: "POST", body, idempotencyKey, expectedRecordVersion }, expectReceipt);
}

function decodeStudentCreateReceipt(value: unknown): Readonly<Record<string, unknown>> {
  const root = expectRecord(value);
  for (const key of ["student", "primary_guardian", "relationship"] as const) {
    const item = expectRecord(root[key]);
    expectString(item.id);
    expectNumber(item.record_version);
  }
  return root;
}

function decodeStudentListItem(value: unknown): StudentListItemDto {
  const root = expectRecord(value);
  const status = expectString(root.status);
  if (status !== "active" && status !== "pending_delete") throw new TypeError("Invalid student status.");
  return {
    id: expectString(root.id),
    display_name: expectString(root.display_name ?? root.displayName),
    contact_hint: nullableString(root.contact_hint ?? root.primaryGuardianName),
    status,
    updated_at: expectString(root.updated_at ?? root.updatedAt),
  };
}

function decodeGuardianSummary(value: unknown): GuardianSummaryDto {
  const root = expectRecord(value);
  const flags = root.flags === undefined
    ? [
        root.isPrimaryContact === true ? "primary" : null,
        root.isEmergencyContact === true ? "emergency" : null,
        root.isBillingContact === true ? "billing" : null,
      ].filter((flag): flag is string => flag !== null)
    : decodeStringArray(root.flags);
  return {
    id: expectString(root.id),
    display_name: expectString(root.display_name ?? root.displayName),
    relationship_type: expectString(root.relationship_type ?? root.relationshipType),
    email: nullableString(root.email),
    phone: nullableString(root.phone),
    flags,
    record_version: expectNumber(root.record_version ?? root.recordVersion),
  };
}

function decodeGuardianRelationship(value: unknown): GuardianSummaryDto {
  const root = expectRecord(value);
  if (root.guardian === undefined) return decodeGuardianSummary(root);
  const guardian = expectRecord(root.guardian);
  const flags = [
    root.is_primary_contact === true ? "primary" : null,
    root.is_emergency_contact === true ? "emergency" : null,
    root.is_billing_contact === true ? "billing" : null,
  ].filter((flag): flag is string => flag !== null);
  return decodeGuardianSummary({
    id: guardian.id,
    display_name: guardian.display_name,
    relationship_type: root.relationship_type,
    email: guardian.email ?? guardian.email_hint ?? null,
    phone: guardian.phone ?? guardian.phone_hint ?? null,
    flags,
    record_version: root.record_version,
  });
}

function decodeOptions(value: unknown): readonly { readonly id: string; readonly display_name: string }[] {
  return expectArray(value ?? [], (item) => {
    const root = expectRecord(item);
    return { id: expectString(root.id), display_name: expectString(root.display_name) };
  });
}

function decodeStringArray(value: unknown): readonly string[] {
  return expectArray(value, expectString);
}

function nullableString(value: unknown): string | null {
  return value === undefined ? null : expectNullableString(value);
}

function nullableEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError("Invalid enum value.");
  return value as T;
}

function invalid(): never {
  throw new TypeError("Invalid receipt value.");
}
