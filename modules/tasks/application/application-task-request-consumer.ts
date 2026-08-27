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
import type { CasesApplicationTaskRequestFactsPort } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";

export interface ApplicationTaskAutomationResult {
  readonly applicationTasks: "completed" | "pending";
  readonly requestedCount: number;
  readonly provisionedCount: number;
}

export interface ApplicationTaskRequestConsumerHooks {
  readonly failBeforeCommit?: () => void;
}

export class ApplicationTaskRequestConsumer {
  constructor(
    private readonly runner: TenantTransactionRunner,
    private readonly facts: CasesApplicationTaskRequestFactsPort,
    private readonly createId: () => string = randomUUID,
    private readonly hooks: ApplicationTaskRequestConsumerHooks = {},
  ) {}

  async drainForCandidateVersion(input: Readonly<{
    organizationId: string; caseId: string; versionId: string; requestId: string;
  }>): Promise<ApplicationTaskAutomationResult> {
    const references = await this.runner.run(systemContext(input.organizationId,input.requestId),
      (transaction) => this.facts.listForCandidateVersion(transaction,input));
    let provisionedCount = 0;
    for (const reference of references) {
      if (await this.processOne({ ...input,...reference })) provisionedCount += 1;
    }
    return Object.freeze({ applicationTasks: provisionedCount === references.length
      ? "completed" : "pending",requestedCount:references.length,provisionedCount });
  }

  private processOne(input: Readonly<{
    organizationId:string;caseId:string;versionId:string;requestId:string;
    sourceEventId:string;targetId:string;
  }>): Promise<boolean> {
    return this.runner.run(systemContext(input.organizationId,input.requestId),async (transaction) => {
      const source = (await lockAuditOutboxSourceTransaction(transaction,{
        organizationId:input.organizationId,eventType:"cases.application_task_requested",
        eventVersion:2,aggregateId:input.targetId,auditEventId:input.sourceEventId,
      })).rows[0];
      if (!source || source.status === "dead_letter") return false;
      const existing = await readTaskBySource(transaction,input.organizationId,input.sourceEventId);
      if (source.status === "delivered") return existing !== null;
      if (source.status !== "pending") return false;
      const facts = await this.facts.readRequestFacts(transaction,{
        organizationId:input.organizationId,targetId:input.targetId,
        sourceEventId:input.sourceEventId,
      });
      if (!facts || facts.caseId !== input.caseId || facts.applicationDeadline === null ||
          !Number.isSafeInteger(facts.applicationRound) || facts.applicationRound < 1) return false;
      if (existing) {
        if (existing.target_id !== facts.targetId || existing.due_at.getTime() !==
            new Date(facts.applicationDeadline).getTime()) return false;
      }
      const claim = await claimAuditOutboxSourceTransaction(transaction,{
        id:source.id,organizationId:input.organizationId,
      });
      if ((claim.rowCount ?? claim.rows.length) !== 1) return false;
      if (!existing) await this.insertTask(transaction,facts,source.request_id);
      const delivered = await completeAuditOutboxSourceTransaction(transaction,{
        id:source.id,organizationId:input.organizationId,
      });
      if ((delivered.rowCount ?? delivered.rows.length) !== 1) return false;
      this.hooks.failBeforeCommit?.();
      return true;
    }).catch(() => false);
  }

  private async insertTask(
    transaction: TenantTransaction,
    facts: NonNullable<Awaited<ReturnType<CasesApplicationTaskRequestFactsPort["readRequestFacts"]>>>,
    requestId: string,
  ): Promise<void> {
    const taskId = this.createId();
    const taskAssignmentId = this.createId();
    const occurredAt = new Date().toISOString();
    const taskKey = `application:${facts.targetId}:round:${facts.applicationRound}`;
    await transaction.query({
      text: `INSERT INTO tasks_tasks
        (id,organization_id,service_case_id,school_target_id,task_kind,task_key,
         creation_trigger,source_event_id,title,task_brief,due_at,state,assignee_user_id,
         assignee_role,assignee_redaction_profile,owner_user_id,record_version,created_at,updated_at)
       VALUES ($1,current_setting('app.organization_id')::uuid,$2,$3,
         'application_prepare_submit',$4,'case_event',$5,$6,$7,$8,'assigned',$9,
         'advisor',NULL,$10,1,$11,$11)`,
      values:[taskId,facts.caseId,facts.targetId,taskKey,facts.sourceEventId,
        "Prepare and submit school application",
        "Prepare the required application materials and submit the application.",
         facts.applicationDeadline,facts.assigneeUserId,facts.ownerUserId,occurredAt],
    });
    await transaction.query({
      text: `INSERT INTO tasks_task_assignments
        (id,organization_id,task_id,assignee_user_id,assignee_role,redaction_profile,
         assignee_membership_id,assignee_role_binding_id,case_collaborator_id,
         assigned_by_user_id,assigned_by_actor_kind,assigned_by_actor_id,status,reason,
         assignment_reason,assigned_at,record_version,updated_at)
       VALUES ($1,current_setting('app.organization_id')::uuid,$2,$3,'advisor',NULL,
         $4,$5,NULL,$6,'system',$7,'assigned','case_event','case_event',$8,1,$8)`,
      values:[taskAssignmentId,taskId,facts.assigneeUserId,facts.assigneeMembershipId,
        facts.assigneeRoleBindingId,facts.sourceActorUserId,facts.sourceEventId,occurredAt],
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

interface ExistingTask { readonly target_id:string;readonly due_at:Date }
async function readTaskBySource(transaction:TenantTransaction,organizationId:string,sourceEventId:string) {
  const result=await transaction.query<ExistingTask>({ text:`SELECT school_target_id AS target_id,due_at
    FROM tasks_tasks WHERE organization_id=$1 AND source_event_id=$2
      AND task_kind='application_prepare_submit' FOR UPDATE`,values:[organizationId,sourceEventId] });
  return result.rows[0] ?? null;
}
async function organizationId(transaction:TenantTransaction):Promise<string>{
  const result=await transaction.query<{id:string}>({text:"SELECT current_setting('app.organization_id') AS id"});
  return result.rows[0]!.id;
}
function systemContext(organizationId:string,requestId:string){return {organizationId,
  actorKind:"system" as const,actorOpaqueId:"application-task-consumer",
  requestId};}
function adapt(transaction:TenantTransaction){return {query:async<Row extends Record<string,unknown>>(
  text:string,values?:readonly unknown[])=>{const result=await transaction.query<Row>({text,values});
  return{rows:result.rows,rowCount:result.rowCount??result.rows.length};}};}
