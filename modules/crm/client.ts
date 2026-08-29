import {
  ApiClientError,
  expectArray,
  expectBoolean,
  expectNullableString,
  expectNumber,
  expectRecord,
  expectString,
  requestApi,
  type ApiRequestBody,
} from "../../lib/api/client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const REFERRAL_SOURCE_TYPES = Object.freeze([
  "customer_referral", "employee_referral", "school_referral", "partner_referral",
  "website", "social_media", "paid_advertising", "event", "walk_in", "other", "unknown",
] as const);
export const REFERRAL_SOURCE_STATUSES = Object.freeze(["active", "inactive"] as const);

export const RELATIONSHIP_TYPES = Object.freeze([
  "parent", "father", "mother", "step_parent", "stepfather", "stepmother",
  "adoptive_parent", "adoptive_father", "adoptive_mother", "foster_parent",
  "foster_father", "foster_mother", "grandparent", "paternal_grandfather",
  "paternal_grandmother", "maternal_grandfather", "maternal_grandmother",
  "adult_sibling", "adult_brother", "adult_sister", "uncle", "aunt",
  "court_appointed_guardian", "institutional_guardian", "other_relative",
  "non_relative_guardian", "other",
] as const);

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];
export type CrmGender = "male" | "female" | "other" | "not_disclosed";
export type StudentStatus = "active" | "pending_delete";

export interface StudentListItem {
  readonly id: string;
  readonly displayName: string;
  readonly dateOfBirth: string | null;
  readonly gender: CrmGender | null;
  readonly status: StudentStatus;
  readonly primaryGuardianName: string | null;
  readonly updatedAt: string;
}

export interface StudentGuardianItem {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly dateOfBirth: string | null;
  readonly gender: CrmGender | null;
  readonly status: StudentStatus;
  readonly recordVersion: number;
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
  readonly recordVersion: number;
  readonly guardians: readonly StudentGuardianItem[];
}

export interface StudentProfileDraft {
  readonly display_name: string;
  readonly date_of_birth: string;
  readonly gender: CrmGender | "";
  readonly contact_email: string;
  readonly contact_phone: string;
  readonly expected_record_version: number;
}

export interface GuardianProfileDraft {
  readonly display_name: string;
  readonly email: string;
  readonly phone: string;
  readonly date_of_birth: string;
  readonly gender: CrmGender | "";
  readonly expected_record_version: number;
}

export interface ProfileValidation {
  readonly displayName?: string;
  readonly dateOfBirth?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly contact?: string;
}

export interface UpdatedStudentProfile {
  readonly id: string;
  readonly record_version: number;
  readonly updated_at: string;
}

export interface UpdatedGuardianProfile {
  readonly id: string;
  readonly record_version: number;
  readonly updated_at: string;
}

export interface StudentCreateDraft {
  readonly student: {
    readonly display_name: string;
    readonly date_of_birth: string;
    readonly gender: CrmGender | "";
    readonly contact_email: string;
    readonly contact_phone: string;
  };
  readonly primary_guardian: {
    readonly display_name: string;
    readonly email: string;
    readonly phone: string;
    readonly date_of_birth: string;
    readonly gender: CrmGender | "";
    readonly relationship_type: RelationshipType;
    readonly relationship_description: string;
    readonly is_legal_guardian: boolean;
    readonly is_emergency_contact: boolean;
    readonly is_billing_contact: boolean;
    readonly notification_consent: boolean;
    /** Set only after the user explicitly selects an existing Guardian. */
    readonly existing_guardian_id?: string;
    /** Set after the duplicate precheck when the user explicitly confirms creating a new Guardian. */
    readonly warning_token?: string | null;
  };
}

export interface PotentialDuplicateCandidate {
  readonly id: string;
  readonly matching_fields: readonly ("display_name" | "email" | "phone")[];
  readonly display_name_hint: string | null;
  readonly email_hint: string | null;
  readonly phone_hint: string | null;
}

export interface PotentialDuplicateResult {
  readonly warnings: readonly PotentialDuplicateCandidate[];
  readonly warning_token: string | null;
}

export interface StudentCreateValidation {
  readonly studentDisplayName?: string;
  readonly studentDateOfBirth?: string;
  readonly studentEmail?: string;
  readonly guardianDisplayName?: string;
  readonly guardianEmail?: string;
  readonly guardianContact?: string;
  readonly guardianSelection?: string;
}

export interface CreatedStudentAggregate {
  readonly student: { readonly id: string; readonly record_version: number };
  readonly primary_guardian: { readonly id: string; readonly record_version: number };
  readonly relationship: { readonly id: string; readonly record_version: number };
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
  readonly relationship_description?: string | null;
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
  readonly relationship_description: string | null;
  readonly is_legal_guardian: boolean;
  readonly is_emergency_contact: boolean;
  readonly is_billing_contact: boolean;
  readonly notification_consent: boolean;
}

