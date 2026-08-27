import {
  ApiClientError,
  expectArray,
  expectRecord,
  requestApi,
  type ApiRequestBody,
} from "../../lib/api/client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const CANDIDATE_LIST_STATUSES = Object.freeze([
  "draft",
  "submitted",
  "awaiting_guardian",
  "confirmed",
  "returned",
] as const);

export type CandidateListStatus = (typeof CANDIDATE_LIST_STATUSES)[number];
export type FounderDecision = "approved" | "rejected";
export type GuardianDecision = "confirmed" | "not_confirmed";
export type GuardianChannel = "phone" | "wechat" | "in_person";

export interface CandidateListSchoolItem {
  readonly id: string;
  readonly school_id: string;
  readonly pinned_resolved_revision_id: string;
  readonly pinned_resolution_sha256: string;
  readonly ordinal: number;
  readonly application_deadline: string | null;
  readonly school_target_id: string | null;
}

export interface CandidateListFounderApproval {
  readonly decision: FounderDecision;
  readonly decided_by_user_id: string;
  readonly decided_at: string;
  readonly reason: string;
  readonly decision_sha256: string;
}

export interface CandidateListGuardianDecision {
  readonly guardian_id: string;
  readonly guardian_relationship_id: string;
  readonly decision: GuardianDecision;
  readonly decided_at: string;
  readonly channel: GuardianChannel;
  readonly recorded_by_user_id: string;
  readonly recorded_at: string;
  readonly bound_founder_decision_sha256: string;
}

export interface CandidateListVersion {
  readonly id: string;
  readonly version_number: number;
  readonly previous_version_id: string | null;
  readonly school_set_sha256: string;
  readonly status: CandidateListStatus;
  readonly record_version: number;
  readonly change_summary: string;
  readonly created_by_user_id: string;
  readonly created_at: string;
  readonly submitted_at: string | null;
  readonly items: readonly CandidateListSchoolItem[];
  readonly founder_approval: CandidateListFounderApproval | null;
  readonly guardian_decision: CandidateListGuardianDecision | null;
}

export interface CandidateListsView {
  readonly items: readonly CandidateListVersion[];
  readonly next_cursor: string | null;
}

export interface CandidateSchoolOption {
  readonly school_id: string;
  readonly display_name: string;
  readonly resolved_revision_id: string;
  readonly resolution_sha256: string;
}

export interface GuardianConfirmationOption {
  readonly guardian_id: string;
  readonly guardian_relationship_id: string;
  readonly display_name: string;
  readonly relationship_type: string;
  readonly relationship_description: string | null;
  readonly is_legal_guardian: boolean;
  readonly is_primary_contact: boolean;
}

export interface CandidateListReceipt {
  readonly id: string;
  readonly record_version: number;
}

export interface CandidateListReviewReceipt extends CandidateListReceipt {
  readonly founder_decision_sha256: string | null;
}

export interface CandidateListGuardianReceipt extends CandidateListReceipt {
  readonly automation: Readonly<{
    readonly application_tasks: "completed" | "pending";
    readonly requested_count: number;
    readonly provisioned_count: number;
  }>;
}

export interface CreateCandidateListInput {
  readonly previous_version_id: string | null;
  readonly expected_case_record_version: number;
  readonly change_summary: string;
  readonly items: readonly Readonly<{
    school_id: string;
    pinned_resolved_revision_id: string;
    pinned_resolution_sha256: string;
    ordinal: number;
    application_deadline: string;
  }>[];
}

export interface ReviewCandidateListInput {
  readonly decision: FounderDecision;
  readonly expected_record_version: number;
  readonly reason: string;
}

export interface RecordGuardianDecisionInput {
  readonly bound_founder_decision_sha256: string;
  readonly channel: GuardianChannel;
  readonly decision: GuardianDecision;
  readonly expected_case_record_version: number;
  readonly expected_list_record_version: number;
  readonly guardian_decided_at: string;
  readonly guardian_id: string;
  readonly guardian_relationship_id: string;
}

export type CandidateListFailure =
  | "unauthenticated"
  | "denied"
  | "stale"
  | "validation"
  | "conflict"
  | "unavailable";

