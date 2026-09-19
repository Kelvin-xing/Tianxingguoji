import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {workspaceCapabilitiesForRole,type RequestAccessActor,type Release1OrganizationRole} from '../../modules/access/public.ts';
import type {TenantTransactionRunner} from '../../modules/shared/server.ts';
import {GuardianRelationshipService,GuardianRelationshipError} from '../../modules/crm/application/guardian-relationship-service.ts';
import {PostgresqlGuardianRelationshipRepository} from '../../modules/crm/infrastructure/postgresql-guardian-relationship-repository.ts';
import {NEON_TEST_STUDENTS,NEON_TEST_PRINCIPALS} from '../../scripts/db/neon-test-synthetic-fixture.ts';

export async function assertTrialGuardianWrites(input:{client:Client;runner:TenantTransactionRunner;organizationId:string;userId:string;founderUserId:string;role:Release1OrganizationRole;studentId:string;caseId:string;allowed:boolean}){
  const {client,organizationId:org,studentId}=input;
  await client.query('SAVEPOINT trial_guardian_writes');
  try{
    const context=async(userId:string)=>{await client.query("SELECT set_config('app.actor_user_id',$1,true)",[userId]);};
    await context(NEON_TEST_PRINCIPALS[2]!.userId);
    const source=NEON_TEST_STUDENTS[1]!;
    const sourceCase=randomUUID();
    await client.query(`INSERT INTO cases_service_cases
      (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,primary_role_binding_id,
       primary_membership_id,primary_user_id,primary_role,stage,workflow_status,record_version,current_primary_advisor_assignment_id,business_category)
      SELECT $1,organization_id,$2,$3,application_type,intake_year,admission_type,primary_role_binding_id,primary_membership_id,
        primary_user_id,primary_role,'signed','active',1,gen_random_uuid(),business_category FROM cases_service_cases WHERE id=$4`,
      [sourceCase,source.id,`SCOPE-${sourceCase}`,input.caseId]);
    await client.query(`INSERT INTO cases_primary_advisor_assignments
      (id,organization_id,service_case_id,advisor_role_binding_id,membership_id,advisor_user_id,advisor_role,starts_at,assignment_reason)
      SELECT current_primary_advisor_assignment_id,organization_id,id,primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,created_at,'trial_scope_source'
      FROM cases_service_cases WHERE id=$1`,[sourceCase]);
    await client.query(`INSERT INTO cases_assessments(id,organization_id,service_case_id,manifest_id,status,record_version)
      SELECT gen_random_uuid(),organization_id,$1,manifest_id,'draft',1 FROM cases_assessments WHERE service_case_id=$2`,[sourceCase,input.caseId]);
    assert.equal((await client.query("SELECT * FROM cases_advance_new_service_case($1,'advisor',$2,clock_timestamp())",[sourceCase,randomUUID()])).rows[0]?.decision,'allowed');
    await client.query("UPDATE crm_guardians SET display_name='Scope Available Guardian',record_version=record_version+1 WHERE id=$1",[source.guardianId]);
    const hiddenGuardian=randomUUID();
    await client.query(`INSERT INTO crm_guardians(id,organization_id,display_name,email,status) VALUES ($1,$2,'Scope Hidden Guardian','scope-hidden@example.invalid','active')`,[hiddenGuardian,org]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const principal=(await client.query('SELECT level,categories,record_version FROM access_trial_members WHERE user_id=$1',[input.userId])).rows[0];
    const actor:RequestAccessActor={userId:input.userId,organizationId:org,roles:[input.role],workspaceCapabilities:workspaceCapabilitiesForRole(input.role),
      ...(principal?{trialPrincipal:{userId:input.userId,organizationId:org,level:principal.level,categories:principal.categories,recordVersion:Number(principal.record_version),active:true}}:{})};
    const service=new GuardianRelationshipService(new PostgresqlGuardianRelationshipRepository(input.runner));
    const deny=(error:unknown)=>error instanceof GuardianRelationshipError&&error.code==='GUARDIAN_RELATIONSHIP_FORBIDDEN';
    const request=()=>({requestId:`guardian-${randomUUID()}`,idempotencyKey:`guardian-${randomUUID()}`});
    const attachCommand={...request(),studentId,guardianId:source.guardianId,relationshipType:'mother' as const,relationshipDescription:null,isLegalGuardian:true,isEmergencyContact:true,isBillingContact:false,notificationConsent:false};
    const primary=(await client.query('SELECT id,guardian_id,record_version FROM crm_student_guardian_relationships WHERE student_id=$1 AND is_primary_contact AND ends_at IS NULL',[studentId])).rows[0];
    const handoffCommand={...request(),studentId,successorGuardianId:source.guardianId,expectedPrimaryRecordVersion:Number(primary.record_version)};
    const endCommand={...request(),studentId,relationshipId:primary.id,expectedRecordVersion:Number(primary.record_version)};
    if(!input.allowed){
      await assert.rejects(service.searchGuardians({actor,studentId,query:'Scope'}),deny);
      await assert.rejects(service.attachGuardian({actor,command:attachCommand}),deny);
      await assert.rejects(service.handoffPrimaryContact({actor,command:handoffCommand}),deny);
      await assert.rejects(service.endRelationship({actor,command:endCommand}),deny);
      return;
    }
    const found=await service.searchGuardians({actor,studentId,query:'Scope'});
    assert.ok(found.some(row=>row.id===source.guardianId));
    assert.equal(found.some(row=>row.id===hiddenGuardian),input.role!=='l2','scoped search must not reveal unassociated guardians');
    if(input.role==='l2')await assert.rejects(service.attachGuardian({actor,command:{...attachCommand,...request(),guardianId:hiddenGuardian}}),error=>error instanceof GuardianRelationshipError&&error.code==='GUARDIAN_RELATIONSHIP_GUARDIAN_NOT_FOUND');
    const attached=await service.attachGuardian({actor,command:attachCommand});
    assert.deepEqual(await service.attachGuardian({actor,command:attachCommand}),attached);
    await assert.rejects(service.endRelationship({actor,command:endCommand}),error=>error instanceof GuardianRelationshipError&&error.code==='GUARDIAN_RELATIONSHIP_PRIMARY_CANNOT_END');
    const handed=await service.handoffPrimaryContact({actor,command:handoffCommand});
    assert.deepEqual(await service.handoffPrimaryContact({actor,command:handoffCommand}),handed);
    const current=(await client.query('SELECT id,guardian_id,is_primary_contact,record_version FROM crm_student_guardian_relationships WHERE student_id=$1 AND ends_at IS NULL',[studentId])).rows;
    assert.equal(current.length,2,'handoff retains the former primary as an associated guardian');
    assert.equal(current.filter(row=>row.is_primary_contact).length,1);
    assert.equal(current.find(row=>row.is_primary_contact)?.guardian_id,source.guardianId);
    const retained=current.find(row=>row.guardian_id===primary.guardian_id)!;
    assert.equal(retained.is_primary_contact,false);
    const endedCommand={...request(),studentId,relationshipId:retained.id,expectedRecordVersion:Number(retained.record_version)};
    const skewedService=new GuardianRelationshipService(new PostgresqlGuardianRelationshipRepository(input.runner),randomUUID,()=>Date.now()-60_000);
    const ended=await skewedService.endRelationship({actor,command:endedCommand});
    assert.deepEqual(await service.endRelationship({actor,command:endedCommand}),ended);
    assert.deepEqual(await service.attachGuardian({actor,command:attachCommand}),attached,'handoff must not change the original attach receipt');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM crm_student_guardian_relationships WHERE student_id=$1 AND ends_at IS NULL',[studentId])).rows[0].count,1);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    for(const [resourceId,eventType] of [[attached.relationshipId,'crm.student_guardian_relationship_created'],[handed.relationship.relationshipId,'crm.student_guardian_primary_handed_off'],[retained.id,'crm.guardian_relationship_ended']]){
      assert.equal((await client.query('SELECT count(*)::int AS count FROM audit_events WHERE resource_id=$1 AND event_type=$2',[resourceId,eventType])).rows[0].count,1);
    }
    if(input.role==='l2'||input.role==='l1'){
      await context(input.founderUserId);
      await client.query(input.role==='l2'?"UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1":"UPDATE access_trial_members SET status='disabled',record_version=record_version+1 WHERE user_id=$1",[input.userId]);
      await assert.rejects(service.attachGuardian({actor,command:attachCommand}),deny);
      await assert.rejects(service.handoffPrimaryContact({actor,command:handoffCommand}),deny);
      await assert.rejects(service.endRelationship({actor,command:endedCommand}),deny);
      await assert.rejects(service.searchGuardians({actor,studentId,query:'Scope'}),deny);
    }
  }finally{
    await client.query('ROLLBACK TO SAVEPOINT trial_guardian_writes');
    await client.query('RELEASE SAVEPOINT trial_guardian_writes');
  }
}
