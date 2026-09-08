import 'server-only'

import type { EmailMessage, EmailDeliveryReceipt, EmailTransport } from '../domain/contract.ts'

export class DeterministicFakeEmailTransport implements EmailTransport {
  readonly messages: EmailMessage[] = []

  async send(message: EmailMessage): Promise<EmailDeliveryReceipt> {
    const existing = this.messages.find((item) => item.idempotencyKey === message.idempotencyKey)
    if (!existing) this.messages.push(Object.freeze({ ...message }))
    return Object.freeze({ channelPolicyId: 'hk_dpa_reviewed_transactional', receiptReference: `fake-email-${message.idempotencyKey.replace(/[^A-Za-z0-9._:-]/g, '-')}`, deliveredAtMs: Date.now() })
  }
}
