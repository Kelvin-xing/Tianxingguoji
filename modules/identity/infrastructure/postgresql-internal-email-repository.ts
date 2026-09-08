import "server-only";

import { randomUUID } from 'node:crypto'

import type { OrganizationRole, EmploymentType } from '../../access/public.ts'
import type { IdentitySessionActor } from '../domain/actor.ts'
import { withAuthTransaction, type DatabaseClient } from './postgresql-client.ts'
import type { InternalEmailCredentialSnapshot, InternalEmailRepository, InternalInviteDeliveryReceipt } from '../application/internal-email.ts'
import { INTERNAL_EMAIL_PASSWORD_POLICY } from '../application/internal-email.ts'

interface ActorRow {
  user_id: string
  normalized_email: string
  organization_id: string
  membership_id: string
  role_binding_id: string
  role: OrganizationRole
  session_id: string
  captured_session_version: string | number
  reauthenticated_at: Date | string | null
}

interface CredentialRow {
  user_id: string
  verifier_version: string
  password_salt: Buffer
  password_verifier: Buffer
  credential_version: string | number
}

interface InviteRow {
  organization_id: string
  target_user_id: string
  status: 'created' | 'redeemed' | 'expired' | 'revoked'
  expires_at: Date | string
}

export class InternalEmailRepositoryError extends Error {
  readonly code: 'INVITE_ALREADY_EXISTS' | 'INVITE_NOT_FOUND' | 'INVITE_NOT_REDEEMABLE' | 'INVITE_EXPIRED' | 'SESSION_LIMIT_REACHED' | 'SESSION_NOT_FOUND'

  constructor(code: InternalEmailRepositoryError['code']) {
    super(`Internal email repository rejected ${code}.`)
    this.name = 'InternalEmailRepositoryError'
    this.code = code
  }
}

