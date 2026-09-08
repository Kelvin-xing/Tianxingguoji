import { createHash } from 'node:crypto'

import { DEFAULT_INTERNAL_INVITATION_TEMPLATE } from './templates.ts'
import {
  EMAIL_DELIVERY_POLICY,
  type EmailDeliveryReceipt,
  type EmailSenderConfiguration,
  type EmailTemplateResolver,
  type EmailTemplateContent,
  type EmailSenderResolver,
} from '../domain/contract.ts'

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export class EmailServiceError extends Error {
  readonly code: 'INVALID' | 'DELIVERY_FAILED'

  constructor(code: 'INVALID' | 'DELIVERY_FAILED') {
    super(`Email service rejected ${code}.`)
    this.name = 'EmailServiceError'
    this.code = code
  }
}

export class EmailService {
  private readonly senderResolver: EmailSenderResolver
  private readonly templateResolver: EmailTemplateResolver
  private readonly baseUrl: string

  constructor(senderResolver: EmailSenderResolver, baseUrl: string, templateResolver: EmailTemplateResolver = DEFAULT_TEMPLATE_RESOLVER) {
    this.senderResolver = senderResolver
    this.templateResolver = templateResolver
    this.baseUrl = baseUrl
  }

  async sendInvitation(input: Readonly<{
    inviteId: string
    organizationId: string
    actorUserId: string
    recipientEmail: string
    activationCredential: string
    expiresAtMs: number
  }>): Promise<EmailDeliveryReceipt> {
    if (!isEmail(input.recipientEmail) || !isUuid(input.inviteId) || !isOpaqueCredential(input.activationCredential) || !Number.isSafeInteger(input.expiresAtMs)) {
      throw new EmailServiceError('INVALID')
    }
    const activationUrl = new URL('/login/activate', this.baseUrl)
    activationUrl.hash = new URLSearchParams({ token: input.activationCredential }).toString()
    let sender: EmailSenderConfiguration
    let template: EmailTemplateContent
    try {
      const resolved = await Promise.all([
        this.senderResolver.resolve({ organizationId: input.organizationId, actorUserId: input.actorUserId }),
        this.templateResolver.resolve({ organizationId: input.organizationId, actorUserId: input.actorUserId, kind: 'internal_user_invitation' }),
      ])
      sender = resolved[0]
      template = resolved[1]
    } catch {
      throw new EmailServiceError('DELIVERY_FAILED')
    }
    if (template.kind !== 'internal_user_invitation' || !template.subject.trim() || !template.bodyText.trim()) throw new EmailServiceError('DELIVERY_FAILED')
    const expiresAt = formatDate(input.expiresAtMs)
    const bodyHtml = renderBodyHtml(template.bodyText)
    const message = {
      idempotencyKey: `identity-invite:${input.inviteId}:${credentialVersion(input.activationCredential)}`,
      to: input.recipientEmail,
      from: sender.from,
      subject: template.subject,
      text: `${template.bodyText}\n\n請在 ${expiresAt} 前開啟以下連結完成帳戶設定：\n${activationUrl.toString()}`,
      html: `${bodyHtml}<p>請在 <strong>${escapeHtml(expiresAt)}</strong> 前完成帳戶設定。</p><p><a href="${escapeHtml(activationUrl.toString())}">確認並設定帳戶</a></p>`,
    } as const
    try {
      const receipt = await sender.transport.send(message)
      if (receipt.channelPolicyId !== EMAIL_DELIVERY_POLICY.channelPolicyId || !SAFE_REFERENCE.test(receipt.receiptReference) || !Number.isSafeInteger(receipt.deliveredAtMs) || receipt.deliveredAtMs <= 0) throw new EmailServiceError('DELIVERY_FAILED')
      return receipt
    } catch (error) {
      if (error instanceof EmailServiceError) throw error
      throw new EmailServiceError('DELIVERY_FAILED')
    }
  }
}

function isEmail(value: string): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value === value.trim().toLowerCase() }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function isOpaqueCredential(value: string): boolean { return /^v1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i.test(value) }
function credentialVersion(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16) }
function formatDate(value: number): string { return new Intl.DateTimeFormat('zh-HK', { dateStyle: 'long', timeZone: 'Asia/Hong_Kong' }).format(value) }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character) }
function renderBodyHtml(value: string): string {
  return value.split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`).join('')
}

const DEFAULT_TEMPLATE_RESOLVER: EmailTemplateResolver = Object.freeze({
  async resolve() { return DEFAULT_INTERNAL_INVITATION_TEMPLATE },
})
