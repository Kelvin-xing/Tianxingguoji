import "server-only";
import { evaluateTrialAccess, type K12BusinessCategory } from "../../access/public.ts";
import { loadTrialPrincipal } from "../../access/server.ts";
import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload, type TaskFactsTransaction } from "../../shared/public.ts";
import { runIdempotentTransaction, IdempotencyExecutionError, type TenantTransaction, type TenantTransactionRunner } from "../../shared/server.ts";
import { InterviewInvitationError, type InterviewInvitationRepository, type InterviewInvitationWrite, type InterviewInvitationResult } from "../application/interview-invitation-service.ts";

export interface InvitationEvidencePort {
  readCleanCaseDocument(transaction:TaskFactsTransaction,input:Readonly<{organizationId:string;caseId:string;documentId:string}>):Promise<boolean>;
}
export class PostgresqlInterviewInvitationRepository implements InterviewInvitationRepository {
  private readonly runner:TenantTransactionRunner;
  private readonly evidence:InvitationEvidencePort;
  private readonly hooks:Readonly<{failBeforeCommit?:()=>void}>;
  constructor(runner:TenantTransactionRunner,evidence:InvitationEvidencePort,hooks:Readonly<{failBeforeCommit?:()=>void}>={}) {
    this.runner=runner;this.evidence=evidence;this.hooks=hooks;
  }
  async record(input:InterviewInvitationWrite):Promise<InterviewInvitationResult> {
    const context={organizationId:input.actor.organizationId,actorKind:"user" as const,actorOpaqueId:input.actor.userId,
      actorUserId:input.actor.userId,requestId:input.requestId};
    try {
      const result=await runIdempotentTransaction({runner:this.runner,context,
        claim:{id:input.idempotencyRecordId,organizationId:context.organizationId,actorKind:"user",actorOpaqueId:input.actor.userId,
          operation:"cases.interview_invitation",key:input.idempotencyKey,requestHash:input.requestHash,createdAt:input.occurredAt},
        revalidate:async tx=>{await this.authorize(tx,input);},
        execute:async tx=>{
          const target=(await tx.query<{state:string;record_version:number|string;current_assignment_id:string|null}>({
            text:"SELECT state,record_version,current_assignment_id FROM cases_school_targets WHERE organization_id=$1 AND service_case_id=$2 AND id=$3 FOR UPDATE",
            values:[context.organizationId,input.caseId,input.targetId]})).rows[0];
          if(!target)throw new InterviewInvitationError("NOT_FOUND");
          if(Number(target.record_version)!==input.expectedRecordVersion)throw new InterviewInvitationError("STALE_VERSION");
          if(target.state!=="submitted"||!target.current_assignment_id)throw new InterviewInvitationError("CONFLICT");
          if(!await this.evidence.readCleanCaseDocument(tx,{organizationId:context.organizationId,caseId:input.caseId,documentId:input.invitationDocumentId}))throw new InterviewInvitationError("EVIDENCE_REQUIRED");
          const value:InterviewInvitationResult={targetId:input.targetId,recordVersion:input.expectedRecordVersion+1,state:"interview",invitationId:input.invitationId};
          await tx.query({text:`INSERT INTO cases_school_target_transition_facts
            (id,organization_id,service_case_id,school_target_id,transition_kind,from_state,to_state,actor_user_id,assignment_id,
             from_record_version,to_record_version,interview_at,invitation_evidence_document_id,occurred_at)
            VALUES ($1,$2,$3,$4,'workflow','submitted','interview',$5,$6,$7,$8,$9,$10,$11)`,
            values:[input.invitationId,context.organizationId,input.caseId,input.targetId,input.actor.userId,target.current_assignment_id,
              input.expectedRecordVersion,value.recordVersion,input.interviewAt,input.invitationDocumentId,input.occurredAt]});
          await tx.query({text:"SELECT set_config('app.target_workflow_transition','authorized',true)"});
          const updated=await tx.query({text:"UPDATE cases_school_targets SET state='interview',record_version=$1,updated_at=GREATEST(updated_at,$2::timestamptz) WHERE id=$3 AND organization_id=$4 AND record_version=$5",
            values:[value.recordVersion,input.occurredAt,input.targetId,context.organizationId,input.expectedRecordVersion]});
          if(updated.rowCount!==1)throw new InterviewInvitationError("STALE_VERSION");
          await tx.query({text:"SELECT set_config('app.target_workflow_transition','',true)"});
          await appendAtomicMutationEffects(adapt(tx),input.effects);this.hooks.failBeforeCommit?.();
          return {state:"completed" as const,resultReference:input.invitationId,responseHash:hashRequestPayload({...value}),updatedAt:input.occurredAt,value};
        }});
      if(result.status==="executed")return result.value;
      return await this.runner.run(context,async tx=>{
        await this.authorize(tx,input);
        const row=(await tx.query<{id:string;to_record_version:number|string}>({text:`SELECT id,to_record_version FROM cases_school_target_transition_facts
          WHERE id=$1 AND organization_id=$2 AND service_case_id=$3 AND school_target_id=$4 AND to_state='interview'`,
          values:[result.resultReference,context.organizationId,input.caseId,input.targetId]})).rows[0];
        if(!row)throw new InterviewInvitationError("CONFLICT");
        const value:InterviewInvitationResult={targetId:input.targetId,recordVersion:Number(row.to_record_version),state:"interview",invitationId:row.id};
        if(hashRequestPayload({...value})!==result.responseHash)throw new InterviewInvitationError("CONFLICT");
        return value;
      });
    } catch(error) {
      if(error instanceof InterviewInvitationError)throw error;
      if(error instanceof IdempotencyExecutionError)throw new InterviewInvitationError("CONFLICT");
      throw new InterviewInvitationError("UNAVAILABLE");
    }
  }
  private async authorize(tx:TenantTransaction,input:InterviewInvitationWrite) {
    const principal=await loadTrialPrincipal(adapt(tx),{organizationId:input.actor.organizationId,userId:input.actor.userId,lock:true});
    const row=(await tx.query<{business_category:K12BusinessCategory|null;stage:string;workflow_status:string}>({
      text:"SELECT business_category,stage,workflow_status FROM cases_service_cases WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      values:[input.caseId,input.actor.organizationId]})).rows[0];
    if(!principal||!row||principal.level!==input.actor.trialPrincipal?.level||!evaluateTrialAccess(principal,"case.manage",{organizationId:input.actor.organizationId,category:row.business_category}).allowed)throw new InterviewInvitationError("NOT_FOUND");
    const binding=await tx.query({text:"SELECT id FROM access_role_bindings WHERE organization_id=$1 AND user_id=$2 AND role=$3 AND status='active' FOR SHARE",values:[input.actor.organizationId,input.actor.userId,principal.level]});
    if(binding.rows.length!==1)throw new InterviewInvitationError("NOT_FOUND");
    if(row.stage==="closed"||row.workflow_status!=="active")throw new InterviewInvitationError("CONFLICT");
  }
}
function adapt(tx:TenantTransaction){return {query:async <Row extends Record<string,unknown>>(text:string,values?:readonly unknown[])=>{
  const result=await tx.query<Row>({text,values});return {rows:result.rows,rowCount:result.rowCount??result.rows.length};}};}
