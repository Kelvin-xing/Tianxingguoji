import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'

import { isOrganizationRole, type EmploymentType, type OrganizationRole } from '../../access/public.ts'
import { INVITE_POLICY } from '../domain/contract.ts'
import type { IdentitySessionActor } from '../domain/actor.ts'
import { hashOpaqueSecret } from './opaque-secret.ts'

export const INTERNAL_EMAIL_PASSWORD_POLICY = Object.freeze({
  version: 'scrypt-v1' as const,
  N: 32_768,
  r: 8,
  p: 1,
  keyLength: 64,
  saltBytes: 32,
  maxmem: 64 * 1024 * 1024,
  passwordMinBytes: 8,
  passwordMaxBytes: 256,
  emailMaxBytes: 320,
  failureWindowMs: 15 * 60 * 1_000,
  failureLimit: 5,
  lockDurationMs: 15 * 60 * 1_000,
})

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACTIVATION_CREDENTIAL = /^v1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const DUMMY_SALT = Buffer.from('a1'.repeat(INTERNAL_EMAIL_PASSWORD_POLICY.saltBytes), 'hex')
const DUMMY_PASSWORD = Buffer.from('invalid-internal-email-password', 'utf8')

export interface InternalEmailInviteActor {
  readonly userId: string
  readonly organizationId: string
  readonly roles: readonly OrganizationRole[]
}

export interface InternalEmailCredentialSnapshot {
  readonly userId: string
  readonly verifierVersion: typeof INTERNAL_EMAIL_PASSWORD_POLICY.version
  readonly salt: Uint8Array
  readonly verifier: Uint8Array
  readonly credentialVersion: number
}

export interface InternalEmailRepository {
  createInvitedIdentity(input: Readonly<{
    inviteId: string
    userId: string
    membershipId: string
    roleBindingId: string
    organizationId: string
    invitedByUserId: string
    normalizedEmail: string
    role: OrganizationRole
    employmentType: EmploymentType
    displayName: string
    secretHash: string
    expiresAtMs: number
    idempotencyKey: string
  }>): Promise<void>
  recordInviteDelivery(input: Readonly<{ inviteId: string; organizationId: string; receipt: InternalInviteDeliveryReceipt }>): Promise<void>
  rotateInvite(input: Readonly<{ inviteId: string; organizationId: string; secretHash: string; expiresAtMs: number; nowMs: number }>): Promise<{ targetUserId: string; normalizedEmail: string }>
  activateInvite(input: Readonly<{
    organizationId: string
    inviteId: string
    targetUserId: string
    secretHash: string
    passwordSalt: Uint8Array
    passwordVerifier: Uint8Array
    displayName: string
    sessionId: string
    sessionSecretHash: string
    nowMs: number
  }>): Promise<IdentitySessionActor>
  findCredential(normalizedEmail: string): Promise<InternalEmailCredentialSnapshot | null>
  completeLoginAttempt(input: Readonly<{
    userId: string | null
    expectedCredentialVersion: number | null
    passwordMatched: boolean
    sessionId: string
    secretHash: string
    nowMs: number
  }>): Promise<IdentitySessionActor | null>
  findActorBySessionSecretHash(input: Readonly<{
    secretHash: string
    nowMs: number
    sensitiveAction: boolean
  }>): Promise<IdentitySessionActor>
  revokeSessionBySecretHash(input: Readonly<{ secretHash: string; reason: string }>): Promise<void>
}

export interface InternalInviteDeliveryReceipt {
  readonly channelPolicyId: 'hk_dpa_reviewed_transactional'
  readonly receiptReference: string
  readonly deliveredAtMs: number
}

export interface InternalEmailServiceOptions {
  readonly repository: InternalEmailRepository
  readonly email: { sendInvitation(input: Readonly<{ inviteId: string; organizationId: string; actorUserId: string; recipientEmail: string; activationCredential: string; expiresAtMs: number }>): Promise<InternalInviteDeliveryReceipt> }
  readonly clock?: { nowMs(): number }
  readonly createId?: () => string
  readonly createSecret?: () => string
}

