import "server-only";
import { loadTrialPrincipal } from "../../access/server.ts";
import { evaluateTrialAccess,isK12BusinessCategory,type TrialPrincipal,type OrganizationRole } from "../../access/public.ts";
import type { TenantTransaction } from "../../shared/server.ts";

export interface DocumentTrialContext {
  readonly organizationId:string;readonly actorUserId:string;readonly actorRole:OrganizationRole;
  readonly trialPrincipal?:TrialPrincipal|null;
}
export function loadDocumentTrialPrincipal(tx:TenantTransaction,input:DocumentTrialContext) {
  return loadTrialPrincipal({query:<R extends Record<string,unknown>>(sql:string,values?:readonly unknown[])=>tx.query<R>({text:sql,values})},
    {organizationId:input.organizationId,userId:input.actorUserId,lock:true});
}
export interface TrialDocumentCase extends Record<string,unknown> {id:string;stage:string;workflow_status:string;student_status:string;business_category:string;}
/** Caller validates the active identity binding, then locks case -> task -> assignment -> file. */
export async function selectTrialDocumentCase(tx:TenantTransaction,input:DocumentTrialContext,caseId:string,scope:{
  documentId?:string;taskId?:string;operation:'read'|'upload'|'download';write:boolean;
}):Promise<TrialDocumentCase|null> {
  const principal=input.trialPrincipal;
  if(!principal?.active || principal.level!==input.actorRole) return null;
  const result=await tx.query<TrialDocumentCase>({text:`SELECT c.id,c.stage,c.workflow_status,c.business_category,s.status AS student_status
    FROM cases_service_cases c JOIN crm_students s ON s.id=c.student_id AND s.organization_id=c.organization_id
    WHERE c.id=$1 AND c.organization_id=$2 FOR ${scope.write?'UPDATE':'SHARE'} OF c FOR SHARE OF s`,values:[caseId,input.organizationId]});
  const row=result.rows[0];if(!row || !isK12BusinessCategory(row.business_category))return null;
  const manager=evaluateTrialAccess(principal,'case.read',{organizationId:input.organizationId,category:row.business_category}).allowed;
  if(!manager && principal.level!=='l3')return null;
  if(!scope.taskId)return manager?row:null;
  const task=(await tx.query<{id:string;state:string;task_kind:string}>({text:`SELECT id,state,task_kind FROM tasks_tasks
    WHERE id=$1 AND organization_id=$2 AND service_case_id=$3 FOR SHARE`,values:[scope.taskId,input.organizationId,caseId]})).rows[0];
  if(!task || !['assigned','accepted','completed'].includes(task.state))return null;
  if(scope.operation==='upload' && (task.state==='completed'||row.stage==='closed'||row.workflow_status!=='active'||row.student_status!=='active'))return null;
  if(scope.operation==='download' && task.task_kind==='interview_support')return null;
  if(!manager){
    const assignment=await tx.query({text:`SELECT id FROM tasks_task_assignments WHERE task_id=$1 AND organization_id=$2
      AND assignee_user_id=$3 AND assignee_role='l3' AND redaction_profile='task_only'
      AND ended_at IS NULL AND status IN ('assigned','accepted') FOR SHARE`,values:[task.id,input.organizationId,input.actorUserId]});
    if(assignment.rows.length!==1)return null;
  }
  const link=await tx.query({text:`SELECT id FROM documents_task_links WHERE task_id=$1 AND organization_id=$2
    AND document_id=$3 AND 'document.read'=ANY(allowed_actions) AND $4=ANY(allowed_actions) FOR SHARE`,
    values:[task.id,input.organizationId,scope.documentId??null,`document.${scope.operation}`]});
  return link.rows.length===1?row:null;
}
