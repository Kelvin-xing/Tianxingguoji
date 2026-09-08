import "server-only";

import { Resend } from 'resend'

import type { EmailDeliveryReceipt, EmailMessage, EmailTransport } from '../domain/contract.ts'

const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

interface ResendClient {
  readonly emails: Readonly<{
    send(payload: Readonly<{ from: string; to: readonly string[]; subject: string; text: string; html: string }>, options: Readonly<{ idempotencyKey: string }>): Promise<Readonly<{ data: { readonly id: string } | null; error: unknown }>>
  }>
}

export class ResendEmailTransport implements EmailTransport {
  private readonly client: ResendClient

  constructor(apiKey: string, createClient: (key: string) => ResendClient = (key) => new Resend(key) as ResendClient) {
    this.client = createClient(apiKey)
  }

  async send(message: EmailMessage): Promise<EmailDeliveryReceipt> {
    let response: Awaited<ReturnType<ResendClient['emails']['send']>>
    try {
      response = await this.client.emails.send({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }, { idempotencyKey: message.idempotencyKey })
    } catch {
      throw new Error('Email transport unavailable.')
    }
    if (response.error !== null) throw new Error('Email transport rejected delivery.')
    if (!response.data || !RECEIPT_ID.test(response.data.id)) {
      throw new Error('Email transport receipt invalid.')
    }
    return Object.freeze({
      channelPolicyId: 'hk_dpa_reviewed_transactional',
      receiptReference: response.data.id,
      deliveredAtMs: Date.now(),
    })
  }
}
