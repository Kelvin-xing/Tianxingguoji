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
  async createInvitedIdentity() { this.created += 1 }
  async recordInviteDelivery() {}
  async rotateInvite(): Promise<{ targetUserId: string; normalizedEmail: string }> { throw new Error('not used') }
  async activateInvite(): Promise<never> { throw new Error('not used') }
  async findCredential() { return null }
  async completeLoginAttempt() { return null }
  async findActorBySessionSecretHash(): Promise<never> { throw new Error('not used') }
  async revokeSessionBySecretHash() {}
}
