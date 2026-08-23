import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import { hasRelease1TaskPolicyContent, RELEASE_1_TASK_INITIAL_STATE } from "../domain/release1-policy.ts";
import type { TaskActorRole, TaskState, TaskTransitionRule } from "../domain/contract.ts";
import {
  TaskWorkspaceError,
  isTaskWorkspaceError,
  type AvailableTaskTransitionView,
  type TaskAcknowledgement,
  type TaskActorContext,
  type TaskAssigneeRole,
  type TaskCollectionView,
  type TaskDetailView,
  type TaskOptionsView,
  type TaskView,
  type TaskWorkspaceRepository,
} from "../application/workspace-service.ts";

const CREATE_OPERATION = "tasks.create";
const TRANSITION_OPERATION = "tasks.transition";
const REFERENCE = /^([0-9a-f-]{36}):(\d{1,16})$/i;

interface ReceiptRow extends Record<string, unknown> { request_hash: string; state: string; result_reference: string | null; response_hash: string | null }
interface TaskRow extends Record<string, unknown> {
  id: string; service_case_id: string; case_number: string; title: string; task_brief: string; due_at: Date | string;
  state: TaskState; assignee_user_id: string; assignee_role: TaskAssigneeRole; assignee_redaction_profile: string | null;
  assignee_binding_id: string; owner_user_id: string; primary_user_id: string; primary_role: string;
  record_version: number | string; updated_at: Date | string; student_status: string; case_stage: string;
}
interface RuleRow extends Record<string, unknown> { from_state: TaskState; to_state: TaskState; actor_kind: "assignee" | "approver" | "owner"; allowed_actor_roles: TaskActorRole[]; requires_reason: boolean; requires_different_actor: boolean }
interface ActorRow extends Record<string, unknown> { role: string }
interface CaseRow extends Record<string, unknown> { id: string; primary_user_id: string; primary_role: string; stage: string; student_status: string }
interface AssigneeRow extends Record<string, unknown> { id: string; user_id: string; role: TaskAssigneeRole }

export interface TaskRepositoryTestHooks { readonly failBeforeCommit?: (operation: "create" | "transition") => void }

