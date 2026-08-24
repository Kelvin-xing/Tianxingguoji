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
import {
  REFERRAL_SOURCE_TYPES,
  type ReferralSourceType,
} from "../crm/client.ts";
import studentProfileCatalogue from "../../schema/k12/student-profile.v1.json" with { type: "json" };
import educationProfileCatalogue from "../../schema/k12/education-profile.v1.json" with { type: "json" };
import schoolPreferencesCatalogue from "../../schema/k12/school-preferences.v1.json" with { type: "json" };
import familyContextCatalogue from "../../schema/k12/family-context.v1.json" with { type: "json" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const CASE_STAGES = Object.freeze([
  "signed",
  "background_collection",
  "school_selection_confirmed",
  "application_in_progress",
  "closed",
] as const);

const CASE_WORKFLOW_STATUSES = Object.freeze([
  "active",
  "paused",
  "termination_pending",
  "closed",
] as const);

const CASE_WORKFLOW_ACTIONS = Object.freeze([
  "pause",
  "resume",
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

const SCHOOL_TARGET_CREATE_BLOCKED_REASON = "selection_workflow_required" as const;

const ADMISSION_TYPES = Object.freeze(["s1_admission", "transfer"] as const);
const PRIMARY_ROLES = Object.freeze(["advisor"] as const);

export type CaseWorkspaceStage = (typeof CASE_STAGES)[number];
export type CaseWorkflowStatus = (typeof CASE_WORKFLOW_STATUSES)[number];
export type CaseWorkflowAction = (typeof CASE_WORKFLOW_ACTIONS)[number];
export type CaseAdmissionType = (typeof ADMISSION_TYPES)[number];
export type CasePrimaryRole = (typeof PRIMARY_ROLES)[number];

export interface CaseWorkspaceListItem {
  readonly id: string;
  readonly caseNumber: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly intakeYear: number;
  readonly admissionType: CaseAdmissionType;
  readonly stage: CaseWorkspaceStage;
  readonly workflowStatus: CaseWorkflowStatus;
  readonly recordVersion: number;
  readonly availableWorkflowActions: readonly CaseWorkflowAction[];
  readonly updatedAt: string;
  readonly primaryRole: CasePrimaryRole;
}

export interface CaseWorkspaceDetail extends CaseWorkspaceListItem {
  readonly assessmentId: string;
  readonly assessmentStatus: "draft" | "background_complete" | "selection_ready";
  readonly manifestId: string;
  readonly primaryBindingLabel: string;
  readonly primaryUserId: string;
}

export interface CaseWorkspaceOptions {
  readonly students: readonly Readonly<{ readonly id: string; readonly displayName: string }>[];
  readonly primaryBindings: readonly Readonly<{
    readonly id: string;
    readonly role: "advisor";
    readonly label: string;
  }>[];
  readonly manifests: readonly Readonly<{
    readonly id: string;
    readonly compositionVersion: string;
    readonly label: string;
  }>[];
}

export interface CreateExistingStudentCaseInput {
  readonly student_id: string;
  readonly intake_year: number;
  readonly admission_type: CaseAdmissionType;
  readonly primary_role_binding_id: string;
  readonly manifest_id: string;
}

export interface CaseWriteReceipt {
  readonly id: string;
  readonly record_version: number;
}

export type CreatedExistingStudentCase = CaseWriteReceipt;

export type AssessmentSemanticState =
  | "provided"
  | "unknown"
  | "not_applicable"
  | "declined_to_provide";
export type AssessmentValueType = "text" | "date" | "integer" | "enum" | "enum_set";
export type AssessmentAccessMode = "full" | "education_profile";

export interface CaseAssessmentView {
  readonly assessment_id: string;
  readonly manifest_id: string;
  readonly record_version: number;
  readonly status: "draft" | "background_complete" | "selection_ready";
  readonly access: {
    readonly mode: AssessmentAccessMode;
    readonly can_edit: boolean;
    readonly editable_field_ids: readonly string[];
    readonly can_complete_background: boolean;
  };
  readonly schema: {
    readonly manifest_id: string;
    readonly composition_version: "k12-catalogue-v1";
    readonly fields: readonly AssessmentFieldView[];
  };
  readonly answers: readonly AssessmentAnswerView[];
}

export interface AssessmentFieldView {
  readonly field_id: string;
  readonly label?: string;
  readonly layer: "base" | "education_stage" | "school_system" | "admission_route";
  readonly module_id?: string;
  readonly module_version?: string;
  readonly value_type: AssessmentValueType;
  readonly enum_values?: readonly string[];
  readonly visibility: string;
  readonly blocking_stages: readonly string[];
}

export interface AssessmentAnswerView {
  readonly field_id: string;
  readonly semantic_state: AssessmentSemanticState;
  readonly value: Readonly<{ readonly type: AssessmentValueType; readonly value: string | number | readonly string[] }> | null;
  readonly value_type: AssessmentValueType | null;
  readonly record_version: number;
}

const APPROVED_ASSESSMENT_FIELDS = deriveApprovedAssessmentFields([
  studentProfileCatalogue,
  educationProfileCatalogue,
  schoolPreferencesCatalogue,
  familyContextCatalogue,
]);
const EDUCATION_PROFILE_ASSESSMENT_FIELDS = Object.freeze(
  APPROVED_ASSESSMENT_FIELDS.filter(
    ({ module_id }) => module_id === educationProfileCatalogue.moduleId,
  ),
);

export interface UpdateCaseAssessmentAnswerInput {
  readonly field_id: string;
  readonly semantic_state: AssessmentSemanticState;
  readonly value: AssessmentAnswerView["value"];
  readonly value_type: AssessmentValueType | null;
  readonly expected_record_version: number;
}

export type CaseRequestFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "stale"
  | "conflict"
  | "unavailable";

export async function listCaseWorkspaceOptions(signal?: AbortSignal): Promise<CaseWorkspaceOptions> {
  return requestApi(
    { path: "/api/v1/cases/options", signal },
    decodeCaseWorkspaceOptionsEnvelope,
  );
}

export async function listCases(signal?: AbortSignal): Promise<readonly CaseWorkspaceListItem[]> {
  return requestApi(
    { path: "/api/v1/cases", signal },
    (value) => {
      const record = exactRecord(value, ["cases"]);
      return Object.freeze(expectArray(record.cases, decodeCaseWorkspaceListItem));
    },
  );
}

export async function getCase(
  caseId: string,
  signal?: AbortSignal,
): Promise<CaseWorkspaceDetail> {
  assertUuid(caseId, "caseId");
  return requestApi(
    { path: `/api/v1/cases/${caseId}`, signal },
    (value) => {
      const record = exactRecord(value, ["case"]);
      const detail = decodeCaseWorkspaceDetail(record.case);
      if (detail.id !== caseId) throw new TypeError("Mismatched Case identity.");
      return detail;
    },
  );
}

export async function createExistingStudentCase(
  input: CreateExistingStudentCaseInput,
  idempotencyKey: string,
): Promise<CreatedExistingStudentCase> {
  assertCreateCaseInput(input);
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new TypeError("Invalid idempotency key.");
  return requestApi(
    {
      path: "/api/v1/cases",
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        student_id: input.student_id,
        intake_year: input.intake_year,
        admission_type: input.admission_type,
        primary_role_binding_id: input.primary_role_binding_id,
        manifest_id: input.manifest_id,
      },
    },
    decodeCaseWriteReceipt,
  );
}

export async function executeCaseWorkflowAction(
  caseId: string,
  input: Readonly<{
    readonly action: "pause" | "resume";
    readonly expected_record_version: number;
    readonly reason: string | null;
  }>,
  idempotencyKey: string,
): Promise<CaseWriteReceipt> {
  assertUuid(caseId, "caseId");
  if (input.action !== "pause" && input.action !== "resume") {
    throw new TypeError("Invalid workflow action.");
  }
  positiveInteger(input.expected_record_version, "expected_record_version");
  if (
    input.reason !== null &&
    (input.reason !== input.reason.trim() || input.reason.length > 1000)
  ) {
    throw new TypeError("Invalid workflow reason.");
  }
  if (input.action === "pause" && (input.reason === null || input.reason.length < 1)) {
    throw new TypeError("A pause reason is required.");
  }
  if (input.action === "resume" && input.reason !== null) {
    throw new TypeError("Resume does not accept a reason.");
  }
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new TypeError("Invalid idempotency key.");
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/workflow-actions`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        action: input.action,
        expected_record_version: input.expected_record_version,
        reason: input.reason,
      },
    },
    decodeCaseWriteReceipt,
  );
}

export function getCaseAssessment(
  caseId: string,
  signal?: AbortSignal,
): Promise<CaseAssessmentView> {
  assertUuid(caseId, "caseId");
  return requestApi(
    { path: `/api/v1/cases/${caseId}/assessment`, signal },
    decodeCaseAssessmentView,
  );
}

export function updateCaseAssessmentAnswer(
  caseId: string,
  input: UpdateCaseAssessmentAnswerInput,
  idempotencyKey: string,
): Promise<CaseWriteReceipt> {
  assertUuid(caseId, "caseId");
  nonBlank(input.field_id, "field_id");
  oneOf(input.semantic_state, [
    "provided", "unknown", "not_applicable", "declined_to_provide",
  ] as const, "semantic_state");
  if ((input.semantic_state === "provided") !== (input.value !== null && input.value_type !== null)) {
    throw new TypeError("Assessment answer value does not match its semantic state.");
  }
  positiveOrZeroInteger(input.expected_record_version, "expected_record_version");
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new TypeError("Invalid idempotency key.");
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/assessment`,
      method: "PATCH",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        field_id: input.field_id,
        semantic_state: input.semantic_state,
        value: input.value,
        value_type: input.value_type,
        expected_record_version: input.expected_record_version,
      },
    },
    decodeCaseWriteReceipt,
  );
}

