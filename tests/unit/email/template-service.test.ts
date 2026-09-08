import assert from 'node:assert/strict'
import test from 'node:test'

import type { AccessContext } from '../../../modules/access/public.ts'
import { EmailTemplateError, EmailTemplateService, type EmailTemplateRepository } from '../../../modules/email/application/templates.ts'

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_ID = '10000000-0000-4000-8000-000000000002'
const IDS = [
  '10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000012',
]

test('allows only Admin to update the current invitation template', async () => {
  let stored: Parameters<EmailTemplateRepository['save']>[0] | null = null
  const repository: EmailTemplateRepository = {
    read: async () => ({ kind: 'internal_user_invitation', subject: '預設主旨', bodyText: '預設正文', customized: false, recordVersion: null, updatedAt: null }),
    save: async (input) => {
      stored = input
      return { templateKind: input.kind, recordVersion: input.nextRecordVersion, updatedAt: input.occurredAt, replayed: false }
    },
  }
  let index = 0
  const service = new EmailTemplateService({ repository, createId: () => IDS[index++]!, now: () => Date.UTC(2026, 8, 8) })
  const receipt = await service.save({ actor: actor('admin'), command: { subject: ' 歡迎加入團隊 ', bodyText: ' 第一段\r\n\r\n第二段 ', expectedRecordVersion: null, idempotencyKey: 'email-template-1', requestId: 'request-1' } })
  assert.equal(receipt.recordVersion, 1)
  const saved = stored as unknown as Parameters<EmailTemplateRepository['save']>[0]
  assert.equal(saved.subject, '歡迎加入團隊')
  assert.equal(saved.bodyText, '第一段\n\n第二段')
  assert.doesNotMatch(JSON.stringify(saved.effects), /歡迎加入團隊|第一段|第二段/)

  assert.throws(
    () => service.save({ actor: actor('founder'), command: { subject: '主旨', bodyText: '正文', expectedRecordVersion: null, idempotencyKey: 'email-template-2', requestId: 'request-2' } }),
    (error: unknown) => error instanceof EmailTemplateError && error.code === 'FORBIDDEN',
  )
})

function actor(role: 'admin' | 'founder'): AccessContext {
  return Object.freeze({
    userId: ADMIN_ID,
    organizationId: ORGANIZATION_ID,
    membershipId: '10000000-0000-4000-8000-000000000003',
    roles: [role] as const,
    workspaceCapabilities: role === 'admin' ? ['email.templates.manage'] as const : [] as const,
    authorizationVersion: 'test-v1',
  })
}