export interface GuardianRelationshipCommandResult {
  readonly relationship_id: string;
  readonly guardian_id: string;
  readonly relationship_type: RelationshipType;
  readonly relationship_description: string | null;
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
export type ProfileMaintenanceFailureKind = StudentRequestFailureKind | "stale";

export const DELETION_ENTITY_TYPES = Object.freeze(["student", "guardian"] as const);
export const PENDING_DELETION_REASON_CODE = "record.lifecycle.pending_delete_requested" as const;

export type DeletionEntityType = (typeof DELETION_ENTITY_TYPES)[number];

export interface PendingDeletionReceipt {
  readonly entity_type: DeletionEntityType;
  readonly entity_id: string;
  readonly status: "pending_delete";
  readonly deletion_requested_at: string;
  readonly record_version: number;
}

export interface PendingDeletionSummary extends PendingDeletionReceipt {
  readonly display_label: string;
}

export type PendingDeletionFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "stale"
  | "conflict"
  | "unavailable";

export type ReferralSourceType = (typeof REFERRAL_SOURCE_TYPES)[number];
export type ReferralSourceStatus = (typeof REFERRAL_SOURCE_STATUSES)[number];

export interface ReferralSource {
  readonly id: string;
  readonly display_name: string;
  readonly source_type: ReferralSourceType;
  readonly description: string | null;
  readonly status: ReferralSourceStatus;
  readonly record_version: number;
  readonly updated_at: string;
}

export interface ReferralSourceListResult {
  readonly items: readonly ReferralSource[];
  readonly next_cursor: string | null;
}

export interface CreateReferralSourceInput {
  readonly display_name: string;
  readonly source_type: ReferralSourceType;
  readonly description: string | null;
}

export interface UpdateReferralSourceInput {
  readonly expected_record_version: number;
  readonly display_name: string;
  readonly source_type: ReferralSourceType;
  readonly description: string | null;
}

export interface DeactivateReferralSourceInput {
  readonly expected_record_version: number;
  readonly reason_code: "record.lifecycle.referral_source_deactivated";
}

export interface ReferralSourceWriteReceipt {
  readonly referral_source: {
    readonly id: string;
    readonly status: ReferralSourceStatus;
    readonly record_version: number;
    readonly updated_at: string;
  };
}

export type ReferralSourceFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "stale"
  | "conflict"
  | "unavailable";

export const DUPLICATE_ENTITY_TYPES = Object.freeze(["student", "guardian"] as const);
export const DUPLICATE_CANDIDATE_STATUSES = Object.freeze([
  "review_required",
  "merged",
  "dismissed",
] as const);

export type DuplicateEntityType = (typeof DUPLICATE_ENTITY_TYPES)[number];
export type DuplicateCandidateStatus = (typeof DUPLICATE_CANDIDATE_STATUSES)[number];
export type DuplicateCandidateFilterStatus = Extract<DuplicateCandidateStatus, "review_required" | "merged">;
export type DuplicateSignalName = "display_name" | "date_of_birth" | "email" | "phone";
export type DuplicateSupportedField =
  | "display_name"
  | "date_of_birth"
  | "contact_email"
  | "contact_phone"
  | "email"
  | "phone";

export interface DuplicateRecordSearchResult {
  readonly id: string;
  readonly entity_type: DuplicateEntityType;
  readonly display_label: string;
  readonly contact_hint: string | null;
}

export interface DuplicateCandidateRecordLabel {
  readonly id: string;
  readonly display_label: string;
}

export interface DuplicateCandidateSummary {
  readonly id: string;
  readonly entity_type: DuplicateEntityType;
  readonly left_record: DuplicateCandidateRecordLabel;
  readonly right_record: DuplicateCandidateRecordLabel;
  readonly matching_signals: readonly DuplicateSignalName[];
  readonly status: DuplicateCandidateStatus;
  readonly merge_id: string | null;
  readonly record_version: number;
}

export interface DuplicateStudentProfile {
  readonly id: string;
  readonly display_name: string;
  readonly date_of_birth: string | null;
  readonly contact_email: string | null;
  readonly contact_phone: string | null;
  readonly record_version: number;
}

export interface DuplicateGuardianProfile {
  readonly id: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly record_version: number;
}

export type DuplicateProfile = DuplicateStudentProfile | DuplicateGuardianProfile;

export interface DuplicateMergeView {
  readonly id: string;
  readonly source_record_id: string;
  readonly canonical_record_id: string;
  readonly provenance_revision_id: string;
  readonly status: "active" | "corrected";
  readonly record_version: number;
  readonly correction_id: string | null;
}

export interface DuplicateCandidateDetail {
  readonly candidate: DuplicateCandidateSummary;
  readonly left_profile: DuplicateProfile;
  readonly right_profile: DuplicateProfile;
  readonly supported_fields: readonly DuplicateSupportedField[];
  readonly merge: DuplicateMergeView | null;
}

export interface DuplicateFieldSelection {
  readonly field_name: DuplicateSupportedField;
  readonly source_record_id: string;
}

export interface DuplicateMergeDraft {
  readonly source_record_id: string;
  readonly canonical_record_id: string;
  readonly expected_candidate_record_version: number;
  readonly expected_source_record_version: number;
  readonly expected_canonical_record_version: number;
  readonly field_selections: readonly DuplicateFieldSelection[];
}

export interface DuplicateMergeReceipt {
  readonly merge_id: string;
  readonly candidate_id: string;
  readonly entity_type: DuplicateEntityType;
  readonly source_record_id: string;
  readonly canonical_record_id: string;
  readonly provenance_revision_id: string;
  readonly record_version: number;
}

export interface DuplicateCorrectionReceipt {
  readonly corrective_revision_id: string;
  readonly merge_id: string;
  readonly source_record_id: string;
  readonly canonical_record_id: string;
  readonly restored_alias_target_id: string;
  readonly record_version: number;
}

export type DuplicateRequestFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "stale"
  | "conflict"
  | "unavailable";

export function listReferralSources(
  statusOrOptions?: ReferralSourceStatus | {
    readonly q?: string;
    readonly status?: ReferralSourceStatus;
    readonly source_type?: ReferralSourceType;
    readonly limit?: number;
    readonly cursor?: string;
  },
  signal?: AbortSignal,
): Promise<ReferralSourceListResult> {
  const options = typeof statusOrOptions === "string"
    ? { status: statusOrOptions }
    : (statusOrOptions ?? {});
  if (options.status !== undefined) assertReferralSourceStatus(options.status, "status");
  if (options.source_type !== undefined) referralSourceType(options.source_type, "source_type");
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Invalid ReferralSource limit.");
  const params = new URLSearchParams();
  if (options.q?.trim()) params.set("q", options.q.trim());
  if (options.status) params.set("status", options.status);
  if (options.source_type) params.set("source_type", options.source_type);
  params.set("limit", String(limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const query = params.toString();
  const path: `/${string}` = query ? `/api/v1/referral-sources?${query}` : "/api/v1/referral-sources";
  return requestApi(
    { path, signal },
    (value) => decodeReferralSourceList(value, options.status),
  );
}

export function getReferralSource(sourceId: string, signal?: AbortSignal): Promise<ReferralSource> {
  assertUuid(sourceId, "sourceId");
  return requestApi(
    { path: `/api/v1/referral-sources/${sourceId}`, signal },
    decodeReferralSource,
  );
}

export function createReferralSource(
  input: CreateReferralSourceInput,
  idempotencyKey: string,
): Promise<ReferralSourceWriteReceipt> {
  const normalized = normalizeReferralSourceCreate(input);
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: "/api/v1/referral-sources",
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: normalized,
    },
    (value) => decodeReferralSourceWriteReceipt(value, undefined, 1),
  );
}

export function updateReferralSource(
  sourceId: string,
  input: UpdateReferralSourceInput,
  idempotencyKey: string,
): Promise<ReferralSourceWriteReceipt> {
  assertUuid(sourceId, "sourceId");
  const normalized = normalizeReferralSourceUpdate(input);
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/referral-sources/${sourceId}`,
      method: "PATCH",
      headers: { "idempotency-key": idempotencyKey },
      body: normalized,
    },
    (value) => decodeReferralSourceWriteReceipt(
      value,
      sourceId,
      normalized.expected_record_version + 1,
    ),
  );
}

export function deactivateReferralSource(
  sourceId: string,
  input: DeactivateReferralSourceInput,
  idempotencyKey: string,
): Promise<ReferralSourceWriteReceipt> {
  assertUuid(sourceId, "sourceId");
  assertPositiveInteger(input.expected_record_version, "expected_record_version");
  if (input.reason_code !== "record.lifecycle.referral_source_deactivated") throw new TypeError("Invalid reason_code.");
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/referral-sources/${sourceId}/deactivate`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: { ...input },
    },
    (value) => decodeReferralSourceWriteReceipt(value, sourceId, input.expected_record_version + 1),
  );
}

export function classifyReferralSourceFailure(error: unknown): ReferralSourceFailureKind {
  if (!(error instanceof ApiClientError)) return "unavailable";
  if (error.code === "UNAUTHENTICATED" || error.status === 401) return "unauthenticated";
  if (error.code === "FORBIDDEN" || error.status === 403) return "forbidden";
  if (error.code === "NOT_FOUND" || error.status === 404) return "not_found";
  if (error.code === "VALIDATION_FAILED" || error.status === 422) return "validation";
  if (error.code === "STALE_VERSION") return "stale";
  if (error.code === "CONFLICT" || error.status === 409) return "conflict";
  return "unavailable";
}

export function referralSourceCreateFingerprint(input: CreateReferralSourceInput): string {
  const normalized = normalizeReferralSourceCreate(input);
  return JSON.stringify(normalized);
}

export function referralSourceUpdateFingerprint(sourceId: string, input: UpdateReferralSourceInput): string {
  assertUuid(sourceId, "sourceId");
  const normalized = normalizeReferralSourceUpdate(input);
  return JSON.stringify({ source_id: sourceId, ...normalized });
}

export class ReferralSourceIdempotencyAttempt {
  private readonly createKey: () => string;
  private fingerprint: string | null = null;
  private key: string | null = null;

  constructor(createKey: () => string = () => globalThis.crypto.randomUUID()) {
    this.createKey = createKey;
  }

