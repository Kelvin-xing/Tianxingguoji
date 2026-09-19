import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {workspaceCapabilitiesForRole,type RequestAccessActor,type Release1OrganizationRole} from '../../modules/access/public.ts';
import type {TenantTransactionRunner} from '../../modules/shared/server.ts';
import {ProfileMaintenanceService,ProfileMaintenanceError} from '../../modules/crm/application/profile-maintenance-service.ts';
import {PostgresqlProfileMaintenanceRepository} from '../../modules/crm/infrastructure/postgresql-profile-maintenance-repository.ts';

/** Uses real profile services/repositories and rolls back each synthetic mutation. */
export async function assertTrialCrmProfileWrites(input:{client:Client;runner:TenantTransactionRunner;organizationId:string;userId:string;founderUserId:string;role:Release1OrganizationRole;studentId:string;guardianId:string;allowed:boolean}) {
  const {client}=input;
  const principal=(await client.query('SELECT level,categories,record_version FROM access_trial_members WHERE user_id=$1',[input.userId])).rows[0];
  const actor:RequestAccessActor={userId:input.userId,organizationId:input.organizationId,roles:[input.role],workspaceCapabilities:workspaceCapabilitiesForRole(input.role),
    ...(principal?{trialPrincipal:{userId:input.userId,organizationId:input.organizationId,level:principal.level,categories:principal.categories,recordVersion:Number(principal.record_version),active:true}}:{})};
  const service=new ProfileMaintenanceService(new PostgresqlProfileMaintenanceRepository(input.runner));
  const denied=(error:unknown)=>error instanceof ProfileMaintenanceError&&error.code==='PROFILE_MAINTENANCE_FORBIDDEN';
  for(const kind of ['student','guardian'] as const){
    await client.query('SAVEPOINT trial_profile');
    try {
      const id=kind==='student'?input.studentId:input.guardianId;
      const table=kind==='student'?'crm_students':'crm_guardians';
      const version=Number((await client.query(`SELECT record_version FROM ${table} WHERE id=$1`,[id])).rows[0].record_version);
      const base={displayName:'Synthetic profile edit',dateOfBirth:null,gender:null,expectedRecordVersion:version,requestId:`profile-${randomUUID()}`,idempotencyKey:`profile-${randomUUID()}`};
      const invoke=(overrides:Partial<typeof base>={})=>kind==='student'
        ? service.updateStudent({actor,command:{...base,...overrides,studentId:id,contactEmail:null,contactPhone:null}})
        : service.updateGuardian({actor,command:{...base,...overrides,guardianId:id,email:'profile@example.invalid',phone:null}});
      const counts=async()=> (await client.query(`SELECT (SELECT count(*)::int FROM audit_events WHERE resource_id=$1) AS audit,
        (SELECT count(*)::int FROM audit_outbox WHERE aggregate_id=$1) AS outbox`,[id])).rows[0];
      const before=await counts();
      if(!input.allowed){
        await assert.rejects(invoke(),denied);
        assert.deepEqual(await counts(),before);
        assert.equal(Number((await client.query(`SELECT record_version FROM ${table} WHERE id=$1`,[id])).rows[0].record_version),version);
        continue;
      }
      const receipt=await invoke();
      assert.equal(receipt.recordVersion,version+1);
      assert.deepEqual(await invoke(),receipt,'same-key retry returns the original profile acknowledgement');
      assert.deepEqual(await counts(),{audit:before.audit+1,outbox:before.outbox+1});
      await assert.rejects(invoke({idempotencyKey:`stale-${randomUUID()}`}),error=>error instanceof ProfileMaintenanceError&&error.code==='PROFILE_MAINTENANCE_STALE_VERSION');
      if(input.role==='l2'||input.role==='l1'){
        await client.query("SELECT set_config('app.actor_user_id',$1,true)",[input.founderUserId]);
        await client.query(input.role==='l2'
          ? "UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1"
          : "UPDATE access_trial_members SET status='disabled',record_version=record_version+1 WHERE user_id=$1",[input.userId]);
        await assert.rejects(invoke(),denied,'revoked scope or disabled membership denies a cached actor and original receipt');
        await assert.rejects(invoke({idempotencyKey:`revoked-${randomUUID()}`,expectedRecordVersion:version+1}),denied);
        assert.deepEqual(await counts(),{audit:before.audit+1,outbox:before.outbox+1});
      }
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT trial_profile');
      await client.query('RELEASE SAVEPOINT trial_profile');
    }
  }
}