export class PostgresqlInternalEmailRepository implements InternalEmailRepository {
  async createInvitedIdentity(input: Readonly<{
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
  }>): Promise<void> {
    await withAuthTransaction(async (client) => {
      await setOrganizationContext(client, input.organizationId)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`internal-email-invite:${input.normalizedEmail}`])
      try {
        await client.query(`SELECT identity_internal_email_create_invite($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [input.inviteId, input.userId, input.membershipId, input.roleBindingId, input.organizationId, input.invitedByUserId, input.normalizedEmail, input.role, input.employmentType, input.displayName, hashBuffer(input.secretHash), new Date(input.expiresAtMs)])
      } catch (error) {
        if (isUniqueViolation(error)) throw new InternalEmailRepositoryError('INVITE_ALREADY_EXISTS')
        if (error instanceof Error && (error as Error & { code?: unknown }).code === '42501') throw new InternalEmailRepositoryError('INVITE_NOT_REDEEMABLE')
        throw error
      }
    })
  }

  async recordInviteDelivery(input: Readonly<{ inviteId: string; organizationId: string; receipt: InternalInviteDeliveryReceipt }>): Promise<void> {
    await withAuthTransaction(async (client) => {
      await setOrganizationContext(client, input.organizationId)
      await client.query(
        `INSERT INTO identity_invite_delivery_receipts (id, organization_id, invite_id, channel_policy_id, receipt_reference, delivered_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (invite_id) DO UPDATE SET receipt_reference = EXCLUDED.receipt_reference, delivered_at = EXCLUDED.delivered_at`,
        [randomUUID(), input.organizationId, input.inviteId, input.receipt.channelPolicyId, input.receipt.receiptReference, new Date(input.receipt.deliveredAtMs)],
      )
    })
  }

  async rotateInvite(input: Readonly<{ inviteId: string; organizationId: string; secretHash: string; expiresAtMs: number; nowMs: number }>): Promise<{ targetUserId: string; normalizedEmail: string }> {
    return withAuthTransaction(async (client) => {
      await setOrganizationContext(client, input.organizationId)
      const result = await client.query<{ target_user_id: string; normalized_email: string; status: InviteRow['status']; expires_at: Date | string }>(`SELECT i.target_user_id, u.normalized_email, i.status, i.expires_at FROM identity_invites i JOIN identity_users u ON u.id = i.target_user_id WHERE i.id = $1 AND i.organization_id = $2 FOR UPDATE`, [input.inviteId, input.organizationId])
      const row = result.rows[0]
      if (!row) throw new InternalEmailRepositoryError('INVITE_NOT_FOUND')
      if (row.status !== 'created') throw new InternalEmailRepositoryError('INVITE_NOT_REDEEMABLE')
      if (toMillis(row.expires_at) <= input.nowMs) {
        await client.query(`UPDATE identity_invites SET status = 'expired', expired_at = transaction_timestamp(), record_version = record_version + 1, updated_at = transaction_timestamp() WHERE id = $1`, [input.inviteId])
        throw new InternalEmailRepositoryError('INVITE_EXPIRED')
      }
      await client.query(`UPDATE identity_invites SET secret_hash = $3, expires_at = $4, record_version = record_version + 1, updated_at = transaction_timestamp() WHERE id = $1 AND organization_id = $2 AND status = 'created'`, [input.inviteId, input.organizationId, hashBuffer(input.secretHash), new Date(input.expiresAtMs)])
      return { targetUserId: row.target_user_id, normalizedEmail: row.normalized_email }
    })
  }

  async activateInvite(input: Readonly<{
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
  }>): Promise<IdentitySessionActor> {
    return withAuthTransaction(async (client) => {
      await setOrganizationContext(client, input.organizationId)
      const result = await client.query<{
        allowed: boolean
        denial_code: string | null
        user_id: string | null
        normalized_email: string | null
        membership_id: string | null
        role_binding_id: string | null
        role: OrganizationRole | null
        session_id: string | null
        captured_session_version: string | number | null
        reauthenticated_at: Date | string | null
      }>(`SELECT * FROM identity_internal_email_activate_invite($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.organizationId, input.inviteId, input.targetUserId, hashBuffer(input.secretHash), Buffer.from(input.passwordSalt), Buffer.from(input.passwordVerifier), input.displayName, input.sessionId, hashBuffer(input.sessionSecretHash), new Date(input.nowMs)])
      const row = result.rows[0]
      if (!row?.allowed) throw new InternalEmailRepositoryError((row?.denial_code as InternalEmailRepositoryError['code']) ?? 'INVITE_NOT_FOUND')
      if (!row.user_id || !row.membership_id || !row.role_binding_id || !row.role || !row.session_id || row.captured_session_version === null) throw new InternalEmailRepositoryError('INVITE_NOT_REDEEMABLE')
      return Object.freeze({ userId: row.user_id, organizationId: input.organizationId, membershipId: row.membership_id, roleBindingId: row.role_binding_id, role: row.role, sessionId: row.session_id, capturedSessionVersion: Number(row.captured_session_version), reauthenticatedAtMs: row.reauthenticated_at === null ? input.nowMs : toMillis(row.reauthenticated_at) })
    })
  }

  async findCredential(normalizedEmail: string): Promise<InternalEmailCredentialSnapshot | null> {
    return withAuthTransaction(async (client) => {
      if (!(await establishOrganizationContext(client))) return null
      const result = await client.query<CredentialRow>(
        `SELECT * FROM identity_internal_email_lookup_credential($1)`,
        [normalizedEmail],
      )
      const row = result.rows[0]
      if (!row || row.verifier_version !== INTERNAL_EMAIL_PASSWORD_POLICY.version || row.password_salt.byteLength !== 32 || row.password_verifier.byteLength !== 64) return null
      return Object.freeze({ userId: row.user_id, verifierVersion: INTERNAL_EMAIL_PASSWORD_POLICY.version, salt: Uint8Array.from(row.password_salt), verifier: Uint8Array.from(row.password_verifier), credentialVersion: Number(row.credential_version) })
    })
  }

