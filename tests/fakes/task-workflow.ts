import type { MutationEffectBundle } from "../../modules/audit/domain/contract.ts";
import type { OrganizationRole } from "../../modules/access/domain/contract.ts";
import type { IdentitySessionActor } from "../../modules/identity/infrastructure/in-memory-session-repository.ts";
import type { TaskState, TaskTransitionPolicy } from "../../modules/tasks/domain/contract.ts";
import {
  evaluateTaskCreation,
  evaluateTaskTransition,
  approveTaskTransitionPolicy,
  proposeTaskTransitionPolicy,
} from "../../modules/tasks/domain/transition-policy.ts";
import {
  RELEASE_1_TASK_INITIAL_STATE,
  RELEASE_1_TASK_TRANSITION_RULES,
  hasRelease1TaskPolicyContent,
} from "../../modules/tasks/domain/release1-policy.ts";
import {
  TaskWorkflowError,
  type TaskTransitionRepository,
  type TaskTransitionRepositoryInput,
  type TaskTransitionResult,
} from "../../modules/tasks/application/service.ts";

interface StoredTask {
  readonly taskId: string;
  readonly organizationId: string;
  readonly caseId: string;
  readonly primaryAdvisorUserId: string;
  readonly policy: TaskTransitionPolicy;
  state: TaskState;
  recordVersion: number;
  assigneeUserId: string;
  assigneeRole: "advisor" | "contractor";
}

interface StoredIdempotencyResult {
  readonly requestHash: string;
  readonly result: TaskTransitionResult;
}

/**
 * Deterministic P1-13 adapter. It stages task, receipt, audit, outbox, and
 * idempotency facts before replacing state to model the production one-TX
 * port without offering a runtime persistence fallback.
 */
export class InMemoryTaskTransitionRepository implements TaskTransitionRepository {
  private readonly activeRoles = new Map<string, OrganizationRole>();
  private readonly tasks = new Map<string, StoredTask>();
  private readonly resultsByIdempotency = new Map<string, StoredIdempotencyResult>();
  private readonly receiptIds = new Set<string>();
  private readonly auditIds = new Set<string>();
  private readonly outboxIds = new Set<string>();
  private readonly assignmentIds = new Set<string>();
  private lastCommittedEffects: MutationEffectBundle | null = null;
  private failNextCommit = false;

