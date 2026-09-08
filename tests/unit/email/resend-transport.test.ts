import assert from 'node:assert/strict'
import test from 'node:test'

import { ResendEmailTransport } from '../../../modules/email/infrastructure/resend-transport.ts'

test('maps the canonical message to Resend without putting the API key in the body', async () => {
  let apiKey: string | undefined
  let request: Readonly<{ payload: Readonly<Record<string, unknown>>; options: Readonly<Record<string, unknown>> }> | undefined
  const transport = new ResendEmailTransport('re_synthetic', (key) => {
    apiKey = key
    return { emails: { send: async (payload, options) => {
      request = Object.freeze({ payload, options })
      return { data: { id: 'email-receipt-1' }, error: null }
    } } }
  })

  const receipt = await transport.send({
    idempotencyKey: 'identity-invite:10000000-0000-4000-8000-000000000001:0123456789abcdef',
    to: 'recipient@example.test.invalid',
    from: 'Tianxing <no-reply@example.test.invalid>',
    subject: 'Invitation',
    text: 'Open the invitation.',
    html: '<p>Open the invitation.</p>',
  })

  assert.equal(apiKey, 're_synthetic')
  assert.deepEqual(request?.payload, {
    from: 'Tianxing <no-reply@example.test.invalid>',
    to: ['recipient@example.test.invalid'],
    subject: 'Invitation',
    text: 'Open the invitation.',
    html: '<p>Open the invitation.</p>',
  })
  assert.deepEqual(request?.options, { idempotencyKey: 'identity-invite:10000000-0000-4000-8000-000000000001:0123456789abcdef' })
  assert.doesNotMatch(JSON.stringify(request), /re_synthetic/)
  assert.equal(receipt.receiptReference, 'email-receipt-1')
})

test('fails closed on rejected or malformed Resend responses', async () => {
  const message = {
    idempotencyKey: 'identity-invite:test', to: 'recipient@example.test.invalid',
    from: 'no-reply@example.test.invalid', subject: 'Invitation', text: 'text', html: '<p>text</p>',
  } as const
  const rejected = new ResendEmailTransport('re_synthetic', () => ({ emails: { send: async () => ({ data: null, error: { name: 'rate_limit' } }) } }))
  const malformed = new ResendEmailTransport('re_synthetic', () => ({ emails: { send: async () => ({ data: null, error: null }) } }))
  await assert.rejects(rejected.send(message), /rejected delivery/)
  await assert.rejects(malformed.send(message), /receipt invalid/)
})