export function completeCaseAssessmentBackground(
  caseId: string,
  expectedRecordVersion: number,
  idempotencyKey: string,
): Promise<CaseWriteReceipt> {
  assertUuid(caseId, "caseId");
  positiveInteger(expectedRecordVersion, "expected_record_version");
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new TypeError("Invalid idempotency key.");
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/assessment/background-completion`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: { expected_record_version: expectedRecordVersion },
    },
    decodeCaseWriteReceipt,
  );
}

export class CaseAssessmentIdempotencyAttempt {
  private readonly createKey: () => string;
  private fingerprint: string | null = null;
  private key: string | null = null;

  constructor(createKey: () => string = () => globalThis.crypto.randomUUID()) {
    this.createKey = createKey;
  }

  keyFor(fingerprint: string): string {
    if (fingerprint.length < 1) throw new TypeError("Assessment command fingerprint is required.");
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.key = null;
    }
    if (this.key === null) {
      const nextKey = this.createKey();
      if (!IDEMPOTENCY_KEY.test(nextKey)) throw new TypeError("Invalid idempotency key.");
      this.key = nextKey;
    }
    return this.key;
  }

  complete(): void {
    this.fingerprint = null;
    this.key = null;
  }
}

export function classifyCaseRequestFailure(error: unknown): CaseRequestFailureKind {
  if (!(error instanceof ApiClientError)) return "unavailable";
  if (error.code === "UNAUTHENTICATED" || error.status === 401) return "unauthenticated";
  if (error.code === "FORBIDDEN" || error.status === 403) return "forbidden";
  if (error.code === "NOT_FOUND" || error.status === 404) return "not_found";
  if (error.code === "VALIDATION_FAILED" || error.status === 422) return "validation";
  if (error.code === "STALE_VERSION") return "stale";
  if (error.code === "CONFLICT" || error.status === 409) return "conflict";
  return "unavailable";
}

/** Owns one key for one semantic workflow attempt, including uncertain retries. */
export class CaseWorkflowIdempotencyAttempt {
  private readonly createKey: () => string;
  private fingerprint: string | null = null;
  private key: string | null = null;

  constructor(createKey: () => string = () => globalThis.crypto.randomUUID()) {
    this.createKey = createKey;
  }

  keyFor(input: Readonly<{
    readonly action: "pause" | "resume";
    readonly expected_record_version: number;
    readonly reason: string | null;
  }>): string {
    const fingerprint = `${input.action}:${input.expected_record_version}:${input.reason}`;
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.key = null;
    }
    if (this.key === null) {
      const nextKey = this.createKey();
      if (!IDEMPOTENCY_KEY.test(nextKey)) throw new TypeError("Invalid idempotency key.");
      this.key = nextKey;
    }
    return this.key;
  }

  complete(): void {
    this.fingerprint = null;
    this.key = null;
  }
}

/** Owns one key for one logical Case create attempt, including uncertain retries. */
export class CaseCreateIdempotencyAttempt {
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

export interface CaseReferralSourceAssignment {
  readonly id: string;
  readonly referral_source_id: string;
  readonly source_display_name: string;
  readonly source_type: ReferralSourceType;
  readonly source_record_version: number;
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly record_version: number;
}

export interface CaseReferralSourceAssignments {
  readonly current: CaseReferralSourceAssignment | null;
  readonly history: readonly CaseReferralSourceAssignment[];
}

export interface AssignCaseReferralSourceInput {
  readonly referral_source_id: string;
  readonly expected_current_assignment_record_version: number | null;
}

export interface CaseReferralSourceWriteReceipt {
  readonly id: string;
  readonly record_version: number;
}

export type CaseReferralSourceFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "stale"
  | "conflict"
  | "unavailable";

export function getCaseReferralSourceAssignments(
  caseId: string,
  signal?: AbortSignal,
): Promise<CaseReferralSourceAssignments> {
  assertUuid(caseId, "caseId");
  return requestApi(
    { path: `/api/v1/cases/${caseId}/referral-source-assignments`, signal },
    decodeCaseReferralSourceAssignments,
  );
}

export function assignCaseReferralSource(
  caseId: string,
  input: AssignCaseReferralSourceInput,
  idempotencyKey: string,
): Promise<CaseReferralSourceWriteReceipt> {
  assertUuid(caseId, "caseId");
  assertUuid(input.referral_source_id, "referral_source_id");
  if (input.expected_current_assignment_record_version !== null) {
    positiveInteger(
      input.expected_current_assignment_record_version,
      "expected_current_assignment_record_version",
    );
  }
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new TypeError("Invalid idempotency key.");
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/referral-source-assignments`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        referral_source_id: input.referral_source_id,
        expected_current_assignment_record_version:
          input.expected_current_assignment_record_version,
      },
    },
    (value) => decodeCaseReferralSourceWriteReceipt(
      value,
      input.expected_current_assignment_record_version === null
        ? 1
        : input.expected_current_assignment_record_version + 1,
    ),
  );
}