export type InternalEmailServiceErrorCode =
  | 'FOUNDER_REQUIRED'
  | 'INVITE_INVALID'
  | 'INVITE_ALREADY_EXISTS'
  | 'INVITE_NOT_FOUND'
  | 'INVITE_NOT_REDEEMABLE'
  | 'INVITE_EXPIRED'
  | 'INVITE_DELIVERY_FAILED'
  | 'AUTHENTICATION_FAILED'
  | 'SESSION_LIMIT_REACHED'
  | 'SESSION_NOT_FOUND'

export class InternalEmailServiceError extends Error {
  readonly code: InternalEmailServiceErrorCode

  constructor(code: InternalEmailServiceErrorCode, options?: ErrorOptions) {
    super(`Internal email identity rejected ${code}.`, options)
    this.name = 'InternalEmailServiceError'
    this.code = code
  }
}

export interface CreatedInternalInvite {
  readonly inviteId: string
  readonly targetUserId: string
  readonly expiresAtMs: number
  readonly deliveryReceipt: InternalInviteDeliveryReceipt
}

export interface CreatedInternalSession {
  readonly cookieSecret: string
  readonly actor: IdentitySessionActor
}

export class InternalEmailService {
  private readonly repository: InternalEmailRepository
  private readonly email: InternalEmailServiceOptions['email']
  private readonly nowMs: () => number
  private readonly createId: () => string
  private readonly createSecret: () => string

  constructor(options: InternalEmailServiceOptions) {
    this.repository = options.repository
    this.email = options.email
    this.nowMs = options.clock?.nowMs ?? (() => Date.now())
    this.createId = options.createId ?? randomUUID
    this.createSecret = options.createSecret ?? (() => randomBytes(INVITE_POLICY.activationSecretBytes).toString('base64url'))
  }

  async createFounderInvite(input: Readonly<{
    actor: InternalEmailInviteActor
    normalizedEmail: string
    role: OrganizationRole
    employmentType?: EmploymentType
    displayName?: string
    idempotencyKey: string
  }>): Promise<CreatedInternalInvite> {
    assertFounder(input.actor)
    const email = normalizeInternalEmail(input.normalizedEmail)
    if (!email || !isOrganizationRole(input.role) || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new InternalEmailServiceError('INVITE_INVALID')
    }
    const employmentType = input.employmentType ?? (input.role === 'contractor' ? 'PART_TIME' : 'FULL_TIME')
    if (!isCompatibleEmployment(input.role, employmentType)) throw new InternalEmailServiceError('INVITE_INVALID')
    const inviteId = this.createId()
    const targetUserId = this.createId()
    const membershipId = this.createId()
    const roleBindingId = this.createId()
    const activationSecret = this.createSecret()
    if (![inviteId, targetUserId, membershipId, roleBindingId].every((value) => UUID.test(value)) || !isOpaqueSecret(activationSecret)) {
      throw new InternalEmailServiceError('INVITE_INVALID')
    }
    const nowMs = this.nowMs()
    const expiresAtMs = nowMs + INVITE_POLICY.expiresInMs
    const activationCredential = buildActivationCredential(input.actor.organizationId, inviteId, targetUserId, activationSecret)
    try {
      await this.repository.createInvitedIdentity({
        inviteId, userId: targetUserId, membershipId, roleBindingId,
        organizationId: input.actor.organizationId, invitedByUserId: input.actor.userId,
        normalizedEmail: email, role: input.role, employmentType,
        displayName: normalizeDisplayName(input.displayName),
        secretHash: hashOpaqueSecret(activationSecret), expiresAtMs, idempotencyKey: input.idempotencyKey,
      })
    } catch (error) {
      throw mapRepositoryError(error)
    }
    let receipt: InternalInviteDeliveryReceipt
    try {
      receipt = await this.email.sendInvitation({ inviteId, organizationId: input.actor.organizationId, actorUserId: input.actor.userId, recipientEmail: email, activationCredential, expiresAtMs })
      await this.repository.recordInviteDelivery({ inviteId, organizationId: input.actor.organizationId, receipt })
    } catch {
      throw new InternalEmailServiceError('INVITE_DELIVERY_FAILED')
    }
    return Object.freeze({ inviteId, targetUserId, expiresAtMs, deliveryReceipt: receipt })
  }

