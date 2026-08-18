import {
  ApiClientError,
  expectArray,
  expectBoolean,
  expectNumber,
  expectNullableString,
  expectRecord,
  expectString,
  requestApi,
} from "../../lib/api/client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const CASE_STAGES = Object.freeze([
  "signed",
  "background_collection",
  "school_selection_confirmed",
  "interview_preparation",
  "application_submitted",
  "awaiting_result",
  "offer_confirmed",
  "closed",
] as const);

const TARGET_STATES = Object.freeze([
  "candidate",
  "preparing",
  "submitted",
  "interview",
  "waitlisted",
  "accepted",
  "rejected",
  "withdrawn",
] as const);

const BLOCKED_REASONS = Object.freeze([
  "founder_read_only",
  "case_stage_not_allowed",
  "no_school_options",
] as const);

export type SchoolTargetCaseStage = (typeof CASE_STAGES)[number];
export type SchoolTargetState = (typeof TARGET_STATES)[number];
export type SchoolTargetCreateBlockedReason = (typeof BLOCKED_REASONS)[number] | null;

export interface SchoolTargetItem {
  readonly target_id: string;
  readonly school_id: string;
  readonly school_name: string;
  readonly state: SchoolTargetState;
  readonly intake_year: number;
  readonly admission_type: string;
  readonly record_version: number;
  readonly resolved_revision_id: string;
  readonly resolution_sha256: string;
  readonly created_at: string;
}

export interface SchoolTargetOption {
  readonly school_id: string;
  readonly display_name: string;
  readonly resolution_sha256: string;
}

export interface SchoolTargetsView {
  readonly case_id: string;
  readonly case_stage: SchoolTargetCaseStage;
  readonly intake_year: number;
  readonly admission_type: string;
  readonly can_create: boolean;
  readonly create_blocked_reason: SchoolTargetCreateBlockedReason;
  readonly items: readonly SchoolTargetItem[];
  readonly school_options: readonly SchoolTargetOption[];
}

export interface CreatedSchoolTarget {
  readonly case_id: string;
  readonly item: SchoolTargetItem;
}

export interface CreateSchoolTargetInput {
  readonly school_id: string;
  readonly expected_resolution_sha256: string;
}

export type SchoolTargetFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "stale"
  | "conflict"
  | "unavailable";

export async function getSchoolTargets(
  caseId: string,
  signal?: AbortSignal,
): Promise<SchoolTargetsView> {
  assertUuid(caseId, "caseId");
  return requestApi(
    { path: `/api/v1/cases/${caseId}/school-targets`, signal },
    (value) => decodeSchoolTargetsView(value, caseId),
  );
}