  keyFor(fingerprint: string): string {
    if (fingerprint.trim() === "") throw new TypeError("Invalid ReferralSource fingerprint.");
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
}

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

export function updateStudentProfile(
  studentId: string,
  draft: StudentProfileDraft,
  idempotencyKey: string,
): Promise<UpdatedStudentProfile> {
  assertUuid(studentId, "studentId");
  if (Object.keys(validateStudentProfileDraft(draft)).length > 0) {
    throw new TypeError("Invalid Student profile draft.");
  }
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/students/${studentId}`,
      method: "PATCH",
      headers: { "idempotency-key": idempotencyKey },
      body: normalizeStudentProfileDraft(draft),
    },
    (value) => decodeUpdatedStudentProfile(value, studentId),
  );
}

export function updateGuardianProfile(
  guardianId: string,
  draft: GuardianProfileDraft,
  idempotencyKey: string,
): Promise<UpdatedGuardianProfile> {
  assertUuid(guardianId, "guardianId");
  if (Object.keys(validateGuardianProfileDraft(draft)).length > 0) {
    throw new TypeError("Invalid Guardian profile draft.");
  }
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/guardians/${guardianId}`,
      method: "PATCH",
      headers: { "idempotency-key": idempotencyKey },
      body: normalizeGuardianProfileDraft(draft),
    },
    (value) => decodeUpdatedGuardianProfile(value, guardianId),
  );
}

export function requestPendingDeletion(
  entityType: DeletionEntityType,
  entityId: string,
  expectedRecordVersion: number,
  idempotencyKey: string,
): Promise<PendingDeletionReceipt> {
  assertDeletionEntityType(entityType);
  assertUuid(entityId, "entityId");
  assertPositiveInteger(expectedRecordVersion, "expectedRecordVersion");
  assertIdempotencyKey(idempotencyKey);
  const collection = entityType === "student" ? "students" : "guardians";
  return requestApi(
    {
      path: `/api/v1/${collection}/${entityId}/deletion-requests`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        expected_record_version: expectedRecordVersion,
        reason_code: PENDING_DELETION_REASON_CODE,
      },
    },
    (value) => decodePendingDeletionReceipt(value, entityType, entityId),
  );
}

export function listPendingDeletionRequests(
  entityType?: DeletionEntityType,
  signal?: AbortSignal,
): Promise<readonly PendingDeletionSummary[]> {
  if (entityType !== undefined) assertDeletionEntityType(entityType);
  const query = entityType === undefined ? "" : `?entity_type=${entityType}`;
  return requestApi(
    { path: `/api/v1/crm/deletion-requests${query}`, signal },
    decodePendingDeletionSummaries,
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

export function precheckPotentialDuplicates(
  input: {
    readonly kind: "student" | "guardian";
    readonly name: string;
    readonly email: string | null;
    readonly phone: string | null;
  },
  signal?: AbortSignal,
): Promise<PotentialDuplicateResult> {
  if (input.kind !== "student" && input.kind !== "guardian") {
    throw new TypeError("Invalid duplicate check kind.");
  }
  return requestApi(
    {
      path: "/api/v1/crm/potential-duplicates",
      method: "POST",
      body: {
        kind: input.kind,
        name: input.name.trim(),
        email: input.email?.trim() || null,
        phone: input.phone?.trim() || null,
      },
      signal,
    },
    decodePotentialDuplicateResult,
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

export function searchDuplicateRecords(
  entityType: DuplicateEntityType,
  query: string,
  signal?: AbortSignal,
): Promise<readonly DuplicateRecordSearchResult[]> {
  assertDuplicateEntityType(entityType);
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 2 || normalizedQuery.length > 100) {
    throw new TypeError("Invalid duplicate record search query.");
  }
  return requestApi(
    {
      path: "/api/v1/crm/duplicate-records/search",
      method: "POST",
      body: { entity_type: entityType, query: normalizedQuery },
      signal,
    },
    (value) => decodeDuplicateSearchResults(value, entityType),
  );
}

export function listDuplicateCandidates(
  entityType: DuplicateEntityType,
  status: DuplicateCandidateFilterStatus,
  signal?: AbortSignal,
): Promise<readonly DuplicateCandidateSummary[]> {
  assertDuplicateEntityType(entityType);
  if (status !== "review_required" && status !== "merged") {
    throw new TypeError("Invalid duplicate candidate status filter.");
  }
  return requestApi(
    {
      path: `/api/v1/crm/duplicate-candidates?entity_type=${entityType}&status=${status}`,
      signal,
    },
    (value) => decodeDuplicateCandidateList(value, entityType, status),
  );
}

export function createDuplicateCandidate(
  entityType: DuplicateEntityType,
  leftRecordId: string,
  rightRecordId: string,
  idempotencyKey: string,
): Promise<DuplicateCandidateSummary> {
  assertDuplicateEntityType(entityType);
  assertUuid(leftRecordId, "leftRecordId");
  assertUuid(rightRecordId, "rightRecordId");
  if (leftRecordId === rightRecordId) throw new TypeError("Duplicate candidate records must differ.");
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: "/api/v1/crm/duplicate-candidates",
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        entity_type: entityType,
        left_record_id: leftRecordId,
        right_record_id: rightRecordId,
      },
    },
    (value) => decodeDuplicateCandidateSummary(value, entityType),
  );
}

export function getDuplicateCandidate(
  candidateId: string,
  signal?: AbortSignal,
): Promise<DuplicateCandidateDetail> {
  assertUuid(candidateId, "candidateId");
  return requestApi(
    { path: `/api/v1/crm/duplicate-candidates/${candidateId}`, signal },
    (value) => decodeDuplicateCandidateDetail(value, candidateId),
  );
}

export function mergeDuplicateCandidate(
  candidateId: string,
  entityType: DuplicateEntityType,
  draft: DuplicateMergeDraft,
  supportedFields: readonly DuplicateSupportedField[],
  idempotencyKey: string,
): Promise<DuplicateMergeReceipt> {
  assertUuid(candidateId, "candidateId");
  assertDuplicateEntityType(entityType);
  validateDuplicateMergeDraft(entityType, draft, supportedFields);
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/crm/duplicate-candidates/${candidateId}/merges`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        source_record_id: draft.source_record_id,
        canonical_record_id: draft.canonical_record_id,
        expected_candidate_record_version: draft.expected_candidate_record_version,
        expected_source_record_version: draft.expected_source_record_version,
        expected_canonical_record_version: draft.expected_canonical_record_version,
        field_selections: draft.field_selections.map((selection) => ({
          field_name: selection.field_name,
          source_record_id: selection.source_record_id,
        })),
        reason_code: "duplicate.confirmed",
      },
    },
    (value) => decodeDuplicateMergeReceipt(value, candidateId, entityType, draft),
  );
}

export function correctDuplicateMerge(
  mergeId: string,
  expectedMergeRecordVersion: number,
  idempotencyKey: string,
): Promise<DuplicateCorrectionReceipt> {
  assertUuid(mergeId, "mergeId");
  assertPositiveInteger(expectedMergeRecordVersion, "expectedMergeRecordVersion");
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/crm/duplicate-merges/${mergeId}/corrections`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        expected_merge_record_version: expectedMergeRecordVersion,
        reason_code: "duplicate.merge.corrected",
      },
    },
    (value) => decodeDuplicateCorrectionReceipt(value, mergeId),
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
  const existingGuardianId = draft.primary_guardian.existing_guardian_id?.trim() ?? "";
  if (existingGuardianId) {
    if (!UUID.test(existingGuardianId)) errors.guardianSelection = "請重新選擇有效的已有監護人。";
  } else {
    if (!draft.primary_guardian.display_name.trim()) {
      errors.guardianDisplayName = "請輸入主要監護人姓名。";
    }
    if (draft.primary_guardian.email && !isValidEmail(draft.primary_guardian.email)) {
      errors.guardianEmail = "請輸入有效的監護人 Email。";
    }
    if (!draft.primary_guardian.email.trim() && !draft.primary_guardian.phone.trim()) {
      errors.guardianContact = "監護人 Email 和電話至少填寫一項。";
    }
  }
  return Object.freeze(errors);
}

