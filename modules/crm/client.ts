import {
  ApiClientError,
  expectArray,
  expectBoolean,
  expectNullableString,
  expectNumber,
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

export interface GuardianContactHint {
  readonly id: string;
  readonly display_name: string;
  readonly email_hint: string | null;
  readonly phone_hint: string | null;
}

export interface CurrentGuardianRelationship {
  readonly relationship_id: string;
  readonly guardian: GuardianContactHint;
  readonly relationship_type: RelationshipType;
  readonly is_legal_guardian: boolean;
  readonly is_primary_contact: boolean;
  readonly is_emergency_contact: boolean;
  readonly is_billing_contact: boolean;
  readonly notification_consent: boolean;
  readonly starts_at: string;
  readonly record_version: number;
}

export interface GuardianRelationshipsView {
  readonly student: {
    readonly id: string;
    readonly display_name: string;
  };
  readonly relationships: readonly CurrentGuardianRelationship[];
}

export interface AttachGuardianRelationshipDraft {
  readonly guardian_id: string;
  readonly relationship_type: RelationshipType;
  readonly is_legal_guardian: boolean;
  readonly is_emergency_contact: boolean;
  readonly is_billing_contact: boolean;
  readonly notification_consent: boolean;
}

export interface GuardianRelationshipCommandResult {
  readonly relationship_id: string;
  readonly guardian_id: string;
  readonly relationship_type: RelationshipType;
  readonly is_legal_guardian: boolean;
  readonly is_primary_contact: boolean;
  readonly is_emergency_contact: boolean;
  readonly is_billing_contact: boolean;
  readonly notification_consent: boolean;
  readonly starts_at: string;
  readonly record_version: number;
}

export interface PrimaryGuardianHandoffResult {
  readonly relationship: GuardianRelationshipCommandResult;
  readonly closed_relationship_ids: {
    readonly previous_primary: string;
    readonly successor_secondary: string;
  };
}

export type StudentRequestFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "conflict"
  | "unavailable";

export type GuardianRelationshipFailureKind = StudentRequestFailureKind | "stale";

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

export function getGuardianRelationships(
  studentId: string,
  signal?: AbortSignal,
): Promise<GuardianRelationshipsView> {
  assertUuid(studentId, "studentId");
  return requestApi(
    { path: `/api/v1/students/${studentId}/guardians`, signal },
    (value) => decodeGuardianRelationshipsView(value, studentId),
  );
}

export function searchGuardians(
  studentId: string,
  query: string,
  signal?: AbortSignal,
): Promise<readonly GuardianContactHint[]> {
  assertUuid(studentId, "studentId");
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 2 || normalizedQuery.length > 100) {
    throw new TypeError("Invalid guardian search query.");
  }
  return requestApi(
    {
      path: `/api/v1/students/${studentId}/guardians/search`,
      method: "POST",
      body: { query: normalizedQuery },
      signal,
    },
    decodeGuardianSearchResults,
  );
}

export function attachGuardianRelationship(
  studentId: string,
  draft: AttachGuardianRelationshipDraft,
  idempotencyKey: string,
): Promise<GuardianRelationshipCommandResult> {
  assertUuid(studentId, "studentId");
  validateAttachGuardianDraft(draft);
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/students/${studentId}/guardians`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        guardian_id: draft.guardian_id,
        relationship_type: draft.relationship_type,
        is_legal_guardian: draft.is_legal_guardian,
        is_emergency_contact: draft.is_emergency_contact,
        is_billing_contact: draft.is_billing_contact,
        notification_consent: draft.notification_consent,
      },
    },
    (value) => decodeGuardianCommandResult(exactRecord(value, ["relationship"]).relationship),
  );
}

export function handoffPrimaryGuardian(
  studentId: string,
  successorGuardianId: string,
  expectedPrimaryRecordVersion: number,
  idempotencyKey: string,
): Promise<PrimaryGuardianHandoffResult> {
  assertUuid(studentId, "studentId");
  assertUuid(successorGuardianId, "successorGuardianId");
  assertPositiveInteger(expectedPrimaryRecordVersion, "expectedPrimaryRecordVersion");
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/students/${studentId}/guardians/primary-handoffs`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        successor_guardian_id: successorGuardianId,
        expected_primary_record_version: expectedPrimaryRecordVersion,
      },
    },
    decodePrimaryGuardianHandoffResult,
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

