import {
  ApiClientError,
  expectArray,
  expectNumber,
  expectRecord,
  expectString,
  requestApi,
} from "../../lib/api/client.ts";
import { TASK_STATES, type TaskState } from "./public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSIGNEE_ROLES = Object.freeze(["advisor", "contractor"] as const);
const AUDIENCES = Object.freeze(["case_workspace", "assigned_task"] as const);
const TASK_KINDS = Object.freeze(["application_prepare_submit", "interview_support", "manual"] as const);
const AUTOMATIC_TASK_ACTIONS = Object.freeze(["accept", "reject", "reassign", "complete", "cancel"] as const);
const SUBMISSION_CHANNELS = Object.freeze(["school_portal", "email", "courier", "in_person", "other"] as const);

export type TaskAudience = (typeof AUDIENCES)[number];
export type TaskAssigneeRole = (typeof ASSIGNEE_ROLES)[number];
export type TaskKind = (typeof TASK_KINDS)[number];
export type AutomaticTaskAction = (typeof AUTOMATIC_TASK_ACTIONS)[number];
export type SubmissionChannel = (typeof SUBMISSION_CHANNELS)[number];

export interface TaskAssignee {
  readonly id: string;
  readonly role: TaskAssigneeRole;
  readonly label: string;
}

export interface AvailableTaskTransition {
  readonly to: TaskState;
  readonly requires_reason: boolean;
  readonly requires_assignee: boolean;
}

export interface CurrentTaskAssignment {
  readonly id: string;
  readonly assignee_user_id: string;
  readonly assignee_role: TaskAssigneeRole;
  readonly status: string;
}

interface TaskBase {
  readonly id: string;
  readonly title: string;
  readonly task_brief: string;
  readonly due_at: string;
  readonly state: TaskState;
  readonly record_version: number;
  readonly updated_at: string;
  readonly available_transitions: readonly AvailableTaskTransition[];
  readonly task_kind: TaskKind;
  readonly school_target_id: string | null;
  readonly is_overdue: boolean;
  readonly current_assignment: CurrentTaskAssignment | null;
  readonly allowed_actions: readonly AutomaticTaskAction[];
}

export interface CaseWorkspaceTask extends TaskBase {
  readonly case_id: string;
  readonly case_number: string;
  readonly assignee: TaskAssignee;
}

export type AssignedTask = TaskBase;

export type TaskListResult =
  | { readonly audience: "case_workspace"; readonly tasks: readonly CaseWorkspaceTask[] }
  | { readonly audience: "assigned_task"; readonly tasks: readonly AssignedTask[] };

export type TaskDetailResult =
  | { readonly audience: "case_workspace"; readonly task: CaseWorkspaceTask }
  | { readonly audience: "assigned_task"; readonly task: AssignedTask };

export interface TaskAssigneeOptions {
  readonly assignees: readonly TaskAssignee[];
}

export interface CreateTaskInput {
  readonly case_id: string;
  readonly title: string;
  readonly task_brief: string;
  readonly due_at: string;
  readonly assignee_user_id: string;
}

export interface TransitionTaskInput {
  readonly to: TaskState;
  readonly expected_record_version: number;
  readonly reason: string;
  readonly next_assignee_user_id: string | null;
}

export interface TaskWriteReceipt {
  readonly id: string;
  readonly record_version: number;
}

export type AutomaticTaskTransitionInput =
  | { readonly action: "accept"; readonly expected_record_version: number }
  | { readonly action: "reject" | "cancel"; readonly expected_record_version: number; readonly reason: string }
  | { readonly action: "reassign"; readonly expected_record_version: number; readonly reason: string; readonly next_assignee_user_id: string };

export interface ApplicationCompletionRecord {
  readonly submitted_at: string;
  readonly submission_channel: SubmissionChannel;
  readonly submitter_user_id: string;
  readonly checklist_snapshot: Readonly<{
    readonly all_required_items_complete: true;
    readonly confirmed_at: string;
  }>;
  readonly official_submission_reference: string | null;
  readonly no_reference_declared: boolean;
}

