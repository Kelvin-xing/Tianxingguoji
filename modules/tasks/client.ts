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

export type TaskAudience = (typeof AUDIENCES)[number];
export type TaskAssigneeRole = (typeof ASSIGNEE_ROLES)[number];

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

interface TaskBase {
  readonly id: string;
  readonly title: string;
  readonly task_brief: string;
  readonly due_at: string;
  readonly state: TaskState;
  readonly record_version: number;
  readonly updated_at: string;
  readonly available_transitions: readonly AvailableTaskTransition[];
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
  ]);
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
  ]);
  return Object.freeze({
    id: uuid(record.id, "task.id"),
    title: boundedText(record.title, "task.title", 300),
    task_brief: boundedText(record.task_brief, "task.task_brief", 4_000),
    due_at: isoTimestamp(record.due_at, "task.due_at"),
    state: oneOf(record.state, TASK_STATES, "task.state"),
    record_version: positiveInteger(record.record_version, "task.record_version"),
    updated_at: isoTimestamp(record.updated_at, "task.updated_at"),
    available_transitions: decodeAvailableTransitions(record.available_transitions),
  });
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