export function classifyGuardianRelationshipFailure(
  error: unknown,
): GuardianRelationshipFailureKind {
  if (error instanceof ApiClientError && error.code === "STALE_VERSION") return "stale";
  return classifyStudentRequestFailure(error);
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

/** Keeps one key for one logical Guardian mutation and its uncertain retries. */
export class GuardianRelationshipIdempotencyAttempt {
  private readonly operation: "attach" | "handoff";
  private readonly createKey: () => string;
  private fingerprint: string | null = null;
  private key: string | null = null;

  constructor(
    operation: "attach" | "handoff",
    createKey: () => string = () => `${operation}:${globalThis.crypto.randomUUID()}`,
  ) {
    this.operation = operation;
    this.createKey = createKey;
  }

  keyFor(fingerprint: string): string {
    if (!fingerprint || fingerprint.length > 512) throw new TypeError("Invalid operation fingerprint.");
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.key = null;
    }
    if (this.key === null) {
      const nextKey = this.createKey();
      assertIdempotencyKey(nextKey);
      this.key = nextKey;
    }
    return this.key;
  }

  rotate(): void {
    this.key = null;
  }

  complete(): void {
    this.fingerprint = null;
    this.key = null;
  }

  operationName(): "attach" | "handoff" {
    return this.operation;
  }
}

export function guardianAttachFingerprint(draft: AttachGuardianRelationshipDraft): string {
  validateAttachGuardianDraft(draft);
  return [
    draft.guardian_id,
    draft.relationship_type,
    Number(draft.is_legal_guardian),
    Number(draft.is_emergency_contact),
    Number(draft.is_billing_contact),
    Number(draft.notification_consent),
  ].join(":");
}

