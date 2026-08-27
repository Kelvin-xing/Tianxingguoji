import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  hashRedactedSnapshot,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import { TASK_STATES, type TaskState } from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REASON_LENGTH = 4_000;

export interface TaskWorkflowClock {
  nowMs(): number;
}

export interface TransitionTaskCommand {
  readonly to: TaskState;
  readonly expectedRecordVersion: number;
  readonly reason: string;
  readonly nextAssigneeUserId: string | null;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface TaskTransitionResult {
  readonly taskId: string;
  readonly state: TaskState;
  readonly recordVersion: number;
}

export interface TaskTransitionRepositoryInput {
  readonly organizationId: string;
  readonly actor: IdentitySessionActor;
  readonly taskId: string;
  readonly to: TaskState;
  readonly expectedRecordVersion: number;
  readonly reason: string;
  readonly nextAssigneeUserId: string | null;
  readonly transitionReceiptId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly transitionedAtMs: number;
  readonly effects: MutationEffectBundle;
}

export interface TaskTransitionRepository {
  /**
   * The production adapter must do every authorizing read and write in one
   * RDS transaction: task/policy/assignment/Primary Advisor lock, actor and
   * role checks, exact Release 1 matrix check, idempotency, receipt, task
   * update, append-only audit, and outbox insert.
   */
  transitionTask(input: TaskTransitionRepositoryInput): Promise<TaskTransitionResult>;
}

export type TaskWorkflowErrorCode =
  | "TASK_COMMAND_INVALID"
  | "TASK_NOT_FOUND"
  | "TASK_POLICY_NOT_APPROVED"
  | "TASK_POLICY_MATRIX_MISMATCH"
  | "TASK_PRIMARY_ADVISOR_REQUIRED"
  | "TASK_ASSIGNMENT_TARGET_REQUIRED"
  | "TASK_ASSIGNMENT_TARGET_INVALID"
  | "TASK_TRANSITION_STALE_VERSION"
  | "TASK_TRANSITION_NOT_ALLOWED"
  | "TASK_ACTOR_NOT_ALLOWED"
  | "TASK_APPROVAL_SEPARATION_REQUIRED"
  | "TASK_REASON_REQUIRED"
  | "TASK_IDEMPOTENCY_KEY_REUSED"
  | "TASK_IDEMPOTENCY_IN_PROGRESS";

export class TaskWorkflowError extends Error {
  readonly code: TaskWorkflowErrorCode;

  constructor(code: TaskWorkflowErrorCode) {
    super(`Task workflow rejected ${code}.`);
    this.name = "TaskWorkflowError";
    this.code = code;
  }
}

export interface TaskWorkflowServiceOptions {
  readonly repository: TaskTransitionRepository;
  readonly clock?: TaskWorkflowClock;
  readonly createId?: () => string;
}

/**
 * Release 1 task transition command seam. Identity validates the opaque
 * session and fresh TOTP boundary before invoking this service; the repository
 * keeps authorization-sensitive reads beside the authoritative write.
 */
export class TaskWorkflowService {
  private readonly repository: TaskTransitionRepository;
  private readonly clock: TaskWorkflowClock;
  private readonly createId: () => string;

  constructor(options: TaskWorkflowServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async transitionTask(input: {
    readonly actor: IdentitySessionActor;
    readonly taskId: string;
    readonly command: TransitionTaskCommand;
  }): Promise<TaskTransitionResult> {
    assertInput(input);
    const transitionedAtMs = this.clock.nowMs();
    if (!Number.isFinite(transitionedAtMs) || transitionedAtMs <= 0) {
      throw new TaskWorkflowError("TASK_COMMAND_INVALID");
    }

    const transitionReceiptId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [transitionReceiptId, auditId, outboxId]) assertUuid(id);

    const occurredAt = new Date(transitionedAtMs).toISOString();
    const nextRecordVersion = input.command.expectedRecordVersion + 1;
    const reasonCode = input.command.reason.trim() === "" ? "not_required" : "provided";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType: "tasks.task_transitioned",
      eventVersion: 1,
      action: "transition",
      resourceType: "Task",
      resourceId: input.taskId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      beforeHashSha256: hashRedactedSnapshot({
        record_version: input.command.expectedRecordVersion,
        status: "before_transition",
      }),
      afterHashSha256: hashRedactedSnapshot({
        record_version: nextRecordVersion,
        status: input.command.to,
      }),
      metadata: {
        previous_version: input.command.expectedRecordVersion,
        next_version: nextRecordVersion,
        status: input.command.to,
        reason_code: reasonCode,
        effect_type: "task_transitioned",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "Task",
      aggregateId: input.taskId,
      eventType: "tasks.task_transitioned",
      eventVersion: 1,
      idempotencyKey: `task-transition-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: input.taskId,
        record_version: nextRecordVersion,
        request_id: input.command.requestId,
        effect_type: "task_transitioned",
        operation: "tasks.transition",
        status: input.command.to,
        reason_code: reasonCode,
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.transitionTask({
      organizationId: input.actor.organizationId,
      actor: input.actor,
      taskId: input.taskId,
      to: input.command.to,
      expectedRecordVersion: input.command.expectedRecordVersion,
      reason: input.command.reason.trim(),
      nextAssigneeUserId: input.command.nextAssigneeUserId,
      transitionReceiptId,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        expected_record_version: input.command.expectedRecordVersion,
        next_assignee_user_id: input.command.nextAssigneeUserId,
        reason: input.command.reason.trim(),
        task_id: input.taskId,
        to: input.command.to,
      }),
      transitionedAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

function assertInput(input: {
  readonly actor: IdentitySessionActor;
  readonly taskId: string;
  readonly command: TransitionTaskCommand;
}): void {
  if (!UUID.test(input.actor.organizationId) || !UUID.test(input.actor.userId) || !UUID.test(input.taskId)) {
    throw new TaskWorkflowError("TASK_COMMAND_INVALID");
  }
  if (!(TASK_STATES as readonly string[]).includes(input.command.to)) {
    throw new TaskWorkflowError("TASK_COMMAND_INVALID");
  }
  if (
    !Number.isSafeInteger(input.command.expectedRecordVersion) ||
    input.command.expectedRecordVersion < 1 ||
    typeof input.command.reason !== "string" ||
    input.command.reason.length > MAX_REASON_LENGTH ||
    !REQUEST_ID.test(input.command.requestId)
  ) {
    throw new TaskWorkflowError("TASK_COMMAND_INVALID");
  }
  try {
    validateIdempotencyKey(input.command.idempotencyKey);
  } catch {
    throw new TaskWorkflowError("TASK_COMMAND_INVALID");
  }

  if (input.command.to === "assigned") {
    if (input.command.nextAssigneeUserId === null) {
      throw new TaskWorkflowError("TASK_ASSIGNMENT_TARGET_REQUIRED");
    }
    if (!UUID.test(input.command.nextAssigneeUserId)) {
      throw new TaskWorkflowError("TASK_ASSIGNMENT_TARGET_INVALID");
    }
  } else if (input.command.nextAssigneeUserId !== null) {
    throw new TaskWorkflowError("TASK_COMMAND_INVALID");
  }
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new TaskWorkflowError("TASK_COMMAND_INVALID");
}
