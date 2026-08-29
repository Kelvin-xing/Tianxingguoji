import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import {
  hashRequestPayload,
  type AccessTaskFactsPort,
  type CasesTaskFactsPort,
  type DocumentsCleanEvidencePort,
} from "../../shared/public.ts";
import {
  IdempotencyExecutionError,
  runIdempotentTransaction,
  type TenantTransaction,
  type TenantTransactionRunner,
} from "../../shared/server.ts";
import {
  P3TaskError,
  type P3EnsureTargetTaskRepositoryInput,
  type P3TaskAcknowledgement,
  type P3TaskKind,
  type P3TaskRepository,
  type P3TransitionTargetTaskRepositoryInput,
} from "../application/p3-service.ts";
import { isValidApplicationCompletion } from "../domain/p3-be-05-policy.ts";

export interface P3TaskRepositoryTestHooks {
  readonly failBeforeCommit?: (operation: "ensure" | "transition") => void;
}

export class PostgresqlP3TaskRepository implements P3TaskRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly casesFacts: CasesTaskFactsPort;
  private readonly accessFacts: AccessTaskFactsPort;
  private readonly evidence: DocumentsCleanEvidencePort;
  private readonly hooks: P3TaskRepositoryTestHooks;
  constructor(
    runner: TenantTransactionRunner, casesFacts: CasesTaskFactsPort,
    accessFacts: AccessTaskFactsPort, evidence: DocumentsCleanEvidencePort,
    hooks: P3TaskRepositoryTestHooks = {},
  ) { this.runner = runner; this.casesFacts = casesFacts; this.accessFacts = accessFacts; this.evidence = evidence; this.hooks = hooks; }

  async ensureTargetTask(input: P3EnsureTargetTaskRepositoryInput): Promise<P3TaskAcknowledgement> {
    const context = actorContext(input.actor.organizationId, input.actor.userId, input.requestId);
    try {
      const result = await runIdempotentTransaction({
        runner: this.runner, context,
        claim: { id: input.idempotencyRecordId, organizationId: input.actor.organizationId,
          actorKind: "user", actorOpaqueId: input.actor.userId,
          operation: "tasks.school_target.provision", key: input.idempotencyKey,
          requestHash: input.requestHash, createdAt: input.effects.audit.occurredAt },
        revalidate: async (transaction) => {
          const facts = await this.casesFacts.readTargetTaskFacts(transaction, {
            organizationId: input.actor.organizationId, caseId: input.caseId,
            targetId: input.targetId, assignmentId: input.assignmentId,
          });
          if (!facts || facts.caseId !== input.caseId || facts.targetId !== input.targetId ||
              facts.assignmentId !== input.assignmentId || facts.caseStage === "closed" || facts.workflowStatus !== "active") {
            throw new P3TaskError("NOT_FOUND");
          }
          const expectedState = input.kind === "application_prepare_submit" ? "preparing" : "interview";
          if (facts.state !== expectedState) {
            throw new P3TaskError("CONFLICT");
          }
          const actor = await this.accessFacts.readActorBindingFacts(transaction, {
            organizationId: input.actor.organizationId, userId: input.actor.userId,
          });
          if (!actor || !actor.bindings.some((binding) => binding.role !== "contractor")) {
            throw new P3TaskError("FORBIDDEN");
          }
          if (!await this.accessFacts.canAssigneeOperate(transaction, {
            organizationId: input.actor.organizationId, caseId: input.caseId,
            userId: facts.assigneeUserId, kind: input.kind, assigneeRole: facts.assigneeRole,
            isPrimaryAdvisor: facts.isPrimaryAdvisor, collaboratorId: facts.collaboratorId,
          })) throw new P3TaskError("FORBIDDEN");
        },
        execute: async (transaction) => {
          const existing = await transaction.query<TaskRow>({
            text: `SELECT id, task_kind, school_target_id, service_case_id, state, record_version,
                          last_transition_receipt_id
                     FROM tasks_tasks WHERE organization_id=$1 AND task_key=$2 FOR UPDATE`,
            values: [input.actor.organizationId, input.taskKey],
          });
          if (existing.rows[0]) {
            const row = existing.rows[0];
            if (row.task_kind !== input.kind || row.school_target_id !== input.targetId || row.service_case_id !== input.caseId) {
              throw new P3TaskError("CONFLICT");
            }
            return outcome(input, acknowledgement(row, input.kind));
          }
          const facts = await this.casesFacts.readTargetTaskFacts(transaction, {
            organizationId: input.actor.organizationId, caseId: input.caseId,
            targetId: input.targetId, assignmentId: input.assignmentId,
          });
          if (!facts) throw new P3TaskError("NOT_FOUND");
          await transaction.query({
            text: `INSERT INTO tasks_tasks
              (id,organization_id,service_case_id,school_target_id,task_kind,task_key,creation_trigger,
               source_event_id,title,task_brief,due_at,state,assignee_user_id,assignee_role,
               assignee_redaction_profile,owner_user_id,record_version,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,'case_event',$7,$8,$9,$10,'assigned',$11,$12,$13,$14,1,transaction_timestamp())`,
            values: [input.taskId, input.actor.organizationId, input.caseId, input.targetId, input.kind,
              input.taskKey, input.sourceEventId, input.title, input.brief, input.dueAt,
              facts.assigneeUserId, facts.assigneeRole,
              facts.assigneeRole === "contractor" ? "task_only" : null, facts.ownerUserId],
          });
          await transaction.query({
            text: `INSERT INTO tasks_task_assignments
              (id,organization_id,task_id,assignee_user_id,assignee_role,redaction_profile,
               assignee_membership_id,assignee_role_binding_id,case_collaborator_id,
               assigned_by_user_id,status,reason,assignment_reason,assigned_at,record_version,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'assigned',$11,$11,$12,1,$12)`,
            values: [input.assignmentId, input.actor.organizationId, input.taskId, facts.assigneeUserId,
              facts.assigneeRole, facts.assigneeRole === "contractor" ? "task_only" : null,
              facts.assigneeMembershipId, facts.assigneeRoleBindingId, facts.collaboratorId,
              input.actor.userId, "case_event", input.effects.audit.occurredAt],
          });
          await appendAtomicMutationEffects(adapt(transaction), input.effects);
          this.hooks.failBeforeCommit?.("ensure");
          const ack = Object.freeze({ id: input.taskId, recordVersion: 1,
            state: "assigned" as const, kind: input.kind, schoolTargetId: input.targetId });
          return outcome(input, ack);
        },
      });
      if (result.status === "executed") return result.value;
      return this.readAcknowledgement(input.actor.organizationId, input.taskId, input.requestId, result.responseHash);
    } catch (error) { throw normalizeError(error); }
  }

  async transitionTargetTask(input: P3TransitionTargetTaskRepositoryInput): Promise<P3TaskAcknowledgement> {
    const context = actorContext(input.actor.organizationId, input.actor.userId, input.requestId);
    try {
      const result = await runIdempotentTransaction({
        runner: this.runner, context,
        claim: { id: input.idempotencyRecordId, organizationId: input.actor.organizationId,
          actorKind: "user", actorOpaqueId: input.actor.userId,
          operation: "tasks.school_target.transition", key: input.idempotencyKey,
          requestHash: input.requestHash, createdAt: input.effects.audit.occurredAt },
        revalidate: async (transaction) => {
          const actor = await this.accessFacts.readActorBindingFacts(transaction, {
            organizationId: input.actor.organizationId, userId: input.actor.userId,
          });
          if (!actor || actor.bindings.length === 0) throw new P3TaskError("FORBIDDEN");
        },
        execute: async (transaction) => this.executeTransition(transaction, input),
      });
      if (result.status === "executed") return result.value;
      return this.readAcknowledgement(input.actor.organizationId, input.taskId, input.requestId, result.responseHash);
    } catch (error) { throw normalizeError(error); }
  }

  private async executeTransition(transaction: TenantTransaction, input: P3TransitionTargetTaskRepositoryInput) {
    const taskResult = await transaction.query<TaskRow>({
      text: `SELECT id,organization_id,service_case_id,school_target_id,task_kind,state,
                    assignee_user_id,assignee_role,owner_user_id,record_version,last_transition_receipt_id
               FROM tasks_tasks WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
      values: [input.taskId, input.actor.organizationId],
    });
    const task = taskResult.rows[0];
    if (!task) throw new P3TaskError("NOT_FOUND");
    if (Number(task.record_version) !== input.expectedRecordVersion) throw new P3TaskError("STALE_VERSION");
    const facts = await this.casesFacts.readCurrentTargetTaskFacts(transaction, {
      organizationId: input.actor.organizationId, caseId: task.service_case_id,
      targetId: task.school_target_id,
    });
    if (!facts || facts.ownerUserId !== task.owner_user_id || facts.caseStage === "closed" || facts.workflowStatus !== "active") {
      throw new P3TaskError("NOT_FOUND");
    }
    const actorFacts = await this.accessFacts.readActorBindingFacts(transaction, {
      organizationId: input.actor.organizationId, userId: input.actor.userId,
    });
    if (!actorFacts) throw new P3TaskError("FORBIDDEN");
    const assignmentResult = await transaction.query<AssignmentRow>({
      text: `SELECT id,assignee_user_id,assignee_role,status,assignee_membership_id,assignee_role_binding_id,
                    case_collaborator_id
               FROM tasks_task_assignments
              WHERE task_id=$1 AND organization_id=$2 AND ended_at IS NULL
              FOR UPDATE`,
      values: [task.id, input.actor.organizationId],
    });
    const assignment = assignmentResult.rows[0];
    const applicationReassignmentAfterReject = input.action === "reassign" &&
      task.task_kind === "application_prepare_submit" && task.state === "assigned" &&
      assignment === undefined && task.owner_user_id === input.actor.userId &&
      actorFacts.bindings.some((binding) => binding.role === "advisor");
    if (!assignment && !applicationReassignmentAfterReject) throw new P3TaskError("CONFLICT");
    const ownerActorRole = task.owner_user_id === input.actor.userId
      ? actorFacts.bindings.find((binding) => binding.role === "advisor")?.role ??
        actorFacts.bindings.find((binding) => binding.role === "founder")?.role
      : undefined;
    const actorRole = assignment?.assignee_user_id === input.actor.userId
      ? actorFacts.bindings.find((binding) => binding.role === assignment.assignee_role)?.role ?? ownerActorRole
      : ownerActorRole;

    let fromState = task.state;
    let toState: string;
    let resultVersion = input.expectedRecordVersion + 1;
    let receiptAssignmentId: string | null = assignment?.id ?? null;
    if (input.action === "accept") {
      if (!assignment || task.state !== "assigned" || assignment.assignee_user_id !== input.actor.userId || !actorRole) throw new P3TaskError("FORBIDDEN");
      toState = "accepted";
      await transaction.query({ text: `UPDATE tasks_task_assignments SET status='accepted',accepted_at=$1,updated_at=$1,record_version=record_version+1 WHERE id=$2 AND organization_id=$3`, values: [input.effects.audit.occurredAt, assignment.id, input.actor.organizationId] });
    } else if (input.action === "reject") {
      if (!assignment || task.state !== "assigned" || assignment.assignee_user_id !== input.actor.userId || !actorRole) throw new P3TaskError("FORBIDDEN");
      toState = "assigned";
      await transaction.query({ text: `UPDATE tasks_task_assignments SET status='rejected',ended_at=$1,ended_by_user_id=$2,end_reason=$3,updated_at=$1,record_version=record_version+1 WHERE id=$4 AND organization_id=$5`, values: [input.effects.audit.occurredAt, input.actor.userId, input.reason, assignment.id, input.actor.organizationId] });
    } else if (input.action === "cancel") {
      if (!assignment || task.state === "completed" || task.state === "cancelled" || task.owner_user_id !== input.actor.userId || !actorRole) throw new P3TaskError("FORBIDDEN");
      toState = "cancelled";
      await transaction.query({ text: `UPDATE tasks_task_assignments SET status='cancelled',ended_at=$1,ended_by_user_id=$2,end_reason=$3,updated_at=$1,record_version=record_version+1 WHERE id=$4 AND organization_id=$5`, values: [input.effects.audit.occurredAt, input.actor.userId, input.reason, assignment.id, input.actor.organizationId] });
    } else if (input.action === "reassign") {
      const historicalReassignment = assignment !== undefined &&
        ["awaiting_reassignment", "accepted"].includes(task.state);
      if ((!applicationReassignmentAfterReject && !historicalReassignment) ||
          task.owner_user_id !== input.actor.userId || !actorRole || !input.nextAssigneeUserId) throw new P3TaskError("FORBIDDEN");
      const replacement = await this.resolveReplacement(transaction, input, task, facts);
      toState = "assigned";
      if (assignment) {
        await transaction.query({ text: `UPDATE tasks_task_assignments SET status='reassigned',ended_at=$1,ended_by_user_id=$2,end_reason=$3,updated_at=$1,record_version=record_version+1 WHERE id=$4 AND organization_id=$5`, values: [input.effects.audit.occurredAt, input.actor.userId, input.reason, assignment.id, input.actor.organizationId] });
      }
      const insertedAssignment = await transaction.query<{ id: string }>({
        text: `INSERT INTO tasks_task_assignments
          (id,organization_id,task_id,assignee_user_id,assignee_role,redaction_profile,
           assignee_membership_id,assignee_role_binding_id,case_collaborator_id,assigned_by_user_id,
           status,reason,assignment_reason,assigned_at,record_version,updated_at)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,'assigned',$10,$10,$11,1,$11)
         RETURNING id`,
        values: [input.actor.organizationId, task.id, replacement.userId, replacement.role,
          replacement.role === "contractor" ? "task_only" : null, replacement.membershipId,
          replacement.roleBindingId, replacement.collaboratorId, input.actor.userId, input.reason,
          input.effects.audit.occurredAt],
      });
      receiptAssignmentId = insertedAssignment.rows[0]?.id ?? null;
      if (receiptAssignmentId === null) throw new P3TaskError("UNAVAILABLE");
      await transaction.query({ text: `UPDATE tasks_tasks SET assignee_user_id=$1,assignee_role=$2,assignee_redaction_profile=$3,state='assigned',record_version=record_version+1,updated_at=$4 WHERE id=$5 AND organization_id=$6`, values: [replacement.userId, replacement.role, replacement.role === "contractor" ? "task_only" : null, input.effects.audit.occurredAt, task.id, input.actor.organizationId] });
    } else {
      if (!assignment || task.state !== "accepted" || assignment.assignee_user_id !== input.actor.userId || !actorRole) throw new P3TaskError("FORBIDDEN");
      if (task.task_kind === "application_prepare_submit") {
        const completion = input.completionRecord;
        assertApplicationCompletion(completion);
        if (completion.submitter_user_id !== input.actor.userId || assignment.assignee_user_id !== input.actor.userId) throw new P3TaskError("COMPLETION_INVALID");
        if (completion.no_reference_declared === true &&
            !input.evidenceReference) throw new P3TaskError("COMPLETION_INVALID");
        if (completion.no_reference_declared === true &&
            !await this.evidence.readCleanCaseEvidence(transaction, { organizationId: input.actor.organizationId,
              caseId: task.service_case_id, targetId: task.school_target_id, taskId: task.id,
              evidenceId: input.evidenceReference! })) throw new P3TaskError("COMPLETION_INVALID");
      } else {
        if (!input.completionRecord) throw new P3TaskError("COMPLETION_INVALID");
        assertInterviewCompletion(input.completionRecord);
      }
      toState = "completed";
      await transaction.query({ text: `UPDATE tasks_task_assignments SET ended_at=$1,ended_by_user_id=$2,end_reason='completed',updated_at=$1,record_version=record_version+1 WHERE id=$3 AND organization_id=$4`, values: [input.effects.audit.occurredAt, input.actor.userId, assignment.id, input.actor.organizationId] });
    }
    const receiptId = input.receiptId;
    if (receiptAssignmentId === null) throw new P3TaskError("UNAVAILABLE");
    await transaction.query({
      text: `INSERT INTO tasks_task_transition_receipts
        (id,organization_id,task_id,assignment_id,from_state,to_state,actor_user_id,actor_role,actor_kind,
         expected_record_version,result_record_version,reason,completion_record_json,evidence_reference,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'user',$9,$10,$11,$12::jsonb,$13,$14)`,
      values: [receiptId, input.actor.organizationId, task.id, receiptAssignmentId, fromState, toState,
        input.actor.userId, actorRole ?? "advisor", input.expectedRecordVersion, resultVersion,
        input.reason || null, input.completionRecord ? JSON.stringify(input.completionRecord) : null,
        input.evidenceReference, input.effects.audit.occurredAt],
    });
    await transaction.query({ text: `UPDATE tasks_tasks SET state=$1,record_version=$2,last_transition_actor_user_id=$3,last_transition_receipt_id=$4,last_transition_reason=$5,completed_at=CASE WHEN $1='completed' THEN $6 ELSE completed_at END,cancelled_at=CASE WHEN $1='cancelled' THEN $6 ELSE cancelled_at END,cancelled_by_user_id=CASE WHEN $1='cancelled' THEN $3 ELSE cancelled_by_user_id END,cancellation_reason=CASE WHEN $1='cancelled' THEN $5 ELSE cancellation_reason END,updated_at=$6 WHERE id=$7 AND organization_id=$8 AND record_version=$9`, values: [toState, resultVersion, input.actor.userId, receiptId, input.reason || null, input.effects.audit.occurredAt, task.id, input.actor.organizationId, input.expectedRecordVersion] });
    await appendAtomicMutationEffects(adapt(transaction), input.effects);
    this.hooks.failBeforeCommit?.("transition");
    const acknowledgement = Object.freeze({ id: task.id, recordVersion: resultVersion,
      state: toState as P3TaskAcknowledgement["state"], kind: task.task_kind as P3TaskKind,
      schoolTargetId: task.school_target_id, ...(toState === "completed" ? { completionReceiptId: receiptId } : {}) });
    return outcome(input, acknowledgement);
  }

  private async resolveReplacement(transaction: TenantTransaction, input: P3TransitionTargetTaskRepositoryInput,
    task: TaskRow, facts: Awaited<ReturnType<CasesTaskFactsPort["readTargetTaskFacts"]>>) {
    const userId = input.nextAssigneeUserId!;
    const bindings = await this.accessFacts.readActorBindingFacts(transaction, { organizationId: input.actor.organizationId, userId });
    if (!bindings) throw new P3TaskError("FORBIDDEN");
    const role = bindings.bindings.some((binding) => binding.role === "advisor")
      ? "advisor" : "contractor";
    const binding = bindings.bindings.find((candidate) => candidate.role === role);
    if (!binding) throw new P3TaskError("FORBIDDEN");
    const can = await this.accessFacts.canAssigneeOperate(transaction, { organizationId: input.actor.organizationId,
      caseId: task.service_case_id, userId, kind: task.task_kind as P3TaskKind, assigneeRole: role,
      isPrimaryAdvisor: facts?.ownerUserId === userId && role === "advisor", collaboratorId: null });
    if (!can) throw new P3TaskError("FORBIDDEN");
    return Object.freeze({ userId, role, membershipId: binding.membershipId, roleBindingId: binding.roleBindingId,
      collaboratorId: null });
  }

  private async readAcknowledgement(organizationId: string, taskId: string, requestId: string, expectedHash: string) {
    const replayAck = await this.runner.run({ organizationId, actorKind: "user", actorOpaqueId: "replay", actorUserId: organizationId, requestId }, async (transaction) => {
      const result = await transaction.query<TaskRow>({ text: `SELECT id,task_kind,school_target_id,state,record_version,last_transition_receipt_id FROM tasks_tasks WHERE id=$1 AND organization_id=$2`, values: [taskId, organizationId] });
      const row = result.rows[0]; if (!row) throw new P3TaskError("NOT_FOUND");
      return acknowledgement(row, row.task_kind as P3TaskKind);
    });
    if (expectedHash !== hashAcknowledgement(replayAck)) throw new P3TaskError("CONFLICT");
    return replayAck;
  }
}

interface TaskRow { readonly id: string; readonly organization_id: string; readonly service_case_id: string; readonly school_target_id: string; readonly task_kind: string; readonly state: string; readonly assignee_user_id: string; readonly assignee_role: string; readonly owner_user_id: string; readonly record_version: number | string; readonly last_transition_receipt_id: string | null; }
interface AssignmentRow { readonly id: string; readonly assignee_user_id: string; readonly assignee_role: string; readonly status: string; readonly assignee_membership_id: string; readonly assignee_role_binding_id: string; readonly case_collaborator_id: string | null; }

function actorContext(organizationId: string, userId: string, requestId: string) { return { organizationId, actorKind: "user" as const, actorOpaqueId: userId, actorUserId: userId, requestId }; }
function acknowledgement(row: TaskRow, kind: P3TaskKind): P3TaskAcknowledgement { return Object.freeze({ id: row.id, recordVersion: Number(row.record_version), state: row.state as P3TaskAcknowledgement["state"], kind, schoolTargetId: row.school_target_id, ...(row.last_transition_receipt_id && row.state === "completed" ? { completionReceiptId: row.last_transition_receipt_id } : {}) }); }
function hashAcknowledgement(value: P3TaskAcknowledgement) { return hashRequestPayload({ id: value.id, record_version: value.recordVersion, state: value.state, kind: value.kind ?? null, school_target_id: value.schoolTargetId ?? null, completion_receipt_id: value.completionReceiptId ?? null }); }
function outcome(input: P3EnsureTargetTaskRepositoryInput | P3TransitionTargetTaskRepositoryInput, value: P3TaskAcknowledgement) { return { state: "completed" as const, resultReference: value.id, responseHash: hashAcknowledgement(value), updatedAt: input.effects.audit.occurredAt, value }; }
function adapt(transaction: TenantTransaction) { return { query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => { const result = await transaction.query<Row>({ text, values }); return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }; } }; }
function assertApplicationCompletion(value: Readonly<Record<string, unknown>> | null): asserts value is Readonly<Record<string, unknown>> {
  if (!isValidApplicationCompletion(value)) throw new P3TaskError("COMPLETION_INVALID");
}
function assertInterviewCompletion(value: Readonly<Record<string, unknown>>) {
  if (typeof value.completed_at !== "string" || Number.isNaN(Date.parse(value.completed_at)) ||
      typeof value.interview_method !== "string" || value.interview_method.trim() === "" ||
      typeof value.coaching_summary !== "string" || value.coaching_summary.trim() === "") throw new P3TaskError("COMPLETION_INVALID");
}
function normalizeError(error: unknown): P3TaskError { if (error instanceof P3TaskError) return error; if (error instanceof IdempotencyExecutionError) return new P3TaskError(error.code === "IDEMPOTENCY_KEY_REUSED" ? "CONFLICT" : "UNAVAILABLE"); return new P3TaskError("UNAVAILABLE"); }
