import assert from 'node:assert/strict'
import test from 'node:test'

import { InternalEmailService, INTERNAL_EMAIL_PASSWORD_POLICY, normalizeInternalEmail, type InternalEmailRepository } from '../../../modules/identity/application/internal-email.ts'

test('internal email identity is invite-only and normalizes email addresses', () => {
  assert.equal(normalizeInternalEmail(' Founder@Example.Test.Invalid '), 'founder@example.test.invalid')
  assert.equal(normalizeInternalEmail('not-an-email'), null)
  assert.equal(INTERNAL_EMAIL_PASSWORD_POLICY.version, 'scrypt-v1')
  assert.equal(INTERNAL_EMAIL_PASSWORD_POLICY.saltBytes, 32)
})

test('only an actor with Founder in the request-time role union may invite', async () => {
  const repository = new FakeRepository()
  const service = new InternalEmailService({
    repository,
    email: { sendInvitation: async () => ({ channelPolicyId: 'hk_dpa_reviewed_transactional', receiptReference: 'fake-1', deliveredAtMs: Date.now() }) },
    clock: { nowMs: () => 1_800_000_000_000 },
    createId: () => '10000000-0000-4000-8000-000000000001',
    createSecret: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })
  await assert.rejects(() => service.createFounderInvite({ actor: { userId: '10000000-0000-4000-8000-000000000002', organizationId: '10000000-0000-4000-8000-000000000003', roles: ['advisor'] }, normalizedEmail: 'person@example.test.invalid', role: 'advisor', idempotencyKey: 'invite-1' }), (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'FOUNDER_REQUIRED')
  assert.equal(repository.created, 0)
})

test('email delivery failure keeps the pending invite available for controlled resend', async () => {
  const repository = new FakeRepository()
  const ids = [
    '10000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000013',
    '10000000-0000-4000-8000-000000000014',
  ]
  const service = new InternalEmailService({
    repository,
    email: { sendInvitation: async () => { throw new Error('synthetic delivery failure') } },
    clock: { nowMs: () => 1_800_000_000_000 },
    createId: () => ids.shift()!,
    createSecret: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })
  await assert.rejects(() => service.createFounderInvite({ actor: { userId: '10000000-0000-4000-8000-000000000002', organizationId: '10000000-0000-4000-8000-000000000003', roles: ['founder'] }, normalizedEmail: 'person@example.test.invalid', role: 'advisor', idempotencyKey: 'invite-2' }), (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'INVITE_DELIVERY_FAILED')
  assert.equal(repository.created, 1)
})

class FakeRepository implements InternalEmailRepository {
  created = 0
  lastCreated: Parameters<InternalEmailRepository['createInvitedIdentity']>[0] | undefined
  async createInvitedIdentity(input: Parameters<InternalEmailRepository['createInvitedIdentity']>[0]) { this.created += 1; this.lastCreated = input }
  async recordInviteDelivery() {}
  async rotateInvite(): Promise<{ targetUserId: string; normalizedEmail: string }> { throw new Error('not used') }
  async activateInvite(): Promise<never> { throw new Error('not used') }
  async findCredential() { return null }
  async completeLoginAttempt() { return null }
  async findActorBySessionSecretHash(): Promise<never> { throw new Error('not used') }
  async revokeSessionBySecretHash() {}
}

test('explicit trial Founder invites actual grades without legacy employment restrictions or role union', async () => {
  const repository = new FakeRepository();
  const service = new InternalEmailService({ repository, email:{sendInvitation:async()=>({channelPolicyId:'hk_dpa_reviewed_transactional',receiptReference:'fake-trial',deliveredAtMs:Date.now()})} });
  const userId='10000000-0000-4000-8000-000000000021',organizationId='10000000-0000-4000-8000-000000000022';
  const actor = {userId,organizationId,roles:['founder'] as const,trialPrincipal:{userId,organizationId,level:'founder' as const,categories:[],active:true,recordVersion:1}};
  const base={actor,normalizedEmail:'trial@example.test.invalid',role:'l2' as const,trialCategories:['local_school','international_school'] as const,employmentType:'PART_TIME' as const,idempotencyKey:'trial-invite'};
  await service.createFounderInvite(base);
  assert.equal(repository.lastCreated?.role,'l2');
  assert.equal(repository.lastCreated?.employmentType,'PART_TIME');
  assert.deepEqual(repository.lastCreated?.trialCategories,['international_school','local_school']);
  for (const role of ['founder','l1','l3'] as const) await service.createFounderInvite({...base,role,trialCategories:[]});
  const rejected=(code:string)=>(error:unknown)=>error instanceof Error && (error as Error & {code?:string}).code===code;
  await assert.rejects(service.createFounderInvite({...base,actor:{...actor,trialPrincipal:{...actor.trialPrincipal,level:'l1'}}}),rejected('FOUNDER_REQUIRED'));
  await assert.rejects(service.createFounderInvite({...base,actor:{...actor,trialPrincipal:{...actor.trialPrincipal,active:false}}}),rejected('FOUNDER_REQUIRED'));
  await assert.rejects(service.createFounderInvite({...base,role:'advisor',trialCategories:undefined}),rejected('INVITE_INVALID'));
  await assert.rejects(service.createFounderInvite({...base,actor:{userId,organizationId,roles:['founder']}}),rejected('INVITE_INVALID'));
  assert.equal(repository.created,4);
});