export async function createSchoolTarget(
  caseId: string,
  input: CreateSchoolTargetInput,
  idempotencyKey: string,
): Promise<CreatedSchoolTarget> {
  assertUuid(caseId, "caseId");
  assertUuid(input.school_id, "school_id");
  assertSha256(input.expected_resolution_sha256, "expected_resolution_sha256");
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new TypeError("Invalid idempotency key.");

  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/school-targets`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        school_id: input.school_id,
        expected_resolution_sha256: input.expected_resolution_sha256,
      },
    },
    (value) => decodeCreatedSchoolTarget(value, caseId, input),
  );
}

export function classifySchoolTargetFailure(error: unknown): SchoolTargetFailureKind {
  if (!(error instanceof ApiClientError)) return "unavailable";
  if (error.code === "UNAUTHENTICATED" || error.status === 401) return "unauthenticated";
  if (error.code === "FORBIDDEN" || error.code === "NOT_FOUND" || error.status === 403 || error.status === 404) {
    return "forbidden";
  }
  if (error.code === "STALE_VERSION") return "stale";
  if (error.code === "CONFLICT" || error.status === 409) return "conflict";
  return "unavailable";
}

export function hasSchoolTarget(view: SchoolTargetsView, schoolId: string): boolean {
  return view.items.some((item) => item.school_id === schoolId);
}

/** Keeps one key for one logical mutation until its outcome is authoritative. */
export class SchoolTargetIdempotencyAttempt {
  private readonly createKey: () => string;
  private schoolId: string | null = null;
  private key: string | null = null;

  constructor(createKey: () => string = () => globalThis.crypto.randomUUID()) {
    this.createKey = createKey;
  }

  select(schoolId: string): void {
    if (schoolId !== "") assertUuid(schoolId, "schoolId");
    if (schoolId !== this.schoolId) {
      this.schoolId = schoolId || null;
      this.key = null;
    }
  }

  keyFor(schoolId: string): string {
    this.select(schoolId);
    if (this.schoolId === null) throw new TypeError("A school must be selected.");
    if (this.key === null) {
      const nextKey = this.createKey();
      if (!IDEMPOTENCY_KEY.test(nextKey)) throw new TypeError("Invalid idempotency key.");
      this.key = nextKey;
    }
    return this.key;
  }

  rotate(): void {
    this.key = null;
  }

  complete(): void {
    this.schoolId = null;
    this.key = null;
  }
}

function decodeSchoolTargetsView(value: unknown, expectedCaseId: string): SchoolTargetsView {
  const record = exactRecord(value, [
    "case_id",
    "case_stage",
    "intake_year",
    "admission_type",
    "can_create",
    "create_blocked_reason",
    "items",
    "school_options",
  ]);
  const caseId = uuid(record.case_id, "case_id");
  if (caseId !== expectedCaseId) throw new TypeError("Mismatched case_id.");
  const caseStage = oneOf(record.case_stage, CASE_STAGES, "case_stage");
  const intakeYear = positiveInteger(record.intake_year, "intake_year");
  const admissionType = nonBlank(record.admission_type, "admission_type");
  const canCreate = expectBoolean(record.can_create);
  const blockedReason = nullableOneOf(
    record.create_blocked_reason,
    BLOCKED_REASONS,
    "create_blocked_reason",
  );
  const items = expectArray(record.items, decodeSchoolTargetItem);
  const schoolOptions = expectArray(record.school_options, decodeSchoolTargetOption);

  if (schoolOptions.length > 3) throw new TypeError("Too many school options.");
  if (canCreate !== (blockedReason === null)) throw new TypeError("Invalid create capability.");
  if (blockedReason === "no_school_options" && schoolOptions.length !== 0) {
    throw new TypeError("Blocked response contains school options.");
  }
  if (canCreate && schoolOptions.length === 0) throw new TypeError("Create capability has no options.");

  assertUnique(items.map((item) => item.target_id), "target_id");
  assertUnique(items.map((item) => item.school_id), "item school_id");
  assertUnique(schoolOptions.map((option) => option.school_id), "option school_id");
  const targetedSchoolIds = new Set(items.map((item) => item.school_id));
  if (schoolOptions.some((option) => targetedSchoolIds.has(option.school_id))) {
    throw new TypeError("A targeted school cannot remain selectable.");
  }
  if (items.some((item) => item.intake_year !== intakeYear || item.admission_type !== admissionType)) {
    throw new TypeError("Target identity does not match the ServiceCase.");
  }

  return Object.freeze({
    case_id: caseId,
    case_stage: caseStage,
    intake_year: intakeYear,
    admission_type: admissionType,
    can_create: canCreate,
    create_blocked_reason: blockedReason,
    items: Object.freeze(items),
    school_options: Object.freeze(schoolOptions),
  });
}

function decodeCreatedSchoolTarget(
  value: unknown,
  expectedCaseId: string,
  input: CreateSchoolTargetInput,
): CreatedSchoolTarget {
  const record = exactRecord(value, ["case_id", "item"]);
  const caseId = uuid(record.case_id, "case_id");
  const item = decodeSchoolTargetItem(record.item);
  if (
    caseId !== expectedCaseId ||
    item.school_id !== input.school_id ||
    item.resolution_sha256 !== input.expected_resolution_sha256 ||
    item.state !== "candidate"
  ) {
    throw new TypeError("Created target does not match the request.");
  }
  return Object.freeze({ case_id: caseId, item });
}

function decodeSchoolTargetItem(value: unknown): SchoolTargetItem {
  const record = exactRecord(value, [
    "target_id",
    "school_id",
    "school_name",
    "state",
    "intake_year",
    "admission_type",
    "record_version",
    "resolved_revision_id",
    "resolution_sha256",
    "created_at",
  ]);
  return Object.freeze({
    target_id: uuid(record.target_id, "target_id"),
    school_id: uuid(record.school_id, "school_id"),
    school_name: nonBlank(record.school_name, "school_name"),
    state: oneOf(record.state, TARGET_STATES, "state"),
    intake_year: positiveInteger(record.intake_year, "intake_year"),
    admission_type: nonBlank(record.admission_type, "admission_type"),
    record_version: positiveInteger(record.record_version, "record_version"),
    resolved_revision_id: uuid(record.resolved_revision_id, "resolved_revision_id"),
    resolution_sha256: sha256(record.resolution_sha256, "resolution_sha256"),
    created_at: isoTimestamp(record.created_at, "created_at"),
  });
}

function decodeSchoolTargetOption(value: unknown): SchoolTargetOption {
  const record = exactRecord(value, ["school_id", "display_name", "resolution_sha256"]);
  return Object.freeze({
    school_id: uuid(record.school_id, "school_id"),
    display_name: nonBlank(record.display_name, "display_name"),
    resolution_sha256: sha256(record.resolution_sha256, "resolution_sha256"),
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = expectRecord(value);
  const expected = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new TypeError("Unexpected response fields.");
  }
  return record;
}

function uuid(value: unknown, field: string): string {
  const parsed = expectString(value);
  assertUuid(parsed, field);
  return parsed;
}

function sha256(value: unknown, field: string): string {
  const parsed = expectString(value);
  assertSha256(parsed, field);
  return parsed;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = expectNumber(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`Invalid ${field}.`);
  return parsed;
}

function nonBlank(value: unknown, field: string): string {
  const parsed = expectString(value);
  if (parsed.trim() === "" || parsed !== parsed.trim()) throw new TypeError(`Invalid ${field}.`);
  return parsed;
}

function isoTimestamp(value: unknown, field: string): string {
  const parsed = expectString(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return parsed;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] {
  const parsed = expectString(value);
  if (!values.includes(parsed)) throw new TypeError(`Invalid ${field}.`);
  return parsed as Values[number];
}

function nullableOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] | null {
  const parsed = expectNullableString(value);
  return parsed === null ? null : oneOf(parsed, values, field);
}

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`Invalid ${field}.`);
}

function assertSha256(value: string, field: string): void {
  if (!SHA256.test(value)) throw new TypeError(`Invalid ${field}.`);
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${field}.`);
}
