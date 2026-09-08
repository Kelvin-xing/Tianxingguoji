export const EMAIL_DELIVERY_POLICY = Object.freeze({
  invitationExpiryHours: 72,
  channelPolicyId: 'hk_dpa_reviewed_transactional',
} as const)

export type EmailDeliveryOutcome = 'delivered' | 'failed'

export interface EmailMessage {
  readonly idempotencyKey: string
  readonly to: string
  readonly from: string
  readonly subject: string
  readonly text: string
  readonly html: string
}

export interface EmailDeliveryReceipt {
  readonly channelPolicyId: typeof EMAIL_DELIVERY_POLICY.channelPolicyId
  readonly receiptReference: string
  readonly deliveredAtMs: number
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailDeliveryReceipt>
}

export interface EmailSenderConfiguration {
  readonly from: string
  readonly transport: EmailTransport
}

export interface EmailSenderResolver {
  resolve(input: Readonly<{
    organizationId: string
    actorUserId: string
  }>): Promise<EmailSenderConfiguration>
}

export type EmailTemplateKind = 'internal_user_invitation'

export interface EmailTemplateContent {
  readonly kind: EmailTemplateKind
  readonly subject: string
  readonly bodyText: string
}

export interface EmailTemplateResolver {
  resolve(input: Readonly<{
    organizationId: string
    actorUserId: string
    kind: EmailTemplateKind
  }>): Promise<EmailTemplateContent>
}

export interface EncryptedEmailSecret {
  readonly ciphertext: Uint8Array
  readonly iv: Uint8Array
  readonly authTag: Uint8Array
  readonly keyVersion: string
}

export interface EmailSecretBox {
  seal(input: Readonly<{ organizationId: string; plaintext: string }>): EncryptedEmailSecret
  open(input: Readonly<{ organizationId: string; secret: EncryptedEmailSecret }>): string
}
