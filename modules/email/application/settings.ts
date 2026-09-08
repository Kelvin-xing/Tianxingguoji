import { randomUUID } from 'node:crypto'

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from '../../audit/public.ts'
import { hasRequestCapability, type AccessContext } from '../../access/public.ts'
import { hashRequestPayload, validateIdempotencyKey } from '../../shared/public.ts'
import type { EmailSecretBox, EncryptedEmailSecret } from '../domain/contract.ts'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const API_KEY = /^re_[A-Za-z0-9_-]{8,252}$/
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export interface EmailSettingsStatus {
  readonly configured: boolean
  readonly provider: 'resend' | null
  readonly fromEmail: string | null
  readonly fromName: string | null
  readonly recordVersion: number | null
  readonly updatedAt: string | null
}

export interface StoredEmailProviderSettings {
  readonly provider: 'resend'
  readonly fromEmail: string
  readonly fromName: string | null
  readonly secret: EncryptedEmailSecret
  readonly recordVersion: number
  readonly updatedAt: string
}

export interface EmailSettingsMutationReceipt {
  readonly settingsId: string
  readonly recordVersion: number
  readonly updatedAt: string
  readonly replayed: boolean
}

export interface EmailSettingsRepository {
  readStatus(input: Readonly<{ organizationId: string; actorUserId: string }>): Promise<EmailSettingsStatus>
  readDeliverySettings(input: Readonly<{ organizationId: string; actorUserId: string }>): Promise<StoredEmailProviderSettings | null>
  save(input: Readonly<{
    organizationId: string
    actorUserId: string
    fromEmail: string
    fromName: string | null
    secret: EncryptedEmailSecret
    expectedRecordVersion: number | null
    nextRecordVersion: number
    requestId: string
    idempotencyKey: string
    idempotencyId: string
    requestHash: string
    occurredAt: string
    effects: MutationEffectBundle
  }>): Promise<EmailSettingsMutationReceipt>
}

export type EmailSettingsErrorCode = 'FORBIDDEN' | 'INVALID' | 'STALE_VERSION' | 'IDEMPOTENCY_CONFLICT' | 'UNAVAILABLE'

export class EmailSettingsError extends Error {
  readonly code: EmailSettingsErrorCode

  constructor(code: EmailSettingsErrorCode) {
    super(`Email settings rejected ${code}.`)
    this.name = 'EmailSettingsError'
    this.code = code
  }
}

export function isEmailSettingsError(error: unknown, code?: EmailSettingsErrorCode): error is EmailSettingsError {
  return error instanceof EmailSettingsError && (code === undefined || error.code === code)
}

export class EmailSettingsService {
  private readonly repository: EmailSettingsRepository
  private readonly secretBox: EmailSecretBox
  private readonly createId: () => string
  private readonly now: () => number

  constructor(input: Readonly<{
    repository: EmailSettingsRepository
    secretBox: EmailSecretBox
    createId?: () => string
    now?: () => number
  }>) {
    this.repository = input.repository
    this.secretBox = input.secretBox
    this.createId = input.createId ?? randomUUID
    this.now = input.now ?? Date.now
  }

  getStatus(actor: AccessContext): Promise<EmailSettingsStatus> {
    requireManageCapability(actor)
    return this.repository.readStatus({ organizationId: actor.organizationId, actorUserId: actor.userId })
  }

  save(input: Readonly<{
    actor: AccessContext
    command: Readonly<{
      apiKey: string
      fromEmail: string
      fromName: string | null
      expectedRecordVersion: number | null
      idempotencyKey: string
      requestId: string
    }>
  }>): Promise<EmailSettingsMutationReceipt> {
    requireManageCapability(input.actor)
    const apiKey = input.command.apiKey.trim()
    const fromEmail = input.command.fromEmail.trim().toLowerCase()
    const fromName = normalizeFromName(input.command.fromName)
    if (!API_KEY.test(apiKey) || fromEmail.length > 320 || !EMAIL.test(fromEmail)) throw new EmailSettingsError('INVALID')
    if (input.command.expectedRecordVersion !== null && (!Number.isSafeInteger(input.command.expectedRecordVersion) || input.command.expectedRecordVersion < 1)) throw new EmailSettingsError('INVALID')
    if (!SAFE_REQUEST_ID.test(input.command.requestId)) throw new EmailSettingsError('INVALID')
    try { validateIdempotencyKey(input.command.idempotencyKey) } catch { throw new EmailSettingsError('INVALID') }

    const nextRecordVersion = (input.command.expectedRecordVersion ?? 0) + 1
    const occurredAt = new Date(this.now()).toISOString()
    const settingsId = input.actor.organizationId
    const auditId = this.createId()
    const outboxId = this.createId()
    const effects = buildAtomicMutationEffects({
      audit: buildAuditEvent({
        id: auditId,
        organizationId: input.actor.organizationId,
        actorUserId: input.actor.userId,
        actorKind: 'user',
        eventType: 'email.provider_settings.updated',
        eventVersion: 1,
        action: 'update_provider_settings',
        resourceType: 'EmailProviderSettings',
        resourceId: settingsId,
        outcome: 'succeeded',
        requestId: input.command.requestId,
        occurredAt,
        metadata: { effect_type: 'email_provider_settings_updated', record_version: nextRecordVersion, status: 'active' },
      }),
      outbox: buildOutboxMessage({
        id: outboxId,
        auditEventId: auditId,
        organizationId: input.actor.organizationId,
        aggregateType: 'EmailProviderSettings',
        aggregateId: settingsId,
        eventType: 'email.provider_settings.updated',
        eventVersion: 1,
        idempotencyKey: `email-settings-${outboxId}`,
        requestId: input.command.requestId,
        payload: { aggregate_id: settingsId, effect_type: 'email_provider_settings_updated', record_version: nextRecordVersion, request_id: input.command.requestId, status: 'active' },
        availableAt: occurredAt,
        createdAt: occurredAt,
      }),
    })
    let secret: EncryptedEmailSecret
    try {
      secret = this.secretBox.seal({ organizationId: input.actor.organizationId, plaintext: apiKey })
    } catch {
      throw new EmailSettingsError('UNAVAILABLE')
    }
    return this.repository.save({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      fromEmail,
      fromName,
      secret,
      expectedRecordVersion: input.command.expectedRecordVersion,
      nextRecordVersion,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      idempotencyId: this.createId(),
      requestHash: hashRequestPayload({
        api_key_sha256: hashRequestPayload({ value: apiKey }),
        expected_record_version: input.command.expectedRecordVersion,
        from_email: fromEmail,
        from_name: fromName,
      }),
      occurredAt,
      effects,
    })
  }
}

function requireManageCapability(actor: AccessContext): void {
  if (!hasRequestCapability(actor, 'email.settings.manage') || !actor.roles.includes('admin')) throw new EmailSettingsError('FORBIDDEN')
}

function normalizeFromName(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > 100 || /[\r\n<>]/.test(normalized)) throw new EmailSettingsError('INVALID')
  return normalized
}