export function guardianHandoffFingerprint(
  successorGuardianId: string,
  expectedPrimaryRecordVersion: number,
): string {
  assertUuid(successorGuardianId, "successorGuardianId");
  assertPositiveInteger(expectedPrimaryRecordVersion, "expectedPrimaryRecordVersion");
  return `${successorGuardianId}:${expectedPrimaryRecordVersion}`;
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

function decodeGuardianRelationshipsView(
  value: unknown,
  expectedStudentId: string,
): GuardianRelationshipsView {
  const record = exactRecord(value, ["student", "relationships"]);
  const student = exactRecord(record.student, ["id", "display_name"]);
  const studentId = uuid(student.id, "student.id");
  if (studentId !== expectedStudentId) throw new TypeError("Mismatched student.id.");
  const relationships = expectArray(record.relationships, decodeCurrentGuardianRelationship);
  assertUnique(relationships.map(({ relationship_id }) => relationship_id), "relationship_id");
  assertUnique(relationships.map(({ guardian }) => guardian.id), "guardian.id");
  if (relationships.filter(({ is_primary_contact }) => is_primary_contact).length > 1) {
    throw new TypeError("Multiple current primary Guardians.");
  }
  return Object.freeze({
    student: Object.freeze({
      id: studentId,
      display_name: nonEmptyString(student.display_name, "student.display_name"),
    }),
    relationships: Object.freeze([...relationships]),
  });
}

function decodeCurrentGuardianRelationship(value: unknown): CurrentGuardianRelationship {
  const record = exactRecord(value, [
    "relationship_id",
    "guardian",
    "relationship_type",
    "is_legal_guardian",
    "is_primary_contact",
    "is_emergency_contact",
    "is_billing_contact",
    "notification_consent",
    "starts_at",
    "record_version",
  ]);
  return Object.freeze({
    relationship_id: uuid(record.relationship_id, "relationship_id"),
    guardian: decodeGuardianContactHint(record.guardian),
    relationship_type: relationshipType(record.relationship_type, "relationship_type"),
    is_legal_guardian: expectBoolean(record.is_legal_guardian),
    is_primary_contact: expectBoolean(record.is_primary_contact),
    is_emergency_contact: expectBoolean(record.is_emergency_contact),
    is_billing_contact: expectBoolean(record.is_billing_contact),
    notification_consent: expectBoolean(record.notification_consent),
    starts_at: isoDateTime(record.starts_at, "starts_at"),
    record_version: positiveInteger(record.record_version, "record_version"),
  });
}

function decodeGuardianSearchResults(value: unknown): readonly GuardianContactHint[] {
  const results = expectArray(value, decodeGuardianContactHint);
  if (results.length > 20) throw new TypeError("Too many Guardian search results.");
  assertUnique(results.map(({ id }) => id), "guardian.id");
  return Object.freeze([...results]);
}

function decodeGuardianContactHint(value: unknown): GuardianContactHint {
  const record = exactRecord(value, ["id", "display_name", "email_hint", "phone_hint"]);
  return Object.freeze({
    id: uuid(record.id, "guardian.id"),
    display_name: nonEmptyString(record.display_name, "guardian.display_name"),
    email_hint: maskedHint(record.email_hint, "guardian.email_hint"),
    phone_hint: maskedHint(record.phone_hint, "guardian.phone_hint"),
  });
}

function decodeGuardianCommandResult(value: unknown): GuardianRelationshipCommandResult {
  const record = exactRecord(value, [
    "relationship_id",
    "guardian_id",
    "relationship_type",
    "is_legal_guardian",
    "is_primary_contact",
    "is_emergency_contact",
    "is_billing_contact",
    "notification_consent",
    "starts_at",
    "record_version",
  ]);
  return Object.freeze({
    relationship_id: uuid(record.relationship_id, "relationship_id"),
    guardian_id: uuid(record.guardian_id, "guardian_id"),
    relationship_type: relationshipType(record.relationship_type, "relationship_type"),
    is_legal_guardian: expectBoolean(record.is_legal_guardian),
    is_primary_contact: expectBoolean(record.is_primary_contact),
    is_emergency_contact: expectBoolean(record.is_emergency_contact),
    is_billing_contact: expectBoolean(record.is_billing_contact),
    notification_consent: expectBoolean(record.notification_consent),
    starts_at: isoDateTime(record.starts_at, "starts_at"),
    record_version: positiveInteger(record.record_version, "record_version"),
  });
}

function decodePrimaryGuardianHandoffResult(value: unknown): PrimaryGuardianHandoffResult {
  const record = exactRecord(value, ["relationship", "closed_relationship_ids"]);
  const relationship = decodeGuardianCommandResult(record.relationship);
  if (!relationship.is_primary_contact) throw new TypeError("Handoff result is not primary.");
  const closed = exactRecord(record.closed_relationship_ids, [
    "previous_primary",
    "successor_secondary",
  ]);
  return Object.freeze({
    relationship,
    closed_relationship_ids: Object.freeze({
      previous_primary: uuid(closed.previous_primary, "closed.previous_primary"),
      successor_secondary: uuid(closed.successor_secondary, "closed.successor_secondary"),
    }),
  });
}

function validateAttachGuardianDraft(draft: AttachGuardianRelationshipDraft): void {
  assertUuid(draft.guardian_id, "guardian_id");
  if (!isRelationshipType(draft.relationship_type)) {
    throw new TypeError("Invalid relationship_type.");
  }
  for (const value of [
    draft.is_legal_guardian,
    draft.is_emergency_contact,
    draft.is_billing_contact,
    draft.notification_consent,
  ]) {
    if (typeof value !== "boolean") throw new TypeError("Invalid relationship flag.");
  }
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

function maskedHint(value: unknown, field: string): string | null {
  const result = nullableNonEmptyString(value, field);
  if (result !== null && !result.includes("*")) throw new TypeError(`Unmasked ${field}.`);
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

function positiveInteger(value: unknown, field: string): number {
  const result = expectNumber(value);
  assertPositiveInteger(result, field);
  return result;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${field}.`);
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value)) throw new TypeError("Invalid idempotency key.");
}

function relationshipType(value: unknown, field: string): RelationshipType {
  const result = expectString(value);
  if (!isRelationshipType(result)) throw new TypeError(`Invalid ${field}.`);
  return result;
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${field}.`);
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