  activateUser(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly role: OrganizationRole;
  }): void {
    this.activeRoles.set(this.actorKey(input.organizationId, input.userId), input.role);
  }

  seedAssignedTask(input: {
    readonly taskId: string;
    readonly organizationId: string;
    readonly caseId: string;
    readonly primaryAdvisorUserId: string;
    readonly assigneeUserId: string;
    readonly assigneeRole: "advisor" | "contractor";
    readonly policy?: TaskTransitionPolicy;
  }): void {
    const policy = input.policy ?? this.createRelease1Policy(input.organizationId);
    const creation = evaluateTaskCreation(policy);
    if (!creation.allowed || creation.initialState !== "assigned") {
      throw new Error("synthetic task requires the approved Release 1 initial state");
    }
    this.tasks.set(input.taskId, {
      taskId: input.taskId,
      organizationId: input.organizationId,
      caseId: input.caseId,
      primaryAdvisorUserId: input.primaryAdvisorUserId,
      policy,
      state: "assigned",
      recordVersion: 1,
      assigneeUserId: input.assigneeUserId,
      assigneeRole: input.assigneeRole,
    });
  }

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  snapshot(): Readonly<{
    tasks: number;
    transitionReceipts: number;
    assignments: number;
    audits: number;
    outbox: number;
    idempotencyResults: number;
  }> {
    return Object.freeze({
      tasks: this.tasks.size,
      transitionReceipts: this.receiptIds.size,
      assignments: this.assignmentIds.size,
      audits: this.auditIds.size,
      outbox: this.outboxIds.size,
      idempotencyResults: this.resultsByIdempotency.size,
    });
  }

  task(taskId: string): Readonly<{
    state: TaskState;
    recordVersion: number;
    assigneeUserId: string;
  }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("synthetic task not found");
    return Object.freeze({
      state: task.state,
      recordVersion: task.recordVersion,
      assigneeUserId: task.assigneeUserId,
    });
  }

  lastEffects(): MutationEffectBundle | null {
    return this.lastCommittedEffects;
  }

  async transitionTask(input: TaskTransitionRepositoryInput): Promise<TaskTransitionResult> {
    const idempotencyScope = [
      input.organizationId,
      input.actor.userId,
      "tasks.transition",
      input.idempotencyKey,
    ].join(":");
    const existing = this.resultsByIdempotency.get(idempotencyScope);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new TaskWorkflowError("TASK_IDEMPOTENCY_KEY_REUSED");
      }
      return existing.result;
    }

    const task = this.tasks.get(input.taskId);
    if (!task || task.organizationId !== input.organizationId) {
      throw new TaskWorkflowError("TASK_NOT_FOUND");
    }
    if (!hasRelease1TaskPolicyContent(task.policy) || task.policy.status !== "approved") {
      throw new TaskWorkflowError("TASK_POLICY_MATRIX_MISMATCH");
    }

    const actorRole = this.activeRoles.get(this.actorKey(input.organizationId, input.actor.userId));
    const decision = evaluateTaskTransition({
      policy: task.policy,
      organizationId: input.organizationId,
      taskOrganizationId: task.organizationId,
      caseId: task.caseId,
      taskCaseId: task.caseId,
      from: task.state,
      to: input.to,
      actorId: input.actor.userId,
      actorRole: input.actor.role,
      actorIsActive: actorRole === input.actor.role,
      assigneeId: task.assigneeUserId,
      approverId: input.to === "approved" && input.actor.role === "founder"
        ? input.actor.userId
        : null,
      ownerId: task.primaryAdvisorUserId,
      redactedTaskContext:
        input.actor.role !== "contractor" ||
        (task.assigneeRole === "contractor" && input.actor.userId === task.assigneeUserId),
      recordVersion: task.recordVersion,
      expectedRecordVersion: input.expectedRecordVersion,
      reason: input.reason,
    });
    if (!decision.allowed) throw decisionError(decision.code);

    if (
      (input.to === "reassigned" || input.to === "cancelled") &&
      task.primaryAdvisorUserId !== input.actor.userId
    ) {
      throw new TaskWorkflowError("TASK_PRIMARY_ADVISOR_REQUIRED");
    }

    let nextAssigneeUserId = task.assigneeUserId;
    let nextAssigneeRole = task.assigneeRole;
    if (input.to === "reassigned") {
      if (input.nextAssigneeUserId === null) {
        throw new TaskWorkflowError("TASK_ASSIGNMENT_TARGET_REQUIRED");
      }
      const targetRole = this.activeRoles.get(this.actorKey(input.organizationId, input.nextAssigneeUserId));
      if (targetRole !== "advisor" && targetRole !== "contractor") {
        throw new TaskWorkflowError("TASK_ASSIGNMENT_TARGET_INVALID");
      }
      nextAssigneeUserId = input.nextAssigneeUserId;
      nextAssigneeRole = targetRole;
    }

    const result: TaskTransitionResult = Object.freeze({
      taskId: input.taskId,
      state: input.to,
      recordVersion: task.recordVersion + 1,
    });
    const nextTask: StoredTask = {
      ...task,
      state: input.to,
      recordVersion: result.recordVersion,
      assigneeUserId: nextAssigneeUserId,
      assigneeRole: nextAssigneeRole,
    };
    const nextTasks = new Map(this.tasks);
    const nextResults = new Map(this.resultsByIdempotency);
    const nextReceiptIds = new Set(this.receiptIds);
    const nextAuditIds = new Set(this.auditIds);
    const nextOutboxIds = new Set(this.outboxIds);
    const nextAssignmentIds = new Set(this.assignmentIds);

    nextTasks.set(input.taskId, nextTask);
    nextResults.set(idempotencyScope, { requestHash: input.requestHash, result });
    nextReceiptIds.add(input.transitionReceiptId);
    nextAuditIds.add(input.effects.audit.id);
    nextOutboxIds.add(input.effects.outbox.id);
    if (input.to === "reassigned") nextAssignmentIds.add(input.transitionReceiptId);

    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic transaction failure");
    }

    this.tasks.clear();
    for (const [key, value] of nextTasks) this.tasks.set(key, value);
    this.resultsByIdempotency.clear();
    for (const [key, value] of nextResults) this.resultsByIdempotency.set(key, value);
    this.replaceSet(this.receiptIds, nextReceiptIds);
    this.replaceSet(this.auditIds, nextAuditIds);
    this.replaceSet(this.outboxIds, nextOutboxIds);
    this.replaceSet(this.assignmentIds, nextAssignmentIds);
    this.lastCommittedEffects = input.effects;
    return result;
  }

  private createRelease1Policy(organizationId: string): TaskTransitionPolicy {
    return approveTaskTransitionPolicy(
      proposeTaskTransitionPolicy({
        policyId: "00000000-0000-4000-8000-000000000091",
        version: 1,
        organizationId,
        requestedBy: "00000000-0000-4000-8000-000000000092",
        initialState: RELEASE_1_TASK_INITIAL_STATE,
        rules: RELEASE_1_TASK_TRANSITION_RULES,
        createdAt: "2026-08-07T00:00:00.000Z",
      }),
      {
        decisionId: "OD-06",
        decisionStatus: "resolved",
        reviewerId: "00000000-0000-4000-8000-000000000093",
        reviewerRole: "founder",
        approvedAt: "2026-08-07T00:05:00.000Z",
      },
    );
  }

  private actorKey(organizationId: string, userId: string): string {
    return `${organizationId}:${userId}`;
  }

  private replaceSet(target: Set<string>, source: ReadonlySet<string>): void {
    target.clear();
    for (const value of source) target.add(value);
  }
}

function decisionError(code: string): TaskWorkflowError {
  switch (code) {
    case "TASK_STALE_VERSION":
      return new TaskWorkflowError("TASK_TRANSITION_STALE_VERSION");
    case "TASK_TRANSITION_NOT_ALLOWED":
      return new TaskWorkflowError("TASK_TRANSITION_NOT_ALLOWED");
    case "TASK_APPROVAL_SEPARATION_REQUIRED":
      return new TaskWorkflowError("TASK_APPROVAL_SEPARATION_REQUIRED");
    case "TASK_REASON_REQUIRED":
      return new TaskWorkflowError("TASK_REASON_REQUIRED");
    case "TASK_ACTOR_NOT_ALLOWED":
    case "TASK_ACTOR_INACTIVE":
    case "TASK_CONTRACTOR_CONTEXT_REQUIRED":
    case "TASK_CONTRACTOR_ACTOR_NOT_ALLOWED":
      return new TaskWorkflowError("TASK_ACTOR_NOT_ALLOWED");
    default:
      return new TaskWorkflowError("TASK_POLICY_NOT_APPROVED");
  }
}
