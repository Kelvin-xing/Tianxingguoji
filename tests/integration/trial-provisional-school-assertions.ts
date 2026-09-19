import {PostgresqlSchoolDirectoryRepository} from "../../modules/schools/infrastructure/postgresql-directory-repository.ts";
import {SchoolResolutionError} from "../../modules/schools/application/resolved-view.ts";
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {workspaceCapabilitiesForRole,type RequestAccessActor,type Release1OrganizationRole} from '../../modules/access/public.ts';
import type {TenantTransactionRunner} from '../../modules/shared/server.ts';
import {createProvisionalSchool,SchoolServiceError} from '../../modules/schools/application/service.ts';
import {PostgresqlProvisionalSchoolRepository} from '../../modules/schools/infrastructure/postgresql-provisional-repository.ts';

export async function assertTrialProvisionalSchool(input:{client:Client;runner:TenantTransactionRunner;organizationId:string;userId:string;founderUserId:string;role:Release1OrganizationRole}){
  const {client,organizationId:org}=input;
  await client.query('SAVEPOINT provisional_fixture');
  try{
    const principal=(await client.query('SELECT level,categories,record_version FROM access_trial_members WHERE user_id=$1',[input.userId])).rows[0];
    const actor:RequestAccessActor={userId:input.userId,organizationId:org,roles:[input.role],workspaceCapabilities:workspaceCapabilitiesForRole(input.role),...(principal?{trialPrincipal:{userId:input.userId,organizationId:org,level:principal.level,categories:principal.categories,recordVersion:Number(principal.record_version),active:true}}:{})};
    const runner:TenantTransactionRunner={async run(context,operation){await client.query('SAVEPOINT provisional_command');try{return await input.runner.run(context,operation)}catch(error){await client.query('ROLLBACK TO SAVEPOINT provisional_command');throw error}finally{await client.query('RELEASE SAVEPOINT provisional_command')}}};
    const repository=new PostgresqlProvisionalSchoolRepository(runner);
    const directory=new PostgresqlSchoolDirectoryRepository(runner);
    const reader={organizationId:org,actorUserId:input.userId};
    const command={schoolNameZh:' 合成未验证学校 ',requestId:randomUUID(),idempotencyKey:randomUUID()};
    const denied=(error:unknown)=>error instanceof SchoolServiceError&&error.code==='SCHOOL_ADVISOR_REQUIRED';
    if(input.role==='l3'){
      await assert.rejects(()=>directory.listProvisionals(reader),error=>error instanceof SchoolResolutionError&&error.code==='SCHOOL_RESOLUTION_FORBIDDEN');
      await assert.rejects(()=>createProvisionalSchool({actor,command},{repository}),denied);
      // A stale, forged request capability must also fail inside the transaction.
      await assert.rejects(()=>createProvisionalSchool({actor:{...actor,trialPrincipal:undefined,workspaceCapabilities:['schools.provisional.create']},command},{repository}),denied);
      return;
    }
    const result=await createProvisionalSchool({actor,command},{repository});
    assert.deepEqual(await createProvisionalSchool({actor,command},{repository}),result);
    const row=(await client.query('SELECT * FROM schools_provisional_records WHERE school_id=$1',[result.schoolId])).rows[0];
    assert.equal(row.school_name_zh,'合成未验证学校');
    assert.equal(row.school_name_en,null);assert.equal(row.district,null);assert.equal(row.reason,null);
    assert.ok((await directory.listProvisionals(reader)).some(item=>item.school_id===result.schoolId&&item.school_name_zh==='合成未验证学校'));
    assert.equal(row.created_by_user_id,input.userId);assert.equal(row.status,'provisional');
    assert.equal((await client.query('SELECT source_school_key FROM schools_schools WHERE id=$1',[result.schoolId])).rows[0].source_school_key,null);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM schools_snapshot_records WHERE school_id=$1',[result.schoolId])).rows[0].count,0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM audit_events WHERE resource_id=$1',[result.schoolId])).rows[0].count,1);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM audit_outbox WHERE aggregate_id=$1',[result.schoolId])).rows[0].count,1);
    await assert.rejects(()=>createProvisionalSchool({actor,command:{...command,schoolNameZh:'另一个名称'}},{repository}),error=>error instanceof SchoolServiceError&&error.code==='SCHOOL_CHANGE_IDEMPOTENCY_KEY_REUSED');
    const english=await createProvisionalSchool({actor,command:{schoolNameEn:'Synthetic Unverified School',requestId:randomUUID(),idempotencyKey:randomUUID()}},{repository});
    assert.notEqual(english.schoolId,result.schoolId);
    // Same name is never used as an identity or automatic merge key.
    const duplicate=await createProvisionalSchool({actor,command:{...command,idempotencyKey:randomUUID()}},{repository});
    assert.notEqual(duplicate.schoolId,result.schoolId);
    await assert.rejects(()=>createProvisionalSchool({actor,command:{...command,schoolNameZh:' ',schoolNameEn:null}},{repository}),error=>error instanceof SchoolServiceError&&error.code==='SCHOOL_COMMAND_INVALID');
    // Force an audit primary-key failure and verify all business/idempotency writes roll back.
    const audit=(await client.query('SELECT id FROM audit_events WHERE resource_id=$1',[result.schoolId])).rows[0].id;
    const failedId=randomUUID();const ids=[failedId,audit,randomUUID()];
    const failedKey=randomUUID();
    await assert.rejects(()=>createProvisionalSchool({actor,command:{...command,idempotencyKey:failedKey}},{repository,createId:()=>ids.shift()!}));
    assert.equal((await client.query('SELECT count(*)::int AS count FROM schools_schools WHERE id=$1',[failedId])).rows[0].count,0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM schools_provisional_records WHERE school_id=$1',[failedId])).rows[0].count,0);
    const recovered=await createProvisionalSchool({actor,command:{...command,idempotencyKey:failedKey}},{repository});
    assert.notEqual(recovered.schoolId,failedId);
    await client.query('SAVEPOINT provisional_boundary');
    await client.query("SELECT set_config('app.organization_id','',true)");
    assert.equal((await client.query('SELECT count(*)::int AS count FROM schools_provisional_records')).rows[0].count,0);
    await client.query('ROLLBACK TO SAVEPOINT provisional_boundary');
    await client.query('RELEASE SAVEPOINT provisional_boundary');
    await client.query('SAVEPOINT provisional_immutable');
    await assert.rejects(()=>client.query("UPDATE schools_provisional_records SET school_name_zh='overwrite' WHERE school_id=$1",[result.schoolId]));
    await client.query('ROLLBACK TO SAVEPOINT provisional_immutable');
    await client.query('RELEASE SAVEPOINT provisional_immutable');
    if(input.role==='l1'||input.role==='l2'){
      await client.query("SELECT set_config('app.actor_user_id',$1,true)",[input.founderUserId]);
      await client.query("UPDATE access_trial_members SET status='disabled',record_version=record_version+1 WHERE user_id=$1",[input.userId]);
      await assert.rejects(()=>createProvisionalSchool({actor,command},{repository}),denied);
      await assert.rejects(()=>directory.listProvisionals(reader),error=>error instanceof SchoolResolutionError&&error.code==='SCHOOL_RESOLUTION_FORBIDDEN');
    }
  }finally{await client.query('ROLLBACK TO SAVEPOINT provisional_fixture');await client.query('RELEASE SAVEPOINT provisional_fixture')}
}
