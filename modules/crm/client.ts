import {
  ApiClientError,
  expectArray,
  expectBoolean,
  expectNullableString,
  expectRecord,
  expectString,
  requestApi,
} from "../../lib/api/client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const RELATIONSHIP_TYPES = Object.freeze([
  "father",
  "mother",
  "other_guardian",
] as const);

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];
export type StudentStatus = "active" | "pending_delete";

export interface StudentListItem {
  readonly id: string;
  readonly displayName: string;
  readonly dateOfBirth: string | null;
  readonly status: StudentStatus;
  readonly primaryGuardianName: string | null;
  readonly updatedAt: string;
}

export interface StudentGuardianItem {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly relationshipType: string;
  readonly isLegalGuardian: boolean;
  readonly isPrimaryContact: boolean;
  readonly isEmergencyContact: boolean;
  readonly isBillingContact: boolean;
  readonly notificationConsent: boolean;
}

export interface StudentDetail extends StudentListItem {
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly guardians: readonly StudentGuardianItem[];
}

export interface StudentCreateDraft {
  readonly student: {
    readonly display_name: string;
    readonly date_of_birth: string;
    readonly contact_email: string;
    readonly contact_phone: string;
  };
  readonly primary_guardian: {
    readonly display_name: string;
    readonly email: string;
    readonly phone: string;
    readonly relationship_type: RelationshipType;
    readonly is_legal_guardian: boolean;
  };
}

export interface StudentCreateValidation {
  readonly studentDisplayName?: string;
  readonly studentDateOfBirth?: string;
  readonly studentEmail?: string;
  readonly guardianDisplayName?: string;
  readonly guardianEmail?: string;
  readonly guardianContact?: string;
}

export interface CreatedStudentAggregate {
  readonly student: {
    readonly id: string;
    readonly display_name: string;
  };
  readonly primary_guardian: {
    readonly id: string;
    readonly display_name: string;
  };
  readonly relationship: {
    readonly id: string;
    readonly relationship_type: RelationshipType;
  };
}

export type StudentRequestFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "conflict"
  | "unavailable";

export function listStudents(signal?: AbortSignal): Promise<readonly StudentListItem[]> {
  return requestApi(
    { path: "/api/v1/students", signal },
    (value) => expectArray(exactRecord(value, ["students"]).students, decodeStudentListItem),
  );
}

export async function getStudent(studentId: string, signal?: AbortSignal): Promise<StudentDetail> {
  assertUuid(studentId, "studentId");
  return await requestApi(
    { path: `/api/v1/students/${studentId}`, signal },
    (value) => decodeStudentDetail(exactRecord(value, ["student"]).student),
  );
}

export function createStudentWithPrimaryGuardian(
  draft: StudentCreateDraft,
  idempotencyKey: string,
): Promise<CreatedStudentAggregate> {
  const validation = validateStudentCreateDraft(draft);
  if (Object.keys(validation).length > 0) throw new TypeError("Invalid student creation draft.");
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new TypeError("Invalid idempotency key.");

  return requestApi(
    {
      path: "/api/v1/students",
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: normalizeStudentCreateDraft(draft),
    },
    decodeCreatedStudentAggregate,
  );
}

export function validateStudentCreateDraft(draft: StudentCreateDraft): StudentCreateValidation {
  const errors: Record<string, string> = {};
  if (!draft.student.display_name.trim()) errors.studentDisplayName = "請輸入學生姓名。";
  if (draft.student.date_of_birth && !isValidDate(draft.student.date_of_birth)) {
    errors.studentDateOfBirth = "請輸入有效的出生日期。";
  }
  if (draft.student.contact_email && !isValidEmail(draft.student.contact_email)) {
    errors.studentEmail = "請輸入有效的學生 Email。";
  }
  if (!draft.primary_guardian.display_name.trim()) {
    errors.guardianDisplayName = "請輸入主要監護人姓名。";
  }
  if (draft.primary_guardian.email && !isValidEmail(draft.primary_guardian.email)) {
    errors.guardianEmail = "請輸入有效的監護人 Email。";
  }
  if (!draft.primary_guardian.email.trim() && !draft.primary_guardian.phone.trim()) {
    errors.guardianContact = "監護人 Email 和電話至少填寫一項。";
  }
  return Object.freeze(errors);
}

export function classifyStudentRequestFailure(error: unknown): StudentRequestFailureKind {
  if (!(error instanceof ApiClientError)) return "unavailable";
  if (error.code === "UNAUTHENTICATED" || error.status === 401) return "unauthenticated";
  if (error.code === "FORBIDDEN" || error.status === 403) return "forbidden";
  if (error.code === "NOT_FOUND" || error.status === 404) return "not_found";
  if (error.code === "VALIDATION_FAILED" || error.status === 422) return "validation";
  if (error.code === "CONFLICT" || error.status === 409) return "conflict";
  return "unavailable";
}

/** Owns one key for one logical save attempt, including uncertain retries. */
export class StudentCreateIdempotencyAttempt {
  private readonly createKey: () => string;
  private key: string | null = null;

  constructor(createKey: () => string = () => globalThis.crypto.randomUUID()) {
    this.createKey = createKey;
  }

  keyForSubmission(): string {
    if (this.key === null) {
      const nextKey = this.createKey();
      if (!IDEMPOTENCY_KEY.test(nextKey)) throw new TypeError("Invalid idempotency key.");
      this.key = nextKey;
    }
    return this.key;
  }

  markBusinessFieldChanged(): void {
    this.key = null;
  }

  complete(): void {
    this.key = null;
  }
}

