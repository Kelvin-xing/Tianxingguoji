import {DocumentObjectReceiptService} from '../../modules/documents/application/object-receipt-service.ts';
import {assertTrialDocumentLifecycle} from './trial-document-lifecycle-assertions.ts';
import {PostgresqlDocumentScanRepository} from '../../modules/documents/infrastructure/postgresql-scan-repository.ts';
import {DocumentScanService} from '../../modules/documents/application/scan-service.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import type {TenantTransactionRunner} from '../../modules/shared/server.ts';
import type {IdentitySessionActor} from '../../modules/identity/public.ts';
import {DocumentWorkspaceService,isDocumentWorkspaceError} from '../../modules/documents/application/workspace-service.ts';
import {PostgresqlDocumentWorkspaceRepository} from '../../modules/documents/infrastructure/postgresql-workspace-repository.ts';
import {DocumentTransferService,isDocumentTransferError,type DocumentTransportAuthorization} from '../../modules/documents/application/transfer-service.ts';
import {PostgresqlDocumentTransferRepository} from '../../modules/documents/infrastructure/postgresql-transfer-repository.ts';
import {TaskDocumentLinkService} from '../../modules/documents/application/task-link-service.ts';

export async function assertTrialDocumentTransfers(input:{client:Client;runner:TenantTransactionRunner;caseId:string;taskId:string;documentId:string;
  business:IdentitySessionActor;restricted:IdentitySessionActor;taskOnly:IdentitySessionActor;links:TaskDocumentLinkService}) {
  const {client,runner,caseId,taskId,documentId,business,restricted,taskOnly,links}=input;
  const documents=new DocumentWorkspaceService(new PostgresqlDocumentWorkspaceRepository(runner));
  const key=()=>({requestId:randomUUID(),idempotencyKey:randomUUID()});
  assert.ok((await documents.list(business)).documents.some(row=>row.id===documentId));
  assert.ok((await documents.list(restricted)).documents.some(row=>row.id===documentId));
  assert.deepEqual((await documents.list(taskOnly)).documents,[]);
  assert.equal(await documents.detail(taskOnly,caseId,documentId),null);
  const localCase=(await client.query("SELECT id FROM cases_service_cases WHERE business_category='local_school' LIMIT 1")).rows[0]!.id;
  await assert.rejects(documents.register({actor:restricted,caseId:localCase,command:{displayName:'Synthetic denied document',classification:'operational_attachment',...key()}}),
    error=>isDocumentWorkspaceError(error,'DOCUMENT_WORKSPACE_NOT_FOUND'));
  const created=await documents.register({actor:business,caseId,command:{displayName:'Synthetic authorized metadata',classification:'operational_attachment',...key()}});
  assert.ok(await documents.detail(restricted,caseId,created.id));
  let uploadScope:DocumentTransportAuthorization|undefined,downloadScope:DocumentTransportAuthorization|undefined;
  const repository=new PostgresqlDocumentTransferRepository(runner);
  const service=new DocumentTransferService({repository,bucket:'synthetic-private',signer:{
    async issueUploadIntent(value){uploadScope=value.authorization;return {url:'https://synthetic.invalid/upload'};},
    async issueDownloadIntent(value){downloadScope=value.authorization;return {url:'https://synthetic.invalid/download'};}
  }});
  const denied=(code:string)=>(error:unknown)=>isDocumentTransferError(error)&&error.code===`DOCUMENT_TRANSFER_${code}`;
  const documentVersion=(await client.query('SELECT record_version FROM documents_documents WHERE id=$1',[documentId])).rows[0]!.record_version;
  const command={actor:taskOnly,caseId,taskId,documentId,command:{checksumSha256:'b'.repeat(64),sizeBytes:1_048_576,contentType:'application/pdf',expectedDocumentRecordVersion:Number(documentVersion),...key()}};
  await assert.rejects(service.createVersion({...command,taskId:undefined}),denied('NOT_FOUND'));
  const pending=await service.createVersion(command);
  assert.deepEqual(await service.createVersion(command),pending);
  await service.issueUploadIntent({actor:taskOnly,caseId,taskId,documentId,versionId:pending.id,expectedRecordVersion:1,requestId:randomUUID()});
  assert.equal(uploadScope?.taskId,taskId);assert.equal(uploadScope?.actorUserId,taskOnly.userId);
  await service.issueDownloadIntent({actor:taskOnly,caseId,taskId,documentId,requestId:randomUUID()});
  assert.equal(downloadScope?.taskId,taskId);
  const object=(await client.query('SELECT object_bucket,object_key,object_version_id FROM documents_document_versions WHERE id=$1',[downloadScope!.versionId])).rows[0]!;
  let delivered=0;
  const capability={actor:taskOnly,authorization:downloadScope!,operation:'download' as const,bucket:object.object_bucket,key:object.object_key,
    providerVersionId:object.object_version_id,execute:async()=>{delivered++;return 'synthetic callback';}};
  assert.equal(await service.consumeCapability(capability),'synthetic callback');assert.equal(delivered,1);
  const pendingObject=(await client.query('SELECT object_bucket,object_key FROM documents_document_versions WHERE id=$1',[pending.id])).rows[0]!;
  const uploadCapability={actor:taskOnly,authorization:uploadScope!,operation:'upload' as const,bucket:pendingObject.object_bucket,key:pendingObject.object_key,
    execute:async()=>{delivered++;return 'synthetic upload callback';}};
  const link=(await links.list(business,taskId)).links.find(row=>row.documentId===documentId)!;
  await links.set({actor:business,taskId,documentId,expectedRecordVersion:link.recordVersion,allowedActions:[],reason:'Synthetic transfer access withdrawal',...key()});
  await assert.rejects(service.consumeCapability(capability),denied('NOT_FOUND'));
  await assert.rejects(service.consumeCapability(uploadCapability),denied('NOT_FOUND'));assert.equal(delivered,1);
  await assert.rejects(service.createVersion(command),denied('NOT_FOUND'));
  await links.set({actor:business,taskId,documentId,expectedRecordVersion:link.recordVersion+1,allowedActions:['document.read','document.upload','document.download'],reason:'Synthetic restore transfer access',...key()});
  await assert.rejects(async()=>service.consumeCapability({...capability,actor:business}),denied('FORBIDDEN'));
  await client.query('SAVEPOINT trial_file_scan');
  const scanRepository=new PostgresqlDocumentScanRepository(runner,{organizationId:business.organizationId,workerContextId:'99999999-9999-4999-8999-999999999999'});
  const receipt=new DocumentObjectReceiptService({repository:scanRepository,organizationId:business.organizationId});
  const event={eventId:randomUUID(),requestId:`scan-${randomUUID()}`,bucket:'synthetic-private',key:`documents/${documentId}/versions/${pending.id}`,
    versionId:'fake-v1-'+ 'c'.repeat(64),scanPolicyVersion:'clamav-release1-v1',deliveryAttempt:1};
  assert.equal((await receipt.receive(event,async()=>({sizeBytes:1_048_576,contentType:'application/pdf',checksumSha256Base64:Buffer.from('b'.repeat(64),'hex').toString('base64')}))).status,'ready');
  const scans=new DocumentScanService({repository:scanRepository}),claim=await scans.claimScanWork(event);
  assert.equal(claim.status,'claimed');
  if(claim.status!=='claimed')throw new Error('Expected claimed scan');
  assert.equal((await scans.completeScanWork({event,work:claim.work,verdict:'clean',scannerEngine:'deterministic-fake-release1'})).status,'available');
  await assert.rejects(service.consumeCapability(capability),denied('CONFLICT'));
  assert.equal(delivered,1);
  await assertTrialDocumentLifecycle({client,runner,caseId,documentId,business,restricted,taskOnly,rollbackVersionId:downloadScope!.versionId});
  await client.query('ROLLBACK TO SAVEPOINT trial_file_scan');await client.query('RELEASE SAVEPOINT trial_file_scan');
  const currentVersion=Number((await client.query('SELECT record_version FROM documents_documents WHERE id=$1',[documentId])).rows[0]!.record_version);
  await service.abandonPendingUpload({actor:taskOnly,taskId,caseId,documentId,versionId:pending.id,
    command:{expectedDocumentRecordVersion:currentVersion,expectedVersionRecordVersion:1,...key()}});
  assert.equal((await client.query('SELECT state FROM documents_document_versions WHERE id=$1',[pending.id])).rows[0]!.state,'abandoned');
  process.stdout.write(JSON.stringify({trial_document_transfers:'pass',metadata:'grade_category_scoped',l3_case_endpoint:'denied',task_version:'create_replay_abandon',token:'actor_bound_revalidated',revocation:'callback_not_executed'})+'\n');
}
