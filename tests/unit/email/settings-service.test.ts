import assert from 'node:assert/strict'
import test from 'node:test'

import type { AccessContext } from '../../../modules/access/public.ts'
import { EmailSettingsError, EmailSettingsService, type EmailSettingsRepository } from '../../../modules/email/application/settings.ts'
import { AesGcmEmailSecretBox } from '../../../modules/email/infrastructure/secret-box.ts'

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_ID = '10000000-0000-4000-8000-000000000002'
const IDS = [
  '10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000012',
]

test('allows only Admin capability and passes an encrypted key to persistence', async () => {
  let stored: Parameters<EmailSettingsRepository['save']>[0] | null = null
  const repository: EmailSettingsRepository = {
    readStatus: async () => ({ configured: false, provider: null, fromEmail: null, fromName: null, recordVersion: null, updatedAt: null }),
    readDeliverySettings: async () => null,
    save: async (input) => {
      stored = input
      return { settingsId: input.organizationId, recordVersion: input.nextRecordVersion, updatedAt: input.occurredAt, replayed: false }
    },
  }
  let index = 0
  const service = new EmailSettingsService({ repository, secretBox: new AesGcmEmailSecretBox(Buffer.alloc(32, 5), 'v1'), createId: () => IDS[index++]!, now: () => Date.UTC(2026, 8, 8) })
  const receipt = await service.save({ actor: actor('admin'), command: { apiKey: 're_synthetic_secret_value', fromEmail: 'ACCOUNTS@EXAMPLE.TEST.INVALID', fromName: ' 天星顧問 ', expectedRecordVersion: null, idempotencyKey: 'email-settings-1', requestId: 'request-1' } })
  assert.equal(receipt.recordVersion, 1)
  const saved = stored as unknown as Parameters<EmailSettingsRepository['save']>[0]
  assert.equal(saved.fromEmail, 'accounts@example.test.invalid')
  assert.equal(saved.fromName, '天星顧問')
  assert.notEqual(Buffer.from(saved.secret.ciphertext).toString('utf8'), 're_synthetic_secret_value')
  assert.doesNotMatch(JSON.stringify(saved.effects), /re_synthetic|accounts@example/i)

  assert.throws(
    () => service.save({ actor: actor('founder'), command: { apiKey: 're_synthetic_secret_value', fromEmail: 'accounts@example.test.invalid', fromName: null, expectedRecordVersion: null, idempotencyKey: 'email-settings-2', requestId: 'request-2' } }),
    (error: unknown) => error instanceof EmailSettingsError && error.code === 'FORBIDDEN',
  )
})

function actor(role: 'admin' | 'founder'): AccessContext {
  return Object.freeze({
    userId: ADMIN_ID,
    organizationId: ORGANIZATION_ID,
    membershipId: '10000000-0000-4000-8000-000000000003',
    roles: [role] as const,
    workspaceCapabilities: role === 'admin' ? ['email.settings.manage'] as const : [] as const,
    authorizationVersion: 'test-v1',
  })
}
