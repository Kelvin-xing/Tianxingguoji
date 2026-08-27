import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
} from "../../audit/public.ts";
import {
  appendAtomicMutationEffects,
  claimAuditOutboxSourceTransaction,
  completeAuditOutboxSourceTransaction,
  lockAuditOutboxSourceTransaction,
} from "../../audit/server.ts";
import type {
  DocumentsCleanEvidencePort,
  TasksApplicationCompletionEventFactsPort,
} from "../../shared/public.ts";
import type { TenantTransaction,TenantTransactionRunner } from "../../shared/server.ts";

export interface ApplicationSubmissionAutomationResult {
  readonly targetTransition:"completed"|"pending";
  readonly targetId:string;
  readonly targetRecordVersion:number|null;
}
export interface ApplicationSubmissionConsumerHooks { readonly failBeforeCommit?:()=>void }

export class ApplicationSubmissionConsumer {
  constructor(private readonly runner:TenantTransactionRunner,
    private readonly taskFacts:TasksApplicationCompletionEventFactsPort,
    private readonly evidence:DocumentsCleanEvidencePort,
    private readonly createId:()=>string=randomUUID,
    private readonly hooks:ApplicationSubmissionConsumerHooks={}){}

  drainForTask(input:Readonly<{organizationId:string;taskId:string;requestId:string}>) {
    return this.runner.run(systemContext(input.organizationId,input.requestId),async transaction=>{
      const source=(await lockAuditOutboxSourceTransaction(transaction,{
        organizationId:input.organizationId,eventType:"tasks.application_submission_completed",
        eventVersion:1,aggregateId:input.taskId,
      })).rows[0];
      const completion=await this.taskFacts.readApplicationCompletionEvent(transaction,input);
      if (!source || !completion || source.status === "dead_letter") return pending(completion?.targetId);
      const existing=await readSubmittedTarget(transaction,input.organizationId,completion.targetId,
        completion.receiptId);
      if (source.status === "delivered") return existing ?? pending(completion.targetId);
      if (source.status !== "pending") return pending(completion.targetId);
      const record=completion.completionRecord;
      if (!validCompletion(record,completion.actorUserId)) return pending(completion.targetId);
      const official=typeof record.official_submission_reference === "string"
        ? record.official_submission_reference.trim() : null;
      const noReference=record.no_reference_declared === true;
      if (noReference) {
        if (!completion.evidenceReference || !await this.evidence.readCleanCaseEvidence(transaction,{
          organizationId:input.organizationId,caseId:completion.caseId,targetId:completion.targetId,
          taskId:completion.taskId,evidenceId:completion.evidenceReference,
        })) return pending(completion.targetId);
      }
      const targetResult=await transaction.query<TargetRow>({
        text:`SELECT target.id,target.service_case_id,target.state,target.record_version,
                    target.current_assignment_id,assignment.assignee_user_id
               FROM cases_school_targets AS target
               JOIN cases_school_target_assignments AS assignment
                 ON assignment.id=target.current_assignment_id
                AND assignment.organization_id=target.organization_id
                AND assignment.school_target_id=target.id
              WHERE target.organization_id=$1 AND target.id=$2
                AND target.service_case_id=$3 FOR UPDATE OF target,assignment`,
        values:[input.organizationId,completion.targetId,completion.caseId],
      });
      const target=targetResult.rows[0];
      if (!target || target.state!=="preparing" ||
          target.assignee_user_id!==completion.actorUserId) return pending(completion.targetId);
      const claim=await claimAuditOutboxSourceTransaction(transaction,{
        id:source.id,organizationId:input.organizationId,
      });
      if ((claim.rowCount??claim.rows.length)!==1) return pending(completion.targetId);
      const occurredAt=new Date().toISOString();
      const nextVersion=Number(target.record_version)+1;
      await transaction.query({
        text:`INSERT INTO cases_school_target_transition_facts
          (id,organization_id,service_case_id,school_target_id,transition_kind,from_state,to_state,
           actor_user_id,assignment_id,from_record_version,to_record_version,submission_task_id,
           task_completion_receipt_id,submission_channel,submitted_at,official_submission_reference,
           no_reference_declared,alternative_evidence_document_id,occurred_at)
         VALUES ($1,$2,$3,$4,'workflow','preparing','submitted',$5,$6,$7,$8,$9,$10,$11,$12,
           $13,$14,$15,$16)`,
        values:[this.createId(),input.organizationId,completion.caseId,completion.targetId,
          completion.actorUserId,target.current_assignment_id,Number(target.record_version),nextVersion,
          completion.taskId,completion.receiptId,record.submission_channel,record.submitted_at,
          official,noReference,completion.evidenceReference,occurredAt],
      });
      await transaction.query({
        text:"SELECT set_config('app.target_workflow_transition','authorized',true)",
      });
      const updated=await transaction.query({
        text:`UPDATE cases_school_targets SET state='submitted',record_version=$1,updated_at=$2
               WHERE id=$3 AND organization_id=$4 AND state='preparing' AND record_version=$5`,
        values:[nextVersion,occurredAt,completion.targetId,input.organizationId,
          Number(target.record_version)],
      });
      await transaction.query({
        text:"SELECT set_config('app.target_workflow_transition','',true)",
      });
      if ((updated.rowCount??0)!==1) return pending(completion.targetId);
      const auditId=this.createId();
      const audit=buildAuditEvent({id:auditId,organizationId:input.organizationId,
        actorUserId:null,actorKind:"system",eventType:"cases.application_submission_recorded",
        eventVersion:1,action:"transition",resourceType:"SchoolTarget",
        resourceId:completion.targetId,outcome:"succeeded",requestId:source.request_id,
        occurredAt,metadata:{effect_type:"cases.application_submission_recorded",
          record_version:nextVersion,status:"submitted"}});
      const outbox=buildOutboxMessage({id:this.createId(),auditEventId:auditId,
        organizationId:input.organizationId,aggregateType:"SchoolTarget",
        aggregateId:completion.targetId,eventType:"cases.application_submission_recorded",
        eventVersion:1,idempotencyKey:`target-${auditId}`,requestId:source.request_id,
        payload:{aggregate_id:completion.targetId,request_id:source.request_id,
          record_version:nextVersion,status:"submitted",
          effect_type:"cases.application_submission_recorded"},availableAt:occurredAt,createdAt:occurredAt});
      await appendAtomicMutationEffects(adapt(transaction),buildAtomicMutationEffects({audit,outbox}));
      const delivered=await completeAuditOutboxSourceTransaction(transaction,{
        id:source.id,organizationId:input.organizationId,
      });
      if ((delivered.rowCount??delivered.rows.length)!==1) return pending(completion.targetId);
      this.hooks.failBeforeCommit?.();
      return Object.freeze({targetTransition:"completed" as const,targetId:completion.targetId,
        targetRecordVersion:nextVersion});
    }).catch(()=>pending());
  }
}

