import "server-only";
import { randomUUID } from "node:crypto";
import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import { runIdempotentTransaction, IdempotencyExecutionError, type TenantTransaction, type TenantTransactionRunner } from "../../shared/server.ts";
import { DocumentVersionError, type DocumentVersionRepository, type DocumentVersionMutationResult } from "../application/version-service.ts";
import { loadDocumentTrialPrincipal, selectTrialDocumentCase } from "./trial-document-scope.ts";

type Input = Parameters<DocumentVersionRepository["softDeleteDocument"]>[0];
type Operation = "rollback" | "soft_delete" | "restore";
interface DocumentRow extends Record<string, unknown> {
  active_document_version_id:string|null; lifecycle_state:string; legal_hold:boolean;
  soft_deleted_at:Date|string|null; record_version:number|string;
}

/** Trial lifecycle writes. Existing users are never implicitly enrolled or upgraded. */
export class PostgresqlDocumentVersionRepository implements DocumentVersionRepository {
  private readonly runner:TenantTransactionRunner;
  private readonly hooks:Readonly<{failBeforeCommit?:()=>void}>;
  constructor(runner:TenantTransactionRunner,hooks:Readonly<{failBeforeCommit?:()=>void}>={}) {
    this.runner=runner;this.hooks=hooks;
  }
  rollbackToCleanVersion(input:Parameters<DocumentVersionRepository["rollbackToCleanVersion"]>[0]) {
    return this.mutate(input,"rollback",input.targetVersionId);
  }
  softDeleteDocument(input:Input) { return this.mutate(input,"soft_delete",null); }
  restoreDocument(input:Parameters<DocumentVersionRepository["restoreDocument"]>[0]) {
    return this.mutate(input,"restore",input.versionId);
  }
  async history(input:Pick<Input,'actor'|'organizationId'|'caseId'|'documentId'>) {
    return this.runner.run({organizationId:input.organizationId,actorUserId:input.actor.userId},async tx=>{
      const writable=await this.authorize(tx,input,false);
      const document=(await tx.query<DocumentRow>({text:`SELECT active_document_version_id,lifecycle_state,legal_hold,soft_deleted_at,record_version
        FROM documents_documents WHERE id=$1 AND organization_id=$2 AND service_case_id=$3 AND owner_kind='case' AND lifecycle_state IN ('active','pending_delete') FOR SHARE`,
        values:[input.documentId,input.organizationId,input.caseId]})).rows[0];
      if(!document)fail('NOT_FOUND');
      const rows=await tx.query<{id:string;state:string;created_at:Date;revoked_at:Date|null}>({text:`SELECT id,state,created_at,revoked_at FROM documents_document_versions
        WHERE organization_id=$1 AND document_id=$2 ORDER BY upload_generation DESC,id FOR SHARE`,values:[input.organizationId,input.documentId]});
      const deadline=document.soft_deleted_at===null?null:new Date(new Date(document.soft_deleted_at).getTime()+30*24*60*60*1000).toISOString();
      const versions=rows.rows.map(row=>({id:row.id,state:row.state,created_at:new Date(row.created_at).toISOString(),
        active:row.id===document.active_document_version_id,selectable:row.state==='available'&&row.revoked_at===null}));
      return {document_id:input.documentId,record_version:Number(document.record_version),lifecycle_state:document.lifecycle_state,
        legal_hold:document.legal_hold,restore_deadline:deadline,versions,
        can_delete:writable&&document.lifecycle_state==='active'&&!document.legal_hold,
        can_restore:writable&&document.lifecycle_state==='pending_delete'&&deadline!==null&&Date.now()<Date.parse(deadline)&&versions.some(v=>v.selectable),
        can_rollback:writable&&document.lifecycle_state==='active'&&versions.some(v=>v.selectable&&!v.active)};
    });
  }
  private async mutate(input:Input,operation:Operation,targetVersionId:string|null):Promise<DocumentVersionMutationResult> {
    const occurredAt=new Date(input.mutatedAtMs).toISOString();
    try {
      const result=await runIdempotentTransaction({runner:this.runner,
        context:{organizationId:input.organizationId,actorUserId:input.actor.userId,actorKind:"user",actorOpaqueId:input.actor.userId,requestId:input.requestId},
        claim:{id:randomUUID(),organizationId:input.organizationId,actorKind:"user",actorOpaqueId:input.actor.userId,
          operation:`documents.lifecycle.${operation}`,key:input.idempotencyKey,requestHash:input.requestHash,createdAt:occurredAt},
        revalidate:async tx=>{await this.authorize(tx,input);},
        execute:async tx=>{
          const document=(await tx.query<DocumentRow>({text:`SELECT active_document_version_id,lifecycle_state,legal_hold,soft_deleted_at,record_version
            FROM documents_documents WHERE id=$1 AND organization_id=$2 AND service_case_id=$3 AND owner_kind='case' FOR UPDATE`,
            values:[input.documentId,input.organizationId,input.caseId]})).rows[0];
          if(!document||document.lifecycle_state==='deleted')fail("NOT_FOUND");
          if(Number(document.record_version)!==input.expectedRecordVersion)fail("STALE");
          if(operation==='restore'){
            if(document.lifecycle_state!=='pending_delete')fail("RESTORE_NOT_PENDING_DELETE");
            if(document.soft_deleted_at===null || input.mutatedAtMs>=new Date(document.soft_deleted_at).getTime()+30*24*60*60*1000)fail("RESTORE_WINDOW_EXPIRED");
          }else if(document.lifecycle_state!=='active')fail("DELETE_NOT_ACTIVE");
          if(operation==='soft_delete'&&document.legal_hold)fail("DELETE_LEGAL_HOLD");
          if(targetVersionId!==null){
            const version=(await tx.query<{state:string;revoked_at:Date|null}>({text:`SELECT state,revoked_at FROM documents_document_versions
              WHERE id=$1 AND organization_id=$2 AND document_id=$3 FOR SHARE`,values:[targetVersionId,input.organizationId,input.documentId]})).rows[0];
            if(!version||version.state!=='available'||version.revoked_at!==null)fail("CLEAN_VERSION_REQUIRED");
          }
          const value:DocumentVersionMutationResult={documentId:input.documentId,
            activeVersionId:operation==='soft_delete'?null:targetVersionId,
            lifecycleState:operation==='soft_delete'?'pending_delete':'active',recordVersion:input.expectedRecordVersion+1};
          const changed=await tx.query({text:`UPDATE documents_documents SET lifecycle_state=$1,active_document_version_id=$2,
            soft_deleted_at=CASE WHEN $1='pending_delete' THEN $3::timestamptz ELSE NULL END,
            retention_ends_at=CASE WHEN $1='pending_delete' THEN retention_ends_at ELSE NULL END,
            record_version=record_version+1,updated_at=GREATEST(updated_at,$3::timestamptz)
            WHERE id=$4 AND organization_id=$5 AND record_version=$6`,
            values:[value.lifecycleState,value.activeVersionId,occurredAt,input.documentId,input.organizationId,input.expectedRecordVersion]});
          if(changed.rowCount!==1)fail("STALE");
          await appendAtomicMutationEffects(adapt(tx),input.effects);
          this.hooks.failBeforeCommit?.();
          return {state:"completed" as const,resultReference:`${value.documentId}:${value.activeVersionId??'none'}:${value.recordVersion}:${value.lifecycleState}`,
            responseHash:hashRequestPayload({...value}),updatedAt:occurredAt,value};
        }});
      if(result.status==='executed')return result.value;
      // The receipt is immutable: return the original acknowledgement, even after later mutations.
      const [documentId,pointer,recordVersion,lifecycleState]=result.resultReference.split(':');
      if(documentId!==input.documentId || !pointer || !['active','pending_delete'].includes(lifecycleState??''))fail("UNAVAILABLE");
      const value:DocumentVersionMutationResult={documentId,activeVersionId:pointer==='none'?null:pointer,
        recordVersion:Number(recordVersion),lifecycleState:lifecycleState as 'active'|'pending_delete'};
      if(hashRequestPayload({...value})!==result.responseHash)fail("UNAVAILABLE");
      return value;
    }catch(error){
      if(error instanceof DocumentVersionError)throw error;
      if(error instanceof IdempotencyExecutionError){
        if(error.code==='IDEMPOTENCY_KEY_REUSED')fail("IDEMPOTENCY_KEY_REUSED");
        if(error.code==='IDEMPOTENCY_IN_PROGRESS')fail("IDEMPOTENCY_IN_PROGRESS");
      }
      fail("UNAVAILABLE");
    }
  }
  private async authorize(tx:TenantTransaction,input:Pick<Input,'actor'|'organizationId'|'caseId'>,write=true):Promise<boolean> {
    const context={organizationId:input.organizationId,actorUserId:input.actor.userId,actorRole:input.actor.role};
    if(input.organizationId!==input.actor.organizationId)fail("CASE_FORBIDDEN");
    const trialPrincipal=await loadDocumentTrialPrincipal(tx,context);
    if(!trialPrincipal?.active||trialPrincipal.level!==input.actor.role||trialPrincipal.level==='l3')fail("CASE_FORBIDDEN");
    const binding=await tx.query({text:`SELECT id FROM access_role_bindings WHERE organization_id=$1 AND user_id=$2 AND role=$3 AND status='active' FOR SHARE`,
      values:[input.organizationId,input.actor.userId,trialPrincipal.level]});
    if(binding.rows.length!==1)fail("CASE_FORBIDDEN");
    const serviceCase=await selectTrialDocumentCase(tx,{...context,trialPrincipal},input.caseId,{operation:'read',write});
    if(!serviceCase)fail("NOT_FOUND");
    const writable=serviceCase.stage!=='closed'&&serviceCase.workflow_status==='active'&&serviceCase.student_status==='active';
    if(write&&!writable)fail("CASE_FORBIDDEN");
    return writable;
  }
}
type ErrorSuffix = ConstructorParameters<typeof DocumentVersionError>[0] extends `DOCUMENT_VERSION_${infer Suffix}`?Suffix:never;
function fail(code:ErrorSuffix):never {
  throw new DocumentVersionError(`DOCUMENT_VERSION_${code}` as ConstructorParameters<typeof DocumentVersionError>[0]);
}
function adapt(tx:TenantTransaction){return {query:async <R extends Record<string,unknown>>(text:string,values?:readonly unknown[])=>{
  const result=await tx.query<R>({text,values});return {rows:result.rows,rowCount:result.rowCount??result.rows.length};}};}
