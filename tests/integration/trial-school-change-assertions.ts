import {SchoolResolutionError} from "../../modules/schools/application/resolved-view.ts";
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {workspaceCapabilitiesForRole,type RequestAccessActor,type Release1OrganizationRole} from '../../modules/access/public.ts';
import type {TenantTransactionRunner} from '../../modules/shared/server.ts';
import {sha256SchoolValue} from '../../modules/schools/public.ts';
import {submitSchoolChange,SchoolServiceError} from '../../modules/schools/application/service.ts';
import {PostgresqlSchoolChangeRepository} from '../../modules/schools/infrastructure/postgresql-change-repository.ts';
import {PostgresqlSchoolDirectoryRepository} from '../../modules/schools/infrastructure/postgresql-directory-repository.ts';

export async function assertTrialSchoolChanges(input:{client:Client;runner:TenantTransactionRunner;organizationId:string;userId:string;founderUserId:string;role:Release1OrganizationRole}){
  const {client,organizationId:org}=input;
  await client.query('SAVEPOINT school_change_fixture');
  try{
    const principal=(await client.query('SELECT level,categories,record_version FROM access_trial_members WHERE user_id=$1',[input.userId])).rows[0];
    const actor:RequestAccessActor={userId:input.userId,organizationId:org,roles:[input.role],workspaceCapabilities:workspaceCapabilitiesForRole(input.role),...(principal?{trialPrincipal:{userId:input.userId,organizationId:org,level:principal.level,categories:principal.categories,recordVersion:Number(principal.record_version),active:true}}:{})};
    const runner:TenantTransactionRunner={async run(context,operation){await client.query('SAVEPOINT school_change_command');try{return await input.runner.run(context,operation)}catch(error){await client.query('ROLLBACK TO SAVEPOINT school_change_command');throw error}finally{await client.query('RELEASE SAVEPOINT school_change_command')}}};
    const repository=new PostgresqlSchoolChangeRepository(runner);
    const base=(await client.query(`SELECT record.school_id,record.snapshot_id,record.fields_json FROM schools_snapshot_records record JOIN schools_snapshots snapshot ON snapshot.id=record.snapshot_id AND snapshot.status='active' ORDER BY record.school_id LIMIT 1`)).rows[0];
    const command={fieldName:'phone',fieldClass:'general' as const,baseSnapshotId:base.snapshot_id,baseValueSha256:sha256SchoolValue(base.fields_json.phone??null),expectedEffectiveValueSha256:sha256SchoolValue(null),
      proposedValue:'Synthetic phone',reason:'Synthetic missing information',evidence:{sourceUrl:'https://example.invalid/source',quote:'Synthetic evidence'},requestId:randomUUID(),idempotencyKey:randomUUID()};
    assert.equal(base.fields_json.phone??null,null);
    const request={actor,schoolId:base.school_id,command};
    const denied=(error:unknown)=>error instanceof SchoolServiceError&&error.code==='SCHOOL_ADVISOR_REQUIRED';
    const reader={organizationId:org,actorUserId:input.userId,schoolId:base.school_id};
    if(input.role==='l3'){
      await assert.rejects(()=>repository.list(reader),error=>error instanceof SchoolResolutionError&&error.code==='SCHOOL_RESOLUTION_FORBIDDEN');
      await assert.rejects(()=>submitSchoolChange(request,{repository}),denied);
      await assert.rejects(()=>submitSchoolChange({...request,actor:{...actor,trialPrincipal:undefined,workspaceCapabilities:['schools.read']}},{repository}),denied);
      return;
    }
    const result=await submitSchoolChange(request,{repository});
    assert.deepEqual(await submitSchoolChange(request,{repository}),result);
    const history=await repository.list(reader);
    const entry=history.find(item=>item.change_request_id===result.changeRequestId)!;
    assert.equal(entry.status,'candidate');assert.equal(entry.fields[0]?.snapshot_value,null);assert.equal(entry.fields[0]?.proposed_value,'Synthetic phone');
    assert.equal('requested_by_user_id' in entry,false);
    await assert.rejects(()=>repository.list({...reader,schoolId:randomUUID()}),error=>error instanceof SchoolResolutionError&&error.code==='SCHOOL_RESOLUTION_NOT_FOUND');
    const saved=(await client.query('SELECT status,requested_by_user_id,approved_by_user_id FROM schools_overlay_revisions WHERE id=$1',[result.changeRequestId])).rows[0];
    assert.deepEqual(saved,{status:'candidate',requested_by_user_id:input.userId,approved_by_user_id:null});
    const read=await new PostgresqlSchoolDirectoryRepository(runner).find({organizationId:org,actorUserId:input.userId,schoolId:base.school_id});
    assert.equal(read.changeContext.canSubmitChanges,true);
    assert.equal(read.changeContext.canEditExisting,input.role!=='l2');
    assert.equal(read.changeContext.baseValueHashes.phone??read.changeContext.emptyValueSha256,command.baseValueSha256);
    assert.equal(read.view.fields.phone??null,null,'submission never changes the effective school record');
    assert.equal(read.changeContext.effectiveValueHashes.phone??read.changeContext.emptyValueSha256,command.expectedEffectiveValueSha256);
    assert.equal((await client.query('SELECT expected_effective_value_sha256 FROM schools_overlay_fields WHERE revision_id=$1',[result.changeRequestId])).rows[0].expected_effective_value_sha256,command.expectedEffectiveValueSha256);
    assert.equal((await client.query('SELECT fields_json FROM schools_snapshot_records WHERE school_id=$1 AND snapshot_id=$2',[base.school_id,base.snapshot_id])).rows[0].fields_json.phone??null,null);
    for(const query of ['SELECT count(*)::int AS n FROM audit_events WHERE resource_id=$1','SELECT count(*)::int AS n FROM audit_outbox WHERE aggregate_id=$1'])assert.equal((await client.query(query,[result.changeRequestId])).rows[0].n,1);
    await assert.rejects(()=>submitSchoolChange({...request,command:{...command,proposedValue:'Changed'}},{repository}),error=>error instanceof SchoolServiceError&&error.code==='SCHOOL_CHANGE_IDEMPOTENCY_KEY_REUSED');
    await assert.rejects(()=>submitSchoolChange({...request,command:{...command,idempotencyKey:randomUUID(),baseValueSha256:'a'.repeat(64)}},{repository}),error=>error instanceof SchoolServiceError&&error.code==='SCHOOL_CHANGE_BASE_STALE');
    await assert.rejects(()=>submitSchoolChange({...request,command:{...command,idempotencyKey:randomUUID(),expectedEffectiveValueSha256:'a'.repeat(64)}},{repository}),error=>error instanceof SchoolServiceError&&error.code==='SCHOOL_CHANGE_BASE_STALE');
    await assert.rejects(()=>submitSchoolChange({...request,command:{...command,expectedEffectiveValueSha256:'a'.repeat(64)}},{repository}),error=>error instanceof SchoolServiceError&&error.code==='SCHOOL_CHANGE_IDEMPOTENCY_KEY_REUSED');
    const edit={...request,command:{...command,fieldName:'district',baseValueSha256:sha256SchoolValue(base.fields_json.district),expectedEffectiveValueSha256:sha256SchoolValue(base.fields_json.district),proposedValue:'Synthetic replacement',idempotencyKey:randomUUID()}};
    assert.ok(base.fields_json.district);
    if(input.role==='l2')await assert.rejects(()=>submitSchoolChange(edit,{repository}),denied);
    else assert.equal((await submitSchoolChange(edit,{repository})).status,'submitted');
    const audit=(await client.query('SELECT id FROM audit_events WHERE resource_id=$1',[result.changeRequestId])).rows[0].id;
    const failedId=randomUUID();const ids=[failedId,audit,randomUUID()];const retryKey=randomUUID();
    await assert.rejects(()=>submitSchoolChange({...request,command:{...command,idempotencyKey:retryKey}},{repository,createId:()=>ids.shift()!}));
    assert.equal((await client.query('SELECT count(*)::int AS n FROM schools_overlay_revisions WHERE id=$1',[failedId])).rows[0].n,0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM schools_overlay_fields WHERE revision_id=$1',[failedId])).rows[0].n,0);
    assert.equal((await submitSchoolChange({...request,command:{...command,idempotencyKey:retryKey}},{repository})).status,'submitted');
    await client.query('SAVEPOINT school_self_review');
    await assert.rejects(()=>client.query(`UPDATE schools_overlay_revisions SET status='approved',approved_by_user_id=$2,
      approved_role='founder',approved_at=statement_timestamp(),record_version=record_version+1,
      updated_at=GREATEST(statement_timestamp(),updated_at) WHERE id=$1`,[result.changeRequestId,input.userId]),
      (error:unknown)=>(error as {constraint?:string}).constraint==='schools_overlay_reviewer_separation_check');
    await client.query('ROLLBACK TO SAVEPOINT school_self_review');
    await client.query('RELEASE SAVEPOINT school_self_review');
    if(input.role==='l2'){
      await client.query(`UPDATE schools_overlay_revisions SET status='approved',approved_by_user_id=$2,
        approved_role='founder',approved_at=statement_timestamp(),record_version=record_version+1,
        updated_at=GREATEST(statement_timestamp(),updated_at) WHERE id=$1`,[result.changeRequestId,input.founderUserId]);
      const approved=(await repository.list(reader)).find(item=>item.change_request_id===result.changeRequestId)!;
      assert.equal(approved.status,'approved');assert.ok(approved.approved_at);
      // An immutable snapshot still says unknown; the effective approved value must prevent replacement.
      await assert.rejects(()=>submitSchoolChange({...request,command:{...command,idempotencyKey:randomUUID()}},{repository}),denied);
    }
    if(input.role==='l1'){
      // Someone approves an earlier request while another editor still has the old form.
      await client.query(`UPDATE schools_overlay_revisions SET status='approved',approved_by_user_id=$2,
        approved_role='founder',approved_at=statement_timestamp(),record_version=record_version+1,
        updated_at=GREATEST(statement_timestamp(),updated_at) WHERE id=$1`,[result.changeRequestId,input.founderUserId]);
      await assert.rejects(()=>submitSchoolChange({...request,command:{...command,idempotencyKey:randomUUID()}},{repository}),error=>error instanceof SchoolServiceError&&error.code==='SCHOOL_CHANGE_BASE_STALE');
      // A lost submission acknowledgement still replays; it does not create another candidate.
      assert.deepEqual(await submitSchoolChange(request,{repository}),result);
      const refreshed=await new PostgresqlSchoolDirectoryRepository(runner).find(reader);
      assert.equal(refreshed.changeContext.baseValueHashes.phone??refreshed.changeContext.emptyValueSha256,sha256SchoolValue(null));
      assert.equal(refreshed.changeContext.effectiveValueHashes.phone,sha256SchoolValue('Synthetic phone'));
      const fresh=await submitSchoolChange({...request,command:{...command,idempotencyKey:randomUUID(),expectedEffectiveValueSha256:refreshed.changeContext.effectiveValueHashes.phone!,proposedValue:'Rechecked value'}},{repository});
      assert.equal((await client.query('SELECT expected_effective_value_sha256 FROM schools_overlay_fields WHERE revision_id=$1',[fresh.changeRequestId])).rows[0].expected_effective_value_sha256,sha256SchoolValue('Synthetic phone'));
      await client.query('SAVEPOINT immutable_school_baseline');
      await assert.rejects(()=>client.query('UPDATE schools_overlay_fields SET expected_effective_value_sha256=$2 WHERE revision_id=$1',[fresh.changeRequestId,sha256SchoolValue(null)]));
      await client.query('ROLLBACK TO SAVEPOINT immutable_school_baseline');
      await client.query('RELEASE SAVEPOINT immutable_school_baseline');
    }
    if(input.role==='l1'||input.role==='l2'){
      await client.query("SELECT set_config('app.actor_user_id',$1,true)",[input.founderUserId]);
      await client.query("UPDATE access_trial_members SET status='disabled',record_version=record_version+1 WHERE user_id=$1",[input.userId]);
      await assert.rejects(()=>submitSchoolChange(request,{repository}),denied);
      await assert.rejects(()=>repository.list(reader),error=>error instanceof SchoolResolutionError&&error.code==='SCHOOL_RESOLUTION_FORBIDDEN');
    }
  }finally{await client.query('ROLLBACK TO SAVEPOINT school_change_fixture');await client.query('RELEASE SAVEPOINT school_change_fixture')}
}