export interface CompleteApplicationTaskInput {
  readonly action: "complete";
  readonly expected_record_version: number;
  readonly completion_record: ApplicationCompletionRecord;
  readonly evidence_reference: string | null;
}

export interface AutomaticTaskWriteReceipt extends TaskWriteReceipt {
  readonly state: TaskState;
  readonly completion_receipt_id: string | null;
}

export interface ApplicationTaskCompletionReceipt extends AutomaticTaskWriteReceipt {
  readonly automation: Readonly<{
    readonly target_transition: "completed" | "pending";
    readonly target_id: string;
    readonly target_record_version: number | null;
  }>;
}

export type TaskFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "stale"
  | "conflict"
  | "unavailable";

export function listTasks(caseId?: string, signal?: AbortSignal): Promise<TaskListResult> {
  if (caseId !== undefined) assertUuid(caseId, "caseId");
  const path = caseId === undefined
    ? "/api/v1/tasks" as const
    : `/api/v1/tasks?case_id=${caseId}` as const;
  return requestApi({ path, signal }, (value) => decodeTaskList(value, caseId));
}

export function getTask(taskId: string, signal?: AbortSignal): Promise<TaskDetailResult> {
  assertUuid(taskId, "taskId");
  return requestApi({ path: `/api/v1/tasks/${taskId}`, signal }, decodeTaskDetail);
}

export function getTaskAssigneeOptions(
  caseId: string,
  signal?: AbortSignal,
): Promise<TaskAssigneeOptions> {
  assertUuid(caseId, "caseId");
  return requestApi(
    { path: `/api/v1/tasks/options?case_id=${caseId}`, signal },
    decodeTaskAssigneeOptions,
  );
}

export function createTask(
  input: CreateTaskInput,
  idempotencyKey: string,
): Promise<TaskWriteReceipt> {
  const normalized = normalizeCreateTaskInput(input);
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: "/api/v1/tasks",
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        case_id: normalized.case_id,
        title: normalized.title,
        task_brief: normalized.task_brief,
        due_at: normalized.due_at,
        assignee_user_id: normalized.assignee_user_id,
      },
    },
    (value) => decodeTaskWriteReceipt(value, undefined, 1),
  );
}

export function transitionTask(
  taskId: string,
  input: TransitionTaskInput,
  idempotencyKey: string,
): Promise<TaskWriteReceipt> {
  assertUuid(taskId, "taskId");
  const normalized = normalizeTransitionTaskInput(input);
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/tasks/${taskId}/transitions`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        to: normalized.to,
        expected_record_version: normalized.expected_record_version,
        reason: normalized.reason,
        next_assignee_user_id: normalized.next_assignee_user_id,
      },
    },
    (value) => decodeTaskWriteReceipt(
      value,
      taskId,
      normalized.expected_record_version + 1,
    ),
  );
}

export function transitionAutomaticTask(
  taskId: string,
  input: AutomaticTaskTransitionInput,
  idempotencyKey: string,
): Promise<AutomaticTaskWriteReceipt> {
  assertUuid(taskId, "taskId");
  const normalized = normalizeAutomaticTaskTransitionInput(input);
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/tasks/${taskId}/p3-transitions`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: normalized.action === "accept"
        ? { action: normalized.action, expected_record_version: normalized.expected_record_version }
        : normalized.action === "reassign"
          ? { action: normalized.action, expected_record_version: normalized.expected_record_version,
              reason: normalized.reason, next_assignee_user_id: normalized.next_assignee_user_id }
        : { action: normalized.action, expected_record_version: normalized.expected_record_version, reason: normalized.reason },
    },
    (value) => decodeAutomaticTaskWriteReceipt(
      value,
      taskId,
      normalized.expected_record_version + 1,
      normalized.action,
    ),
  );
}

