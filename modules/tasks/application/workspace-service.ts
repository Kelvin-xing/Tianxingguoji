import { randomUUID } from "node:crypto";

import { evaluateBootstrapAuthorization, type OrganizationRole } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import { TASK_STATES, type TaskState } from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type TaskAudience = "case_workspace" | "assigned_task";
export type TaskAssigneeRole = "advisor" | "contractor";
export interface TaskAssigneeView { readonly id: string; readonly role: TaskAssigneeRole; readonly label: string }
export interface AvailableTaskTransitionView {
  readonly to: TaskState; readonly requiresReason: boolean; readonly requiresAssignee: boolean;
}
export interface TaskBaseView {
  readonly id: string; readonly title: string; readonly taskBrief: string; readonly dueAt: string;
  readonly state: TaskState; readonly recordVersion: number; readonly updatedAt: string;
  readonly availableTransitions: readonly AvailableTaskTransitionView[];
}
export interface CaseWorkspaceTaskView extends TaskBaseView {
  readonly caseId: string; readonly caseNumber: string; readonly assignee: TaskAssigneeView;
}
export type AssignedTaskView = TaskBaseView;
export type TaskView = CaseWorkspaceTaskView | AssignedTaskView;
export interface TaskCollectionView { readonly audience: TaskAudience; readonly tasks: readonly TaskView[] }
export interface TaskDetailView { readonly audience: TaskAudience; readonly task: TaskView }
export interface TaskOptionsView { readonly assignees: readonly TaskAssigneeView[] }
export interface TaskAcknowledgement { readonly id: string; readonly recordVersion: number }