export function classifyCaseReferralSourceFailure(error: unknown): CaseReferralSourceFailureKind {
  if (!(error instanceof ApiClientError)) return "unavailable";
  if (error.code === "UNAUTHENTICATED" || error.status === 401) return "unauthenticated";
  if (error.code === "FORBIDDEN" || error.status === 403) return "forbidden";
  if (error.code === "NOT_FOUND" || error.status === 404) return "not_found";
  if (error.code === "VALIDATION_FAILED" || error.status === 422) return "validation";
  if (error.code === "STALE_VERSION") return "stale";
  if (error.code === "CONFLICT" || error.status === 409) return "conflict";
  return "unavailable";
}

export function caseReferralSourceFingerprint(
  caseId: string,
  input: AssignCaseReferralSourceInput,
): string {
  assertUuid(caseId, "caseId");
  assertUuid(input.referral_source_id, "referral_source_id");
  if (input.expected_current_assignment_record_version !== null) {
    positiveInteger(
      input.expected_current_assignment_record_version,
      "expected_current_assignment_record_version",
    );
  }
  return `${caseId}:${input.referral_source_id}:${input.expected_current_assignment_record_version ?? "none"}`;
}

export class CaseReferralSourceIdempotencyAttempt {
  private readonly createKey: () => string;
  private fingerprint: string | null = null;
  private key: string | null = null;