export function completeApplicationTask(
  taskId: string,
  targetId: string,
  input: CompleteApplicationTaskInput,
  idempotencyKey: string,
): Promise<ApplicationTaskCompletionReceipt> {
  assertUuid(taskId, "taskId");
  assertUuid(targetId, "targetId");
  const normalized = normalizeCompleteApplicationTaskInput(input);
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/tasks/${taskId}/p3-transitions`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        action: normalized.action,
        expected_record_version: normalized.expected_record_version,
        completion_record: {
          submitted_at: normalized.completion_record.submitted_at,
          submission_channel: normalized.completion_record.submission_channel,
          submitter_user_id: normalized.completion_record.submitter_user_id,
          checklist_snapshot: {
            all_required_items_complete: normalized.completion_record.checklist_snapshot.all_required_items_complete,
            confirmed_at: normalized.completion_record.checklist_snapshot.confirmed_at,
          },
          official_submission_reference: normalized.completion_record.official_submission_reference,
          no_reference_declared: normalized.completion_record.no_reference_declared,
        },
        evidence_reference: normalized.evidence_reference,
      },
    },
    (value) => decodeApplicationTaskCompletionReceipt(
      value,
      taskId,
      targetId,
      normalized.expected_record_version + 1,
    ),
  );
}

export function classifyTaskFailure(error: unknown): TaskFailureKind {
  if (!(error instanceof ApiClientError)) return "unavailable";
  if (error.code === "UNAUTHENTICATED" || error.status === 401) return "unauthenticated";
  if (error.code === "FORBIDDEN" || error.status === 403) return "forbidden";
  if (error.code === "NOT_FOUND" || error.status === 404) return "not_found";
  if (error.code === "VALIDATION_FAILED" || error.status === 422) return "validation";
  if (error.code === "STALE_VERSION") return "stale";
  if (error.code === "CONFLICT" || error.status === 409) return "conflict";
  return "unavailable";
}

export function createTaskFingerprint(input: CreateTaskInput): string {
  const normalized = normalizeCreateTaskInput(input);
  return JSON.stringify(normalized);
}

export function transitionTaskFingerprint(taskId: string, input: TransitionTaskInput): string {
  assertUuid(taskId, "taskId");
  const normalized = normalizeTransitionTaskInput(input);
  return JSON.stringify({ task_id: taskId, ...normalized });
}

export function automaticTaskTransitionFingerprint(
  taskId: string,
  input: AutomaticTaskTransitionInput | CompleteApplicationTaskInput,
): string {
  assertUuid(taskId, "taskId");
  const normalized = input.action === "complete"
    ? normalizeCompleteApplicationTaskInput(input)
    : normalizeAutomaticTaskTransitionInput(input);
  return JSON.stringify({ task_id: taskId, ...normalized });
}

export class TaskIdempotencyAttempt {
  private readonly createKey: () => string;
  private fingerprint: string | null = null;
  private key: string | null = null;

  constructor(createKey: () => string = () => globalThis.crypto.randomUUID()) {
    this.createKey = createKey;
  }

  keyFor(fingerprint: string): string {
    if (fingerprint.trim() === "") throw new TypeError("Invalid task fingerprint.");
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

function decodeTaskList(value: unknown, expectedCaseId?: string): TaskListResult {
  const record = exactRecord(value, ["audience", "tasks"]);
  const audience = oneOf(record.audience, AUDIENCES, "audience");
  if (expectedCaseId !== undefined && audience !== "case_workspace") {
    throw new TypeError("Case task list has an invalid audience.");
  }
  if (audience === "case_workspace") {
    const tasks = expectArray(record.tasks, decodeCaseWorkspaceTask);
    if (expectedCaseId !== undefined && tasks.some((task) => task.case_id !== expectedCaseId)) {
      throw new TypeError("Case task list contains another Case.");
    }
    assertUnique(tasks.map((task) => task.id), "task.id");
    return Object.freeze({ audience, tasks: Object.freeze(tasks) });
  }
  const tasks = expectArray(record.tasks, decodeAssignedTask);
  assertUnique(tasks.map((task) => task.id), "task.id");
  return Object.freeze({ audience, tasks: Object.freeze(tasks) });
}

function decodeTaskDetail(value: unknown): TaskDetailResult {
  const record = exactRecord(value, ["audience", "task"]);
  const audience = oneOf(record.audience, AUDIENCES, "audience");
  return audience === "case_workspace"
    ? Object.freeze({ audience, task: decodeCaseWorkspaceTask(record.task) })
    : Object.freeze({ audience, task: decodeAssignedTask(record.task) });
}

function decodeCaseWorkspaceTask(value: unknown): CaseWorkspaceTask {
  const record = exactRecord(value, [
    "id",
    "case_id",
    "case_number",
    "title",
    "task_brief",
    "due_at",
    "state",
    "assignee",
    "record_version",
    "updated_at",
    "available_transitions",
    "task_kind",
    "school_target_id",
    "is_overdue",
    "current_assignment",
    "allowed_actions",
  ]);
  const taskKind = oneOf(record.task_kind, TASK_KINDS, "task.task_kind");
  const schoolTargetId = nullableUuid(record.school_target_id, "task.school_target_id");
  assertTaskKindTarget(taskKind, schoolTargetId);
  return Object.freeze({
    id: uuid(record.id, "task.id"),
    case_id: uuid(record.case_id, "task.case_id"),
    case_number: boundedText(record.case_number, "task.case_number", 100),
    title: boundedText(record.title, "task.title", 300),
    task_brief: boundedText(record.task_brief, "task.task_brief", 4_000),
    due_at: isoTimestamp(record.due_at, "task.due_at"),
    state: oneOf(record.state, TASK_STATES, "task.state"),
    assignee: decodeTaskAssignee(record.assignee),
    record_version: positiveInteger(record.record_version, "task.record_version"),
    updated_at: isoTimestamp(record.updated_at, "task.updated_at"),
    available_transitions: decodeAvailableTransitions(record.available_transitions),
    task_kind: taskKind,
    school_target_id: schoolTargetId,
    is_overdue: expectBooleanValue(record.is_overdue, "task.is_overdue"),
    current_assignment: decodeCurrentTaskAssignment(record.current_assignment),
    allowed_actions: decodeAutomaticTaskActions(record.allowed_actions),
  });
}

function decodeAssignedTask(value: unknown): AssignedTask {
  const record = exactRecord(value, [
    "id",
    "title",
    "task_brief",
    "due_at",
    "state",
    "record_version",
    "updated_at",
    "available_transitions",
    "task_kind",
    "school_target_id",
    "is_overdue",
    "current_assignment",
    "allowed_actions",
  ]);
  const taskKind = oneOf(record.task_kind, TASK_KINDS, "task.task_kind");
  const schoolTargetId = nullableUuid(record.school_target_id, "task.school_target_id");
  assertTaskKindTarget(taskKind, schoolTargetId);
  return Object.freeze({
    id: uuid(record.id, "task.id"),
    title: boundedText(record.title, "task.title", 300),
    task_brief: boundedText(record.task_brief, "task.task_brief", 4_000),
    due_at: isoTimestamp(record.due_at, "task.due_at"),
    state: oneOf(record.state, TASK_STATES, "task.state"),
    record_version: positiveInteger(record.record_version, "task.record_version"),
    updated_at: isoTimestamp(record.updated_at, "task.updated_at"),
    available_transitions: decodeAvailableTransitions(record.available_transitions),
    task_kind: taskKind,
    school_target_id: schoolTargetId,
    is_overdue: expectBooleanValue(record.is_overdue, "task.is_overdue"),
    current_assignment: decodeCurrentTaskAssignment(record.current_assignment),
    allowed_actions: decodeAutomaticTaskActions(record.allowed_actions),
  });
}

function decodeCurrentTaskAssignment(value: unknown): CurrentTaskAssignment | null {
  if (value === null) return null;
  const record = exactRecord(value, ["id", "assignee_user_id", "assignee_role", "status"]);
  return Object.freeze({
    id: uuid(record.id, "assignment.id"),
    assignee_user_id: uuid(record.assignee_user_id, "assignment.assignee_user_id"),
    assignee_role: oneOf(record.assignee_role, ASSIGNEE_ROLES, "assignment.assignee_role"),
    status: boundedText(record.status, "assignment.status", 100),
  });
}

function decodeAutomaticTaskActions(value: unknown): readonly AutomaticTaskAction[] {
  const actions = expectArray(value, (action) => oneOf(action, AUTOMATIC_TASK_ACTIONS, "task.allowed_actions"));
  assertUnique(actions, "task.allowed_actions");
  return Object.freeze(actions);
}

function decodeTaskAssigneeOptions(value: unknown): TaskAssigneeOptions {
  const record = exactRecord(value, ["assignees"]);
  const assignees = expectArray(record.assignees, decodeTaskAssignee);
  if (assignees.length > 100) throw new TypeError("Too many Task assignees.");
  assertUnique(assignees.map((assignee) => assignee.id), "assignee.id");
  if (!isCanonicalAssigneeOrder(assignees)) throw new TypeError("Task assignees are not canonical.");
  return Object.freeze({ assignees: Object.freeze(assignees) });
}

function decodeTaskAssignee(value: unknown): TaskAssignee {
  const record = exactRecord(value, ["id", "role", "label"]);
  return Object.freeze({
    id: uuid(record.id, "assignee.id"),
    role: oneOf(record.role, ASSIGNEE_ROLES, "assignee.role"),
    label: boundedText(record.label, "assignee.label", 200),
  });
}

function decodeAvailableTransitions(value: unknown): readonly AvailableTaskTransition[] {
  const transitions = expectArray(value, (item) => {
    const record = exactRecord(item, ["to", "requires_reason", "requires_assignee"]);
    const to = oneOf(record.to, TASK_STATES, "transition.to");
    const requiresReason = expectBooleanValue(record.requires_reason, "transition.requires_reason");
    const requiresAssignee = expectBooleanValue(record.requires_assignee, "transition.requires_assignee");
    if (requiresAssignee !== (to === "assigned")) {
      throw new TypeError("Invalid Task transition assignee requirement.");
    }
    return Object.freeze({
      to,
      requires_reason: requiresReason,
      requires_assignee: requiresAssignee,
    });
  });
  assertUnique(transitions.map((transition) => transition.to), "transition.to");
  return Object.freeze(transitions);
}

function decodeTaskWriteReceipt(
  value: unknown,
  expectedId: string | undefined,
  expectedVersion: number,
): TaskWriteReceipt {
  const record = exactRecord(value, ["id", "record_version"]);
  const id = uuid(record.id, "receipt.id");
  const recordVersion = positiveInteger(record.record_version, "receipt.record_version");
  if (expectedId !== undefined && id !== expectedId) throw new TypeError("Mismatched Task receipt id.");
  if (recordVersion !== expectedVersion) throw new TypeError("Mismatched Task receipt version.");
  return Object.freeze({ id, record_version: recordVersion });
}

function decodeAutomaticTaskWriteReceipt(
  value: unknown,
  expectedId: string,
  expectedVersion: number,
  action: AutomaticTaskTransitionInput["action"],
): AutomaticTaskWriteReceipt {
  const record = exactRecord(value, ["id", "record_version", "state", "completion_receipt_id"]);
  const receipt = decodeTaskWriteReceipt(
    { id: record.id, record_version: record.record_version },
    expectedId,
    expectedVersion,
  );
  const expectedState = action === "accept" ? "accepted" : action === "cancel" ? "cancelled" : "assigned";
  const state = oneOf(record.state, TASK_STATES, "receipt.state");
  if (state !== expectedState || record.completion_receipt_id !== null) {
    throw new TypeError("Mismatched automatic Task receipt.");
  }
  return Object.freeze({ ...receipt, state, completion_receipt_id: null });
}

function decodeApplicationTaskCompletionReceipt(
  value: unknown,
  expectedId: string,
  expectedTargetId: string,
  expectedVersion: number,
): ApplicationTaskCompletionReceipt {
  const record = exactRecord(value, ["id", "record_version", "state", "completion_receipt_id", "automation"]);
  const receipt = decodeTaskWriteReceipt(
    { id: record.id, record_version: record.record_version },
    expectedId,
    expectedVersion,
  );
  const state = oneOf(record.state, TASK_STATES, "receipt.state");
  const completionReceiptId = uuid(record.completion_receipt_id, "receipt.completion_receipt_id");
  if (state !== "completed") throw new TypeError("Mismatched application Task completion state.");
  const automationRecord = exactRecord(record.automation, ["target_transition", "target_id", "target_record_version"]);
  const targetTransition = oneOf(automationRecord.target_transition, ["completed", "pending"] as const, "receipt.automation.target_transition");
  const targetId = uuid(automationRecord.target_id, "receipt.automation.target_id");
  const targetRecordVersion = automationRecord.target_record_version === null
    ? null
    : positiveInteger(automationRecord.target_record_version, "receipt.automation.target_record_version");
  if (targetId !== expectedTargetId ||
      (targetTransition === "completed" && targetRecordVersion === null) ||
      (targetTransition === "pending" && targetRecordVersion !== null)) {
    throw new TypeError("Mismatched application Task automation receipt.");
  }
  return Object.freeze({
    ...receipt,
    state,
    completion_receipt_id: completionReceiptId,
    automation: Object.freeze({
      target_transition: targetTransition,
      target_id: targetId,
      target_record_version: targetRecordVersion,
    }),
  });
}

function normalizeCreateTaskInput(input: CreateTaskInput): CreateTaskInput {
  assertUuid(input.case_id, "case_id");
  assertUuid(input.assignee_user_id, "assignee_user_id");
  return Object.freeze({
    case_id: input.case_id,
    title: normalizeBoundedText(input.title, "title", 300),
    task_brief: normalizeBoundedText(input.task_brief, "task_brief", 4_000),
    due_at: isoTimestamp(input.due_at, "due_at"),
    assignee_user_id: input.assignee_user_id,
  });
}

function normalizeTransitionTaskInput(input: TransitionTaskInput): TransitionTaskInput {
  const to = oneOf(input.to, TASK_STATES, "to");
  const expectedRecordVersion = positiveInteger(
    input.expected_record_version,
    "expected_record_version",
  );
  const reason = input.reason.trim();
  if (reason.length > 4_000) throw new TypeError("Invalid reason.");
  const nextAssigneeUserId = input.next_assignee_user_id;
  if (to === "assigned") {
    if (nextAssigneeUserId === null) throw new TypeError("Reassignment requires an assignee.");
    assertUuid(nextAssigneeUserId, "next_assignee_user_id");
  } else if (nextAssigneeUserId !== null) {
    throw new TypeError("This transition cannot include an assignee.");
  }
  return Object.freeze({
    to,
    expected_record_version: expectedRecordVersion,
    reason,
    next_assignee_user_id: nextAssigneeUserId,
  });
}

function normalizeAutomaticTaskTransitionInput(
  input: AutomaticTaskTransitionInput,
): AutomaticTaskTransitionInput {
  const action = oneOf(input.action, ["accept", "reject", "reassign", "cancel"] as const, "action");
  const expectedRecordVersion = positiveInteger(input.expected_record_version, "expected_record_version");
  if (action === "accept") {
    return Object.freeze({ action, expected_record_version: expectedRecordVersion });
  }
  if (!("reason" in input)) throw new TypeError("Task transition requires a reason.");
  const reason = normalizeBoundedText(input.reason, "reason", 4_000);
  if (action === "reassign") {
    const nextAssigneeUserId = "next_assignee_user_id" in input ? input.next_assignee_user_id : undefined;
    if (!nextAssigneeUserId) throw new TypeError("Reassignment requires an assignee.");
    assertUuid(nextAssigneeUserId, "next_assignee_user_id");
    return Object.freeze({ action, expected_record_version: expectedRecordVersion, reason,
      next_assignee_user_id: nextAssigneeUserId });
  }
  return Object.freeze({ action, expected_record_version: expectedRecordVersion, reason });
}

function normalizeCompleteApplicationTaskInput(
  input: CompleteApplicationTaskInput,
): CompleteApplicationTaskInput {
  if (input.action !== "complete") throw new TypeError("Invalid application Task action.");
  const expectedRecordVersion = positiveInteger(input.expected_record_version, "expected_record_version");
  const record = input.completion_record;
  const submittedAt = pastOrPresentIsoTimestamp(record.submitted_at, "completion_record.submitted_at");
  const confirmedAt = pastOrPresentIsoTimestamp(record.checklist_snapshot.confirmed_at, "completion_record.checklist_snapshot.confirmed_at");
  const submissionChannel = oneOf(record.submission_channel, SUBMISSION_CHANNELS, "completion_record.submission_channel");
  assertUuid(record.submitter_user_id, "completion_record.submitter_user_id");
  if (record.checklist_snapshot.all_required_items_complete !== true) {
    throw new TypeError("Application checklist is incomplete.");
  }
  const noReferenceDeclared = record.no_reference_declared;
  if (typeof noReferenceDeclared !== "boolean") throw new TypeError("Invalid no_reference_declared.");
  const officialReference = record.official_submission_reference === null
    ? null
    : record.official_submission_reference.trim();
  if ((noReferenceDeclared && officialReference !== null) ||
      (!noReferenceDeclared && (officialReference === null || officialReference === ""))) {
    throw new TypeError("Application reference selection is invalid.");
  }
  const evidenceReference = input.evidence_reference;
  if (evidenceReference !== null) assertUuid(evidenceReference, "evidence_reference");
  if (noReferenceDeclared && evidenceReference === null) {
    throw new TypeError("No-reference completion requires evidence.");
  }
  return Object.freeze({
    action: "complete",
    expected_record_version: expectedRecordVersion,
    completion_record: Object.freeze({
      submitted_at: submittedAt,
      submission_channel: submissionChannel,
      submitter_user_id: record.submitter_user_id,
      checklist_snapshot: Object.freeze({
        all_required_items_complete: true,
        confirmed_at: confirmedAt,
      }),
      official_submission_reference: officialReference,
      no_reference_declared: noReferenceDeclared,
    }),
    evidence_reference: evidenceReference,
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = expectRecord(value);
  const expected = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new TypeError("Unexpected Task response fields.");
  }
  return record;
}

function uuid(value: unknown, field: string): string {
  const parsed = expectString(value);
  assertUuid(parsed, field);
  return parsed;
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  const parsed = expectString(value);
  if (parsed.trim() === "" || parsed !== parsed.trim() || parsed.length > maxLength) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return parsed;
}

function normalizeBoundedText(value: string, field: string, maxLength: number): string {
  return boundedText(value.trim(), field, maxLength);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = expectNumber(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`Invalid ${field}.`);
  return parsed;
}

function isoTimestamp(value: unknown, field: string): string {
  const parsed = expectString(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return parsed;
}

function pastOrPresentIsoTimestamp(value: unknown, field: string): string {
  const parsed = isoTimestamp(value, field);
  if (Date.parse(parsed) > Date.now()) throw new TypeError(`Future ${field}.`);
  return parsed;
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function assertTaskKindTarget(kind: TaskKind, targetId: string | null): void {
  if ((kind === "manual") !== (targetId === null)) {
    throw new TypeError("Task kind and SchoolTarget do not match.");
  }
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

function expectBooleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`Invalid ${field}.`);
  return value;
}

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`Invalid ${field}.`);
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value)) throw new TypeError("Invalid idempotency key.");
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${field}.`);
}

function isCanonicalAssigneeOrder(assignees: readonly TaskAssignee[]): boolean {
  const sorted = [...assignees].sort((left, right) => (
    left.role.localeCompare(right.role) ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id)
  ));
  return assignees.every((assignee, index) => assignee.id === sorted[index]?.id);
}
