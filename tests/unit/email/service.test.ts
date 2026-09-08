import assert from 'node:assert/strict'
import test from 'node:test'

import { EmailService } from '../../../modules/email/application/service.ts'
import type { EmailMessage, EmailSenderResolver, EmailTemplateResolver, EmailTransport } from '../../../modules/email/domain/contract.ts'

const INVITE_ID = '10000000-0000-4000-8000-000000000001'
const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000002'
const ACTOR_USER_ID = '10000000-0000-4000-8000-000000000004'
const CREDENTIAL = 'v1.10000000-0000-4000-8000-000000000002.10000000-0000-4000-8000-000000000001.10000000-0000-4000-8000-000000000003.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

test('builds a minimal invitation email and returns a safe delivery receipt', async () => {
  const transport = new RecordingTransport()
  const resolver: EmailSenderResolver = { resolve: async () => ({ transport, from: 'no-reply@example.test.invalid' }) }
  const service = new EmailService(resolver, 'https://app.example.test.invalid')
  const receipt = await service.sendInvitation({ inviteId: INVITE_ID, organizationId: ORGANIZATION_ID, actorUserId: ACTOR_USER_ID, recipientEmail: 'new.user@example.test.invalid', activationCredential: CREDENTIAL, expiresAtMs: Date.UTC(2026, 8, 10) })

  assert.equal(receipt.channelPolicyId, 'hk_dpa_reviewed_transactional')
  assert.equal(transport.messages.length, 1)
  assert.match(transport.messages[0]!.text, /\/login\/activate#token=/)
  assert.doesNotMatch(transport.messages[0]!.text, /password|密碼/i)
  assert.match(transport.messages[0]!.idempotencyKey, new RegExp(`^identity-invite:${INVITE_ID}:[0-9a-f]{16}$`))
})

test('uses the organization invitation template while keeping secure controls system-owned', async () => {
  const transport = new RecordingTransport()
  const resolver: EmailSenderResolver = { resolve: async () => ({ transport, from: 'no-reply@example.test.invalid' }) }
  const templates: EmailTemplateResolver = { resolve: async () => ({ kind: 'internal_user_invitation', subject: '歡迎加入團隊', bodyText: '請完成帳戶設定。\n<script>unsafe()</script>' }) }
  const service = new EmailService(resolver, 'https://app.example.test.invalid', templates)
  await service.sendInvitation({ inviteId: INVITE_ID, organizationId: ORGANIZATION_ID, actorUserId: ACTOR_USER_ID, recipientEmail: 'new.user@example.test.invalid', activationCredential: CREDENTIAL, expiresAtMs: Date.UTC(2026, 8, 10) })

  assert.equal(transport.messages[0]?.subject, '歡迎加入團隊')
  assert.match(transport.messages[0]!.html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/)
  assert.doesNotMatch(transport.messages[0]!.html, /<script>/)
  assert.match(transport.messages[0]!.html, /確認並設定帳戶/)
  assert.match(transport.messages[0]!.html, /\/login\/activate#token=/)
})

class RecordingTransport implements EmailTransport {
  readonly messages: EmailMessage[] = []
  async send(message: EmailMessage) {
    this.messages.push(message)
    return { channelPolicyId: 'hk_dpa_reviewed_transactional' as const, receiptReference: 'email-test-1', deliveredAtMs: Date.now() }
  }
}