export function listCandidateLists(
  caseId: string,
  signal?: AbortSignal,
): Promise<CandidateListsView> {
  assertUuid(caseId, "caseId");
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/candidate-lists?limit=100`,
      signal,
    },
    decodeCandidateListsView,
  );
}

export function listCandidateSchoolOptions(signal?: AbortSignal): Promise<readonly CandidateSchoolOption[]> {
  return requestApi(
    { path: "/api/v1/schools/options?limit=100", signal },
    (value) => {
      const root = exactRecord(value, ["items", "next_cursor"]);
      nullableOpaqueCursor(root.next_cursor, "school options next_cursor");
      const items = expectArray(root.items, decodeCandidateSchoolOption);
      assertUnique(items.map(({ school_id }) => school_id), "school option");
      return Object.freeze(items);
    },
  );
}

export function getGuardianConfirmationOptions(
  caseId: string,
  signal?: AbortSignal,
): Promise<readonly GuardianConfirmationOption[]> {
  assertUuid(caseId, "caseId");
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/guardian-confirmation-options`,
      signal,
    },
    (value) => {
      const root = exactRecord(value, ["items"]);
      const items = expectArray(root.items, decodeGuardianConfirmationOption);
      assertUnique(items.map(({ guardian_relationship_id }) => guardian_relationship_id), "guardian relationship");
      return Object.freeze(items);
    },
  );
}

export function createCandidateList(
  caseId: string,
  input: CreateCandidateListInput,
  idempotencyKey: string,
): Promise<CandidateListReceipt> {
  assertUuid(caseId, "caseId");
  assertIdempotencyKey(idempotencyKey);
  validateCreateInput(input);
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/candidate-lists`,
      method: "POST",
      idempotencyKey,
      body: input as unknown as ApiRequestBody,
    },
    decodeCandidateListReceipt,
  );
}

export function reviewCandidateList(
  caseId: string,
  versionId: string,
  input: ReviewCandidateListInput,
  idempotencyKey: string,
): Promise<CandidateListReviewReceipt> {
  assertUuid(caseId, "caseId");
  assertUuid(versionId, "versionId");
  assertIdempotencyKey(idempotencyKey);
  positiveInteger(input.expected_record_version, "expected_record_version");
  if (!(["approved", "rejected"] as readonly unknown[]).includes(input.decision)) {
    throw new TypeError("Invalid Founder decision.");
  }
  boundedText(input.reason, "reason", 1000);
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/candidate-lists/${versionId}/review`,
      method: "POST",
      idempotencyKey,
      body: input as unknown as ApiRequestBody,
    },
    decodeCandidateListReviewReceipt,
  );
}

