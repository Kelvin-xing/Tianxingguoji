import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import type {TenantTransactionRunner} from '../../modules/shared/server.ts';
import {NotificationHttpRepository,NotificationHttpError} from '../../modules/notifications/infrastructure/http-repository.ts';

export async function seedSyntheticNotice(client:Client,org:string,userId:string):Promise<string>{
  const audit=randomUUID(),outbox=randomUUID(),notice=randomUUID(),aggregate=randomUUID(),request=randomUUID();
  await client.query(`INSERT INTO audit_events(id,organization_id,actor_user_id,actor_kind,event_type,event_version,action,resource_type,resource_id,outcome,request_id,occurred_at,metadata)
    VALUES($1,$2,$3,'user','tasks.task_created',1,'create','Task',$4,'succeeded',$5,transaction_timestamp(),'{}')`,[audit,org,userId,aggregate,request]);
  await client.query(`INSERT INTO audit_outbox(id,audit_event_id,organization_id,aggregate_type,aggregate_id,event_type,event_version,idempotency_key,request_id,payload,status)
    VALUES($1,$2,$3,'Task',$4,'tasks.task_created',1,$5,$6,jsonb_build_object('aggregate_id',($4::uuid)::text,'request_id',$6::text),'pending')`,[outbox,audit,org,aggregate,randomUUID(),request]);
  await client.query(`INSERT INTO notifications_notifications(id,organization_id,recipient_user_id,outbox_id,effect_type,effect_idempotency_key)
    VALUES($1,$2,$3,$4,'task_assigned',$5)`,[notice,org,userId,outbox,randomUUID()]);
  return notice;
}

export async function assertTrialNotificationReads(input:{client:Client;runner:TenantTransactionRunner;organizationId:string;founder:{userId:string};l1:{userId:string};l2:{userId:string};l3:{userId:string}}):Promise<void>{
  const {client,organizationId:org}=input;
  await client.query('SAVEPOINT trial_notifications');
  const runner:TenantTransactionRunner={async run(context,work){await client.query('SAVEPOINT notice_command');try{return await input.runner.run(context,work);}catch(error){await client.query('ROLLBACK TO SAVEPOINT notice_command');throw error;}finally{await client.query('RELEASE SAVEPOINT notice_command');}}};
  const repository=new NotificationHttpRepository(runner);
  const denied=(code:string)=>(error:unknown)=>error instanceof NotificationHttpError&&error.code===code;
  try{
    const notices=new Map<string,string>();
    for(const person of [input.founder,input.l1,input.l2,input.l3]){
      const id=await seedSyntheticNotice(client,org,person.userId);notices.set(person.userId,id);
      const scope={organizationId:org,userId:person.userId};
      assert.equal((await repository.list({...scope,limit:100})).length,1);
      assert.equal(await repository.unreadCount(scope),1);
      assert.equal(await repository.resolveTarget({...scope,notificationId:id}),person===input.l3?'TASK_PENDING_ITEM':'WORKSPACE_PENDING_ITEM');
      const command={...scope,notificationId:id,expectedRecordVersion:1,idempotencyKey:randomUUID()};
      const read=await repository.markRead(command);assert.equal(read.status,'read');assert.equal(read.record_version,2);
      assert.deepEqual(await repository.markRead(command),read);
      assert.equal(await repository.unreadCount(scope),0);
      await assert.rejects(repository.markRead({...command,expectedRecordVersion:2}),denied('CONFLICT'));
    }
    const scope={organizationId:org,userId:input.l3.userId};
    const foreign=notices.get(input.l1.userId)!;
    await assert.rejects(repository.resolveTarget({...scope,notificationId:foreign}),denied('NOT_FOUND'));
    await assert.rejects(repository.markRead({...scope,notificationId:foreign,expectedRecordVersion:1,idempotencyKey:randomUUID()}),denied('NOT_FOUND'));
    // Direct ID lookup must work even if a notice is outside the recent list page.
    for(let i=0;i<101;i++)await seedSyntheticNotice(client,org,input.l3.userId);
    const page=await repository.list({...scope,limit:100});
    const hidden=(await client.query('SELECT id FROM notifications_notifications WHERE recipient_user_id=$1',[input.l3.userId])).rows.find(row=>!page.some(item=>item.id===row.id));
    assert.ok(hidden);
    assert.equal(await repository.resolveTarget({...scope,notificationId:hidden.id}),'TASK_PENDING_ITEM');
    // Disabled trial row never falls back to its still-active actual role.
    await client.query("SELECT set_config('app.actor_user_id',$1,true)",[input.founder.userId]);
    await client.query("UPDATE access_trial_members SET status='disabled',record_version=record_version+1,updated_by_user_id=$2 WHERE user_id=$1",[input.l3.userId,input.founder.userId]);
    await assert.rejects(repository.list({...scope,limit:100}),denied('FORBIDDEN'));
    await assert.rejects(repository.unreadCount(scope),denied('FORBIDDEN'));
    await assert.rejects(repository.resolveTarget({...scope,notificationId:hidden.id}),denied('FORBIDDEN'));
    await assert.rejects(repository.markRead({...scope,notificationId:hidden.id,expectedRecordVersion:1,idempotencyKey:randomUUID()}),denied('FORBIDDEN'));
    process.stdout.write(JSON.stringify({trial_notification_reads:'pass',grades:4,ownership:'isolated',read:'idempotent',older_notice:'resolved',disabled:'all_denied'})+'\n');
  }finally{await client.query('ROLLBACK TO SAVEPOINT trial_notifications');await client.query('RELEASE SAVEPOINT trial_notifications');}
}
