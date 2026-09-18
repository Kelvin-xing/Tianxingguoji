import "server-only";
import { resolvedSchoolDisplayName } from "../../schools/server.ts";
import type { CasesInterviewTaskRequestFactsPort, InterviewTaskRequestFacts, TaskFactsTransaction, TaskFactsAssigneeRole, JsonValue } from "../../shared/public.ts";
import { PostgresqlAccessTaskFactsPort } from "../../access/server.ts";

export class PostgresqlInterviewTaskRequestFacts implements CasesInterviewTaskRequestFactsPort {
  async readSource(tx:TaskFactsTransaction,input:Readonly<{organizationId:string;targetId:string;invitationId:string}>) {
    const result=await tx.query<{audit_event_id:string}>({text:`SELECT audit_event_id FROM audit_outbox
      WHERE organization_id=$1 AND aggregate_id=$2 AND idempotency_key=$3
        AND event_type='cases.interview_invitation_recorded' AND event_version=1`,
      values:[input.organizationId,input.targetId,`interview-${input.invitationId}`]});
    return result.rows.length===1?result.rows[0]!.audit_event_id:null;
  }
  async readFacts(tx:TaskFactsTransaction,input:Readonly<{organizationId:string;targetId:string;invitationId:string}>):Promise<InterviewTaskRequestFacts|null> {
    const sourceEventId=await this.readSource(tx,input);if(!sourceEventId)return null;
    const result=await tx.query<{fields_json:Record<string,JsonValue>;source_school_key:string;interview_method:string|null;interview_language:string|null;coaching_requirements:string|null;background_summary:string|null;case_id:string;interview_at:Date|string;owner_user_id:string;role:TaskFactsAssigneeRole;
      membership_id:string;binding_id:string;actor_user_id:string;business_category:string|null}>({text:`SELECT
      revision.fields_json,school.source_school_key,f.interview_method,f.interview_language,f.coaching_requirements,f.background_summary,c.id AS case_id,f.interview_at,c.primary_user_id AS owner_user_id,b.role,m.id AS membership_id,b.id AS binding_id,
      f.actor_user_id,c.business_category
      FROM cases_school_target_transition_facts f
      JOIN cases_school_targets t ON t.id=f.school_target_id AND t.organization_id=f.organization_id AND t.service_case_id=f.service_case_id
      JOIN schools_resolved_revisions revision ON revision.id=t.pinned_resolved_revision_id AND revision.organization_id=t.organization_id AND revision.school_id=t.school_id
      JOIN schools_schools school ON school.id=t.school_id AND school.organization_id=t.organization_id
      JOIN cases_service_cases c ON c.id=t.service_case_id AND c.organization_id=t.organization_id
      JOIN access_trial_members p ON p.user_id=c.primary_user_id AND p.organization_id=c.organization_id AND p.status='active'
      JOIN access_organization_memberships m ON m.id=p.membership_id AND m.organization_id=p.organization_id AND m.user_id=p.user_id AND m.status='active'
      JOIN access_role_bindings b ON b.membership_id=m.id AND b.organization_id=m.organization_id AND b.user_id=m.user_id AND b.role=p.level AND b.status='active'
      WHERE f.id=$3 AND f.organization_id=$1 AND f.school_target_id=$2 AND f.from_state='submitted' AND f.to_state='interview'
        AND f.interview_at IS NOT NULL AND f.invitation_evidence_document_id IS NOT NULL
        AND t.state='interview' AND t.record_version=f.to_record_version
        AND c.workflow_status='active' AND c.stage='application_in_progress'
      FOR SHARE OF f,t,c,p,m,b`,values:[input.organizationId,input.targetId,input.invitationId]});
    if(result.rows.length!==1)return null;const row=result.rows[0]!;
    if(!await new PostgresqlAccessTaskFactsPort().canAssigneeOperate(tx,{organizationId:input.organizationId,caseId:row.case_id,
      userId:row.owner_user_id,kind:'interview_support',assigneeRole:row.role,businessCategory:row.business_category,
      isPrimaryAdvisor:true,collaboratorId:null}))return null;
    return {sourceEventId,invitationId:input.invitationId,caseId:row.case_id,targetId:input.targetId,
      interviewAt:new Date(row.interview_at).toISOString(),taskBrief:`目標學校：${resolvedSchoolDisplayName(row.fields_json,row.source_school_key).slice(0,200)}\n面試方式：${row.interview_method??"未提供"}\n面試語言：${row.interview_language??"未提供"}\n輔導要求：${row.coaching_requirements??"未提供"}\n必要背景：${row.background_summary??"未提供"}`,ownerUserId:row.owner_user_id,assigneeRole:row.role,
      assigneeMembershipId:row.membership_id,assigneeRoleBindingId:row.binding_id,sourceActorUserId:row.actor_user_id};
  }
}