  async completeLoginAttempt(input: Readonly<{ userId: string | null; expectedCredentialVersion: number | null; passwordMatched: boolean; sessionId: string; secretHash: string; nowMs: number }>): Promise<IdentitySessionActor | null> {
    return withAuthTransaction(async (client) => {
      if (input.userId) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`internal-email-login:${input.userId}`])
      }
      if (input.passwordMatched && input.userId && !(await establishUserContext(client, input.userId))) return null
      const result = await client.query<ActorRow & { allowed: boolean }>(
        `SELECT * FROM identity_internal_email_complete_login($1,$2,$3,$4,$5,$6)`,
        [input.userId, input.expectedCredentialVersion, input.passwordMatched, input.sessionId, hashBuffer(input.secretHash), new Date(input.nowMs)],
      )
      return actorFromCommand(result.rows[0])
    })
  }

  async findActorBySessionSecretHash(input: Readonly<{ secretHash: string; nowMs: number; sensitiveAction: boolean }>): Promise<IdentitySessionActor> {
    const actor = await withAuthTransaction(async (client) => {
      const secretHash = hashBuffer(input.secretHash)
      if (!(await establishSessionContext(client, secretHash))) return null
      const result = await client.query<ActorRow & { allowed: boolean }>(
        `SELECT * FROM identity_internal_email_resolve_session($1,$2,$3)`,
        [secretHash, new Date(input.nowMs), input.sensitiveAction],
      )
      return actorFromCommand(result.rows[0])
    })
    if (!actor) throw new InternalEmailRepositoryError('SESSION_NOT_FOUND')
    return actor
  }

  async revokeSessionBySecretHash(input: Readonly<{ secretHash: string; reason: string }>): Promise<void> {
    await withAuthTransaction(async (client) => {
      const secretHash = hashBuffer(input.secretHash)
      if (!(await establishSessionContext(client, secretHash))) return
      await client.query(`SELECT identity_internal_email_revoke_session($1,$2)`, [secretHash, input.reason.slice(0, 120)])
    })
  }
}

async function establishUserContext(client: DatabaseClient, userId: string): Promise<boolean> {
  const organizationId = await establishOrganizationContext(client)
  if (!organizationId) return false
  await client.query(`SELECT set_config('app.actor_user_id', $1, true)`, [userId])
  return true
}

async function establishSessionContext(client: DatabaseClient, secretHash: Buffer): Promise<boolean> {
  const organizationId = await establishOrganizationContext(client)
  if (!organizationId) return false
  const session = await client.query<{ user_id: string }>(`SELECT session.user_id FROM identity_sessions AS session WHERE session.secret_hash = $1 AND session.session_kind = 'internal_email' FOR UPDATE`, [secretHash])
  const userId = session.rows[0]?.user_id
  if (!userId) return false
  await client.query(`SELECT set_config('app.actor_user_id', $1, true)`, [userId])
  return true
}

async function establishOrganizationContext(client: DatabaseClient): Promise<string | null> {
  const organization = await client.query<{ organization_id: string }>(`SELECT organization.id AS organization_id FROM access_organizations AS organization WHERE organization.status = 'active' FOR SHARE`)
  const organizationId = organization.rows.length === 1 ? organization.rows[0]?.organization_id : null
  if (!organizationId) return null
  await setOrganizationContext(client, organizationId)
  return organizationId
}

async function setOrganizationContext(client: DatabaseClient, organizationId: string): Promise<void> {
  await client.query(`SELECT set_config('app.organization_id', $1, true)`, [organizationId])
}


function actorFromCommand(row: (ActorRow & { allowed: boolean }) | undefined): IdentitySessionActor | null {
  if (!row?.allowed || !row.user_id || !row.organization_id || !row.membership_id || !row.role_binding_id || !row.role || !row.session_id) return null
  return Object.freeze({ userId: row.user_id, organizationId: row.organization_id, membershipId: row.membership_id, roleBindingId: row.role_binding_id, role: row.role, sessionId: row.session_id, capturedSessionVersion: Number(row.captured_session_version), reauthenticatedAtMs: row.reauthenticated_at === null ? null : toMillis(row.reauthenticated_at) })
}

function hashBuffer(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new TypeError('Expected SHA-256 hash.')
  return Buffer.from(value, 'hex')
}

function toMillis(value: Date | string): number { const millis = value instanceof Date ? value.getTime() : Date.parse(value); if (!Number.isFinite(millis)) throw new Error('Invalid timestamp.'); return millis }
function isUniqueViolation(error: unknown): boolean { return error instanceof Error && (error as Error & { code?: unknown }).code === '23505' }
