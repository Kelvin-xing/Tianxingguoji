import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {workspaceCapabilitiesForRole,type RequestAccessActor,type Release1OrganizationRole} from '../../modules/access/public.ts';
import type {TenantTransactionRunner} from '../../modules/shared/server.ts';
import {submitSchoolChange} from '../../modules/schools/application/service.ts';
import {reviewSchoolChange,SchoolGovernanceError} from '../../modules/schools/application/governance-service.ts';
import {PostgresqlSchoolChangeRepository} from '../../modules/schools/infrastructure/postgresql-change-repository.ts';
import {PostgresqlSchoolReviewRepository} from '../../modules/schools/infrastructure/postgresql-review-repository.ts';
import {PostgresqlSchoolDirectoryRepository} from '../../modules/schools/infrastructure/postgresql-directory-repository.ts';

export async function assertTrialSchoolReviews(input:{client:Client;runner:TenantTransactionRunner;organizationId:string;userId:string;founderUserId:string;l1UserId:string;role:Release1OrganizationRole}){
  const {client,organizationId:org}=input;
  await client.query('SAVEPOINT school_reviews');
  try{
    const runner:TenantTransactionRunner={async run(context,operation){await client.query('SAVEPOINT school_review_command');try{return await input.runner.run(context,operation)}catch(error){await client.query('ROLLBACK TO SAVEPOINT school_review_command');throw error}finally{await client.query('RELEASE SAVEPOINT school_review_command')}}};
    async function actorFor(userId:string,role:Release1OrganizationRole):Promise<RequestAccessActor>{
      const row=(await client.query('SELECT level,categories,record_version FROM access_trial_members WHERE organization_id=$1 AND user_id=$2',[org,userId])).rows[0];
      return {userId,organizationId:org,roles:[role],workspaceCapabilities:workspaceCapabilitiesForRole(role),...(row?{trialPrincipal:{organizationId:org,userId,level:row.level,categories:row.categories,recordVersion:Number(row.record_version),active:true}}:{})};
    }
    const actor=await actorFor(input.userId,input.role);
    const requesterId=input.role==='founder'?input.l1UserId:input.founderUserId;
    const requester=await actorFor(requesterId,input.role==='founder'?'l1':'founder');
    const changes=new PostgresqlSchoolChangeRepository(runner),reviews=new PostgresqlSchoolReviewRepository(runner),directory=new PostgresqlSchoolDirectoryRepository(runner);
    const schoolId=(await client.query('SELECT school_id FROM schools_snapshot_records ORDER BY school_id LIMIT 1')).rows[0].school_id;
    async function submit(field='phone',author=requester){
      const current=await directory.find({organizationId:org,actorUserId:author.userId,schoolId});
      return submitSchoolChange({actor:author,schoolId,command:{fieldName:field,fieldClass:field==='phone'?'general':'identity',baseSnapshotId:current.pin.baseSnapshotId,
        baseValueSha256:current.changeContext.baseValueHashes[field]??current.changeContext.emptyValueSha256,
        expectedEffectiveValueSha256:current.changeContext.effectiveValueHashes[field]??current.changeContext.emptyValueSha256,
        proposedValue:'Synthetic '+randomUUID(),reason:'Synthetic review fixture',evidence:{sourceUrl:'https://example.invalid/school',quote:'Synthetic evidence'},requestId:randomUUID(),idempotencyKey:randomUUID()}},{repository:changes});
    }
    const candidate=await submit();
    const request={actor,changeRequestId:candidate.changeRequestId,command:{decision:'approve' as const,expectedRecordVersion:1,reason:'Synthetic approval',requestId:randomUUID(),idempotencyKey:randomUUID()}};
    const errorCode=(code:string)=>(error:unknown)=>error instanceof SchoolGovernanceError&&error.code===code;
    if(input.role!=='founder'&&input.role!=='l1'){
      await assert.rejects(()=>reviewSchoolChange(request,{repository:reviews}),errorCode('SCHOOL_GOVERNANCE_REVIEWER_REQUIRED'));
      const forged:RequestAccessActor={...actor,trialPrincipal:{organizationId:org,userId:actor.userId,level:'founder',categories:[],active:true,recordVersion:1}};
      await assert.rejects(()=>reviewSchoolChange({...request,actor:forged},{repository:reviews}),errorCode('SCHOOL_GOVERNANCE_REVIEWER_REQUIRED'));
      return;
    }
    const own=await submit('phone',actor);
    for(const decision of ['approve','reject'] as const)await assert.rejects(()=>reviewSchoolChange({...request,changeRequestId:own.changeRequestId,command:{...request.command,decision,idempotencyKey:randomUUID()}},{repository:reviews}),errorCode('SCHOOL_GOVERNANCE_SELF_REVIEW_DENIED'));
    const stale=await submit();
    const approved=await reviewSchoolChange(request,{repository:reviews});
    assert.equal(approved.status,'approved');assert.equal(approved.recordVersion,2);assert.ok(approved.resolvedRevisionId);
    assert.deepEqual(await reviewSchoolChange(request,{repository:reviews}),approved);
    const receipt=(await client.query('SELECT reviewer_role,decision,reason,reviewed_by_user_id FROM schools_change_review_receipts WHERE revision_id=$1',[candidate.changeRequestId])).rows[0];
    assert.deepEqual(receipt,{reviewer_role:input.role,decision:'approve',reason:'Synthetic approval',reviewed_by_user_id:input.userId});
    assert.equal((await client.query('SELECT approved_role FROM schools_overlay_revisions WHERE id=$1',[candidate.changeRequestId])).rows[0].approved_role,input.role);
    for(const query of ['SELECT count(*)::int n FROM audit_events WHERE resource_id=$1','SELECT count(*)::int n FROM audit_outbox WHERE aggregate_id=$1'])assert.equal((await client.query(query,[candidate.changeRequestId])).rows[0].n,2);
    await assert.rejects(()=>reviewSchoolChange({...request,command:{...request.command,reason:'Different'}},{repository:reviews}),errorCode('SCHOOL_GOVERNANCE_IDEMPOTENCY_KEY_REUSED'));
    await assert.rejects(()=>reviewSchoolChange({...request,command:{...request.command,idempotencyKey:randomUUID()}},{repository:reviews}),errorCode('SCHOOL_GOVERNANCE_STALE_VERSION'));
    await assert.rejects(()=>reviewSchoolChange({...request,changeRequestId:stale.changeRequestId,command:{...request.command,idempotencyKey:randomUUID()}},{repository:reviews}),errorCode('SCHOOL_GOVERNANCE_STALE_VERSION'));
    const rejectRequest={...request,changeRequestId:stale.changeRequestId,command:{...request.command,decision:'reject' as const,reason:'Outdated information',idempotencyKey:randomUUID()}};
    const rejected=await reviewSchoolChange(rejectRequest,{repository:reviews});
    assert.equal(rejected.status,'rejected');assert.equal(rejected.resolvedRevisionId,null);
    assert.deepEqual(await reviewSchoolChange(rejectRequest,{repository:reviews}),rejected);
    assert.equal((await client.query('SELECT reason FROM schools_change_review_receipts WHERE revision_id=$1',[stale.changeRequestId])).rows[0].reason,'Outdated information');
    const identity=await submit('school_name_en');
    assert.equal((await reviewSchoolChange({...request,changeRequestId:identity.changeRequestId,command:{...request.command,idempotencyKey:randomUUID()}},{repository:reviews})).status,'approved');
    const rollback=await submit();
    const rollbackRequest={...request,changeRequestId:rollback.changeRequestId,command:{...request.command,idempotencyKey:randomUUID()}};
    const duplicateAudit=(await client.query('SELECT id FROM audit_events WHERE resource_id=$1 LIMIT 1',[candidate.changeRequestId])).rows[0].id;
    const proposedResolution=randomUUID(),ids=[proposedResolution,duplicateAudit,randomUUID()];
    await assert.rejects(()=>reviewSchoolChange(rollbackRequest,{repository:reviews,createId:()=>ids.shift()!}));
    assert.equal((await client.query('SELECT status FROM schools_overlay_revisions WHERE id=$1',[rollback.changeRequestId])).rows[0].status,'candidate');
    assert.equal((await client.query('SELECT count(*)::int n FROM schools_change_review_receipts WHERE revision_id=$1',[rollback.changeRequestId])).rows[0].n,0);
    assert.equal((await client.query('SELECT count(*)::int n FROM schools_resolved_revisions WHERE id=$1',[proposedResolution])).rows[0].n,0);
    assert.equal((await reviewSchoolChange(rollbackRequest,{repository:reviews})).status,'approved');
    await client.query('SAVEPOINT school_receipt_immutable');
    await assert.rejects(()=>client.query("UPDATE schools_change_review_receipts SET reason='Overwrite' WHERE revision_id=$1",[candidate.changeRequestId]));
    await client.query('ROLLBACK TO SAVEPOINT school_receipt_immutable');await client.query('RELEASE SAVEPOINT school_receipt_immutable');
    // Pre-upgrade pending rows must not receive an invented effective baseline.
    const legacyId=randomUUID();
    await client.query(`INSERT INTO schools_overlay_revisions(id,organization_id,school_id,base_snapshot_id,revision_number,requested_by_user_id,reason)
      SELECT $1,organization_id,school_id,base_snapshot_id,(SELECT max(revision_number)+1 FROM schools_overlay_revisions WHERE organization_id=$2 AND school_id=$3),requested_by_user_id,'Legacy pending request'
      FROM schools_overlay_revisions WHERE id=$4`,[legacyId,org,schoolId,candidate.changeRequestId]);
    await client.query(`INSERT INTO schools_overlay_fields(organization_id,revision_id,school_id,field_name,field_class,proposed_value_json,base_value_sha256,evidence_json)
      SELECT organization_id,$1,school_id,field_name,field_class,proposed_value_json,base_value_sha256,evidence_json FROM schools_overlay_fields WHERE revision_id=$2`,[legacyId,candidate.changeRequestId]);
    const legacyRequest={...request,changeRequestId:legacyId,command:{...request.command,idempotencyKey:randomUUID()}};
    await assert.rejects(()=>reviewSchoolChange(legacyRequest,{repository:reviews}),errorCode('SCHOOL_GOVERNANCE_STALE_VERSION'));
    assert.equal((await reviewSchoolChange({...legacyRequest,command:{...legacyRequest.command,decision:'reject'}},{repository:reviews})).status,'rejected');
    if(input.role==='l1'){
      await client.query("SELECT set_config('app.actor_user_id',$1,true)",[input.founderUserId]);
      await client.query("UPDATE access_trial_members SET status='disabled',record_version=record_version+1 WHERE user_id=$1",[input.userId]);
      await assert.rejects(()=>reviewSchoolChange(request,{repository:reviews}),errorCode('SCHOOL_GOVERNANCE_REVIEWER_REQUIRED'));
    }
  }finally{await client.query('ROLLBACK TO SAVEPOINT school_reviews');await client.query('RELEASE SAVEPOINT school_reviews')}
}