export interface TaskActorContext {
  readonly organizationId: string; readonly actorUserId: string; readonly actorRole: OrganizationRole;
}
export interface TaskWorkspaceRepository {
  list(input: TaskActorContext & { readonly caseId: string | null }): Promise<TaskCollectionView>;
  detail(input: TaskActorContext & { readonly taskId: string }): Promise<TaskDetailView | null>;
  options(input: TaskActorContext & { readonly caseId: string }): Promise<TaskOptionsView | null>;
  create(input: TaskActorContext & {
    readonly taskId: string; readonly caseId: string; readonly title: string; readonly taskBrief: string;
    readonly dueAt: string; readonly assigneeUserId: string; readonly requestId: string;
    readonly idempotencyKey: string; readonly requestHash: string; readonly effects: MutationEffectBundle;
  }): Promise<TaskAcknowledgement>;
  transition(input: TaskActorContext & {
    readonly taskId: string; readonly receiptId: string; readonly to: TaskState;
    readonly expectedRecordVersion: number; readonly reason: string; readonly nextAssigneeUserId: string | null;
    readonly requestId: string; readonly idempotencyKey: string; readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<TaskAcknowledgement>;
}

export type TaskWorkspaceErrorCode =
  | "TASK_FORBIDDEN" | "TASK_INVALID" | "TASK_NOT_FOUND" | "TASK_STALE_VERSION"
  | "TASK_CONFLICT" | "TASK_POLICY_UNAVAILABLE" | "TASK_UNAVAILABLE";
const ERROR_CODES = new Set<TaskWorkspaceErrorCode>([
  "TASK_FORBIDDEN", "TASK_INVALID", "TASK_NOT_FOUND", "TASK_STALE_VERSION",
  "TASK_CONFLICT", "TASK_POLICY_UNAVAILABLE", "TASK_UNAVAILABLE",
]);
export class TaskWorkspaceError extends Error {
  readonly code: TaskWorkspaceErrorCode;
  constructor(code: TaskWorkspaceErrorCode) {
    super(`Task workspace rejected ${code}.`); this.name = "TaskWorkspaceError"; this.code = code;
  }
}
export function isTaskWorkspaceError(value: unknown, code?: TaskWorkspaceErrorCode): value is TaskWorkspaceError {
  if (!(value instanceof Error) || value.name !== "TaskWorkspaceError") return false;
  const candidate = (value as Error & { code?: unknown }).code;
  return typeof candidate === "string" && ERROR_CODES.has(candidate as TaskWorkspaceErrorCode) &&
    (code === undefined || candidate === code);
}

export class TaskWorkspaceService {
  private readonly repository: TaskWorkspaceRepository;
  private readonly createId: () => string;
  private readonly now: () => number;
  constructor(
    repository: TaskWorkspaceRepository,
    createId: () => string = randomUUID,
    now: () => number = Date.now,
  ) { this.repository = repository; this.createId = createId; this.now = now; }

  list(actor: IdentitySessionActor, caseId: string | null): Promise<TaskCollectionView> {
    const context = authorize(actor, "tasks.read");
    if (caseId !== null && !UUID.test(caseId)) invalid();
    return this.repository.list({ ...context, caseId });
  }
  detail(actor: IdentitySessionActor, taskId: string): Promise<TaskDetailView | null> {
    const context = authorize(actor, "tasks.read"); if (!UUID.test(taskId)) invalid();
    return this.repository.detail({ ...context, taskId });
  }
  options(actor: IdentitySessionActor, caseId: string): Promise<TaskOptionsView | null> {
    const context = authorize(actor, "tasks.create"); if (!UUID.test(caseId)) invalid();
    return this.repository.options({ ...context, caseId });
  }
  create(input: { readonly actor: IdentitySessionActor; readonly command: {
    readonly caseId: string; readonly title: string; readonly taskBrief: string; readonly dueAt: string;
    readonly assigneeUserId: string; readonly requestId: string; readonly idempotencyKey: string;
  } }): Promise<TaskAcknowledgement> {
    const context = authorize(input.actor, "tasks.create"); const command = input.command;
    if (!UUID.test(command.caseId) || !UUID.test(command.assigneeUserId) || !REQUEST_ID.test(command.requestId) ||
        command.title !== command.title.trim() || command.title.length < 1 || command.title.length > 300 ||
        command.taskBrief !== command.taskBrief.trim() || command.taskBrief.length < 1 || command.taskBrief.length > 4_000 ||
        !isIsoInstant(command.dueAt)) invalid();
    validateKey(command.idempotencyKey);
    const taskId = checkedId(this.createId); const effects = mutationEffects({ actor: input.actor,
      resourceId: taskId, requestId: command.requestId, operation: "tasks.create", status: "assigned",
      recordVersion: 1, occurredAt: checkedNow(this.now), createId: this.createId });
    return this.repository.create({ ...context, taskId, ...command,
      requestHash: hashRequestPayload({ assignee_user_id: command.assigneeUserId, case_id: command.caseId,
        due_at: command.dueAt, task_brief: command.taskBrief, title: command.title }), effects });
  }
  transition(input: { readonly actor: IdentitySessionActor; readonly taskId: string; readonly command: {
    readonly to: TaskState; readonly expectedRecordVersion: number; readonly reason: string;
    readonly nextAssigneeUserId: string | null; readonly requestId: string; readonly idempotencyKey: string;
  } }): Promise<TaskAcknowledgement> {
    const context = authorize(input.actor, "tasks.transition"); const command = input.command;
    if (!UUID.test(input.taskId) || !(TASK_STATES as readonly string[]).includes(command.to) ||
        !Number.isSafeInteger(command.expectedRecordVersion) || command.expectedRecordVersion < 1 ||
        command.reason !== command.reason.trim() || command.reason.length > 4_000 || !REQUEST_ID.test(command.requestId)) invalid();
    if (command.to === "reassigned") { if (!command.nextAssigneeUserId || !UUID.test(command.nextAssigneeUserId)) invalid(); }
    else if (command.nextAssigneeUserId !== null) invalid();
    validateKey(command.idempotencyKey);
    const effects = mutationEffects({ actor: input.actor, resourceId: input.taskId, requestId: command.requestId,
      operation: "tasks.transition", status: command.to, recordVersion: command.expectedRecordVersion + 1,
      occurredAt: checkedNow(this.now), createId: this.createId });
    return this.repository.transition({ ...context, taskId: input.taskId, receiptId: checkedId(this.createId), ...command,
      requestHash: hashRequestPayload({ expected_record_version: command.expectedRecordVersion,
        next_assignee_user_id: command.nextAssigneeUserId, reason: command.reason, task_id: input.taskId, to: command.to }), effects });
  }
}

function authorize(actor: IdentitySessionActor, capability: "tasks.read" | "tasks.create" | "tasks.transition"): TaskActorContext {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !evaluateBootstrapAuthorization(actor.role, { capability }).allowed) forbidden();
  return { organizationId: actor.organizationId, actorUserId: actor.userId, actorRole: actor.role };
}
function mutationEffects(input: { actor: IdentitySessionActor; resourceId: string; requestId: string;
  operation: "tasks.create" | "tasks.transition"; status: string; recordVersion: number; occurredAt: string;
  createId: () => string }): MutationEffectBundle {
  const auditId = checkedId(input.createId); const eventType = input.operation === "tasks.create" ? "tasks.task_created" : "tasks.task_transitioned";
  const audit = buildAuditEvent({ id: auditId, organizationId: input.actor.organizationId,
    actorUserId: input.actor.userId, actorKind: "user", eventType, eventVersion: 1,
    action: input.operation === "tasks.create" ? "create" : "transition", resourceType: "Task",
    resourceId: input.resourceId, outcome: "succeeded", requestId: input.requestId, occurredAt: input.occurredAt,
    metadata: { effect_type: input.operation, record_version: input.recordVersion, status: input.status } });
  const outbox = buildOutboxMessage({ id: checkedId(input.createId), auditEventId: auditId,
    organizationId: input.actor.organizationId, aggregateType: "Task", aggregateId: input.resourceId,
    eventType, eventVersion: 1, idempotencyKey: `task-${auditId}`, requestId: input.requestId,
    payload: { aggregate_id: input.resourceId, effect_type: input.operation,
      record_version: input.recordVersion, request_id: input.requestId, status: input.status },
    availableAt: input.occurredAt, createdAt: input.occurredAt });
  return buildAtomicMutationEffects({ audit, outbox });
}
function checkedId(createId: () => string): string { const value = createId(); if (!UUID.test(value)) invalid(); return value; }
function checkedNow(now: () => number): string { const value = now(); if (!Number.isFinite(value) || value <= 0) invalid(); return new Date(value).toISOString(); }
function isIsoInstant(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)); }
function validateKey(value: string): void { try { validateIdempotencyKey(value); } catch { invalid(); } }
function invalid(): never { throw new TaskWorkspaceError("TASK_INVALID"); }
function forbidden(): never { throw new TaskWorkspaceError("TASK_FORBIDDEN"); }
