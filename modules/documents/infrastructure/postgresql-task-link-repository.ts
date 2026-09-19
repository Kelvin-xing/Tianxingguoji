import "server-only";
import { loadTrialPrincipal } from "../../access/server.ts";
import { evaluateTrialAccess,isK12BusinessCategory,type TrialPrincipal } from "../../access/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import { runIdempotentTransaction,IdempotencyExecutionError,type TenantTransaction,type TenantTransactionRunner } from "../../shared/server.ts";
import { DocumentWorkspaceError,isDocumentWorkspaceError } from "../application/workspace-service.ts";
import type { TaskDocumentLinkRepository,TaskDocumentAction } from "../application/task-link-service.ts";

interface TaskRow extends Record<string,unknown> {id:string;service_case_id:string;business_category:string;state:string;task_kind:string;workflow_status:string;stage:string;}
export class PostgresqlTaskDocumentLinkRepository implements TaskDocumentLinkRepository {
  private readonly runner:TenantTransactionRunner;
  private readonly failBeforeCommit?:()=>void;
  constructor(runner:TenantTransactionRunner,hooks:{failBeforeCommit?:()=>void}={}){this.runner=runner;this.failBeforeCommit=hooks.failBeforeCommit;}
  async list(actor:IdentitySessionActor,taskId:string) {
    try {return await this.runner.run({organizationId:actor.organizationId,actorUserId:actor.userId},async tx=>{
      const {task,principal,manager}=await scope(tx,actor,taskId,false);
      const rows=await tx.query<{id:string;document_id:string;display_name:string;record_version:string;allowed_actions:TaskDocumentAction[];clean:boolean;document_record_version:string;latest_state:string|null;latest_id:string|null;latest_version:string|null}>({
        text:`SELECT l.id,l.document_id,l.record_version,l.allowed_actions,d.display_name,d.record_version AS document_record_version,latest.state AS latest_state,latest.id AS latest_id,latest.record_version AS latest_version,
          EXISTS(SELECT 1 FROM documents_document_versions v WHERE v.id=d.active_document_version_id
            AND v.document_id=d.id AND v.organization_id=d.organization_id AND v.state='available' AND v.revoked_at IS NULL) AS clean
          FROM documents_task_links l JOIN documents_documents d ON d.id=l.document_id AND d.organization_id=l.organization_id
          LEFT JOIN LATERAL(SELECT id,state,record_version FROM documents_document_versions WHERE document_id=d.id AND organization_id=d.organization_id
            ORDER BY upload_generation DESC LIMIT 1) latest ON true
          WHERE l.organization_id=$1 AND l.task_id=$2 AND d.lifecycle_state='active' AND d.soft_deleted_at IS NULL
            AND ($3::boolean OR 'document.read'=ANY(l.allowed_actions)) ORDER BY l.created_at,l.id`,
        values:[actor.organizationId,taskId,manager]});
      const canGrant=manager && task.stage!=='closed' && task.workflow_status==='active' && !['completed','cancelled'].includes(task.state);
      const options=canGrant ? (await tx.query<{id:string;display_name:string}>({text:`SELECT id,display_name FROM documents_documents
        WHERE organization_id=$1 AND service_case_id=$2 AND owner_kind='case' AND lifecycle_state='active' AND soft_deleted_at IS NULL
        ORDER BY display_name,id`,values:[actor.organizationId,task.service_case_id]})).rows.map(row=>({id:row.id,displayName:row.display_name})) : [];
      return {canManage:manager,canGrant,options,links:rows.rows.map(row=>({id:row.id,documentId:row.document_id,displayName:row.display_name,
        recordVersion:Number(row.record_version),availableVersion:row.clean,documentRecordVersion:Number(row.document_record_version),latestVersionState:row.latest_state,
        pendingUpload:row.latest_state==='pending_upload'&&row.latest_id?{id:row.latest_id,recordVersion:Number(row.latest_version)}:null,...(manager?{configuredActions:row.allowed_actions}:{}),
        allowedActions:row.allowed_actions.filter(action=>{
          if(action==='document.download' && (!row.clean || task.task_kind==='interview_support')) return false;
          if(action==='document.upload' && (task.state==='completed' || task.stage==='closed' || task.workflow_status!=='active')) return false;
          return manager || evaluateTrialAccess(principal,action,{organizationId:actor.organizationId,
            category:isK12BusinessCategory(task.business_category)?task.business_category:null,projection:'task_only',
            task:{assigneeUserId:actor.userId,assignmentStatus:'active',status:task.state as 'assigned'|'accepted'|'completed'},
            document:{linkedToTask:true,allowedTaskActions:row.allowed_actions,availableVersion:row.clean}}).allowed;
        })}))};
    });} catch(e){throw mapped(e);}
  }
  async set(input:Parameters<TaskDocumentLinkRepository['set']>[0]) {
    try {
      let authorizedTask:TaskRow|null=null;
      const result=await runIdempotentTransaction({runner:this.runner,
        context:{organizationId:input.actor.organizationId,actorUserId:input.actor.userId},
        claim:{id:input.id,organizationId:input.actor.organizationId,actorKind:'user',actorOpaqueId:input.actor.userId,
          operation:'documents.task_link.set',key:input.idempotencyKey,requestHash:input.requestHash,createdAt:input.effects.audit.occurredAt},
        revalidate:async tx=>{const {task,manager}=await scope(tx,input.actor,input.taskId,true);
          if(!manager) fail('FORBIDDEN');
          authorizedTask=task;
          if(task.task_kind==='interview_support' && input.allowedActions.includes('document.download')) fail('FORBIDDEN');
          const document=await tx.query({text:`SELECT id FROM documents_documents WHERE id=$1 AND organization_id=$2
            AND owner_kind='case' AND service_case_id=$3 AND lifecycle_state='active' AND soft_deleted_at IS NULL FOR SHARE`,
            values:[input.documentId,input.actor.organizationId,task.service_case_id]});
          if(document.rows.length!==1) fail('NOT_FOUND');
        },
        execute:async tx=>{
          if(!authorizedTask) fail('UNAVAILABLE');
          if(input.allowedActions.length && (authorizedTask.stage==='closed' || authorizedTask.workflow_status!=='active' || ['completed','cancelled'].includes(authorizedTask.state))) fail('CONFLICT');
          const current=await tx.query<{id:string;record_version:string}>({text:`SELECT id,record_version FROM documents_task_links
            WHERE organization_id=$1 AND task_id=$2 AND document_id=$3 FOR UPDATE`,values:[input.actor.organizationId,input.taskId,input.documentId]});
          const row=current.rows[0];
          if(Number(row?.record_version??0)!==input.expectedRecordVersion) fail('CONFLICT');
          const id=row?.id??input.id;
          if(row) await tx.query({text:`UPDATE documents_task_links SET allowed_actions=$2,reason=$3,changed_by_user_id=$4,
            record_version=record_version+1 WHERE id=$1`,values:[id,input.allowedActions,input.reason,input.actor.userId]});
          else await tx.query({text:`INSERT INTO documents_task_links(id,organization_id,task_id,document_id,allowed_actions,reason,changed_by_user_id)
            VALUES($1,$2,$3,$4,$5,$6,$7)`,values:[id,input.actor.organizationId,input.taskId,input.documentId,input.allowedActions,input.reason,input.actor.userId]});
          await appendAtomicMutationEffects(adapt(tx),input.effects);this.failBeforeCommit?.();
          const value={id,recordVersion:input.expectedRecordVersion+1};
          return {state:'completed' as const,resultReference:`${id}:${value.recordVersion}`,responseHash:hashRequestPayload(value),updatedAt:input.effects.audit.occurredAt,value};
        }});
      if(result.status==='executed') return result.value;
      const match=/^([0-9a-f-]{36}):(\d+)$/.exec(result.resultReference);
      if(!match) fail('UNAVAILABLE');
      const value={id:match[1]!,recordVersion:Number(match[2])};
      if(hashRequestPayload(value)!==result.responseHash) fail('UNAVAILABLE');
      return value;
    } catch(e){throw mapped(e);}
  }
}
function adapt(tx:TenantTransaction){return {async query<R extends Record<string,unknown>>(sql:string,values?:readonly unknown[]){const r=await tx.query<R>({text:sql,values});return {rows:r.rows,rowCount:r.rowCount??r.rows.length};}};}
async function scope(tx:TenantTransaction,actor:IdentitySessionActor,taskId:string,write:boolean):Promise<{task:TaskRow;principal:TrialPrincipal;manager:boolean}>{
  const principal=await loadTrialPrincipal(adapt(tx),{organizationId:actor.organizationId,userId:actor.userId,lock:true});
  if(!principal?.active || principal.level!==actor.role) fail('FORBIDDEN');
  const binding=await tx.query({text:`SELECT id FROM access_role_bindings WHERE organization_id=$1 AND user_id=$2 AND role=$3 AND status='active' FOR SHARE`,values:[actor.organizationId,actor.userId,principal.level]});
  if(binding.rows.length!==1) fail('FORBIDDEN');
  const locator=await tx.query<{service_case_id:string}>({text:`SELECT service_case_id FROM tasks_tasks WHERE id=$1 AND organization_id=$2`,values:[taskId,actor.organizationId]});
  const caseId=locator.rows[0]?.service_case_id;if(!caseId) fail('NOT_FOUND');
  await tx.query({text:`SELECT id FROM cases_service_cases WHERE id=$1 AND organization_id=$2 FOR SHARE`,values:[caseId,actor.organizationId]});
  const result=await tx.query<TaskRow>({text:`SELECT t.id,t.service_case_id,t.state,t.task_kind,c.business_category,c.stage,c.workflow_status
    FROM tasks_tasks t JOIN cases_service_cases c ON c.id=t.service_case_id AND c.organization_id=t.organization_id
    WHERE t.id=$1 AND t.organization_id=$2 FOR ${write?'UPDATE':'SHARE'} OF t`,values:[taskId,actor.organizationId]});
  const task=result.rows[0];if(!task || !isK12BusinessCategory(task.business_category)) fail('NOT_FOUND');
  const manager=evaluateTrialAccess(principal,'task.assign',{organizationId:actor.organizationId,category:task.business_category}).allowed;
  if(!manager){
    if(principal.level!=='l3' || !['assigned','accepted','completed'].includes(task.state)) fail('NOT_FOUND');
    const assignment=await tx.query({text:`SELECT id FROM tasks_task_assignments WHERE task_id=$1 AND organization_id=$2
      AND assignee_user_id=$3 AND assignee_role='l3' AND redaction_profile='task_only' AND ended_at IS NULL
      AND status IN ('assigned','accepted') FOR SHARE`,values:[taskId,actor.organizationId,actor.userId]});
    if(assignment.rows.length!==1) fail('NOT_FOUND');
  }
  return {task,principal,manager};
}
function fail(code:'FORBIDDEN'|'NOT_FOUND'|'CONFLICT'|'UNAVAILABLE'):never{throw new DocumentWorkspaceError(`DOCUMENT_WORKSPACE_${code}`);}
function mapped(e:unknown){return isDocumentWorkspaceError(e)?e:new DocumentWorkspaceError(e instanceof IdempotencyExecutionError?'DOCUMENT_WORKSPACE_CONFLICT':'DOCUMENT_WORKSPACE_UNAVAILABLE');}