export function recordGuardianCandidateListDecision(
  caseId: string,
  versionId: string,
  input: RecordGuardianDecisionInput,
  idempotencyKey: string,
): Promise<CandidateListGuardianReceipt> {
  assertUuid(caseId, "caseId");
  assertUuid(versionId, "versionId");
  assertIdempotencyKey(idempotencyKey);
  assertUuid(input.guardian_id, "guardian_id");
  assertUuid(input.guardian_relationship_id, "guardian_relationship_id");
  positiveInteger(input.expected_case_record_version, "expected_case_record_version");
  positiveInteger(input.expected_list_record_version, "expected_list_record_version");
  sha256(input.bound_founder_decision_sha256, "bound_founder_decision_sha256");
  oneOf(input.channel, ["phone", "wechat", "in_person"] as const, "channel");
  oneOf(input.decision, ["confirmed", "not_confirmed"] as const, "decision");
  const decidedAt = isoTimestamp(input.guardian_decided_at, "guardian_decided_at");
  if (Date.parse(decidedAt) > Date.now()) throw new TypeError("Guardian decision cannot be in the future.");
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/candidate-lists/${versionId}/guardian-decision`,
      method: "POST",
      idempotencyKey,
      body: input as unknown as ApiRequestBody,
    },
    decodeCandidateListGuardianReceipt,
  );
}

export function classifyCandidateListFailure(error: unknown): CandidateListFailure {
  if (!(error instanceof ApiClientError)) return "unavailable";
  if (error.code === "UNAUTHENTICATED" || error.status === 401) return "unauthenticated";
  if (error.code === "FORBIDDEN" || error.code === "NOT_FOUND" || error.status === 403 || error.status === 404) {
    return "denied";
  }
  if (error.code === "STALE_VERSION") return "stale";
  if (error.code === "VALIDATION_FAILED" || error.status === 422) return "validation";
  if (error.code === "CONFLICT" || error.status === 409) return "conflict";
  return "unavailable";
}

export class CandidateListIdempotencyAttempt {
  private readonly createKey: () => string;
  private fingerprint: string | null = null;
  private key: string | null = null;

  constructor(createKey: () => string = () => globalThis.crypto.randomUUID()) {
    this.createKey = createKey;
  }

  keyFor(fingerprint: string): string {
    const normalized = fingerprint.trim();
    if (normalized.length < 1) throw new TypeError("Candidate list command fingerprint is required.");
    if (normalized !== this.fingerprint) {
      this.fingerprint = normalized;
      this.key = null;
    }
    if (this.key === null) {
      const nextKey = this.createKey();
      assertIdempotencyKey(nextKey);
      this.key = nextKey;
    }
    return this.key;
  }

  complete(): void {
    this.fingerprint = null;
    this.key = null;
  }
}

function decodeCandidateListsView(value: unknown): CandidateListsView {
  const root = exactRecord(value, ["items", "next_cursor"]);
  const items = expectArray(root.items, decodeCandidateListVersion);
  assertUnique(items.map(({ id }) => id), "candidate list version");
  const ordered = [...items].sort((left, right) => right.version_number - left.version_number);
  if (ordered.some((item, index) => item !== items[index])) {
    throw new TypeError("Candidate list versions are not in canonical order.");
  }
  return Object.freeze({
    items: Object.freeze(items),
    next_cursor: nullableOpaqueCursor(root.next_cursor, "next_cursor"),
  });
}

function decodeCandidateListVersion(value: unknown): CandidateListVersion {
  const record = exactRecord(value, [
    "id",
    "version_number",
    "previous_version_id",
    "school_set_sha256",
    "status",
    "record_version",
    "change_summary",
    "created_by_user_id",
    "created_at",
    "submitted_at",
    "items",
    "founder_approval",
    "guardian_decision",
  ]);
  const items = expectArray(record.items, decodeCandidateListSchoolItem);
  assertUnique(items.map(({ school_id }) => school_id), "candidate school");
  if (items.some((item, index) => item.ordinal !== index + 1)) {
    throw new TypeError("Candidate schools are not in canonical order.");
  }
  const status = oneOf(record.status, CANDIDATE_LIST_STATUSES, "candidate list status");
  const founderApproval = record.founder_approval === null
    ? null
    : decodeCandidateListFounderApproval(record.founder_approval);
  const guardianDecision = record.guardian_decision === null
    ? null
    : decodeCandidateListGuardianDecision(record.guardian_decision);
  if (status === "submitted" && (founderApproval !== null || guardianDecision !== null)) {
    throw new TypeError("Submitted CandidateList has a premature decision.");
  }
  if (status === "awaiting_guardian" && founderApproval?.decision !== "approved") {
    throw new TypeError("Awaiting Guardian CandidateList has no Founder approval.");
  }
  if (status === "confirmed" &&
      (founderApproval?.decision !== "approved" || guardianDecision?.decision !== "confirmed")) {
    throw new TypeError("Confirmed CandidateList has no matching decisions.");
  }
  if (status === "returned" && !(
    (founderApproval?.decision === "rejected" && guardianDecision === null) ||
    (founderApproval?.decision === "approved" && guardianDecision?.decision === "not_confirmed")
  )) {
    throw new TypeError("Returned CandidateList has no matching decision.");
  }
  return Object.freeze({
    id: uuid(record.id, "candidate list id"),
    version_number: positiveInteger(record.version_number, "version_number"),
    previous_version_id: nullableUuid(record.previous_version_id, "previous_version_id"),
    school_set_sha256: sha256(record.school_set_sha256, "school_set_sha256"),
    status,
    record_version: positiveInteger(record.record_version, "record_version"),
    change_summary: boundedText(record.change_summary, "change_summary", 1000),
    created_by_user_id: uuid(record.created_by_user_id, "created_by_user_id"),
    created_at: isoTimestamp(record.created_at, "created_at"),
    submitted_at: nullableTimestamp(record.submitted_at, "submitted_at"),
    items: Object.freeze(items),
    founder_approval: founderApproval,
    guardian_decision: guardianDecision,
  });
}

function decodeCandidateListSchoolItem(value: unknown): CandidateListSchoolItem {
  const record = exactRecord(value, [
    "id",
    "school_id",
    "pinned_resolved_revision_id",
    "pinned_resolution_sha256",
    "ordinal",
    "application_deadline",
    "school_target_id",
  ]);
  return Object.freeze({
    id: uuid(record.id, "candidate item id"),
    school_id: uuid(record.school_id, "school_id"),
    pinned_resolved_revision_id: uuid(record.pinned_resolved_revision_id, "pinned_resolved_revision_id"),
    pinned_resolution_sha256: sha256(record.pinned_resolution_sha256, "pinned_resolution_sha256"),
    ordinal: positiveInteger(record.ordinal, "ordinal"),
    application_deadline: nullableTimestamp(record.application_deadline, "application_deadline"),
    school_target_id: nullableUuid(record.school_target_id, "school_target_id"),
  });
}

function decodeCandidateListFounderApproval(value: unknown): CandidateListFounderApproval {
  const record = exactRecord(value, [
    "decision",
    "decided_by_user_id",
    "decided_at",
    "reason",
    "decision_sha256",
  ]);
  return Object.freeze({
    decision: oneOf(record.decision, ["approved", "rejected"] as const, "Founder decision"),
    decided_by_user_id: uuid(record.decided_by_user_id, "decided_by_user_id"),
    decided_at: isoTimestamp(record.decided_at, "decided_at"),
    reason: boundedText(record.reason, "Founder reason", 1000),
    decision_sha256: sha256(record.decision_sha256, "decision_sha256"),
  });
}

function decodeCandidateListGuardianDecision(value: unknown): CandidateListGuardianDecision {
  const record = exactRecord(value, [
    "guardian_id",
    "guardian_relationship_id",
    "decision",
    "decided_at",
    "channel",
    "recorded_by_user_id",
    "recorded_at",
    "bound_founder_decision_sha256",
  ]);
  return Object.freeze({
    guardian_id: uuid(record.guardian_id, "guardian_id"),
    guardian_relationship_id: uuid(record.guardian_relationship_id, "guardian_relationship_id"),
    decision: oneOf(record.decision, ["confirmed", "not_confirmed"] as const, "Guardian decision"),
    decided_at: isoTimestamp(record.decided_at, "Guardian decided_at"),
    channel: oneOf(record.channel, ["phone", "wechat", "in_person"] as const, "Guardian channel"),
    recorded_by_user_id: uuid(record.recorded_by_user_id, "recorded_by_user_id"),
    recorded_at: isoTimestamp(record.recorded_at, "recorded_at"),
    bound_founder_decision_sha256: sha256(
      record.bound_founder_decision_sha256,
      "bound_founder_decision_sha256",
    ),
  });
}

function decodeCandidateSchoolOption(value: unknown): CandidateSchoolOption {
  const record = exactRecord(value, [
    "school_id",
    "display_name",
    "resolved_revision_id",
    "resolution_sha256",
  ]);
  return Object.freeze({
    school_id: uuid(record.school_id, "school option id"),
    display_name: boundedText(record.display_name, "school display_name", 300),
    resolved_revision_id: uuid(record.resolved_revision_id, "school resolved_revision_id"),
    resolution_sha256: sha256(record.resolution_sha256, "school resolution_sha256"),
  });
}

function decodeGuardianConfirmationOption(value: unknown): GuardianConfirmationOption {
  const record = exactRecord(value, [
    "guardian_id",
    "guardian_relationship_id",
    "display_name",
    "relationship_type",
    "relationship_description",
    "is_legal_guardian",
    "is_primary_contact",
  ]);
  return Object.freeze({
    guardian_id: uuid(record.guardian_id, "guardian_id"),
    guardian_relationship_id: uuid(record.guardian_relationship_id, "guardian_relationship_id"),
    display_name: boundedText(record.display_name, "guardian display_name", 300),
    relationship_type: boundedText(record.relationship_type, "relationship_type", 100),
    relationship_description: nullableBoundedText(
      record.relationship_description,
      "relationship_description",
      500,
    ),
    is_legal_guardian: boolean(record.is_legal_guardian, "is_legal_guardian"),
    is_primary_contact: boolean(record.is_primary_contact, "is_primary_contact"),
  });
}

function decodeCandidateListReceipt(value: unknown): CandidateListReceipt {
  const record = exactRecord(value, ["id", "record_version"]);
  return Object.freeze({
    id: uuid(record.id, "receipt id"),
    record_version: positiveInteger(record.record_version, "receipt record_version"),
  });
}

function decodeCandidateListReviewReceipt(value: unknown): CandidateListReviewReceipt {
  const record = exactRecord(value, ["id", "record_version", "founder_decision_sha256"]);
  return Object.freeze({
    id: uuid(record.id, "receipt id"),
    record_version: positiveInteger(record.record_version, "receipt record_version"),
    founder_decision_sha256: record.founder_decision_sha256 === null
      ? null
      : sha256(record.founder_decision_sha256, "founder_decision_sha256"),
  });
}

function decodeCandidateListGuardianReceipt(value: unknown): CandidateListGuardianReceipt {
  const record = exactRecord(value, ["id", "record_version", "automation"]);
  const automation = exactRecord(record.automation, [
    "application_tasks",
    "requested_count",
    "provisioned_count",
  ]);
  const requestedCount = nonNegativeInteger(
    automation.requested_count,
    "automation.requested_count",
  );
  const provisionedCount = nonNegativeInteger(
    automation.provisioned_count,
    "automation.provisioned_count",
  );
  if (provisionedCount > requestedCount) {
    throw new TypeError("Invalid CandidateList automation counts.");
  }
  return Object.freeze({
    id: uuid(record.id, "receipt id"),
    record_version: positiveInteger(record.record_version, "receipt record_version"),
    automation: Object.freeze({
      application_tasks: oneOf(
        automation.application_tasks,
        ["completed", "pending"] as const,
        "automation.application_tasks",
      ),
      requested_count: requestedCount,
      provisioned_count: provisionedCount,
    }),
  });
}

function validateCreateInput(input: CreateCandidateListInput): void {
  if (input.previous_version_id !== null) assertUuid(input.previous_version_id, "previous_version_id");
  positiveInteger(input.expected_case_record_version, "expected_case_record_version");
  boundedText(input.change_summary, "change_summary", 1000);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) {
    throw new TypeError("Candidate list requires 1 to 50 schools.");
  }
  const schools = new Set<string>();
  input.items.forEach((item, index) => {
    assertUuid(item.school_id, "school_id");
    assertUuid(item.pinned_resolved_revision_id, "pinned_resolved_revision_id");
    sha256(item.pinned_resolution_sha256, "pinned_resolution_sha256");
    isoTimestamp(item.application_deadline, "application_deadline");
    if (item.ordinal !== index + 1 || schools.has(item.school_id)) {
      throw new TypeError("Candidate list schools must be unique and contiguous.");
    }
    schools.add(item.school_id);
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = expectRecord(value);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || expected.some((key, index) => key !== actual[index])) {
    throw new TypeError("Unexpected CandidateList DTO shape.");
  }
  return record;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return value as Values[number];
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`Invalid ${field}.`);
  return value.toLowerCase();
}

function assertUuid(value: string, field: string): void {
  uuid(value, field);
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`Invalid ${field}.`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`Invalid ${field}.`);
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`Invalid ${field}.`);
  return value as number;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > maximum) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return value;
}

function nullableBoundedText(value: unknown, field: string, maximum: number): string | null {
  return value === null ? null : boundedText(value, field, maximum);
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`Invalid ${field}.`);
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : isoTimestamp(value, field);
}

function nullableOpaqueCursor(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${label}.`);
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value)) throw new TypeError("Invalid idempotency key.");
}
