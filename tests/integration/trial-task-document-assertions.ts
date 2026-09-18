import {assertTrialDocumentTransfers} from './trial-document-transfer-assertions.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { IdentitySessionActor } from '../../modules/identity/public.ts';
import type { TenantTransactionRunner } from '../../modules/shared/server.ts';
import { TaskDocumentLinkService } from '../../modules/documents/application/task-link-service.ts';
import { PostgresqlTaskDocumentLinkRepository } from '../../modules/documents/infrastructure/postgresql-task-link-repository.ts';
import { PostgresqlCleanTaskEvidencePort } from '../../modules/documents/infrastructure/postgresql-clean-task-evidence.ts';
import { isDocumentWorkspaceError } from '../../modules/documents/application/workspace-service.ts';

export async function assertTrialTaskDocuments(input:{client:Client;runner:TenantTransactionRunner;caseId:string;taskId:string;
  business:IdentitySessionActor;restricted:IdentitySessionActor;taskOnly:IdentitySessionActor}) {
  const {client,caseId,taskId,business,restricted,taskOnly}=input;
  const runner:TenantTransactionRunner={run:(context,operation)=>input.runner.run(context,tx=>operation({async query<Row>(query:{text:string;values?:readonly unknown[]}){
    try{return await tx.query<Row>(query);}catch(error){const e=error as {code?:string;constraint?:string;message?:string};
      process.stdout.write(JSON.stringify({trial_document_sql:{code:e.code,constraint:e.constraint,message:e.message}})+'\n');throw error;}
  }}))};
  const org=business.organizationId,documentId=randomUUID();
  const links=new TaskDocumentLinkService(new PostgresqlTaskDocumentLinkRepository(runner));
  const key=()=>({requestId:randomUUID(),idempotencyKey:randomUUID()});
  const denied=(suffix:string)=>(e:unknown)=>isDocumentWorkspaceError(e) && e.code===`DOCUMENT_WORKSPACE_${suffix}`;
  await client.query(`INSERT INTO documents_documents(id,organization_id,owner_kind,service_case_id,display_name,classification)
    VALUES($1,$2,'case',$3,'Synthetic task evidence','operational_attachment')`,[documentId,org,caseId]);
  const targetId=(await client.query('SELECT school_target_id FROM tasks_tasks WHERE id=$1',[taskId])).rows[0]!.school_target_id;
  const evidence=()=>runner.run({organizationId:org,actorUserId:taskOnly.userId},tx=>new PostgresqlCleanTaskEvidencePort().readCleanCaseEvidence(tx,
    {organizationId:org,caseId,targetId,taskId,evidenceId:documentId,actorUserId:taskOnly.userId}));
  assert.equal(await evidence(),false);
  assert.deepEqual((await links.list(taskOnly,taskId)).links,[]);
  const command={actor:restricted,taskId,documentId,expectedRecordVersion:0,allowedActions:['document.read','document.upload','document.download'] as const,
    reason:'Synthetic task-specific evidence grant',...key()};
  await assert.rejects(links.set({...command,actor:taskOnly,...key()}),denied('FORBIDDEN'));
  const failing=new TaskDocumentLinkService(new PostgresqlTaskDocumentLinkRepository(runner,{failBeforeCommit(){throw new Error('Synthetic link audit rollback');}}));
  await assert.rejects(failing.set({...command,...key()}),denied('UNAVAILABLE'));
  assert.equal((await links.list(business,taskId)).links.length,0);
  const ack=await links.set(command);assert.equal(ack.recordVersion,1);
  assert.deepEqual(await links.set(command),ack);
  assert.deepEqual((await links.list(taskOnly,taskId)).links[0]!.allowedActions,['document.read','document.upload']);
  assert.equal(await evidence(),false);
  await assert.rejects(links.set({...command,...key()}),denied('CONFLICT'));
  const other=(await client.query('SELECT id FROM cases_service_cases WHERE id<>$1 LIMIT 1',[caseId])).rows[0]!.id;
  const otherDocument=randomUUID();
  await client.query(`INSERT INTO documents_documents(id,organization_id,owner_kind,service_case_id,display_name,classification)
    VALUES($1,$2,'case',$3,'Synthetic unrelated evidence','operational_attachment')`,[otherDocument,org,other]);
  await assert.rejects(links.set({...command,documentId:otherDocument,...key()}),denied('NOT_FOUND'));
  // Build a synthetic clean metadata lifecycle using the real SQL constraints.
  // This proves grant/evidence authorization, not object upload or antivirus execution.
  await seedSyntheticCleanTaskVersion(client,org,documentId,business.userId);
  assert.equal(await evidence(),true);
  const visible=await links.list(taskOnly,taskId);
  assert.equal(visible.canManage,false);assert.equal('caseId' in visible.links[0]!,false);
  assert.deepEqual(visible.links[0]!.allowedActions,['document.read','document.upload','document.download']);
  const revoke=await links.set({...command,actor:business,allowedActions:[],expectedRecordVersion:1,reason:'Synthetic withdraw file grant',...key()});
  assert.equal(revoke.recordVersion,2);assert.equal(await evidence(),false);assert.deepEqual((await links.list(taskOnly,taskId)).links,[]);
  await links.set({...command,expectedRecordVersion:2,...key()});
  assert.equal(await evidence(),true);
  await client.query('SAVEPOINT task_document_scope');
  await client.query("SELECT set_config('app.actor_user_id',(SELECT user_id::text FROM access_trial_members WHERE level='founder' AND status='active' LIMIT 1),true)");
  await client.query(`UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1`,[restricted.userId]);
  await assert.rejects(links.set(command),denied('NOT_FOUND'));
  await client.query('ROLLBACK TO SAVEPOINT task_document_scope');await client.query('RELEASE SAVEPOINT task_document_scope');
  assert.equal((await client.query("SELECT count(*)::int n FROM audit_events WHERE resource_id=$1 AND event_type='documents.task_link_changed'",[taskId])).rows[0]!.n,3);
  process.stdout.write(JSON.stringify({trial_task_documents:'pass',links:'explicit_actions',cross_case:'denied',l3_grant:'denied',replay:'single_audit',rollback:'atomic',clean_evidence:'granted_only'})+'\n');
  await assertTrialDocumentTransfers({client,runner,caseId,taskId,documentId,business,restricted,taskOnly,links});
  return {documentId,links};
}

