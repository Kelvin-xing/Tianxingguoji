import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {InternalEmailService,InternalEmailServiceError,type InternalEmailInviteActor,type InternalInviteDeliveryReceipt} from '../../modules/identity/application/internal-email.ts';
import {PostgresqlInternalEmailRepository} from '../../modules/identity/infrastructure/postgresql-internal-email-repository.ts';
import type {DeterministicFakeEmailTransport} from '../../modules/email/infrastructure/deterministic-fake-transport.ts';

export async function assertInviteOperations(input:{service:InternalEmailService;actor:InternalEmailInviteActor;client:Client;transport:DeterministicFakeEmailTransport;baseUrl:string;cookie:string}):Promise<void>{
  const {service,actor,client,transport}=input;
  const command={actor,normalizedEmail:`idempotent-${randomUUID()}@example.test.invalid`,role:'l2' as const,trialCategories:['international_school'] as const,idempotencyKey:randomUUID()};
  // Separate Node and Next runtimes use independent pools against the same key.
  const cross={...command,normalizedEmail:`cross-runtime-${randomUUID()}@example.test.invalid`,idempotencyKey:randomUUID()};
  const httpBody={normalized_email:cross.normalizedEmail,role:cross.role,trial_categories:cross.trialCategories};
  const [direct,http]=await Promise.all([service.createFounderInvite(cross),fetch(input.baseUrl+'/api/v1/auth/invites',{
    method:'POST',headers:{cookie:input.cookie,'content-type':'application/json','idempotency-key':cross.idempotencyKey},body:JSON.stringify(httpBody),
  })]);
  assert.equal(http.status,200);assert.equal((await http.json()).data.invite_id,direct.inviteId);
  assert.equal((await client.query('SELECT count(*)::int n FROM identity_invite_operations WHERE invite_id=$1',[direct.inviteId])).rows[0].n,1);
  const conflict=await fetch(input.baseUrl+'/api/v1/auth/invites',{
    method:'POST',headers:{cookie:input.cookie,'content-type':'application/json','idempotency-key':cross.idempotencyKey},body:JSON.stringify({...httpBody,trial_categories:['local_school']}),
  });
  assert.equal(conflict.status,409);
  const before=transport.messages.length;
  const simultaneous=await Promise.all([service.createFounderInvite(command),service.createFounderInvite(command)]);
  assert.equal(simultaneous[0]!.inviteId,simultaneous[1]!.inviteId);
  assert.equal(transport.messages.length,before+1);
  const original=await service.createFounderInvite(command);
  assert.ok(original.deliveryReceipt);
  const failure=(code:string)=>(error:unknown)=>error instanceof InternalEmailServiceError&&error.code===code;
  await assert.rejects(service.createFounderInvite({...command,trialCategories:['local_school']}),failure('INVITE_CONFLICT'));
  const resend={actor,inviteId:original.inviteId,idempotencyKey:randomUUID()};
  const simultaneousResend=await Promise.all([service.resendFounderInvite(resend),service.resendFounderInvite(resend)]);
  assert.equal(simultaneousResend[0]!.inviteId,original.inviteId);
  assert.equal(simultaneousResend[1]!.inviteId,original.inviteId);
  const rotated=await service.resendFounderInvite(resend);
  assert.ok(rotated.deliveryReceipt);
  assert.equal(transport.messages.length,before+2);
  assert.deepEqual(await service.createFounderInvite(command),original);
  assert.deepEqual(await service.resendFounderInvite(resend),rotated);
  const facts=(await client.query(`SELECT (SELECT count(*)::int FROM identity_invite_operations WHERE invite_id=$1) operations,
    (SELECT count(*)::int FROM audit_events WHERE resource_id=$1) events,
    (SELECT record_version::int FROM identity_invites WHERE id=$1) version`,[original.inviteId])).rows[0];
  assert.deepEqual(facts,{operations:2,events:2,version:2});
  const stored=(await client.query('SELECT * FROM identity_invite_operations WHERE invite_id=$1',[original.inviteId])).rows;
  assert.equal(Object.keys(stored[0]).some(key=>/secret|token|password/.test(key)),false);
  await assert.rejects(client.query("UPDATE identity_invite_operations SET receipt_reference='changed' WHERE invite_id=$1",[original.inviteId]),(error:unknown)=>(error as {code?:string}).code==='23514');
  // A failed/unknown external delivery is never automatically retried without a fresh resend action.
  let deliveries=0;
  const unavailable=new InternalEmailService({repository:new PostgresqlInternalEmailRepository(),email:{async sendInvitation(){deliveries++;throw new Error('synthetic unknown delivery');}}});
  const failedCommand={...command,normalizedEmail:`delivery-failed-${randomUUID()}@example.test.invalid`,idempotencyKey:randomUUID()};
  await assert.rejects(unavailable.createFounderInvite(failedCommand),failure('INVITE_DELIVERY_FAILED'));
  const pending=await unavailable.createFounderInvite(failedCommand);
  assert.equal(pending.deliveryReceipt,null);assert.equal(deliveries,1);
  const recovery={actor,inviteId:pending.inviteId,idempotencyKey:randomUUID()};
  const delivered=await service.resendFounderInvite(recovery);
  assert.ok(delivered.deliveryReceipt);
  assert.deepEqual(await unavailable.createFounderInvite(failedCommand),pending);
  assert.equal(deliveries,1);
  // A delayed old delivery receipt cannot overwrite the latest resend receipt.
  let releaseOld!:(receipt:InternalInviteDeliveryReceipt)=>void;
  let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const delayed=new InternalEmailService({repository:new PostgresqlInternalEmailRepository(),email:{async sendInvitation(){entered();return new Promise<InternalInviteDeliveryReceipt>(resolve=>{releaseOld=resolve;});}}});
  const old=delayed.resendFounderInvite({actor,inviteId:pending.inviteId,idempotencyKey:randomUUID()});
  await started;
  const newer=await service.resendFounderInvite({actor,inviteId:pending.inviteId,idempotencyKey:randomUUID()});
  assert.ok(newer.deliveryReceipt);
  releaseOld({channelPolicyId:'hk_dpa_reviewed_transactional',receiptReference:'late-synthetic-receipt',deliveredAtMs:Date.now()});
  await old;
  assert.equal((await client.query('SELECT receipt_reference FROM identity_invite_delivery_receipts WHERE invite_id=$1',[pending.inviteId])).rows[0].receipt_reference,newer.deliveryReceipt.receiptReference);
  process.stdout.write(JSON.stringify({trial_invite_operations:'pass',concurrent_create:'one',concurrent_resend:'one',changed_payload:'conflict',old_receipt:'stable',unknown_delivery:'explicit_resend_only'})+'\n');
}