  async activateInvite(input: Readonly<{ activationCredential: string; password: string; displayName: string }>): Promise<CreatedInternalSession> {
    const parsed = parseActivationCredential(input.activationCredential)
    const password = passwordBytes(input.password)
    const displayName = normalizeDisplayName(input.displayName)
    if (!password || !displayName) throw new InternalEmailServiceError('INVITE_INVALID')
    const salt = randomBytes(INTERNAL_EMAIL_PASSWORD_POLICY.saltBytes)
    const verifier = await deriveInternalEmailVerifier(password, salt)
    const cookieSecret = this.createSecret()
    if (!isOpaqueSecret(cookieSecret)) throw new InternalEmailServiceError('INVITE_INVALID')
    try {
      const actor = await this.repository.activateInvite({
        ...parsed, passwordSalt: salt, passwordVerifier: verifier, displayName,
        sessionId: this.createId(), sessionSecretHash: hashOpaqueSecret(cookieSecret), nowMs: this.nowMs(),
      })
      return Object.freeze({ cookieSecret, actor })
    } catch (error) {
      throw mapRepositoryError(error)
    } finally {
      password.fill(0)
      verifier.fill(0)
      salt.fill(0)
    }
  }

  async resendFounderInvite(input: Readonly<{ actor: InternalEmailInviteActor; inviteId: string }>): Promise<CreatedInternalInvite> {
    assertFounder(input.actor)
    if (!UUID.test(input.inviteId)) throw new InternalEmailServiceError('INVITE_INVALID')
    const activationSecret = this.createSecret()
    if (!isOpaqueSecret(activationSecret)) throw new InternalEmailServiceError('INVITE_INVALID')
    const nowMs = this.nowMs()
    const expiresAtMs = nowMs + INVITE_POLICY.expiresInMs
    let target: { targetUserId: string; normalizedEmail: string }
    try {
      target = await this.repository.rotateInvite({ inviteId: input.inviteId, organizationId: input.actor.organizationId, secretHash: hashOpaqueSecret(activationSecret), expiresAtMs, nowMs })
    } catch (error) {
      throw mapRepositoryError(error)
    }
    const activationCredential = buildActivationCredential(input.actor.organizationId, input.inviteId, target.targetUserId, activationSecret)
    try {
      const deliveryReceipt = await this.email.sendInvitation({ inviteId: input.inviteId, organizationId: input.actor.organizationId, actorUserId: input.actor.userId, recipientEmail: target.normalizedEmail, activationCredential, expiresAtMs })
      await this.repository.recordInviteDelivery({ inviteId: input.inviteId, organizationId: input.actor.organizationId, receipt: deliveryReceipt })
      return Object.freeze({ inviteId: input.inviteId, targetUserId: target.targetUserId, expiresAtMs, deliveryReceipt })
    } catch {
      throw new InternalEmailServiceError('INVITE_DELIVERY_FAILED')
    }
  }

  async createSession(input: Readonly<{ email: unknown; password: unknown }>): Promise<CreatedInternalSession> {
    const normalizedEmail = normalizeInternalEmail(input.email)
    const password = passwordBytes(input.password)
    const credential = await this.repository.findCredential(normalizedEmail ?? 'invalid@example.invalid')
    const derived = await deriveInternalEmailVerifier(password ?? DUMMY_PASSWORD, credential?.salt ?? DUMMY_SALT)
    const matched = password !== null && credential !== null && safeEqual(derived, credential.verifier)
    const cookieSecret = this.createSecret()
    try {
      const actor = await this.repository.completeLoginAttempt({
        userId: credential?.userId ?? null,
        expectedCredentialVersion: credential?.credentialVersion ?? null,
        passwordMatched: matched,
        sessionId: this.createId(), secretHash: hashOpaqueSecret(cookieSecret), nowMs: this.nowMs(),
      })
      if (!actor) throw new InternalEmailServiceError('AUTHENTICATION_FAILED')
      return Object.freeze({ cookieSecret, actor })
    } catch (error) {
      throw mapRepositoryError(error)
    } finally {
      password?.fill(0)
      derived.fill(0)
    }
  }

  async requireSession(input: Readonly<{ cookieSecret: string; sensitiveAction: boolean }>): Promise<IdentitySessionActor> {
    try {
      return await this.repository.findActorBySessionSecretHash({ secretHash: hashOpaqueSecret(input.cookieSecret), nowMs: this.nowMs(), sensitiveAction: input.sensitiveAction })
    } catch (error) {
      throw mapRepositoryError(error)
    }
  }