/** Synthetic metadata fixture only; no object transport or antivirus is invoked. */
export async function seedSyntheticCleanTaskVersion(client:Client,org:string,documentId:string,userId:string) {
  const versionId=randomUUID(),scanId=randomUUID();
  const objectKey=`documents/${documentId}/versions/${versionId}`;
  await client.query(`INSERT INTO documents_document_versions(id,organization_id,document_id,object_bucket,object_key,
    checksum_sha256,size_bytes,detected_content_type,uploaded_by_user_id,state,upload_generation)
    VALUES($1,$2,$3,'synthetic-private',$4,$5,1024,'application/pdf',$6,'pending_upload',1)`,[versionId,org,documentId,objectKey,'a'.repeat(64),userId]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');await client.query('SET CONSTRAINTS ALL DEFERRED');
  await client.query(`UPDATE documents_document_versions SET object_version_id='synthetic-version',state='quarantined',record_version=record_version+1 WHERE id=$1`,[versionId]);
  await client.query(`INSERT INTO documents_scan_results(id,organization_id,document_version_id,scan_policy_version,state,attempt_count,
    object_bucket,object_key,object_version_id) VALUES($1,$2,$3,'clamav-release1-v1','queued',0,'synthetic-private',$4,'synthetic-version')`,[scanId,org,versionId,objectKey]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');await client.query('SET CONSTRAINTS ALL DEFERRED');
  await client.query(`UPDATE documents_scan_results SET state='running',attempt_count=1,started_at=transaction_timestamp(),record_version=record_version+1 WHERE id=$1`,[scanId]);
  await client.query(`UPDATE documents_document_versions SET state='scanning',record_version=record_version+1 WHERE id=$1`,[versionId]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');await client.query('SET CONSTRAINTS ALL DEFERRED');
  await client.query(`UPDATE documents_scan_results SET state='clean',engine='clamav-release1',completed_at=transaction_timestamp(),record_version=record_version+1 WHERE id=$1`,[scanId]);
  await client.query(`UPDATE documents_document_versions SET state='available',record_version=record_version+1 WHERE id=$1`,[versionId]);
  await client.query(`UPDATE documents_documents SET active_document_version_id=$2,record_version=record_version+1 WHERE id=$1`,[documentId,versionId]);
}