export function validateStudentProfileDraft(draft: StudentProfileDraft): ProfileValidation {
  const errors: Record<string, string> = {};
  const displayName = draft.display_name.trim();
  const email = draft.contact_email.trim();
  const phone = draft.contact_phone.trim();
  if (displayName.length < 1 || displayName.length > 512) {
    errors.displayName = "學生姓名必須為 1 至 512 個字元。";
  }
  if (draft.date_of_birth && !isValidDate(draft.date_of_birth)) {
    errors.dateOfBirth = "請輸入有效的出生日期。";
  }
  if (email && (email.length > 320 || !isValidEmail(email))) {
    errors.email = "請輸入有效的學生 Email。";
  }
  if (phone.length > 64) errors.phone = "學生電話不可超過 64 個字元。";
  if (!Number.isSafeInteger(draft.expected_record_version) || draft.expected_record_version < 1) {
    throw new TypeError("Invalid Student profile record version.");
  }
  return Object.freeze(errors);
}

export function validateGuardianProfileDraft(draft: GuardianProfileDraft): ProfileValidation {
  const errors: Record<string, string> = {};
  const displayName = draft.display_name.trim();
  const email = draft.email.trim();
  const phone = draft.phone.trim();
  if (displayName.length < 1 || displayName.length > 512) {
    errors.displayName = "監護人姓名必須為 1 至 512 個字元。";
  }
  if (email && (email.length > 320 || !isValidEmail(email))) {
    errors.email = "請輸入有效的監護人 Email。";
  }
  if (phone.length > 64) errors.phone = "監護人電話不可超過 64 個字元。";
  if (!email && !phone) errors.contact = "監護人 Email 和電話至少填寫一項。";
  if (!Number.isSafeInteger(draft.expected_record_version) || draft.expected_record_version < 1) {
    throw new TypeError("Invalid Guardian profile record version.");
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

export function classifyProfileMaintenanceFailure(
  error: unknown,
): ProfileMaintenanceFailureKind {
  if (error instanceof ApiClientError && error.code === "STALE_VERSION") return "stale";
  return classifyStudentRequestFailure(error);
}

export function classifyDuplicateRequestFailure(error: unknown): DuplicateRequestFailureKind {
  if (!(error instanceof ApiClientError)) return "unavailable";
  if (error.code === "UNAUTHENTICATED" || error.status === 401) return "unauthenticated";
  if (error.code === "FORBIDDEN" || error.status === 403) return "forbidden";
  if (error.code === "NOT_FOUND" || error.status === 404) return "not_found";
  if (error.code === "VALIDATION_FAILED" || error.status === 422) return "validation";
  if (error.code === "STALE_VERSION" && error.status === 409) return "stale";
  if (error.code === "CONFLICT" && error.status === 409) return "conflict";
  return "unavailable";
}

export function classifyPendingDeletionFailure(error: unknown): PendingDeletionFailureKind {
  if (!(error instanceof ApiClientError)) return "unavailable";
  if (error.code === "UNAUTHENTICATED" || error.status === 401) return "unauthenticated";
  if (error.code === "FORBIDDEN" || error.status === 403) return "forbidden";
  if (error.code === "NOT_FOUND" || error.status === 404) return "not_found";
  if (error.code === "VALIDATION_FAILED" || error.status === 422) return "validation";
  if (error.code === "STALE_VERSION" && error.status === 409) return "stale";
  if (error.code === "CONFLICT" && error.status === 409) return "conflict";
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

/** Owns one key for one profile Save attempt and its uncertain retries. */
export class ProfileUpdateIdempotencyAttempt {
  private readonly operation: "student" | "guardian";
  private readonly createKey: () => string;
  private key: string | null = null;

  constructor(
    operation: "student" | "guardian",
    createKey: () => string = () => `${operation}-profile:${globalThis.crypto.randomUUID()}`,
  ) {
    this.operation = operation;
    this.createKey = createKey;
  }

  keyForSubmission(): string {
    if (this.key === null) {
      const nextKey = this.createKey();
      assertIdempotencyKey(nextKey);
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

  operationName(): "student" | "guardian" {
    return this.operation;
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

/** Keeps one opaque key for one logical duplicate command and uncertain retries. */
export class DuplicateMutationIdempotencyAttempt {
  private readonly operation: "candidate" | "merge" | "correction";
  private readonly createKey: () => string;
  private fingerprint: string | null = null;
  private key: string | null = null;

  constructor(
    operation: "candidate" | "merge" | "correction",
    createKey: () => string = () => `duplicate-${operation}:${globalThis.crypto.randomUUID()}`,
  ) {
    this.operation = operation;
    this.createKey = createKey;
  }

  keyFor(fingerprint: string): string {
    if (!fingerprint || fingerprint.length > 2_048) throw new TypeError("Invalid duplicate command fingerprint.");
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

  operationName(): "candidate" | "merge" | "correction" {
    return this.operation;
  }
}

/** Keeps one key for one lifecycle request and its uncertain retries. */
export class PendingDeletionIdempotencyAttempt {
  private readonly createKey: () => string;
  private fingerprint: string | null = null;
  private key: string | null = null;

  constructor(
    createKey: () => string = () => `pending-deletion:${globalThis.crypto.randomUUID()}`,
  ) {
    this.createKey = createKey;
  }

  keyFor(fingerprint: string): string {
    if (!fingerprint || fingerprint.length > 256) throw new TypeError("Invalid deletion fingerprint.");
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
}

export function pendingDeletionFingerprint(
  entityType: DeletionEntityType,
  entityId: string,
  expectedRecordVersion: number,
): string {
  assertDeletionEntityType(entityType);
  assertUuid(entityId, "entityId");
  assertPositiveInteger(expectedRecordVersion, "expectedRecordVersion");
  return `${entityType}:${entityId}:${expectedRecordVersion}`;
}

export function duplicateCandidateFingerprint(
  entityType: DuplicateEntityType,
  leftRecordId: string,
  rightRecordId: string,
): string {
  assertDuplicateEntityType(entityType);
  assertUuid(leftRecordId, "leftRecordId");
  assertUuid(rightRecordId, "rightRecordId");
  if (leftRecordId === rightRecordId) throw new TypeError("Duplicate candidate records must differ.");
  return `${entityType}:${leftRecordId}:${rightRecordId}`;
}

export function duplicateMergeFingerprint(
  entityType: DuplicateEntityType,
  draft: DuplicateMergeDraft,
  supportedFields: readonly DuplicateSupportedField[],
): string {
  validateDuplicateMergeDraft(entityType, draft, supportedFields);
  return JSON.stringify({
    entity_type: entityType,
    ...draft,
    field_selections: draft.field_selections.map((selection) => ({ ...selection })),
  });
}

export function duplicateCorrectionFingerprint(mergeId: string, recordVersion: number): string {
  assertUuid(mergeId, "mergeId");
  assertPositiveInteger(recordVersion, "recordVersion");
  return `${mergeId}:${recordVersion}`;
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

function normalizeStudentCreateDraft(draft: StudentCreateDraft): ApiRequestBody {
  const existingGuardianId = draft.primary_guardian.existing_guardian_id?.trim() || null;
  return {
    student: {
      display_name: draft.student.display_name.trim(),
      date_of_birth: nullable(draft.student.date_of_birth),
      gender: draft.student.gender || null,
      contact_email: nullable(draft.student.contact_email),
      contact_phone: nullable(draft.student.contact_phone),
    },
    primary_guardian: existingGuardianId
      ? {
          kind: "existing" as const,
          guardian_id: existingGuardianId,
          relationship_type: draft.primary_guardian.relationship_type,
          relationship_description: nullable(draft.primary_guardian.relationship_description),
          is_legal_guardian: draft.primary_guardian.is_legal_guardian,
          is_emergency_contact: draft.primary_guardian.is_emergency_contact,
          is_billing_contact: draft.primary_guardian.is_billing_contact,
          notification_consent: draft.primary_guardian.notification_consent,
        }
      : {
          kind: "new" as const,
          display_name: draft.primary_guardian.display_name.trim(),
          email: nullable(draft.primary_guardian.email),
          phone: nullable(draft.primary_guardian.phone),
          date_of_birth: nullable(draft.primary_guardian.date_of_birth),
          gender: draft.primary_guardian.gender || null,
          relationship_type: draft.primary_guardian.relationship_type,
          relationship_description: nullable(draft.primary_guardian.relationship_description),
          is_legal_guardian: draft.primary_guardian.is_legal_guardian,
          is_emergency_contact: draft.primary_guardian.is_emergency_contact,
          is_billing_contact: draft.primary_guardian.is_billing_contact,
          notification_consent: draft.primary_guardian.notification_consent,
          ...(draft.primary_guardian.warning_token ? { warning_token: draft.primary_guardian.warning_token } : {}),
        },
  } as ApiRequestBody;
}

function normalizeStudentProfileDraft(draft: StudentProfileDraft) {
  const email = nullable(draft.contact_email);
  return {
    display_name: draft.display_name.trim(),
    date_of_birth: nullable(draft.date_of_birth),
    gender: draft.gender || null,
    contact_email: email?.toLowerCase() ?? null,
    contact_phone: nullable(draft.contact_phone),
    expected_record_version: draft.expected_record_version,
  } as const;
}

function normalizeGuardianProfileDraft(draft: GuardianProfileDraft) {
  const email = nullable(draft.email);
  return {
    display_name: draft.display_name.trim(),
    email: email?.toLowerCase() ?? null,
    phone: nullable(draft.phone),
    date_of_birth: nullable(draft.date_of_birth),
    gender: draft.gender || null,
    expected_record_version: draft.expected_record_version,
  } as const;
}

function decodeReferralSourceList(
  value: unknown,
  expectedStatus?: ReferralSourceStatus,
): ReferralSourceListResult {
  const outer = exactRecord(value, ["items", "next_cursor"]);
  const sources = expectArray(outer.items, decodeReferralSource);
  const nextCursor = expectNullableString(outer.next_cursor);
  if (nextCursor !== null && !/^rs_v1_[A-Za-z0-9_-]+$/.test(nextCursor)) {
    throw new TypeError("Invalid ReferralSource next_cursor.");
  }
  if (sources.length > 100) throw new TypeError("Too many ReferralSource records.");
  assertUnique(sources.map(({ id }) => id), "ReferralSource.id");
  if (expectedStatus !== undefined && sources.some(({ status }) => status !== expectedStatus)) {
    throw new TypeError("ReferralSource status filter mismatch.");
  }
  for (let index = 1; index < sources.length; index += 1) {
    const previous = sources[index - 1];
    const current = sources[index];
    if (!previous || !current || compareReferralSources(previous, current) > 0) {
      throw new TypeError("Invalid ReferralSource order.");
    }
  }
  return Object.freeze({ items: Object.freeze([...sources]), next_cursor: nextCursor });
}

function decodeReferralSource(value: unknown): ReferralSource {
  const record = exactRecord(value, [
    "id",
    "display_name",
    "source_type",
    "description",
    "status",
    "record_version",
    "updated_at",
  ]);
  return Object.freeze({
    id: uuid(record.id, "ReferralSource.id"),
    display_name: referralSourceDisplayName(record.display_name),
    source_type: referralSourceType(record.source_type, "ReferralSource.source_type"),
    description: nullableNonEmptyString(record.description, "ReferralSource.description"),
    status: referralSourceStatus(record.status, "ReferralSource.status"),
    record_version: positiveInteger(record.record_version, "ReferralSource.record_version"),
    updated_at: isoDateTime(record.updated_at, "ReferralSource.updated_at"),
  });
}

function decodeReferralSourceWriteReceipt(
  value: unknown,
  expectedId: string | undefined,
  expectedVersion: number,
): ReferralSourceWriteReceipt {
  const outer = exactRecord(value, ["referral_source"]);
  const record = exactRecord(outer.referral_source, ["id", "status", "record_version", "updated_at"]);
  const id = uuid(record.id, "ReferralSource receipt.id");
  const status = referralSourceStatus(record.status, "ReferralSource receipt.status");
  const recordVersion = positiveInteger(
    record.record_version,
    "ReferralSource receipt.record_version",
  );
  const updatedAt = isoDateTime(record.updated_at, "ReferralSource receipt.updated_at");
  if ((expectedId !== undefined && id !== expectedId) || recordVersion !== expectedVersion) {
    throw new TypeError("Mismatched ReferralSource receipt.");
  }
  return Object.freeze({ referral_source: Object.freeze({ id, status, record_version: recordVersion, updated_at: updatedAt }) });
}

function normalizeReferralSourceCreate(input: CreateReferralSourceInput) {
  const sourceType = referralSourceType(input.source_type, "source_type");
  const description = nullableNonEmptyString(input.description, "description");
  if ((sourceType === "other") !== (description !== null)) {
    throw new TypeError("Invalid ReferralSource description.");
  }
  return Object.freeze({
    display_name: referralSourceDisplayName(input.display_name),
    source_type: sourceType,
    description,
  });
}

function normalizeReferralSourceUpdate(input: UpdateReferralSourceInput) {
  assertPositiveInteger(input.expected_record_version, "expected_record_version");
  const description = nullableNonEmptyString(input.description, "description");
  const sourceType = referralSourceType(input.source_type, "source_type");
  if ((sourceType === "other") !== (description !== null)) {
    throw new TypeError("Invalid ReferralSource description.");
  }
  return Object.freeze({
    expected_record_version: input.expected_record_version,
    display_name: referralSourceDisplayName(input.display_name),
    description,
    source_type: sourceType,
  });
}

function referralSourceDisplayName(value: unknown): string {
  const result = expectString(value);
  if (result !== result.trim() || result.length < 1 || result.length > 200) {
    throw new TypeError("Invalid ReferralSource display_name.");
  }
  return result;
}

function referralSourceType(value: unknown, field: string): ReferralSourceType {
  const result = expectString(value);
  if (!(REFERRAL_SOURCE_TYPES as readonly string[]).includes(result)) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return result as ReferralSourceType;
}

function referralSourceStatus(value: unknown, field: string): ReferralSourceStatus {
  const result = expectString(value);
  assertReferralSourceStatus(result, field);
  return result;
}

function assertReferralSourceStatus(
  value: string,
  field: string,
): asserts value is ReferralSourceStatus {
  if (!(REFERRAL_SOURCE_STATUSES as readonly string[]).includes(value)) {
    throw new TypeError(`Invalid ${field}.`);
  }
}

function compareReferralSources(left: ReferralSource, right: ReferralSource): number {
  if (left.display_name !== right.display_name) return left.display_name < right.display_name ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function decodeStudentListItem(value: unknown): StudentListItem {
  const record = exactRecord(value, [
    "id",
    "displayName",
    "dateOfBirth",
    "gender",
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
    gender: nullableGender(record.gender),
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
    "gender",
    "status",
    "primaryGuardianName",
    "updatedAt",
    "contactEmail",
    "contactPhone",
    "recordVersion",
    "guardians",
  ]);
  const base = decodeStudentListItem(Object.fromEntries(
    ["id", "displayName", "dateOfBirth", "gender", "status", "primaryGuardianName", "updatedAt"]
      .map((key) => [key, record[key]]),
  ));
  const guardians = expectArray(record.guardians, decodeGuardian);
  assertUnique(guardians.map(({ id }) => id), "guardian.id");
  return Object.freeze({
    ...base,
    contactEmail: nullableNonEmptyString(record.contactEmail, "contactEmail"),
    contactPhone: nullableNonEmptyString(record.contactPhone, "contactPhone"),
    recordVersion: positiveInteger(record.recordVersion, "recordVersion"),
    guardians: Object.freeze([...guardians]),
  });
}

function decodePotentialDuplicateResult(value: unknown): PotentialDuplicateResult {
  const record = exactRecord(value, ["warnings", "warning_token"]);
  const warnings = expectArray(record.warnings, (candidate) => {
    const item = exactRecord(candidate, [
      "id", "matching_fields", "display_name_hint", "email_hint", "phone_hint",
    ]);
    const matchingFields = expectArray(item.matching_fields, (field) => {
      if (field !== "display_name" && field !== "email" && field !== "phone") {
        throw new TypeError("Invalid duplicate matching field.");
      }
      return field;
    });
    return Object.freeze({
      id: uuid(item.id, "duplicate.id"),
      matching_fields: Object.freeze([...matchingFields]),
      display_name_hint: nullableNonEmptyString(item.display_name_hint, "display_name_hint"),
      email_hint: nullableNonEmptyString(item.email_hint, "email_hint"),
      phone_hint: nullableNonEmptyString(item.phone_hint, "phone_hint"),
    });
  });
  const warningToken = nullableNonEmptyString(record.warning_token, "warning_token");
  assertUnique(warnings.map(({ id }) => id), "duplicate.id");
  return Object.freeze({
    warnings: Object.freeze([...warnings]),
    warning_token: warningToken,
  });
}

function decodeGuardian(value: unknown): StudentGuardianItem {
  const record = exactRecord(value, [
    "id",
    "displayName",
    "email",
    "phone",
    "dateOfBirth",
    "gender",
    "status",
    "recordVersion",
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
    dateOfBirth: nullableDate(record.dateOfBirth),
    gender: nullableGender(record.gender),
    status: studentStatus(record.status, "guardian.status"),
    recordVersion: positiveInteger(record.recordVersion, "guardian.recordVersion"),
    relationshipType: nonEmptyString(record.relationshipType, "guardian.relationshipType"),
    isLegalGuardian: expectBoolean(record.isLegalGuardian),
    isPrimaryContact: expectBoolean(record.isPrimaryContact),
    isEmergencyContact: expectBoolean(record.isEmergencyContact),
    isBillingContact: expectBoolean(record.isBillingContact),
    notificationConsent: expectBoolean(record.notificationConsent),
  });
}

function decodePendingDeletionReceipt(
  value: unknown,
  expectedEntityType?: DeletionEntityType,
  expectedEntityId?: string,
): PendingDeletionReceipt {
  const record = exactRecord(value, [
    "entity_type",
    "entity_id",
    "status",
    "deletion_requested_at",
    "record_version",
  ]);
  const entityType = deletionEntityType(record.entity_type, "entity_type");
  const entityId = uuid(record.entity_id, "entity_id");
  if (expectedEntityType !== undefined && entityType !== expectedEntityType) {
    throw new TypeError("Mismatched deletion entity_type.");
  }
  if (expectedEntityId !== undefined && entityId !== expectedEntityId) {
    throw new TypeError("Mismatched deletion entity_id.");
  }
  if (expectString(record.status) !== "pending_delete") {
    throw new TypeError("Invalid deletion status.");
  }
  return Object.freeze({
    entity_type: entityType,
    entity_id: entityId,
    status: "pending_delete",
    deletion_requested_at: isoDateTime(record.deletion_requested_at, "deletion_requested_at"),
    record_version: positiveInteger(record.record_version, "record_version"),
  });
}

function decodePendingDeletionSummaries(value: unknown): readonly PendingDeletionSummary[] {
  const items = expectArray(value, (item) => {
    const record = exactRecord(item, [
      "entity_type",
      "entity_id",
      "display_label",
      "status",
      "deletion_requested_at",
      "record_version",
    ]);
    const receipt = decodePendingDeletionReceipt(Object.fromEntries(
      ["entity_type", "entity_id", "status", "deletion_requested_at", "record_version"]
        .map((key) => [key, record[key]]),
    ));
    return Object.freeze({
      ...receipt,
      display_label: nonEmptyString(record.display_label, "display_label"),
    });
  });
  if (items.length > 100) throw new TypeError("Too many deletion request summaries.");
  assertUnique(items.map(({ entity_type, entity_id }) => `${entity_type}:${entity_id}`), "deletion request");
  for (let index = 1; index < items.length; index += 1) {
    const prior = items[index - 1]!;
    const current = items[index]!;
    const priorTime = Date.parse(prior.deletion_requested_at);
    const currentTime = Date.parse(current.deletion_requested_at);
    if (priorTime < currentTime || (priorTime === currentTime && prior.entity_id > current.entity_id)) {
      throw new TypeError("Invalid deletion request order.");
    }
  }
  return Object.freeze([...items]);
}

function decodeUpdatedStudentProfile(value: unknown, expectedId: string): UpdatedStudentProfile {
  const envelope = exactRecord(value, ["student"]);
  const record = exactRecord(envelope.student, ["id", "record_version", "updated_at"]);
  const id = uuid(record.id, "student.id");
  if (id !== expectedId) throw new TypeError("Mismatched student.id.");
  return Object.freeze({
    id,
    record_version: positiveInteger(record.record_version, "student.record_version"),
    updated_at: isoDateTime(record.updated_at, "student.updated_at"),
  });
}

function decodeUpdatedGuardianProfile(value: unknown, expectedId: string): UpdatedGuardianProfile {
  const envelope = exactRecord(value, ["guardian"]);
  const record = exactRecord(envelope.guardian, ["id", "record_version", "updated_at"]);
  const id = uuid(record.id, "guardian.id");
  if (id !== expectedId) throw new TypeError("Mismatched guardian.id.");
  return Object.freeze({
    id,
    record_version: positiveInteger(record.record_version, "guardian.record_version"),
    updated_at: isoDateTime(record.updated_at, "guardian.updated_at"),
  });
}

function decodeCreatedStudentAggregate(value: unknown): CreatedStudentAggregate {
  const record = exactRecord(value, ["student", "primary_guardian", "relationship"]);
  const student = exactRecord(record.student, ["id", "record_version"]);
  const guardian = exactRecord(record.primary_guardian, ["id", "record_version"]);
  const relationship = exactRecord(record.relationship, ["id", "record_version"]);
  return Object.freeze({
    student: Object.freeze({
      id: uuid(student.id, "student.id"),
      record_version: positiveInteger(student.record_version, "student.record_version"),
    }),
    primary_guardian: Object.freeze({
      id: uuid(guardian.id, "primary_guardian.id"),
      record_version: positiveInteger(guardian.record_version, "primary_guardian.record_version"),
    }),
    relationship: Object.freeze({
      id: uuid(relationship.id, "relationship.id"),
      record_version: positiveInteger(relationship.record_version, "relationship.record_version"),
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
    "relationship_description",
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
    relationship_description: nullableNonEmptyString(record.relationship_description,
      "relationship_description"),
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
    "relationship_description",
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
    relationship_description: nullableNonEmptyString(record.relationship_description,
      "relationship_description"),
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

const STUDENT_DUPLICATE_SIGNALS = Object.freeze([
  "display_name",
  "date_of_birth",
  "email",
  "phone",
] as const satisfies readonly DuplicateSignalName[]);
const GUARDIAN_DUPLICATE_SIGNALS = Object.freeze([
  "display_name",
  "email",
  "phone",
] as const satisfies readonly DuplicateSignalName[]);
const STUDENT_DUPLICATE_FIELDS = Object.freeze([
  "display_name",
  "date_of_birth",
  "contact_email",
  "contact_phone",
] as const satisfies readonly DuplicateSupportedField[]);
const GUARDIAN_DUPLICATE_FIELDS = Object.freeze([
  "display_name",
  "email",
  "phone",
] as const satisfies readonly DuplicateSupportedField[]);

function decodeDuplicateSearchResults(
  value: unknown,
  expectedEntityType: DuplicateEntityType,
): readonly DuplicateRecordSearchResult[] {
  const results = expectArray(value, (item) => {
    const record = exactRecord(item, ["id", "entity_type", "display_label", "contact_hint"]);
    const entityType = duplicateEntityType(record.entity_type, "entity_type");
    if (entityType !== expectedEntityType) throw new TypeError("Mismatched duplicate search entity_type.");
    return Object.freeze({
      id: uuid(record.id, "search.id"),
      entity_type: entityType,
      display_label: nonEmptyString(record.display_label, "search.display_label"),
      contact_hint: maskedHint(record.contact_hint, "search.contact_hint"),
    });
  });
  if (results.length > 20) throw new TypeError("Too many duplicate record search results.");
  assertUnique(results.map(({ id }) => id), "search.id");
  return Object.freeze([...results]);
}

function decodeDuplicateCandidateList(
  value: unknown,
  expectedEntityType: DuplicateEntityType,
  expectedStatus: DuplicateCandidateFilterStatus,
): readonly DuplicateCandidateSummary[] {
  const candidates = expectArray(value, (item) => {
    const candidate = decodeDuplicateCandidateSummary(item, expectedEntityType);
    if (candidate.status !== expectedStatus) throw new TypeError("Mismatched duplicate candidate status.");
    return candidate;
  });
  if (candidates.length > 100) throw new TypeError("Too many duplicate candidates.");
  assertUnique(candidates.map(({ id }) => id), "candidate.id");
  return Object.freeze([...candidates]);
}

function decodeDuplicateCandidateSummary(
  value: unknown,
  expectedEntityType?: DuplicateEntityType,
): DuplicateCandidateSummary {
  const record = exactRecord(value, [
    "id",
    "entity_type",
    "left_record",
    "right_record",
    "matching_signals",
    "status",
    "merge_id",
    "record_version",
  ]);
  const entityType = duplicateEntityType(record.entity_type, "candidate.entity_type");
  if (expectedEntityType !== undefined && entityType !== expectedEntityType) {
    throw new TypeError("Mismatched candidate.entity_type.");
  }
  const leftRecord = decodeDuplicateRecordLabel(record.left_record, "left_record");
  const rightRecord = decodeDuplicateRecordLabel(record.right_record, "right_record");
  if (leftRecord.id === rightRecord.id) throw new TypeError("Duplicate candidate pair must differ.");
  const signals = expectArray(record.matching_signals, (signal) => {
    const result = expectString(signal);
    if (!duplicateSignalsFor(entityType).includes(result as DuplicateSignalName)) {
      throw new TypeError("Invalid candidate.matching_signals.");
    }
    return result as DuplicateSignalName;
  });
  if (signals.length < 1) throw new TypeError("Missing candidate.matching_signals.");
  assertCanonicalSubset(signals, duplicateSignalsFor(entityType), "candidate.matching_signals");
  const status = duplicateCandidateStatus(record.status);
  const mergeId = record.merge_id === null ? null : uuid(record.merge_id, "candidate.merge_id");
  if ((status === "merged") !== (mergeId !== null)) {
    throw new TypeError("Invalid candidate merge state.");
  }
  return Object.freeze({
    id: uuid(record.id, "candidate.id"),
    entity_type: entityType,
    left_record: leftRecord,
    right_record: rightRecord,
    matching_signals: Object.freeze([...signals]),
    status,
    merge_id: mergeId,
    record_version: positiveInteger(record.record_version, "candidate.record_version"),
  });
}

function decodeDuplicateRecordLabel(value: unknown, field: string): DuplicateCandidateRecordLabel {
  const record = exactRecord(value, ["id", "display_label"]);
  return Object.freeze({
    id: uuid(record.id, `${field}.id`),
    display_label: nonEmptyString(record.display_label, `${field}.display_label`),
  });
}

function decodeDuplicateCandidateDetail(value: unknown, expectedCandidateId: string): DuplicateCandidateDetail {
  const record = exactRecord(value, [
    "candidate",
    "left_profile",
    "right_profile",
    "supported_fields",
    "merge",
  ]);
  const candidate = decodeDuplicateCandidateSummary(record.candidate);
  if (candidate.id !== expectedCandidateId) throw new TypeError("Mismatched candidate.id.");
  const supportedFields = expectArray(record.supported_fields, (field) => expectString(field) as DuplicateSupportedField);
  const canonicalFields = duplicateFieldsFor(candidate.entity_type);
  assertExactSequence(supportedFields, canonicalFields, "supported_fields");
  const leftProfile = decodeDuplicateProfile(record.left_profile, candidate.entity_type);
  const rightProfile = decodeDuplicateProfile(record.right_profile, candidate.entity_type);
  if (leftProfile.id !== candidate.left_record.id || rightProfile.id !== candidate.right_record.id) {
    throw new TypeError("Mismatched candidate profile pair.");
  }
  const merge = record.merge === null ? null : decodeDuplicateMergeView(record.merge, candidate);
  if ((candidate.status === "merged") !== (merge !== null)) {
    throw new TypeError("Mismatched candidate detail merge state.");
  }
  return Object.freeze({
    candidate,
    left_profile: leftProfile,
    right_profile: rightProfile,
    supported_fields: Object.freeze([...supportedFields]),
    merge,
  });
}

function decodeDuplicateProfile(value: unknown, entityType: DuplicateEntityType): DuplicateProfile {
  if (entityType === "student") {
    const record = exactRecord(value, [
      "id",
      "display_name",
      "date_of_birth",
      "contact_email",
      "contact_phone",
      "record_version",
    ]);
    return Object.freeze({
      id: uuid(record.id, "student_profile.id"),
      display_name: nonEmptyString(record.display_name, "student_profile.display_name"),
      date_of_birth: nullableDate(record.date_of_birth),
      contact_email: nullableNonEmptyString(record.contact_email, "student_profile.contact_email"),
      contact_phone: nullableNonEmptyString(record.contact_phone, "student_profile.contact_phone"),
      record_version: positiveInteger(record.record_version, "student_profile.record_version"),
    });
  }
  const record = exactRecord(value, ["id", "display_name", "email", "phone", "record_version"]);
  return Object.freeze({
    id: uuid(record.id, "guardian_profile.id"),
    display_name: nonEmptyString(record.display_name, "guardian_profile.display_name"),
    email: nullableNonEmptyString(record.email, "guardian_profile.email"),
    phone: nullableNonEmptyString(record.phone, "guardian_profile.phone"),
    record_version: positiveInteger(record.record_version, "guardian_profile.record_version"),
  });
}

function decodeDuplicateMergeView(
  value: unknown,
  candidate: DuplicateCandidateSummary,
): DuplicateMergeView {
  const record = exactRecord(value, [
    "id",
    "source_record_id",
    "canonical_record_id",
    "provenance_revision_id",
    "status",
    "record_version",
    "correction_id",
  ]);
  const id = uuid(record.id, "merge.id");
  if (id !== candidate.merge_id) throw new TypeError("Mismatched merge.id.");
  const sourceRecordId = uuid(record.source_record_id, "merge.source_record_id");
  const canonicalRecordId = uuid(record.canonical_record_id, "merge.canonical_record_id");
  assertCandidatePair(candidate, sourceRecordId, canonicalRecordId);
  const status = expectString(record.status);
  if (status !== "active" && status !== "corrected") throw new TypeError("Invalid merge.status.");
  const correctionId = record.correction_id === null ? null : uuid(record.correction_id, "merge.correction_id");
  if ((status === "corrected") !== (correctionId !== null)) throw new TypeError("Invalid merge correction state.");
  return Object.freeze({
    id,
    source_record_id: sourceRecordId,
    canonical_record_id: canonicalRecordId,
    provenance_revision_id: uuid(record.provenance_revision_id, "merge.provenance_revision_id"),
    status,
    record_version: positiveInteger(record.record_version, "merge.record_version"),
    correction_id: correctionId,
  });
}

function decodeDuplicateMergeReceipt(
  value: unknown,
  expectedCandidateId: string,
  expectedEntityType: DuplicateEntityType,
  draft: DuplicateMergeDraft,
): DuplicateMergeReceipt {
  const record = exactRecord(value, [
    "merge_id",
    "candidate_id",
    "entity_type",
    "source_record_id",
    "canonical_record_id",
    "provenance_revision_id",
    "record_version",
  ]);
  const candidateId = uuid(record.candidate_id, "receipt.candidate_id");
  const entityType = duplicateEntityType(record.entity_type, "receipt.entity_type");
  const sourceRecordId = uuid(record.source_record_id, "receipt.source_record_id");
  const canonicalRecordId = uuid(record.canonical_record_id, "receipt.canonical_record_id");
  if (
    candidateId !== expectedCandidateId ||
    entityType !== expectedEntityType ||
    sourceRecordId !== draft.source_record_id ||
    canonicalRecordId !== draft.canonical_record_id
  ) {
    throw new TypeError("Mismatched duplicate merge receipt.");
  }
  return Object.freeze({
    merge_id: uuid(record.merge_id, "receipt.merge_id"),
    candidate_id: candidateId,
    entity_type: entityType,
    source_record_id: sourceRecordId,
    canonical_record_id: canonicalRecordId,
    provenance_revision_id: uuid(record.provenance_revision_id, "receipt.provenance_revision_id"),
    record_version: positiveInteger(record.record_version, "receipt.record_version"),
  });
}

function decodeDuplicateCorrectionReceipt(value: unknown, expectedMergeId: string): DuplicateCorrectionReceipt {
  const record = exactRecord(value, [
    "corrective_revision_id",
    "merge_id",
    "source_record_id",
    "canonical_record_id",
    "restored_alias_target_id",
    "record_version",
  ]);
  const mergeId = uuid(record.merge_id, "correction.merge_id");
  if (mergeId !== expectedMergeId) throw new TypeError("Mismatched correction.merge_id.");
  const sourceRecordId = uuid(record.source_record_id, "correction.source_record_id");
  const restoredAliasTargetId = uuid(record.restored_alias_target_id, "correction.restored_alias_target_id");
  if (restoredAliasTargetId !== sourceRecordId) throw new TypeError("Invalid restored alias target.");
  return Object.freeze({
    corrective_revision_id: uuid(record.corrective_revision_id, "correction.corrective_revision_id"),
    merge_id: mergeId,
    source_record_id: sourceRecordId,
    canonical_record_id: uuid(record.canonical_record_id, "correction.canonical_record_id"),
    restored_alias_target_id: restoredAliasTargetId,
    record_version: positiveInteger(record.record_version, "correction.record_version"),
  });
}

function validateDuplicateMergeDraft(
  entityType: DuplicateEntityType,
  draft: DuplicateMergeDraft,
  supportedFields: readonly DuplicateSupportedField[],
): void {
  assertDuplicateEntityType(entityType);
  const canonicalFields = duplicateFieldsFor(entityType);
  assertExactSequence(supportedFields, canonicalFields, "supported_fields");
  assertUuid(draft.source_record_id, "source_record_id");
  assertUuid(draft.canonical_record_id, "canonical_record_id");
  if (draft.source_record_id === draft.canonical_record_id) throw new TypeError("Merge records must differ.");
  assertPositiveInteger(draft.expected_candidate_record_version, "expected_candidate_record_version");
  assertPositiveInteger(draft.expected_source_record_version, "expected_source_record_version");
  assertPositiveInteger(draft.expected_canonical_record_version, "expected_canonical_record_version");
  assertExactSequence(draft.field_selections.map(({ field_name }) => field_name), canonicalFields, "field_selections");
  for (const selection of draft.field_selections) {
    assertUuid(selection.source_record_id, "field_selections.source_record_id");
    if (selection.source_record_id !== draft.source_record_id && selection.source_record_id !== draft.canonical_record_id) {
      throw new TypeError("Invalid field selection record.");
    }
  }
}

function duplicateSignalsFor(entityType: DuplicateEntityType): readonly DuplicateSignalName[] {
  return entityType === "student" ? STUDENT_DUPLICATE_SIGNALS : GUARDIAN_DUPLICATE_SIGNALS;
}

function duplicateFieldsFor(entityType: DuplicateEntityType): readonly DuplicateSupportedField[] {
  return entityType === "student" ? STUDENT_DUPLICATE_FIELDS : GUARDIAN_DUPLICATE_FIELDS;
}

function assertCanonicalSubset<T extends string>(values: readonly T[], canonical: readonly T[], field: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${field}.`);
  let prior = -1;
  for (const value of values) {
    const index = canonical.indexOf(value);
    if (index <= prior) throw new TypeError(`Invalid ${field} order.`);
    prior = index;
  }
}

function assertExactSequence<T extends string>(values: readonly T[], canonical: readonly T[], field: string): void {
  if (values.length !== canonical.length || values.some((value, index) => value !== canonical[index])) {
    throw new TypeError(`Invalid ${field} sequence.`);
  }
}

function assertCandidatePair(
  candidate: DuplicateCandidateSummary,
  sourceRecordId: string,
  canonicalRecordId: string,
): void {
  const pair = new Set([candidate.left_record.id, candidate.right_record.id]);
  if (sourceRecordId === canonicalRecordId || !pair.has(sourceRecordId) || !pair.has(canonicalRecordId)) {
    throw new TypeError("Mismatched duplicate candidate pair.");
  }
}

function assertDuplicateEntityType(value: string): asserts value is DuplicateEntityType {
  if (!(DUPLICATE_ENTITY_TYPES as readonly string[]).includes(value)) {
    throw new TypeError("Invalid duplicate entity type.");
  }
}

function assertDeletionEntityType(value: string): asserts value is DeletionEntityType {
  if (!(DELETION_ENTITY_TYPES as readonly string[]).includes(value)) {
    throw new TypeError("Invalid deletion entity type.");
  }
}

function deletionEntityType(value: unknown, field: string): DeletionEntityType {
  const result = expectString(value);
  assertDeletionEntityType(result);
  if (!(DELETION_ENTITY_TYPES as readonly string[]).includes(result)) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return result as DeletionEntityType;
}

function duplicateEntityType(value: unknown, field: string): DuplicateEntityType {
  const result = expectString(value);
  if (!(DUPLICATE_ENTITY_TYPES as readonly string[]).includes(result)) throw new TypeError(`Invalid ${field}.`);
  return result as DuplicateEntityType;
}

function duplicateCandidateStatus(value: unknown): DuplicateCandidateStatus {
  const result = expectString(value);
  if (!(DUPLICATE_CANDIDATE_STATUSES as readonly string[]).includes(result)) {
    throw new TypeError("Invalid candidate.status.");
  }
  return result as DuplicateCandidateStatus;
}

function studentStatus(value: unknown, field: string): StudentStatus {
  const result = expectString(value);
  if (result !== "active" && result !== "pending_delete") throw new TypeError(`Invalid ${field}.`);
  return result;
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

function nullableGender(value: unknown): CrmGender | null {
  const result = expectNullableString(value);
  if (result !== null && !["male", "female", "other", "not_disclosed"].includes(result)) {
    throw new TypeError("Invalid gender.");
  }
  return result as CrmGender | null;
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
