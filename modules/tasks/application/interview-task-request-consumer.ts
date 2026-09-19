import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
} from "../../audit/public.ts";
import {
  claimAuditOutboxSourceTransaction,
  completeAuditOutboxSourceTransaction,
  lockAuditOutboxSourceTransaction,
  appendAtomicMutationEffects,
} from "../../audit/server.ts";
import type { CasesInterviewTaskRequestFactsPort } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";

export interface InterviewTaskRequestConsumerHooks {
  readonly failBeforeCommit?: () => void;
}

export class InterviewTaskRequestConsumer {
  private readonly runner: TenantTransactionRunner;
  private readonly facts: CasesInterviewTaskRequestFactsPort;
  private readonly createId: () => string;
  private readonly hooks: InterviewTaskRequestConsumerHooks;
  constructor(runner:TenantTransactionRunner,facts:CasesInterviewTaskRequestFactsPort,
    createId:()=>string=randomUUID,hooks:InterviewTaskRequestConsumerHooks={}) {
    this.runner=runner;this.facts=facts;this.createId=createId;this.hooks=hooks;
  }

  async drainForInvitation(input:Readonly<{organizationId:string;caseId:string;targetId:string;invitationId:string;requestId:string}>):Promise<boolean> {
    return this.runner.run(systemContext(input.organizationId,input.requestId),async transaction=>{
      const sourceEventId=await this.facts.readSource(transaction,input);
      if(!sourceEventId)return false;
      const source=(await lockAuditOutboxSourceTransaction(transaction,{
        organizationId:input.organizationId,eventType:"cases.interview_invitation_recorded",eventVersion:1,
        aggregateId:input.targetId,auditEventId:sourceEventId,
      })).rows[0];
      if (!source) {
        logDeliveryFailure("source_missing");
        return false;
      }
      if (source.status === "dead_letter") {
        logDeliveryFailure("source_dead_letter");
        return false;
      }
      const existing = await readTaskBySource(transaction,input.organizationId,sourceEventId);
      if (existing && (existing.target_id!==input.targetId || existing.case_id!==input.caseId)) return false;
      if (source.status === "delivered") {
        if (existing === null) logDeliveryFailure("delivered_without_task");
        return existing !== null;
      }
      if (source.status !== "pending") {
        logDeliveryFailure("source_not_pending");
        return false;
      }
      const facts = await this.facts.readFacts(transaction,input);
      if (!facts || facts.caseId !== input.caseId) {
        logDeliveryFailure("facts_invalid");
        return false;
      }
      if (existing) {
        if (existing.target_id !== facts.targetId || existing.due_at.getTime() !==
            new Date(facts.interviewAt).getTime()) {
          logDeliveryFailure("existing_task_mismatch");
          return false;
        }
      }
      const claim = await claimAuditOutboxSourceTransaction(transaction,{
        id:source.id,organizationId:input.organizationId,
      });
      if ((claim.rowCount ?? claim.rows.length) !== 1) {
        logDeliveryFailure("claim_lost");
        return false;
      }
      if (!existing) await this.insertTask(transaction,facts,source.request_id);
      const delivered = await completeAuditOutboxSourceTransaction(transaction,{
        id:source.id,organizationId:input.organizationId,
      });
      if ((delivered.rowCount ?? delivered.rows.length) !== 1) {
        throw new Error("Interview delivery claim lost");
      }
      this.hooks.failBeforeCommit?.();
      return true;
    }).catch((error) => {
      // Keep asynchronous delivery failures observable without logging SQL or business payloads.
      process.stderr.write(
        `event=interview_task_consumer_failure operation=tasks.interview_task_delivery` +
        ` postgres_code=${safePostgresCode(error)}` +
        ` postgres_constraint=${safePostgresConstraint(error)}\n`,
      );
      return false;
    });
  }

