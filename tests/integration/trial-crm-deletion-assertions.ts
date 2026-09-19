import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {workspaceCapabilitiesForRole,type RequestAccessActor,type Release1OrganizationRole} from '../../modules/access/public.ts';
import type {TenantTransactionRunner} from '../../modules/shared/server.ts';
import {PostgresqlCustomerDeletionGuard} from '../../modules/cases/infrastructure/postgresql-customer-deletion-guard.ts';
import {DeletionReviewService,isDeletionReviewError,PENDING_DELETE_REASON} from '../../modules/crm/application/deletion-review-service.ts';
import {PostgresqlDeletionReviewRepository} from '../../modules/crm/infrastructure/postgresql-deletion-review-repository.ts';

export async function assertTrialCrmDeletion(input:{client:Client;runner:TenantTransactionRunner;organizationId:string;userId:string;founderUserId:string;role:Release1OrganizationRole;studentId:string;guardianId:string;allowed:boolean}) {
  const {client,organizationId:org}=input;
  await client.query('SAVEPOINT trial_deletion');
  try {
    const principal=(await client.query('SELECT level,categories,record_version FROM access_trial_members WHERE user_id=$1',[input.userId])).rows[0];
    const actor:RequestAccessActor={userId:input.userId,organizationId:org,roles:[input.role],workspaceCapabilities:workspaceCapabilitiesForRole(input.role),
      ...(principal?{trialPrincipal:{userId:input.userId,organizationId:org,level:principal.level,categories:principal.categories,recordVersion:Number(principal.record_version),active:true}}:{})};
    // Each service transaction gets its own rollback boundary, including expected rejections.
    const runner:TenantTransactionRunner={async run(context,operation){
      await client.query('SAVEPOINT deletion_command');
      try{return await input.runner.run(context,operation)}catch(error){await client.query('ROLLBACK TO SAVEPOINT deletion_command');throw error}
      finally{await client.query('RELEASE SAVEPOINT deletion_command')}
    }};
    const service=new DeletionReviewService(new PostgresqlDeletionReviewRepository(runner,new PostgresqlCustomerDeletionGuard()));
    const command=(entityType:'student'|'guardian',entityId:string,expectedRecordVersion:number)=>({entityType,entityId,expectedRecordVersion,reasonCode:PENDING_DELETE_REASON,requestId:`delete-${randomUUID()}`,idempotencyKey:`delete-${randomUUID()}`});
    const denied=(error:unknown)=>isDeletionReviewError(error,'DELETION_REVIEW_FORBIDDEN')||isDeletionReviewError(error,'DELETION_REVIEW_NOT_FOUND');
    for(const [kind,id,table] of [['student',input.studentId,'crm_students'],['guardian',input.guardianId,'crm_guardians']] as const){
      const version=Number((await client.query(`SELECT record_version FROM ${table} WHERE id=$1`,[id])).rows[0].record_version);
      await assert.rejects(async()=>service.requestDeletion({actor,command:command(kind,id,version)}),input.allowed?(error:unknown)=>isDeletionReviewError(error,'DELETION_REVIEW_CONFLICT'):denied,
        'open cases and current guardian relationships remain blockers even for authorized grades');
    }
    const orphan=randomUUID();
    await client.query("INSERT INTO crm_guardians(id,organization_id,display_name,email,status) VALUES ($1,$2,'Synthetic deletion guardian','delete@example.invalid','active')",[orphan,org]);
    const request=command('guardian',orphan,1);
    const canReview=input.role==='founder'||input.role==='l1';
    if(!canReview){
      await assert.rejects(async()=>service.requestDeletion({actor,command:request}),denied,'no historical role grants orphan guardian access');
      await assert.rejects(async()=>service.listDeletionRequests(actor,null),denied);
      await assert.rejects(async()=>service.decideDeletion({actor,command:{entityType:'guardian',entityId:orphan,decision:'approve',expectedRecordVersion:2,correlationRequestId:'denied-decision',idempotencyKey:randomUUID()}}),denied);
      return;
    }
    const failingRunner:TenantTransactionRunner={run:(context,operation)=>runner.run(context,tx=>operation({query:query=>{
      if(query.text.includes('INSERT INTO audit_events'))throw new Error('Synthetic audit unavailable');
      return tx.query(query);
    }}))};
    const failing=new DeletionReviewService(new PostgresqlDeletionReviewRepository(failingRunner,new PostgresqlCustomerDeletionGuard(),()=>{}));
    await assert.rejects(async()=>failing.requestDeletion({actor,command:command('guardian',orphan,1)}),error=>isDeletionReviewError(error,'DELETION_REVIEW_UNAVAILABLE'));
    assert.equal((await client.query('SELECT status FROM crm_guardians WHERE id=$1',[orphan])).rows[0].status,'active','audit failure rolls back the pending-delete mutation');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM audit_outbox WHERE aggregate_id=$1',[orphan])).rows[0].count,0);
    const pending=await service.requestDeletion({actor,command:request});
    assert.equal(pending.status,'pending_delete');
    assert.deepEqual(await service.requestDeletion({actor,command:request}),pending);
    assert.ok((await service.listDeletionRequests(actor,'guardian')).some(row=>row.entityId===orphan));
    const decide=(decision:'approve'|'reject',expectedRecordVersion:number)=>({entityType:'guardian' as const,entityId:orphan,decision,expectedRecordVersion,correlationRequestId:`decision-${randomUUID()}`,idempotencyKey:randomUUID()});
    const rejection=decide('reject',2);
    assert.equal((await service.decideDeletion({actor,command:rejection})).status,'active');
    const second=command('guardian',orphan,3);
    await service.requestDeletion({actor,command:second});
    const approval=decide('approve',4);
    const result=await service.decideDeletion({actor,command:approval});
    assert.equal(result.status,'deleted');
    assert.deepEqual(await service.decideDeletion({actor,command:approval}),result);
    await assert.rejects(async()=>service.requestDeletion({actor,command:second}),error=>isDeletionReviewError(error,'DELETION_REVIEW_NOT_FOUND'),'deleted profiles do not return old request receipts');
    assert.equal((await service.listDeletionRequests(actor,null)).some(row=>row.entityId===orphan),false);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM audit_events WHERE resource_id=$1',[orphan])).rows[0].count,4);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM audit_outbox WHERE aggregate_id=$1',[orphan])).rows[0].count,4);
    if(input.role==='l1'){
      await client.query("SELECT set_config('app.actor_user_id',$1,true)",[input.founderUserId]);
      await client.query("UPDATE access_trial_members SET status='disabled',record_version=record_version+1 WHERE user_id=$1",[input.userId]);
      await assert.rejects(async()=>service.decideDeletion({actor,command:approval}),denied,'disabled reviewers cannot replay original decisions');
      await assert.rejects(async()=>service.listDeletionRequests(actor,null),denied);
      await assert.rejects(async()=>service.requestDeletion({actor,command:request}),denied);
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
  } finally {await client.query('ROLLBACK TO SAVEPOINT trial_deletion');await client.query('RELEASE SAVEPOINT trial_deletion')}
}
