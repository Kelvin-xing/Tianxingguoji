import { randomUUID } from 'node:crypto'

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from '../../audit/public.ts'
import { hasRequestCapability, type AccessContext } from '../../access/public.ts'
import { hashRequestPayload, validateIdempotencyKey } from '../../shared/public.ts'
import type { EmailTemplateContent, EmailTemplateKind } from '../domain/contract.ts'

const SUBJECT_MAX_LENGTH = 160
const BODY_MAX_LENGTH = 4_000
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SUBJECT_CONTROL = /[\u0000-\u001F\u007F]/
const BODY_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

export const DEFAULT_INTERNAL_INVITATION_TEMPLATE: EmailTemplateContent = Object.freeze({
  kind: 'internal_user_invitation',
  subject: '天星顧問工作台邀請',
  bodyText: '你已獲邀加入天星顧問工作台。',
})

export interface EmailTemplateStatus extends EmailTemplateContent {
  readonly customized: boolean
  readonly recordVersion: number | null
  readonly updatedAt: string | null
}

export interface EmailTemplateMutationReceipt {
  readonly templateKind: EmailTemplateKind
  readonly recordVersion: number
  readonly updatedAt: string
  readonly replayed: boolean
}

export interface EmailTemplateRepository {
  read(input: Readonly<{
    organizationId: string
    actorUserId: string
    kind: EmailTemplateKind
  }>): Promise<EmailTemplateStatus>
  save(input: Readonly<{
    organizationId: string
    actorUserId: string
    kind: EmailTemplateKind
    subject: string
    bodyText: string
    expectedRecordVersion: number | null
    nextRecordVersion: number
    requestId: string
    idempotencyKey: string
    idempotencyId: string
    requestHash: string
    occurredAt: string
    effects: MutationEffectBundle
  }>): Promise<EmailTemplateMutationReceipt>
}

export type EmailTemplateErrorCode = 'FORBIDDEN' | 'INVALID' | 'STALE_VERSION' | 'IDEMPOTENCY_CONFLICT' | 'UNAVAILABLE'

export class EmailTemplateError extends Error {
  readonly code: EmailTemplateErrorCode

  constructor(code: EmailTemplateErrorCode) {
    super(`Email template rejected ${code}.`)
    this.name = 'EmailTemplateError'
    this.code = code
  }
}

export function isEmailTemplateError(error: unknown, code?: EmailTemplateErrorCode): error is EmailTemplateError {
  return error instanceof EmailTemplateError && (code === undefined || error.code === code)
}

export class EmailTemplateService {
  private readonly input: Readonly<{
    repository: EmailTemplateRepository
    createId?: () => string
    now?: () => number
  }>

  constructor(input: Readonly<{
    repository: EmailTemplateRepository
    createId?: () => string
    now?: () => number
  }>) { this.input = input }

  get(actor: AccessContext): Promise<EmailTemplateStatus> {
    requireManageCapability(actor)
    return this.input.repository.read({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      kind: 'internal_user_invitation',
    })
  }

  save(input: Readonly<{
    actor: AccessContext
    command: Readonly<{
      subject: string
      bodyText: string
      expectedRecordVersion: number | null
      idempotencyKey: string
      requestId: string
    }>
  }>): Promise<EmailTemplateMutationReceipt> {
    requireManageCapability(input.actor)
    const subject = normalizeSubject(input.command.subject)
    const bodyText = normalizeBody(input.command.bodyText)
    const expectedRecordVersion = input.command.expectedRecordVersion
    if (expectedRecordVersion !== null && (!Number.isSafeInteger(expectedRecordVersion) || expectedRecordVersion < 1)) throw new EmailTemplateError('INVALID')
    if (!SAFE_REQUEST_ID.test(input.command.requestId)) throw new EmailTemplateError('INVALID')
    try { validateIdempotencyKey(input.command.idempotencyKey) } catch { throw new EmailTemplateError('INVALID') }

    const createId = this.input.createId ?? randomUUID
    const occurredAt = new Date((this.input.now ?? Date.now)()).toISOString()
    const nextRecordVersion = (expectedRecordVersion ?? 0) + 1
    const auditId = createId()
    const outboxId = createId()
    const effects = buildAtomicMutationEffects({
      audit: buildAuditEvent({
        id: auditId,
        organizationId: input.actor.organizationId,
        actorUserId: input.actor.userId,
        actorKind: 'user',
        eventType: 'email.template.updated',
        eventVersion: 1,
        action: 'update_email_template',
        resourceType: 'EmailTemplate',
        resourceId: input.actor.organizationId,
        outcome: 'succeeded',
        requestId: input.command.requestId,
        occurredAt,
        metadata: { effect_type: 'email_template_updated', record_version: nextRecordVersion },
      }),
      outbox: buildOutboxMessage({
        id: outboxId,
        auditEventId: auditId,
        organizationId: input.actor.organizationId,
        aggregateType: 'EmailTemplate',
        aggregateId: input.actor.organizationId,
        eventType: 'email.template.updated',
        eventVersion: 1,
        idempotencyKey: `email-template-${outboxId}`,
        requestId: input.command.requestId,
        payload: { aggregate_id: input.actor.organizationId, effect_type: 'email_template_updated', record_version: nextRecordVersion, request_id: input.command.requestId },
        availableAt: occurredAt,
        createdAt: occurredAt,
      }),
    })
    return this.input.repository.save({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      kind: 'internal_user_invitation',
      subject,
      bodyText,
      expectedRecordVersion,
      nextRecordVersion,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      idempotencyId: createId(),
      requestHash: hashRequestPayload({ body_text: bodyText, expected_record_version: expectedRecordVersion, subject }),
      occurredAt,
      effects,
    })
  }
}

function requireManageCapability(actor: AccessContext): void {
  if (!hasRequestCapability(actor, 'email.templates.manage') || !actor.roles.includes('admin')) throw new EmailTemplateError('FORBIDDEN')
}

function normalizeSubject(value: string): string {
  if (typeof value !== 'string') throw new EmailTemplateError('INVALID')
  const normalized = value.trim()
  if (!normalized || normalized.length > SUBJECT_MAX_LENGTH || SUBJECT_CONTROL.test(normalized)) throw new EmailTemplateError('INVALID')
  return normalized
}

function normalizeBody(value: string): string {
  if (typeof value !== 'string') throw new EmailTemplateError('INVALID')
  const normalized = value.replace(/\r\n?/g, '\n').trim()
  if (!normalized || normalized.length > BODY_MAX_LENGTH || BODY_CONTROL.test(normalized)) throw new EmailTemplateError('INVALID')
  return normalized
}
