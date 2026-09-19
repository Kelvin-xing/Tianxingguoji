import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {workspaceCapabilitiesForRole,type RequestAccessActor,type Release1OrganizationRole} from '../../modules/access/public.ts';
import type {TenantTransactionRunner} from '../../modules/shared/server.ts';
import {ReferralSourceService,REFERRAL_SOURCE_DEACTIVATE_REASON} from '../../modules/crm/application/referral-source-service.ts';
import {PostgresqlReferralSourceRepository} from '../../modules/crm/infrastructure/postgresql-referral-source-repository.ts';
import {CaseReferralSourceAssignmentService} from '../../modules/cases/application/referral-source-assignment-service.ts';
import {PostgresqlCaseReferralSourceAssignmentRepository} from '../../modules/cases/infrastructure/postgresql-referral-source-assignment-repository.ts';
export async function assertTrialReferralSources(input:{client:Client;runner:TenantTransactionRunner;organizationId:string;userId:string;founderUserId:string;role:Release1OrganizationRole;caseId:string;allowed:boolean}){
  const {client,organizationId:org}=input;
  await client.query('SAVEPOINT trial_referral');
  try{
    const principal=(await client.query('SELECT level,categories,record_version FROM access_trial_members WHERE user_id=$1',[input.userId])).rows[0];
    const actor:RequestAccessActor={userId:input.userId,organizationId:org,roles:[input.role],workspaceCapabilities:workspaceCapabilitiesForRole(input.role),...(principal?{trialPrincipal:{userId:input.userId,organizationId:org,level:principal.level,categories:principal.categories,recordVersion:Number(principal.record_version),active:true}}:{})};
    const runner:TenantTransactionRunner={async run(context,operation){await client.query('SAVEPOINT referral_command');try{return await input.runner.run(context,operation)}catch(error){await client.query('ROLLBACK TO SAVEPOINT referral_command');throw error}finally{await client.query('RELEASE SAVEPOINT referral_command')}}};
    const sources=new ReferralSourceService(new PostgresqlReferralSourceRepository(runner));
    const assignments=new CaseReferralSourceAssignmentService(new PostgresqlCaseReferralSourceAssignmentRepository(runner));
    const denied=(error:unknown)=>error instanceof Error&&/_(FORBIDDEN|NOT_FOUND)$/.test(String((error as {code?:string}).code));
    const meta=()=>({requestId:randomUUID(),idempotencyKey:randomUUID()});
    const sourceId=randomUUID();
    await client.query("INSERT INTO crm_referral_sources(id,organization_id,display_name,source_type,status) VALUES ($1,$2,'Synthetic source','website','active')",[sourceId,org]);
    if(input.role==='l3')await assert.rejects(async()=>sources.list(actor),denied);
    else assert.ok((await sources.list(actor,{query:'Synthetic source'})).items.some(row=>row.id===sourceId));
    const creation={...meta(),displayName:'Synthetic managed source',sourceType:'website' as const,description:null};
    if(input.role==='founder'||input.role==='l1'){
      const created=await sources.create({actor,command:creation});
      assert.deepEqual(await sources.create({actor,command:creation}),created);
      const update={...meta(),sourceId:created.id,expectedRecordVersion:1,displayName:'Synthetic revised source',sourceType:'website' as const,description:null};
      const updated=await sources.update({actor,command:update});assert.equal(updated.recordVersion,2);
      const deactivate={...meta(),sourceId:created.id,expectedRecordVersion:2,reasonCode:REFERRAL_SOURCE_DEACTIVATE_REASON};
      assert.equal((await sources.deactivate({actor,command:deactivate})).status,'inactive');
      assert.equal((await sources.find(actor,created.id)).status,'inactive');
    }else await assert.rejects(async()=>sources.create({actor,command:creation}),denied);
    const command={...meta(),caseId:input.caseId,referralSourceId:sourceId,expectedCurrentAssignmentRecordVersion:null};
    if(!input.allowed){
      await assert.rejects(async()=>assignments.assign({actor,command}),denied);
      if(input.role==='l3')await assert.rejects(async()=>assignments.read(actor,input.caseId),denied);
      else assert.equal(await assignments.read(actor,input.caseId),null);
      return;
    }
    const result=await assignments.assign({actor,command});
    assert.deepEqual(await assignments.assign({actor,command}),result);
    assert.equal((await assignments.read(actor,input.caseId))?.current?.referralSourceId,sourceId);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM audit_events WHERE resource_id=$1',[result.id])).rows[0].count,1);
    const replacementId=randomUUID();
    await client.query("INSERT INTO crm_referral_sources(id,organization_id,display_name,source_type,status) VALUES ($1,$2,'Synthetic replacement','employee_referral','active')",[replacementId,org]);
    const replacement={...meta(),caseId:input.caseId,referralSourceId:replacementId,expectedCurrentAssignmentRecordVersion:1};
    const replaced=await assignments.assign({actor,command:replacement});
    assert.deepEqual(await assignments.assign({actor,command:replacement}),replaced);
    const view=await assignments.read(actor,input.caseId);
    assert.equal(view?.current?.referralSourceId,replacementId);
    assert.equal(view?.history[0]?.referralSourceId,sourceId);
    assert.ok(Date.parse(view!.history[0]!.endsAt!)>=Date.parse(view!.history[0]!.startsAt));
    if(input.role==='l2'){
      await client.query(`UPDATE crm_referral_sources SET status='inactive',deactivated_at=transaction_timestamp(),
        deactivated_by_user_id=$2,deactivate_reason_code=$3,record_version=record_version+1,updated_at=transaction_timestamp() WHERE id=$1`,[sourceId,input.founderUserId,REFERRAL_SOURCE_DEACTIVATE_REASON]);
      assert.equal((await sources.list(actor,{status:'inactive'})).items.some(row=>row.id===sourceId),false);
      await assert.rejects(async()=>sources.find(actor,sourceId),denied);
      assert.equal((await assignments.read(actor,input.caseId))?.history[0]?.referralSourceId,sourceId,'inactive sources retain case history');
    }
    if(input.role==='l1'||input.role==='l2'){
      await client.query("SELECT set_config('app.actor_user_id',$1,true)",[input.founderUserId]);
      await client.query(input.role==='l2'?"UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1":"UPDATE access_trial_members SET status='disabled',record_version=record_version+1 WHERE user_id=$1",[input.userId]);
      await assert.rejects(async()=>assignments.assign({actor,command}),denied);
      if(input.role==='l1')await assert.rejects(async()=>sources.create({actor,command:creation}),denied);
    }
  }finally{await client.query('ROLLBACK TO SAVEPOINT trial_referral');await client.query('RELEASE SAVEPOINT trial_referral')}
}