  private async insertTask(
    transaction: TenantTransaction,
    facts: NonNullable<Awaited<ReturnType<CasesInterviewTaskRequestFactsPort["readFacts"]>>>,
    requestId: string,
  ): Promise<void> {
    const taskId = this.createId();
    const taskAssignmentId = this.createId();
    const occurredAt = new Date().toISOString();
    const taskKey = `interview:${facts.invitationId}`;
    await transaction.query({
      text: `INSERT INTO tasks_tasks
        (id,organization_id,service_case_id,school_target_id,task_kind,task_key,
         creation_trigger,source_event_id,title,task_brief,due_at,state,assignee_user_id,
         assignee_role,assignee_redaction_profile,owner_user_id,record_version,created_at,updated_at)
       VALUES ($1,current_setting('app.organization_id')::uuid,$2,$3,
         'interview_support',$4,'case_event',$5,$6,$7,$8,'assigned',$9,
         $10,CASE WHEN $10 IN ('contractor','l3') THEN 'task_only' ELSE NULL END,$11,1,$12,$12)`,
      values:[taskId,facts.caseId,facts.targetId,taskKey,facts.sourceEventId,
        "面試支援",
         facts.taskBrief,
         facts.interviewAt,facts.ownerUserId,facts.assigneeRole,facts.ownerUserId,occurredAt],
    });
    await transaction.query({
      text: `INSERT INTO tasks_task_assignments
        (id,organization_id,task_id,assignee_user_id,assignee_role,redaction_profile,
         assignee_membership_id,assignee_role_binding_id,case_collaborator_id,
         assigned_by_user_id,assigned_by_actor_kind,assigned_by_actor_id,status,reason,
         assignment_reason,assigned_at,record_version,updated_at)
       VALUES ($1,current_setting('app.organization_id')::uuid,$2,$3,$4,
         CASE WHEN $4 IN ('contractor','l3') THEN 'task_only' ELSE NULL END,
         $5,$6,NULL,$7,'system',$8,'assigned','case_event','case_event',$9,1,$9)`,
      values:[taskAssignmentId,taskId,facts.ownerUserId,facts.assigneeRole,
        facts.assigneeMembershipId,facts.assigneeRoleBindingId,facts.sourceActorUserId,facts.sourceEventId,occurredAt],
    });
    const auditId=this.createId();
    const audit=buildAuditEvent({ id:auditId,organizationId:(await organizationId(transaction)),
      actorUserId:null,actorKind:"system",eventType:"tasks.task_created",eventVersion:1,
      action:"create",resourceType:"Task",resourceId:taskId,outcome:"succeeded",requestId,
      occurredAt,metadata:{effect_type:"tasks.task_created",record_version:1,status:"assigned"} });
    const outbox=buildOutboxMessage({ id:this.createId(),auditEventId:auditId,
      organizationId:audit.organizationId,aggregateType:"Task",aggregateId:taskId,
      eventType:"tasks.task_created",eventVersion:1,idempotencyKey:`task-${auditId}`,
      requestId,payload:{aggregate_id:taskId,request_id:requestId,record_version:1,
        status:"assigned",effect_type:"tasks.task_created"},availableAt:occurredAt,createdAt:occurredAt });
    await appendAtomicMutationEffects(adapt(transaction),buildAtomicMutationEffects({audit,outbox}));
  }
}

interface ExistingTask { readonly target_id:string;readonly case_id:string;readonly due_at:Date }
async function readTaskBySource(transaction:TenantTransaction,organizationId:string,sourceEventId:string) {
  const result=await transaction.query<ExistingTask>({ text:`SELECT school_target_id AS target_id,service_case_id AS case_id,due_at
    FROM tasks_tasks WHERE organization_id=$1 AND source_event_id=$2
      AND task_kind='interview_support' FOR UPDATE`,values:[organizationId,sourceEventId] });
  return result.rows[0] ?? null;
}
async function organizationId(transaction:TenantTransaction):Promise<string>{
  const result=await transaction.query<{id:string}>({text:"SELECT current_setting('app.organization_id') AS id"});
  return result.rows[0]!.id;
}
function systemContext(organizationId:string,requestId:string){return {organizationId,
  actorKind:"system" as const,actorOpaqueId:"interview-task-consumer",
  requestId};}

function safePostgresCode(error: unknown): string {
  const code = valueFromError(error, "code");
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "OTHER";
}

function safePostgresConstraint(error: unknown): string {
  const constraint = valueFromError(error, "constraint");
  return typeof constraint === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(constraint)
    ? constraint : "NONE";
}

function logDeliveryFailure(reason: "source_missing" | "source_dead_letter" |
  "delivered_without_task" | "source_not_pending" | "facts_invalid" |
  "existing_task_mismatch" | "claim_lost" | "delivery_lost"): void {
  process.stderr.write(
    `event=interview_task_consumer_pending operation=tasks.interview_task_delivery reason=${reason}\n`,
  );
}

function valueFromError(error: unknown, key: "code" | "constraint"): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as Record<string, unknown>)[key];
}

function adapt(transaction:TenantTransaction){return {query:async<Row extends Record<string,unknown>>(
  text:string,values?:readonly unknown[])=>{const result=await transaction.query<Row>({text,values});
  return{rows:result.rows,rowCount:result.rowCount??result.rows.length};}};}