  async revokeSession(input: Readonly<{ cookieSecret: string; reason: string }>): Promise<void> {
    await this.repository.revokeSessionBySecretHash({ secretHash: hashOpaqueSecret(input.cookieSecret), reason: input.reason })
  }
}

export function normalizeInternalEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return Buffer.byteLength(normalized, 'utf8') <= INTERNAL_EMAIL_PASSWORD_POLICY.emailMaxBytes && EMAIL.test(normalized) ? normalized : null
}

export function deriveInternalEmailVerifier(password: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  if (salt.byteLength !== INTERNAL_EMAIL_PASSWORD_POLICY.saltBytes || password.byteLength < 1 || password.byteLength > INTERNAL_EMAIL_PASSWORD_POLICY.passwordMaxBytes) throw new TypeError('Internal email credential input is invalid.')
  return new Promise((resolve, reject) => scrypt(password, salt, INTERNAL_EMAIL_PASSWORD_POLICY.keyLength, { N: INTERNAL_EMAIL_PASSWORD_POLICY.N, r: INTERNAL_EMAIL_PASSWORD_POLICY.r, p: INTERNAL_EMAIL_PASSWORD_POLICY.p, maxmem: INTERNAL_EMAIL_PASSWORD_POLICY.maxmem }, (error, key) => error ? reject(error) : resolve(key)))
}

function passwordBytes(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength < INTERNAL_EMAIL_PASSWORD_POLICY.passwordMinBytes || bytes.byteLength > INTERNAL_EMAIL_PASSWORD_POLICY.passwordMaxBytes) { bytes.fill(0); return null }
  return bytes
}

function safeEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  const left = Buffer.from(actual); const right = Buffer.from(expected)
  return left.byteLength === INTERNAL_EMAIL_PASSWORD_POLICY.keyLength && right.byteLength === left.byteLength && timingSafeEqual(left, right)
}

function assertFounder(actor: InternalEmailInviteActor): void {
  if (!UUID.test(actor.userId) || !UUID.test(actor.organizationId) || !actor.roles.includes('founder')) throw new InternalEmailServiceError('FOUNDER_REQUIRED')
}

function isCompatibleEmployment(role: OrganizationRole, employment: EmploymentType): boolean {
  return !(employment === 'FULL_TIME' && role === 'contractor') && !(employment === 'PART_TIME' && (role === 'founder' || role === 'advisor'))
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') return '待啟用'
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 100 ? normalized : '待啟用'
}

function isOpaqueSecret(value: string): boolean { return Buffer.from(value, 'base64url').byteLength === INVITE_POLICY.activationSecretBytes }

function buildActivationCredential(organizationId: string, inviteId: string, targetUserId: string, secret: string): string { return `v1.${organizationId}.${inviteId}.${targetUserId}.${secret}` }

function parseActivationCredential(value: string): { organizationId: string; inviteId: string; targetUserId: string; secretHash: string } {
  const match = ACTIVATION_CREDENTIAL.exec(value)
  if (!match) throw new InternalEmailServiceError('INVITE_INVALID')
  return { organizationId: match[1]!.toLowerCase(), inviteId: match[2]!.toLowerCase(), targetUserId: match[3]!.toLowerCase(), secretHash: hashOpaqueSecret(match[4]!) }
}

function mapRepositoryError(error: unknown): InternalEmailServiceError {
  if (error instanceof InternalEmailServiceError) return error
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined
  if (code === 'INVITE_ALREADY_EXISTS') return new InternalEmailServiceError('INVITE_ALREADY_EXISTS')
  if (code === 'INVITE_EXPIRED') return new InternalEmailServiceError('INVITE_EXPIRED')
  if (code === 'INVITE_NOT_FOUND') return new InternalEmailServiceError('INVITE_NOT_FOUND')
  if (code === 'INVITE_NOT_REDEEMABLE') return new InternalEmailServiceError('INVITE_NOT_REDEEMABLE')
  if (code === 'SESSION_LIMIT_REACHED') return new InternalEmailServiceError('SESSION_LIMIT_REACHED')
  if (code === 'SESSION_NOT_FOUND') return new InternalEmailServiceError('SESSION_NOT_FOUND')
  return new InternalEmailServiceError('INVITE_INVALID', { cause: error })
}