  constructor(createKey: () => string = () => globalThis.crypto.randomUUID()) {
    this.createKey = createKey;
  }

  keyFor(fingerprint: string): string {
    if (fingerprint.trim() === "") throw new TypeError("Invalid assignment fingerprint.");
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.key = null;
    }
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
    this.fingerprint = null;
    this.key = null;
  }
}

export type SchoolTargetCaseStage = CaseWorkspaceStage;
export type SchoolTargetState = (typeof TARGET_STATES)[number];
export type SchoolTargetCreateBlockedReason = typeof SCHOOL_TARGET_CREATE_BLOCKED_REASON;

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

export interface SchoolTargetsView {
  readonly case_id: string;
  readonly case_stage: SchoolTargetCaseStage;
  readonly intake_year: number;
  readonly admission_type: string;
  readonly can_create: false;
  readonly create_blocked_reason: SchoolTargetCreateBlockedReason;
  readonly items: readonly SchoolTargetItem[];
  readonly school_options: readonly [];
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

function decodeCaseWorkspaceOptionsEnvelope(value: unknown): CaseWorkspaceOptions {
  const root = exactRecord(value, ["options"]);
  const options = exactRecord(root.options, ["students", "primaryBindings", "manifests"]);
  const students = expectArray(options.students, (item) => {
    const record = exactRecord(item, ["id", "displayName"]);
    return Object.freeze({
      id: uuid(record.id, "student id"),
      displayName: nonBlank(record.displayName, "student displayName"),
    });
  });
  const primaryBindings = expectArray(options.primaryBindings, (item) => {
    const record = exactRecord(item, ["id", "role", "label"]);
    return Object.freeze({
      id: uuid(record.id, "primary binding id"),
      role: oneOf(record.role, ["advisor"] as const, "primary binding role"),
      label: nonBlank(record.label, "primary binding label"),
    });
  });
  const manifests = expectArray(options.manifests, (item) => {
    const record = exactRecord(item, ["id", "compositionVersion", "label"]);
    return Object.freeze({
      id: uuid(record.id, "manifest id"),
      compositionVersion: nonBlank(record.compositionVersion, "compositionVersion"),
      label: nonBlank(record.label, "manifest label"),
    });
  });
  assertUnique(students.map(({ id }) => id), "student id");
  assertUnique(primaryBindings.map(({ id }) => id), "primary binding id");
  assertUnique(manifests.map(({ id }) => id), "manifest id");
  return Object.freeze({
    students: Object.freeze(students),
    primaryBindings: Object.freeze(primaryBindings),
    manifests: Object.freeze(manifests),
  });
}

function decodeCaseWorkspaceListItem(value: unknown): CaseWorkspaceListItem {
  const record = exactRecord(value, [
    "id",
    "caseNumber",
    "studentId",
    "studentName",
    "intakeYear",
    "admissionType",
    "stage",
    "workflowStatus",
    "recordVersion",
    "availableWorkflowActions",
    "updatedAt",
    "primaryRole",
  ]);
  const workflowStatus = oneOf(
    record.workflowStatus,
    CASE_WORKFLOW_STATUSES,
    "workflowStatus",
  );
  const availableWorkflowActions = canonicalWorkflowActions(
    record.availableWorkflowActions,
  );
  return Object.freeze({
    id: uuid(record.id, "case id"),
    caseNumber: nonBlank(record.caseNumber, "caseNumber"),
    studentId: uuid(record.studentId, "studentId"),
    studentName: nonBlank(record.studentName, "studentName"),
    intakeYear: caseIntakeYear(record.intakeYear),
    admissionType: oneOf(record.admissionType, ADMISSION_TYPES, "admissionType"),
    stage: oneOf(record.stage, CASE_STAGES, "stage"),
    workflowStatus,
    recordVersion: positiveInteger(record.recordVersion, "recordVersion"),
    availableWorkflowActions,
    updatedAt: isoTimestamp(record.updatedAt, "updatedAt"),
    primaryRole: oneOf(record.primaryRole, PRIMARY_ROLES, "primaryRole"),
  });
}

function decodeCaseWorkspaceDetail(value: unknown): CaseWorkspaceDetail {
  const record = exactRecord(value, [
    "id", "caseNumber", "studentId", "studentName", "intakeYear", "admissionType",
    "stage", "workflowStatus", "recordVersion", "availableWorkflowActions",
    "updatedAt", "primaryRole",
    "assessmentId",
    "assessmentStatus",
    "manifestId",
    "primaryBindingLabel",
    "primaryUserId",
  ]);
  const listItem = decodeCaseWorkspaceListItem({
    id: record.id,
    caseNumber: record.caseNumber,
    studentId: record.studentId,
    studentName: record.studentName,
    intakeYear: record.intakeYear,
    admissionType: record.admissionType,
    stage: record.stage,
    workflowStatus: record.workflowStatus,
    recordVersion: record.recordVersion,
    availableWorkflowActions: record.availableWorkflowActions,
    updatedAt: record.updatedAt,
    primaryRole: record.primaryRole,
  });
  return Object.freeze({
    ...listItem,
    assessmentId: uuid(record.assessmentId, "assessmentId"),
    assessmentStatus: oneOf(
      record.assessmentStatus,
      ["draft", "background_complete", "selection_ready"] as const,
      "assessmentStatus",
    ),
    manifestId: uuid(record.manifestId, "manifestId"),
    primaryBindingLabel: nonBlank(record.primaryBindingLabel, "primaryBindingLabel"),
    primaryUserId: uuid(record.primaryUserId, "primaryUserId"),
  });
}

function decodeCaseAssessmentView(value: unknown): CaseAssessmentView {
  const record = exactRecord(value, [
    "assessment_id", "manifest_id", "record_version", "status", "access", "schema", "answers",
  ]);
  const assessmentId = uuid(record.assessment_id, "assessment_id");
  const manifestId = uuid(record.manifest_id, "manifest_id");
  const schemaRecord = exactRecord(record.schema, ["manifest_id", "composition_version", "fields"]);
  if (uuid(schemaRecord.manifest_id, "schema.manifest_id") !== manifestId) {
    throw new TypeError("Assessment manifest identity drift.");
  }
  const fields = expectArray(schemaRecord.fields, decodeAssessmentField);
  assertUnique(fields.map(({ field_id }) => field_id), "assessment field_id");
  const fieldById = new Map(fields.map((field) => [field.field_id, field]));

  const answers = expectArray(record.answers, (answerValue) => decodeAssessmentAnswer(answerValue, fieldById));
  assertUnique(answers.map(({ field_id }) => field_id), "assessment answer field_id");
  const answerIndexes = answers.map(({ field_id }) => fields.findIndex((field) => field.field_id === field_id));
  if (answerIndexes.some((fieldIndex, index) => index > 0 && fieldIndex <= answerIndexes[index - 1]!)) {
    throw new TypeError("Assessment answers are not a canonical schema-ordered subset.");
  }

  const accessRecord = exactRecord(record.access, [
    "mode", "can_edit", "editable_field_ids", "can_complete_background",
  ]);
  const mode = oneOf(accessRecord.mode, ["full", "education_profile"] as const, "access.mode");
  const expectedFields = mode === "full"
    ? APPROVED_ASSESSMENT_FIELDS
    : EDUCATION_PROFILE_ASSESSMENT_FIELDS;
  if (
    fields.length !== expectedFields.length ||
    fields.some((field, index) => !assessmentFieldMatches(field, expectedFields[index]!))
  ) {
    throw new TypeError("Assessment schema projection is not canonical.");
  }
  const canEdit = expectBoolean(accessRecord.can_edit);
  const editableFieldIds = expectArray(accessRecord.editable_field_ids, (fieldId) =>
    nonBlank(fieldId, "access.editable_field_id"));
  assertUnique(editableFieldIds, "access editable_field_id");
  if (editableFieldIds.some((fieldId) => !fieldById.has(fieldId))) {
    throw new TypeError("Editable Assessment field is outside the visible schema.");
  }
  const visibleFieldIds = fields.map(({ field_id }) => field_id);
  if (
    canEdit
      ? editableFieldIds.length !== visibleFieldIds.length ||
        editableFieldIds.some((fieldId, index) => fieldId !== visibleFieldIds[index])
      : editableFieldIds.length !== 0
  ) {
    throw new TypeError("Assessment edit access is inconsistent.");
  }
  const canCompleteBackground = expectBoolean(accessRecord.can_complete_background);
  if (canCompleteBackground && (mode !== "full" || !canEdit)) {
    throw new TypeError("Assessment completion access is inconsistent.");
  }
  return Object.freeze({
    assessment_id: assessmentId,
    manifest_id: manifestId,
    record_version: positiveInteger(record.record_version, "assessment.record_version"),
    status: oneOf(
      record.status,
      ["draft", "background_complete", "selection_ready"] as const,
      "assessment.status",
    ),
    access: Object.freeze({
      mode,
      can_edit: canEdit,
      editable_field_ids: Object.freeze([...editableFieldIds]),
      can_complete_background: canCompleteBackground,
    }),
    schema: Object.freeze({
      manifest_id: manifestId,
      composition_version: oneOf(
        schemaRecord.composition_version,
        ["k12-catalogue-v1"] as const,
        "schema.composition_version",
      ),
      fields: Object.freeze([...fields]),
    }),
    answers: Object.freeze([...answers]),
  });
}

function deriveApprovedAssessmentFields(modules: readonly unknown[]): readonly AssessmentFieldView[] {
  const blockerStages = ["background_collection", "school_selection_confirmed"] as const;
  const fields = modules.flatMap((moduleValue) => {
    const moduleRecord = exactRecord(moduleValue, [
      "applicationType", "layer", "moduleId", "version", "catalogueStatus",
      "productionEnabled", "fields", "blockers",
    ]);
    if (
      moduleRecord.applicationType !== "k12" ||
      moduleRecord.catalogueStatus !== "approved" ||
      moduleRecord.productionEnabled !== true
    ) {
      throw new TypeError("Invalid approved K12 catalogue module.");
    }
    const layer = oneOf(
      moduleRecord.layer,
      ["base", "education_stage", "school_system", "admission_route"] as const,
      "catalogue.layer",
    );
    const moduleId = nonBlank(moduleRecord.moduleId, "catalogue.moduleId");
    const moduleVersion = nonBlank(moduleRecord.version, "catalogue.version");
    const blockerRecord = exactRecord(moduleRecord.blockers, blockerStages);
    const blockerFieldIds = Object.fromEntries(blockerStages.map((stage) => [
      stage,
      expectArray(blockerRecord[stage], (fieldId) => nonBlank(fieldId, `catalogue.${stage}`)),
    ])) as Readonly<Record<(typeof blockerStages)[number], readonly string[]>>;
    const rawFields = expectArray(moduleRecord.fields, (fieldValue) => {
      const fieldRecord = recordWithOptionalKeys(
        fieldValue,
        ["fieldId", "label", "valueType", "visibility"],
        ["enumValues"],
      );
      const valueType = oneOf(
        fieldRecord.valueType,
        ["text", "date", "integer", "enum", "enum_set"] as const,
        "catalogue.field.valueType",
      );
      const enumValues = fieldRecord.enumValues === undefined
        ? undefined
        : expectArray(fieldRecord.enumValues, (entry) => nonBlank(entry, "catalogue.field.enumValue"));
      if ((valueType === "enum" || valueType === "enum_set") !== (enumValues !== undefined)) {
        throw new TypeError("Invalid approved K12 catalogue enum metadata.");
      }
      return Object.freeze({
        field_id: nonBlank(fieldRecord.fieldId, "catalogue.field.fieldId"),
        label: nonBlank(fieldRecord.label, "catalogue.field.label"),
        layer,
        module_id: moduleId,
        module_version: moduleVersion,
        value_type: valueType,
        ...(enumValues ? { enum_values: Object.freeze([...enumValues]) } : {}),
        visibility: nonBlank(fieldRecord.visibility, "catalogue.field.visibility"),
      });
    });
    const moduleFieldIds = rawFields.map(({ field_id }) => field_id);
    assertUnique(moduleFieldIds, "catalogue field_id");
    for (const stage of blockerStages) {
      assertUnique(blockerFieldIds[stage], `catalogue ${stage}`);
      if (blockerFieldIds[stage].some((fieldId) => !moduleFieldIds.includes(fieldId))) {
        throw new TypeError("K12 catalogue blocker is outside its module.");
      }
    }
    return rawFields.map((field) => Object.freeze({
      ...field,
      blocking_stages: Object.freeze(
        blockerStages.filter((stage) => blockerFieldIds[stage].includes(field.field_id)),
      ),
    }));
  });
  assertUnique(fields.map(({ field_id }) => field_id), "approved assessment field_id");
  if (fields.length !== 15) throw new TypeError("Approved Assessment catalogue must contain 15 fields.");
  return Object.freeze(fields);
}

function assessmentFieldMatches(
  actual: AssessmentFieldView,
  expected: AssessmentFieldView,
): boolean {
  return actual.field_id === expected.field_id &&
    actual.label === expected.label &&
    actual.layer === expected.layer &&
    actual.module_id === expected.module_id &&
    actual.module_version === expected.module_version &&
    actual.value_type === expected.value_type &&
    sameOrderedStrings(actual.enum_values, expected.enum_values) &&
    actual.visibility === expected.visibility &&
    sameOrderedStrings(actual.blocking_stages, expected.blocking_stages);
}

function sameOrderedStrings(
  actual: readonly string[] | undefined,
  expected: readonly string[] | undefined,
): boolean {
  if (actual === undefined || expected === undefined) return actual === expected;
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function decodeAssessmentField(value: unknown): AssessmentFieldView {
  const record = recordWithOptionalKeys(
    value,
    ["field_id", "layer", "value_type", "visibility", "blocking_stages"],
    ["label", "module_id", "module_version", "enum_values"],
  );
  const valueType = oneOf(
    record.value_type,
    ["text", "date", "integer", "enum", "enum_set"] as const,
    "field.value_type",
  );
  const enumValues = record.enum_values === undefined
    ? undefined
    : expectArray(record.enum_values, (entry) => nonBlank(entry, "field.enum_value"));
  if ((valueType === "enum" || valueType === "enum_set") !== (enumValues !== undefined)) {
    throw new TypeError("Assessment enum metadata is inconsistent.");
  }
  if (enumValues) assertUnique(enumValues, "field enum_value");
  const optionalText = (key: "label" | "module_id" | "module_version") =>
    record[key] === undefined ? undefined : nonBlank(record[key], `field.${key}`);
  return Object.freeze({
    field_id: nonBlank(record.field_id, "field.field_id"),
    ...(optionalText("label") ? { label: optionalText("label") } : {}),
    layer: oneOf(
      record.layer,
      ["base", "education_stage", "school_system", "admission_route"] as const,
      "field.layer",
    ),
    ...(optionalText("module_id") ? { module_id: optionalText("module_id") } : {}),
    ...(optionalText("module_version") ? { module_version: optionalText("module_version") } : {}),
    value_type: valueType,
    ...(enumValues ? { enum_values: Object.freeze([...enumValues]) } : {}),
    visibility: nonBlank(record.visibility, "field.visibility"),
    blocking_stages: Object.freeze(expectArray(
      record.blocking_stages,
      (entry) => nonBlank(entry, "field.blocking_stage"),
    )),
  });
}

function decodeAssessmentAnswer(
  value: unknown,
  fieldById: ReadonlyMap<string, AssessmentFieldView>,
): AssessmentAnswerView {
  const record = exactRecord(value, [
    "field_id", "semantic_state", "value", "value_type", "record_version",
  ]);
  const fieldId = nonBlank(record.field_id, "answer.field_id");
  const field = fieldById.get(fieldId);
  if (!field) throw new TypeError("Assessment answer is outside the visible schema.");
  const semanticState = oneOf(
    record.semantic_state,
    ["provided", "unknown", "not_applicable", "declined_to_provide"] as const,
    "answer.semantic_state",
  );
  const valueType = record.value_type === null
    ? null
    : oneOf(record.value_type, ["text", "date", "integer", "enum", "enum_set"] as const, "answer.value_type");
  const typedValue = record.value === null ? null : decodeAssessmentTypedValue(record.value);
  if (semanticState === "provided") {
    if (valueType !== field.value_type || typedValue?.type !== field.value_type) {
      throw new TypeError("Assessment answer value type is inconsistent.");
    }
  } else if (valueType !== null || typedValue !== null) {
    throw new TypeError("Non-provided Assessment answer must not contain a value.");
  }
  return Object.freeze({
    field_id: fieldId,
    semantic_state: semanticState,
    value: typedValue,
    value_type: valueType,
    record_version: positiveInteger(record.record_version, "answer.record_version"),
  });
}

function decodeAssessmentTypedValue(value: unknown): NonNullable<AssessmentAnswerView["value"]> {
  const record = exactRecord(value, ["type", "value"]);
  const type = oneOf(
    record.type,
    ["text", "date", "integer", "enum", "enum_set"] as const,
    "answer.value.type",
  );
  let typedValue: string | number | readonly string[];
  if (type === "integer") {
    typedValue = expectNumber(record.value);
    if (!Number.isSafeInteger(typedValue)) throw new TypeError("Invalid integer Assessment value.");
  } else if (type === "enum_set") {
    typedValue = Object.freeze(expectArray(record.value, (entry) => nonBlank(entry, "answer enum value")));
  } else {
    typedValue = expectString(record.value);
  }
  return Object.freeze({ type, value: typedValue });
}

function decodeCaseWriteReceipt(value: unknown): CaseWriteReceipt {
  const record = exactRecord(value, ["id", "record_version"]);
  return Object.freeze({
    id: uuid(record.id, "id"),
    record_version: positiveInteger(record.record_version, "record_version"),
  });
}

function assertCreateCaseInput(input: CreateExistingStudentCaseInput): void {
  assertUuid(input.student_id, "student_id");
  assertUuid(input.primary_role_binding_id, "primary_role_binding_id");
  assertUuid(input.manifest_id, "manifest_id");
  caseIntakeYear(input.intake_year);
  oneOf(input.admission_type, ADMISSION_TYPES, "admission_type");
}

function caseIntakeYear(value: unknown): number {
  const parsed = expectNumber(value);
  if (!Number.isSafeInteger(parsed) || parsed < 2000 || parsed > 2200) {
    throw new TypeError("Invalid intake year.");
  }
  return parsed;
}

function canonicalWorkflowActions(value: unknown): readonly CaseWorkflowAction[] {
  const actions = expectArray(
    value,
    (item) => oneOf(item, CASE_WORKFLOW_ACTIONS, "availableWorkflowActions"),
  );
  if (actions.length > CASE_WORKFLOW_ACTIONS.length) {
    throw new TypeError("Too many available workflow actions.");
  }
  assertUnique(actions, "available workflow action");
  const canonical = CASE_WORKFLOW_ACTIONS.filter((action) => actions.includes(action));
  if (canonical.some((action, index) => action !== actions[index])) {
    throw new TypeError("Workflow actions are not in canonical order.");
  }
  return Object.freeze(actions);
}

function decodeCaseReferralSourceAssignments(value: unknown): CaseReferralSourceAssignments {
  const record = exactRecord(value, ["current", "history"]);
  const current = record.current === null
    ? null
    : decodeCaseReferralSourceAssignment(record.current, "current");
  const history = expectArray(
    record.history,
    (item) => decodeCaseReferralSourceAssignment(item, "history"),
  );
  if (history.length > 100) throw new TypeError("Too many referral source assignments.");
  assertUnique(history.map(({ id }) => id), "assignment id");
  if (current !== null && history.some(({ id }) => id === current.id)) {
    throw new TypeError("Current assignment is duplicated in history.");
  }
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const next = history[index];
    if (!previous || !next || compareClosedAssignments(previous, next) > 0) {
      throw new TypeError("Invalid assignment history order.");
    }
    if (previous.record_version !== next.record_version + 1) {
      throw new TypeError("Invalid assignment history chain version.");
    }
  }
  if (current === null && history.length > 0) {
    throw new TypeError("Assignment history cannot exist without a current assignment.");
  }
  if (current !== null && history.length > 0 && history[0]?.record_version !== current.record_version) {
    throw new TypeError("Current and latest closed assignment versions do not match.");
  }
  return Object.freeze({
    current,
    history: Object.freeze([...history]),
  });
}

function decodeCaseReferralSourceAssignment(
  value: unknown,
  state: "current" | "history",
): CaseReferralSourceAssignment {
  const record = exactRecord(value, [
    "id",
    "referral_source_id",
    "source_display_name",
    "source_type",
    "source_record_version",
    "starts_at",
    "ends_at",
    "record_version",
  ]);
  const endsAt = expectNullableString(record.ends_at);
  if ((state === "current" && endsAt !== null) || (state === "history" && endsAt === null)) {
    throw new TypeError("Invalid assignment current/history state.");
  }
  return Object.freeze({
    id: uuid(record.id, "assignment.id"),
    referral_source_id: uuid(record.referral_source_id, "assignment.referral_source_id"),
    source_display_name: boundedNonBlank(record.source_display_name, "assignment.source_display_name", 200),
    source_type: oneOf(record.source_type, REFERRAL_SOURCE_TYPES, "assignment.source_type"),
    source_record_version: positiveInteger(
      record.source_record_version,
      "assignment.source_record_version",
    ),
    starts_at: isoTimestamp(record.starts_at, "assignment.starts_at"),
    ends_at: endsAt === null ? null : isoTimestamp(endsAt, "assignment.ends_at"),
    record_version: positiveInteger(record.record_version, "assignment.record_version"),
  });
}

function decodeCaseReferralSourceWriteReceipt(
  value: unknown,
  expectedVersion: number,
): CaseReferralSourceWriteReceipt {
  const record = exactRecord(value, ["id", "record_version"]);
  const recordVersion = positiveInteger(record.record_version, "assignment receipt.record_version");
  if (recordVersion !== expectedVersion) throw new TypeError("Mismatched assignment receipt version.");
  return Object.freeze({
    id: uuid(record.id, "assignment receipt.id"),
    record_version: recordVersion,
  });
}

function compareClosedAssignments(
  left: CaseReferralSourceAssignment,
  right: CaseReferralSourceAssignment,
): number {
  if (left.ends_at !== right.ends_at) return left.ends_at! > right.ends_at! ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
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
  if (canCreate !== false) throw new TypeError("SchoolTarget creation must remain disabled.");
  const blockedReason = oneOf(
    record.create_blocked_reason,
    [SCHOOL_TARGET_CREATE_BLOCKED_REASON] as const,
    "create_blocked_reason",
  );
  const items = expectArray(record.items, decodeSchoolTargetItem);
  const schoolOptions = expectArray(record.school_options, (item) => item);
  if (schoolOptions.length !== 0) throw new TypeError("Retired SchoolTarget creation exposed options.");

  assertUnique(items.map((item) => item.target_id), "target_id");
  assertUnique(items.map((item) => item.school_id), "item school_id");
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
    school_options: Object.freeze([] as const),
  });
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


function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = expectRecord(value);
  const expected = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new TypeError("Unexpected response fields.");
  }
  return record;
}

function recordWithOptionalKeys(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = expectRecord(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
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

function positiveOrZeroInteger(value: unknown, field: string): number {
  const parsed = expectNumber(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`Invalid ${field}.`);
  return parsed;
}

function nonBlank(value: unknown, field: string): string {
  const parsed = expectString(value);
  if (parsed.trim() === "" || parsed !== parsed.trim()) throw new TypeError(`Invalid ${field}.`);
  return parsed;
}

function boundedNonBlank(value: unknown, field: string, maxLength: number): string {
  const parsed = nonBlank(value, field);
  if (parsed !== parsed.trim() || parsed.length > maxLength) throw new TypeError(`Invalid ${field}.`);
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

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`Invalid ${field}.`);
}

function assertSha256(value: string, field: string): void {
  if (!SHA256.test(value)) throw new TypeError(`Invalid ${field}.`);
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${field}.`);
}