interface TargetRow{readonly id:string;readonly service_case_id:string;readonly state:string;
  readonly record_version:number|string;readonly current_assignment_id:string;
  readonly assignee_user_id:string}
async function readSubmittedTarget(transaction:TenantTransaction,organizationId:string,
  targetId:string,receiptId:string){const result=await transaction.query<{record_version:number|string}>({
    text:`SELECT target.record_version FROM cases_school_targets AS target
      JOIN cases_school_target_transition_facts AS fact ON fact.organization_id=target.organization_id
        AND fact.school_target_id=target.id AND fact.to_state='submitted'
        AND fact.task_completion_receipt_id=$3
      WHERE target.organization_id=$1 AND target.id=$2 AND target.state='submitted'`,
    values:[organizationId,targetId,receiptId]});const row=result.rows[0];return row?Object.freeze({
      targetTransition:"completed" as const,targetId,targetRecordVersion:Number(row.record_version)}):null;}
function validCompletion(value:Readonly<Record<string,unknown>>,actorUserId:string){
  const keys=Object.keys(value).sort().join(",");
  if(keys!=="checklist_snapshot,no_reference_declared,official_submission_reference,submission_channel,submitted_at,submitter_user_id")return false;
  const checklist=value.checklist_snapshot;
  if(!checklist||typeof checklist!=="object"||Array.isArray(checklist)||
    Object.keys(checklist).sort().join(",")!=="all_required_items_complete,confirmed_at")return false;
  const checked=checklist as Record<string,unknown>;
  if(checked.all_required_items_complete!==true||typeof checked.confirmed_at!=="string"||
    !validPastInstant(checked.confirmed_at)||typeof value.submitted_at!=="string"||
    !validPastInstant(value.submitted_at)||value.submitter_user_id!==actorUserId||
    !["school_portal","email","courier","in_person","other"].includes(String(value.submission_channel)))return false;
  const official=typeof value.official_submission_reference==="string"&&value.official_submission_reference.trim()!=="";
  return value.no_reference_declared===true?value.official_submission_reference===null:
    value.no_reference_declared===false&&official;
}
function validPastInstant(value:string){const time=Date.parse(value);return Number.isFinite(time)&&time<=Date.now();}
function pending(targetId="00000000-0000-4000-8000-000000000000"){return Object.freeze({
  targetTransition:"pending" as const,targetId,targetRecordVersion:null});}
function systemContext(organizationId:string,requestId:string){return{organizationId,
  actorKind:"system" as const,actorOpaqueId:"application-submission-consumer",
  requestId};}
function adapt(transaction:TenantTransaction){return{query:async<Row extends Record<string,unknown>>(
  text:string,values?:readonly unknown[])=>{const result=await transaction.query<Row>({text,values});
  return{rows:result.rows,rowCount:result.rowCount??result.rows.length};}};}