function normalizeStudentCreateDraft(draft: StudentCreateDraft) {
  return {
    student: {
      display_name: draft.student.display_name.trim(),
      date_of_birth: nullable(draft.student.date_of_birth),
      contact_email: nullable(draft.student.contact_email),
      contact_phone: nullable(draft.student.contact_phone),
    },
    primary_guardian: {
      display_name: draft.primary_guardian.display_name.trim(),
      email: nullable(draft.primary_guardian.email),
      phone: nullable(draft.primary_guardian.phone),
      relationship_type: draft.primary_guardian.relationship_type,
      is_legal_guardian: draft.primary_guardian.is_legal_guardian,
    },
  } as const;
}

function decodeStudentListItem(value: unknown): StudentListItem {
  const record = exactRecord(value, [
    "id",
    "displayName",
    "dateOfBirth",
    "status",
    "primaryGuardianName",
    "updatedAt",
  ]);
  const status = expectString(record.status);
  if (status !== "active" && status !== "pending_delete") throw new TypeError("Invalid student status.");
  return Object.freeze({
    id: uuid(record.id, "id"),
    displayName: nonEmptyString(record.displayName, "displayName"),
    dateOfBirth: nullableDate(record.dateOfBirth),
    status,
    primaryGuardianName: nullableNonEmptyString(record.primaryGuardianName, "primaryGuardianName"),
    updatedAt: isoDateTime(record.updatedAt, "updatedAt"),
  });
}

function decodeStudentDetail(value: unknown): StudentDetail {
  const record = exactRecord(value, [
    "id",
    "displayName",
    "dateOfBirth",
    "status",
    "primaryGuardianName",
    "updatedAt",
    "contactEmail",
    "contactPhone",
    "guardians",
  ]);
  const base = decodeStudentListItem(Object.fromEntries(
    ["id", "displayName", "dateOfBirth", "status", "primaryGuardianName", "updatedAt"]
      .map((key) => [key, record[key]]),
  ));
  return Object.freeze({
    ...base,
    contactEmail: nullableNonEmptyString(record.contactEmail, "contactEmail"),
    contactPhone: nullableNonEmptyString(record.contactPhone, "contactPhone"),
    guardians: Object.freeze([...expectArray(record.guardians, decodeGuardian)]),
  });
}

function decodeGuardian(value: unknown): StudentGuardianItem {
  const record = exactRecord(value, [
    "id",
    "displayName",
    "email",
    "phone",
    "relationshipType",
    "isLegalGuardian",
    "isPrimaryContact",
    "isEmergencyContact",
    "isBillingContact",
    "notificationConsent",
  ]);
  return Object.freeze({
    id: uuid(record.id, "guardian.id"),
    displayName: nonEmptyString(record.displayName, "guardian.displayName"),
    email: nullableNonEmptyString(record.email, "guardian.email"),
    phone: nullableNonEmptyString(record.phone, "guardian.phone"),
    relationshipType: nonEmptyString(record.relationshipType, "guardian.relationshipType"),
    isLegalGuardian: expectBoolean(record.isLegalGuardian),
    isPrimaryContact: expectBoolean(record.isPrimaryContact),
    isEmergencyContact: expectBoolean(record.isEmergencyContact),
    isBillingContact: expectBoolean(record.isBillingContact),
    notificationConsent: expectBoolean(record.notificationConsent),
  });
}

function decodeCreatedStudentAggregate(value: unknown): CreatedStudentAggregate {
  const record = exactRecord(value, ["student", "primary_guardian", "relationship"]);
  const student = exactRecord(record.student, ["id", "display_name"]);
  const guardian = exactRecord(record.primary_guardian, ["id", "display_name"]);
  const relationship = exactRecord(record.relationship, ["id", "relationship_type"]);
  const relationshipType = expectString(relationship.relationship_type);
  if (!isRelationshipType(relationshipType)) {
    throw new TypeError("Invalid relationship.relationship_type.");
  }
  return Object.freeze({
    student: Object.freeze({
      id: uuid(student.id, "student.id"),
      display_name: nonEmptyString(student.display_name, "student.display_name"),
    }),
    primary_guardian: Object.freeze({
      id: uuid(guardian.id, "primary_guardian.id"),
      display_name: nonEmptyString(guardian.display_name, "primary_guardian.display_name"),
    }),
    relationship: Object.freeze({
      id: uuid(relationship.id, "relationship.id"),
      relationship_type: relationshipType,
    }),
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = expectRecord(value);
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new TypeError("Invalid CRM response shape.");
  }
  return record;
}

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`Invalid ${field}.`);
}

function uuid(value: unknown, field: string): string {
  const result = expectString(value);
  assertUuid(result, field);
  return result;
}

function nonEmptyString(value: unknown, field: string): string {
  const result = expectString(value);
  if (!result.trim()) throw new TypeError(`Invalid ${field}.`);
  return result;
}

function nullableNonEmptyString(value: unknown, field: string): string | null {
  const result = expectNullableString(value);
  if (result !== null && !result.trim()) throw new TypeError(`Invalid ${field}.`);
  return result;
}

function nullableDate(value: unknown): string | null {
  const result = expectNullableString(value);
  if (result !== null && !isValidDate(result)) throw new TypeError("Invalid dateOfBirth.");
  return result;
}

function isoDateTime(value: unknown, field: string): string {
  const result = expectString(value);
  if (Number.isNaN(Date.parse(result))) throw new TypeError(`Invalid ${field}.`);
  return result;
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isRelationshipType(value: string): value is RelationshipType {
  return (RELATIONSHIP_TYPES as readonly string[]).includes(value);
}