export class PostgresqlTaskWorkspaceRepository implements TaskWorkspaceRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly hooks: TaskRepositoryTestHooks;
  constructor(runner: TenantTransactionRunner, hooks: TaskRepositoryTestHooks = {}) {
    this.runner = runner; this.hooks = hooks;
  }

  list(input: Parameters<TaskWorkspaceRepository["list"]>[0]): Promise<TaskCollectionView> {
    return this.run(input, async (tx) => {
      await assertActor(tx, input);
      if (input.actorRole === "contractor" && input.caseId !== null) forbidden();
      const rows = await selectVisibleTasks(tx, input, input.caseId, null, false);
      const rules = await loadApprovedRules(tx);
      return Object.freeze({ audience: input.actorRole === "contractor" ? "assigned_task" : "case_workspace",
        tasks: Object.freeze(rows.map((row) => view(row, input, rules))) });
    });
  }

  detail(input: Parameters<TaskWorkspaceRepository["detail"]>[0]): Promise<TaskDetailView | null> {
    return this.run(input, async (tx) => {
      await assertActor(tx, input); const rows = await selectVisibleTasks(tx, input, null, input.taskId, false);
      const row = rows[0]; if (!row) return null; const rules = await loadApprovedRules(tx);
      return Object.freeze({ audience: input.actorRole === "contractor" ? "assigned_task" : "case_workspace",
        task: view(row, input, rules) });
    });
  }

  options(input: Parameters<TaskWorkspaceRepository["options"]>[0]): Promise<TaskOptionsView | null> {
    return this.run(input, async (tx) => {
      await assertActor(tx, input); if (input.actorRole === "contractor") forbidden();
      const serviceCase = await lockCase(tx, input, input.caseId, false); if (!serviceCase) return null;
      if (!isWritableCase(serviceCase) || serviceCase.primary_user_id !== input.actorUserId) return null;
      const result = await tx.query<AssigneeRow>(`SELECT binding.id,binding.user_id,binding.role
        FROM access_role_bindings AS binding
        JOIN access_organization_memberships AS membership ON membership.id=binding.membership_id
          AND membership.organization_id=binding.organization_id AND membership.user_id=binding.user_id
        JOIN identity_users AS actor ON actor.id=binding.user_id
        WHERE binding.role IN ('advisor','contractor') AND binding.status='active'
          AND membership.status='active' AND actor.status='active'
        ORDER BY binding.role,binding.id LIMIT 100`);
      return Object.freeze({ assignees: Object.freeze(result.rows.map(assigneeView)) });
    });
  }

  create(input: Parameters<TaskWorkspaceRepository["create"]>[0]): Promise<TaskAcknowledgement> {
    return this.run(input, async (tx) => {
      const replay = await claimReceipt(tx, input, CREATE_OPERATION); await assertActor(tx, input);
      const serviceCase = await lockCase(tx, input, input.caseId, true); if (!serviceCase || !isWritableCase(serviceCase) ||
        serviceCase.primary_user_id !== input.actorUserId || serviceCase.primary_role !== input.actorRole) notFound();
      if (replay) return replay; await assertApprovedPolicy(tx);
      const assignee = await lockAssignee(tx, input.assigneeUserId); if (!assignee) notFound();
      await tx.query(`INSERT INTO tasks_tasks
        (id,organization_id,service_case_id,title,task_brief,due_at,state,assignee_user_id,
         assignee_role,assignee_redaction_profile,owner_user_id,record_version)
        VALUES ($1,$2,$3,$4,$5,$6,'assigned',$7,$8,$9,$10,1)`,
      [input.taskId,input.organizationId,input.caseId,input.title,input.taskBrief,input.dueAt,
        assignee.user_id,assignee.role,assignee.role === "contractor" ? "task_only" : null,serviceCase.primary_user_id]);
      await tx.query(`INSERT INTO tasks_task_assignments
        (id,organization_id,task_id,assignee_user_id,assignee_role,redaction_profile,assigned_by_user_id,status,reason)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'assigned','initial_assignment')`,
      [input.organizationId,input.taskId,assignee.user_id,assignee.role,
        assignee.role === "contractor" ? "task_only" : null,input.actorUserId]);
      const result = Object.freeze({ id: input.taskId, recordVersion: 1 });
      await appendAtomicMutationEffects(tx, input.effects); this.hooks.failBeforeCommit?.("create");
      await completeReceipt(tx, input, CREATE_OPERATION, result); return result;
    });
  }

  transition(input: Parameters<TaskWorkspaceRepository["transition"]>[0]): Promise<TaskAcknowledgement> {
    return this.run(input, async (tx) => {
      const replay = await claimReceipt(tx, input, TRANSITION_OPERATION); await assertActor(tx, input);
      const rows = await selectVisibleTasks(tx, input, null, input.taskId, true); const task = rows[0];
      if (!task || !isWritableTask(task)) notFound(); if (replay) return replay;
      if (version(task.record_version) !== input.expectedRecordVersion) stale();
      const rules = await loadApprovedRules(tx, true); const rule = rules.find((candidate) =>
        candidate.from === task.state && candidate.to === input.to); if (!rule) conflict();
      if (!rule.allowedActorRoles.includes(input.actorRole) ||
          (rule.actorKind === "assignee" && task.assignee_user_id !== input.actorUserId) ||
          (rule.actorKind === "owner" && task.primary_user_id !== input.actorUserId) ||
          (rule.actorKind === "approver" && (input.actorRole !== "founder" || task.assignee_user_id === input.actorUserId))) forbidden();
      if (rule.requiresReason && input.reason === "") invalid();
      let nextAssignee: AssigneeRow | null = null;
      if (input.to === "reassigned") { nextAssignee = input.nextAssigneeUserId ? await lockAssignee(tx, input.nextAssigneeUserId) : null;
        if (!nextAssignee) notFound(); }
      await tx.query(`INSERT INTO tasks_task_transition_receipts
        (id,organization_id,task_id,from_state,to_state,actor_user_id,actor_role,
         expected_record_version,result_record_version,reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [input.receiptId,input.organizationId,input.taskId,task.state,input.to,input.actorUserId,
        input.actorRole,input.expectedRecordVersion,input.expectedRecordVersion+1,input.reason || null]);
      const updated = await tx.query(`UPDATE tasks_tasks SET state=$2,
        assignee_user_id=COALESCE($3,assignee_user_id),
        assignee_role=COALESCE($4,assignee_role),
        assignee_redaction_profile=CASE WHEN $3::uuid IS NULL THEN assignee_redaction_profile
          WHEN $4='contractor' THEN 'task_only' ELSE NULL END,
        approver_user_id=CASE WHEN $2='approved' THEN $5 ELSE approver_user_id END,
        owner_user_id=$9,
        last_transition_actor_user_id=$5,last_transition_receipt_id=$6,last_transition_reason=$7,
        record_version=record_version+1,updated_at=transaction_timestamp()
        WHERE id=$1 AND record_version=$8`,
      [input.taskId,input.to,nextAssignee?.user_id ?? null,nextAssignee?.role ?? null,
        input.actorUserId,input.receiptId,input.reason || null,input.expectedRecordVersion,task.primary_user_id]);
      if (updated.rowCount !== 1) stale();
      if (nextAssignee) await tx.query(`INSERT INTO tasks_task_assignments
        (id,organization_id,task_id,assignee_user_id,assignee_role,redaction_profile,assigned_by_user_id,status,reason)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'reassigned',$7)`,
      [input.organizationId,input.taskId,nextAssignee.user_id,nextAssignee.role,
        nextAssignee.role === "contractor" ? "task_only" : null,input.actorUserId,input.reason]);
      const result = Object.freeze({ id: input.taskId, recordVersion: input.expectedRecordVersion + 1 });
      await appendAtomicMutationEffects(tx, input.effects); this.hooks.failBeforeCommit?.("transition");
      await completeReceipt(tx, input, TRANSITION_OPERATION, result); return result;
    });
  }

  private run<T>(input: TaskActorContext, operation: (tx: Db) => Promise<T>): Promise<T> {
    return this.runner.run({ organizationId: input.organizationId, actorUserId: input.actorUserId }, async (tenantTx) => {
      try { return await operation(adapt(tenantTx)); } catch (cause) {
        if (isTaskWorkspaceError(cause)) throw cause;
        const constraint = postgresConstraint(cause);
        if (constraint === "tasks_transition_receipt_version_check") stale();
        if (constraint?.startsWith("tasks_policy_")) policyUnavailable();
        throw new TaskWorkspaceError("TASK_UNAVAILABLE");
      }
    });
  }
}

async function assertActor(tx: Db, input: TaskActorContext): Promise<void> {
  const result = await tx.query<ActorRow>(`SELECT binding.role FROM identity_users AS actor
    JOIN access_organization_memberships AS membership ON membership.user_id=actor.id AND membership.status='active'
    JOIN access_role_bindings AS binding ON binding.membership_id=membership.id
      AND binding.user_id=actor.id AND binding.status='active'
    JOIN access_organizations AS organization ON organization.id=membership.organization_id AND organization.status='active'
    WHERE actor.id=$1 AND actor.status='active' AND binding.role=$2 FOR SHARE OF actor,membership,binding,organization`,
  [input.actorUserId,input.actorRole]); if (result.rowCount !== 1) forbidden();
}
async function lockCase(tx: Db, input: TaskActorContext, caseId: string, update: boolean): Promise<CaseRow | null> {
  const result = await tx.query<CaseRow>(`SELECT service_case.id,service_case.primary_user_id,service_case.primary_role,
      service_case.stage,student.status AS student_status FROM cases_service_cases AS service_case
    JOIN crm_students AS student ON student.id=service_case.student_id AND student.organization_id=service_case.organization_id
    WHERE service_case.id=$1 ${update ? "FOR UPDATE OF service_case" : "FOR SHARE OF service_case"}`, [caseId]);
  return result.rows[0] ?? null;
}
async function selectVisibleTasks(tx: Db, input: TaskActorContext, caseId: string | null, taskId: string | null, update: boolean): Promise<readonly TaskRow[]> {
  const result = await tx.query<TaskRow>(`SELECT task.id,task.service_case_id,service_case.case_number,task.title,
      task.task_brief,task.due_at,task.state,task.assignee_user_id,task.assignee_role,
      task.assignee_redaction_profile,assignee_binding.id AS assignee_binding_id,task.owner_user_id,
      service_case.primary_user_id,service_case.primary_role,task.record_version,task.updated_at,
      student.status AS student_status,service_case.stage AS case_stage
    FROM tasks_tasks AS task JOIN cases_service_cases AS service_case ON service_case.id=task.service_case_id
    JOIN crm_students AS student ON student.id=service_case.student_id AND student.organization_id=service_case.organization_id
    JOIN access_role_bindings AS assignee_binding ON assignee_binding.user_id=task.assignee_user_id
      AND assignee_binding.organization_id=task.organization_id AND assignee_binding.role=task.assignee_role
      AND assignee_binding.status='active'
    WHERE ($1::uuid IS NULL OR task.service_case_id=$1) AND ($2::uuid IS NULL OR task.id=$2)
      AND ($3='founder' OR ($3='advisor' AND (task.assignee_user_id=$4 OR service_case.primary_user_id=$4))
        OR ($3='contractor' AND task.assignee_user_id=$4 AND task.assignee_role='contractor'
          AND task.assignee_redaction_profile='task_only'))
    ORDER BY task.updated_at DESC,task.id ${update ? "FOR UPDATE OF task,service_case" : ""}`,
  [caseId,taskId,input.actorRole,input.actorUserId]); return result.rows;
}
async function lockAssignee(tx: Db, userId: string): Promise<AssigneeRow | null> {
  const result = await tx.query<AssigneeRow>(`SELECT binding.id,binding.user_id,binding.role
    FROM access_role_bindings AS binding JOIN access_organization_memberships AS membership
      ON membership.id=binding.membership_id AND membership.status='active'
    JOIN identity_users AS actor ON actor.id=binding.user_id AND actor.status='active'
    WHERE binding.user_id=$1 AND binding.role IN ('advisor','contractor') AND binding.status='active'
    FOR SHARE OF binding,membership,actor`, [userId]); return result.rows[0] ?? null;
}
async function loadApprovedRules(tx: Db, lock = false): Promise<readonly TaskTransitionRule[]> {
  const policy = await tx.query<{ id: string; initial_state: TaskState }>(`SELECT id,initial_state FROM tasks_transition_policies
    WHERE status='approved' ${lock ? "FOR SHARE" : ""}`); const selected = policy.rows[0];
  if (!selected || selected.initial_state !== RELEASE_1_TASK_INITIAL_STATE) policyUnavailable();
  const rows = await tx.query<RuleRow>(`SELECT from_state,to_state,actor_kind,allowed_actor_roles,
    requires_reason,requires_different_actor FROM tasks_transition_rules WHERE policy_id=$1
    ORDER BY from_state,to_state`, [selected.id]);
  const rules = rows.rows.map((row) => Object.freeze({ from: row.from_state,to: row.to_state,
    actorKind: row.actor_kind,allowedActorRoles: Object.freeze([...row.allowed_actor_roles]),
    requiresReason: row.requires_reason,requiresDifferentActor: row.requires_different_actor }));
  if (!hasRelease1TaskPolicyContent({ initialState: selected.initial_state, rules })) policyUnavailable(); return rules;
}
async function assertApprovedPolicy(tx: Db): Promise<void> { await loadApprovedRules(tx, true); }
function isWritableCase(row: CaseRow): boolean { return row.stage !== "closed" && row.student_status === "active"; }
function isWritableTask(row: TaskRow): boolean { return row.case_stage !== "closed" && row.student_status === "active"; }
function view(row: TaskRow, actor: TaskActorContext, rules: readonly TaskTransitionRule[]): TaskView {
  const transitions: AvailableTaskTransitionView[] = rules.filter((rule) => rule.from === row.state &&
    rule.allowedActorRoles.includes(actor.actorRole) && ((rule.actorKind === "assignee" && row.assignee_user_id === actor.actorUserId) ||
      (rule.actorKind === "owner" && row.primary_user_id === actor.actorUserId) ||
      (rule.actorKind === "approver" && actor.actorRole === "founder" && row.assignee_user_id !== actor.actorUserId)))
    .map((rule) => Object.freeze({ to: rule.to, requiresReason: rule.requiresReason, requiresAssignee: rule.to === "reassigned" }));
  const base = { id: row.id,title: row.title,taskBrief: row.task_brief,dueAt: new Date(row.due_at).toISOString(),
    state: row.state,recordVersion: version(row.record_version),updatedAt: new Date(row.updated_at).toISOString(),
    availableTransitions: Object.freeze(transitions) };
  if (actor.actorRole === "contractor") return Object.freeze(base);
  return Object.freeze({ ...base,caseId: row.service_case_id,caseNumber: row.case_number,
    assignee: assigneeView({ id: row.assignee_binding_id,user_id: row.assignee_user_id,role: row.assignee_role }) });
}
function assigneeView(row: AssigneeRow) { return Object.freeze({ id: row.user_id,role: row.role,
  label: `${row.role === "advisor" ? "Advisor" : "Contractor"} · ${row.id.slice(-8)}` }); }
async function claimReceipt(tx: Db, input: TaskActorContext & { idempotencyKey: string; requestHash: string }, operation: string) {
  const inserted = await tx.query(`INSERT INTO shared_idempotency_records
    (id,organization_id,actor_user_id,operation,idempotency_key,request_hash,state)
    VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress')
    ON CONFLICT (organization_id,actor_user_id,operation,idempotency_key) DO NOTHING RETURNING id`,
  [input.organizationId,input.actorUserId,operation,input.idempotencyKey,input.requestHash]);
  const selected = await tx.query<ReceiptRow>(`SELECT request_hash,state,result_reference,response_hash
    FROM shared_idempotency_records WHERE organization_id=$1 AND actor_user_id=$2 AND operation=$3
      AND idempotency_key=$4 FOR UPDATE`, [input.organizationId,input.actorUserId,operation,input.idempotencyKey]);
  if (inserted.rowCount === 1) return null; const row=selected.rows[0];
  if (!row || row.request_hash!==input.requestHash || row.state!=="completed" || !row.result_reference || !row.response_hash) conflict();
  const result=parseReference(row.result_reference); if(row.response_hash!==hashAck(result)) unavailable(); return result;
}
async function completeReceipt(tx: Db,input: TaskActorContext & { idempotencyKey:string;requestHash:string },operation:string,result:TaskAcknowledgement){
  const completed=await tx.query(`UPDATE shared_idempotency_records SET state='completed',result_reference=$5,
    response_hash=$6,record_version=record_version+1,updated_at=transaction_timestamp()
    WHERE organization_id=$1 AND actor_user_id=$2 AND operation=$3 AND idempotency_key=$4
      AND request_hash=$7 AND state='in_progress'`,[input.organizationId,input.actorUserId,operation,input.idempotencyKey,
      `${result.id}:${result.recordVersion}`,hashAck(result),input.requestHash]); if(completed.rowCount!==1) unavailable(); }
function parseReference(value:string):TaskAcknowledgement{const match=REFERENCE.exec(value);if(!match)unavailable();return Object.freeze({id:match[1]!,recordVersion:version(match[2]!)});}
function hashAck(value:TaskAcknowledgement){return hashRequestPayload({id:value.id,record_version:value.recordVersion});}
function version(value:number|string){const parsed=typeof value==="number"?value:Number(value);if(!Number.isSafeInteger(parsed)||parsed<1)unavailable();return parsed;}
function postgresConstraint(value:unknown){if(!value||typeof value!=="object")return null;const error=value as{code?:unknown;constraint?:unknown};return typeof error.code==="string"&&typeof error.constraint==="string"?error.constraint:null;}
function forbidden():never{throw new TaskWorkspaceError("TASK_FORBIDDEN");} function notFound():never{throw new TaskWorkspaceError("TASK_NOT_FOUND");}
function invalid():never{throw new TaskWorkspaceError("TASK_INVALID");}
function stale():never{throw new TaskWorkspaceError("TASK_STALE_VERSION");} function conflict():never{throw new TaskWorkspaceError("TASK_CONFLICT");}
function policyUnavailable():never{throw new TaskWorkspaceError("TASK_POLICY_UNAVAILABLE");} function unavailable():never{throw new TaskWorkspaceError("TASK_UNAVAILABLE");}
interface Db{query<Row extends Record<string,unknown>=Record<string,unknown>>(text:string,values?:readonly unknown[]):Promise<{rows:readonly Row[];rowCount:number}>}
function adapt(tx:TenantTransaction):Db{return Object.freeze({async query<Row extends Record<string,unknown>>(text:string,values?:readonly unknown[]){const result=await tx.query<Row>({text,values});return{rows:result.rows,rowCount:result.rowCount??result.rows.length};}});}
