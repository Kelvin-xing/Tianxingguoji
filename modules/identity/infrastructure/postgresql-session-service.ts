import { randomUUID } from 'node:crypto'
import { evaluateSession, selectAvailableSessionSlot, SESSION_POLICY } from '../domain/contract.ts'
import type { OrganizationRole } from '../../access/public.ts'
import type { CognitoIdentity, CognitoTokenSet } from './cognito-client.ts'
import { getAuthConfig } from './auth-config.ts'
import { withAuthTransaction, type DatabaseClient } from './postgresql-client.ts'
import {
  createSessionSecret,
  encryptProviderTokens,
  hashSessionSecret,
} from './session-crypto.ts'

export interface SessionActor {
  userId: string
  normalizedEmail: string
  organizationId: string
  membershipId: string
  roleBindingId: string
  role: OrganizationRole
  sessionId: string
  capturedSessionVersion: number
  reauthenticatedAt: number | null
}

export interface CreatedSession {
  secret: string
  actor: SessionActor
}

export type SessionCreationErrorCode =
  | 'IDENTITY_NOT_INVITED'
  | 'USER_DISABLED'
  | 'PROVIDER_ALREADY_LINKED'
  | 'NO_ACTIVE_MEMBERSHIP'
  | 'SESSION_LIMIT_REACHED'

export class SessionCreationError extends Error {
  readonly code: SessionCreationErrorCode

  constructor(code: SessionCreationErrorCode) {
    super('The identity cannot receive an application session')
    this.name = 'SessionCreationError'
    this.code = code
  }
}

export type SessionAccessErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'USER_DISABLED'
  | 'SESSION_NOT_ACTIVE'
  | 'SESSION_VERSION_STALE'
  | 'ORGANIZATION_INACTIVE'
  | 'MEMBERSHIP_INACTIVE'
  | 'SESSION_ABSOLUTE_EXPIRED'
  | 'SESSION_IDLE_EXPIRED'
  | 'SENSITIVE_REAUTH_REQUIRED'

export class SessionAccessError extends Error {
  readonly code: SessionAccessErrorCode

  constructor(code: SessionAccessErrorCode) {
    super('The application session is not active')
    this.name = 'SessionAccessError'
    this.code = code
  }
}

interface IdentityUserRow {
  id: string
  normalized_email: string
  status: 'invited' | 'active' | 'disabled'
  session_version: string | number
}

interface ProviderIdentityRow extends IdentityUserRow {
  provider_user_id: string
}

interface MembershipRoleRow {
  organization_id: string
  membership_id: string
  role_binding_id: string
  role: OrganizationRole
}

interface SessionRow {
  session_id: string
  user_id: string
  normalized_email: string
  user_status: 'invited' | 'active' | 'disabled'
  current_session_version: string | number
  captured_session_version: string | number
  session_status: 'active' | 'revoked' | 'expired'
  organization_id: string
  organization_status: 'active' | 'disabled'
  membership_id: string
  membership_status: 'invited' | 'active' | 'disabled'
  role_binding_id: string
  role: OrganizationRole
  last_seen_at: Date | string
  idle_expires_at: Date | string
  absolute_expires_at: Date | string
  reauthenticated_at: Date | string | null
}

export async function createSessionForIdentity(
  identity: CognitoIdentity,
  tokens: CognitoTokenSet,
  nowMs = Date.now(),
): Promise<CreatedSession> {
  const config = getAuthConfig()
  return withAuthTransaction(async (client) => {
    const user = await resolveIdentityUser(client, identity, nowMs)
    if (user.status === 'disabled') throw new SessionCreationError('USER_DISABLED')

    const membership = await findActiveMembershipRole(client, user.id)
    if (!membership) throw new SessionCreationError('NO_ACTIVE_MEMBERSHIP')

    const activeSlots = await client.query<{ session_slot: number }>(
      `SELECT session_slot
         FROM identity_sessions
        WHERE user_id = $1
          AND status = 'active'
        FOR UPDATE`,
      [user.id],
    )
    const slotDecision = selectAvailableSessionSlot(activeSlots.rows.map((row) => row.session_slot as 1 | 2 | 3))
    if (!slotDecision.allowed) throw new SessionCreationError('SESSION_LIMIT_REACHED')

    const secret = createSessionSecret()
    const sessionId = randomUUID()
    const createdAt = new Date(nowMs)
    const absoluteExpiresAt = new Date(nowMs + SESSION_POLICY.absoluteTimeoutMs)
    const idleExpiresAt = new Date(
      Math.min(nowMs + SESSION_POLICY.idleTimeoutMs, absoluteExpiresAt.getTime()),
    )
    const encryptedProviderTokens = encryptProviderTokens(tokens, config.sessionEncryptionKey)
    const capturedSessionVersion = toSafeInteger(user.session_version)

    await client.query(
      `INSERT INTO identity_sessions (
         id,
         user_id,
         organization_id,
         membership_id,
         secret_hash,
         captured_session_version,
         session_slot,
         status,
         provider_token_ciphertext,
         provider_token_key_version,
         last_seen_at,
         idle_expires_at,
         absolute_expires_at,
         reauthenticated_at,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'active', $8, 'v1',
         $9, $10, $11, $9, $9, $9
       )`,
      [
        sessionId,
        user.id,
        membership.organization_id,
        membership.membership_id,
        hashSessionSecret(secret),
        capturedSessionVersion,
        slotDecision.slot,
        encryptedProviderTokens,
        createdAt,
        idleExpiresAt,
        absoluteExpiresAt,
      ],
    )

    return {
      secret,
      actor: {
        userId: user.id,
        normalizedEmail: user.normalized_email,
        organizationId: membership.organization_id,
        membershipId: membership.membership_id,
        roleBindingId: membership.role_binding_id,
        role: membership.role,
        sessionId,
        capturedSessionVersion,
        reauthenticatedAt: nowMs,
      },
    }
  })
}

export async function revokeSessionBySecret(secret: string, reason = 'sign_out'): Promise<void> {
  await withAuthTransaction(async (client) => {
    await client.query(
      `UPDATE identity_sessions
          SET status = 'revoked',
              revoked_at = transaction_timestamp(),
              revoke_reason = $2,
              record_version = record_version + 1,
              updated_at = transaction_timestamp()
        WHERE secret_hash = $1
          AND status = 'active'`,
      [hashSessionSecret(secret), reason],
    )
  })
}

export async function findActorBySecret(
  secret: string,
  nowMs = Date.now(),
  sensitiveAction = false,
): Promise<SessionActor> {
  return withAuthTransaction(async (client) => {
    const result = await client.query<SessionRow>(
      `SELECT
         session.id AS session_id,
         identity_user.id AS user_id,
         identity_user.normalized_email,
         identity_user.status AS user_status,
         identity_user.session_version AS current_session_version,
         session.captured_session_version,
         session.status AS session_status,
         organization.id AS organization_id,
         organization.status AS organization_status,
         membership.id AS membership_id,
         membership.status AS membership_status,
         role_binding.id AS role_binding_id,
         role_binding.role,
         session.last_seen_at,
         session.idle_expires_at,
         session.absolute_expires_at,
         session.reauthenticated_at
       FROM identity_sessions AS session
       JOIN identity_users AS identity_user ON identity_user.id = session.user_id
       JOIN access_organization_memberships AS membership
         ON membership.id = session.membership_id
        AND membership.organization_id = session.organization_id
        AND membership.user_id = session.user_id
       JOIN access_organizations AS organization ON organization.id = session.organization_id
       JOIN access_role_bindings AS role_binding
         ON role_binding.membership_id = membership.id
        AND role_binding.organization_id = membership.organization_id
        AND role_binding.user_id = membership.user_id
        AND role_binding.status = 'active'
       WHERE session.secret_hash = $1
       ORDER BY CASE role_binding.role
         WHEN 'founder' THEN 1
         WHEN 'admin' THEN 2
         WHEN 'advisor' THEN 3
         WHEN 'data_reviewer' THEN 4
         ELSE 5
       END
       LIMIT 1
       FOR UPDATE OF session, identity_user, membership, organization, role_binding`,
      [hashSessionSecret(secret)],
    )
    const row = result.rows[0]
    if (!row) throw new SessionAccessError('SESSION_NOT_FOUND')

    const decision = evaluateSession({
      nowMs,
      sensitiveAction,
      userStatus: row.user_status,
      currentSessionVersion: toSafeInteger(row.current_session_version),
      sessionStatus: row.session_status,
      capturedSessionVersion: toSafeInteger(row.captured_session_version),
      organizationStatus: row.organization_status,
      membershipStatus: row.membership_status,
      idleExpiresAtMs: toMillis(row.idle_expires_at),
      absoluteExpiresAtMs: toMillis(row.absolute_expires_at),
      reauthenticatedAtMs: row.reauthenticated_at === null ? null : toMillis(row.reauthenticated_at),
    })
    if (!decision.allowed) {
      await expireOrRevokeSession(client, row.session_id, decision.code)
      throw new SessionAccessError(decision.code)
    }

    const idleExpiresAtMs = Math.min(nowMs + SESSION_POLICY.idleTimeoutMs, toMillis(row.absolute_expires_at))
    await client.query(
      `UPDATE identity_sessions
          SET last_seen_at = $2,
              idle_expires_at = $3,
              record_version = record_version + 1,
              updated_at = $2
        WHERE id = $1
          AND status = 'active'`,
      [row.session_id, new Date(nowMs), new Date(idleExpiresAtMs)],
    )

    return {
      userId: row.user_id,
      normalizedEmail: row.normalized_email,
      organizationId: row.organization_id,
      membershipId: row.membership_id,
      roleBindingId: row.role_binding_id,
      role: row.role,
      sessionId: row.session_id,
      capturedSessionVersion: toSafeInteger(row.captured_session_version),
      reauthenticatedAt: row.reauthenticated_at === null ? null : toMillis(row.reauthenticated_at),
    }
  })
}

async function resolveIdentityUser(
  client: DatabaseClient,
  identity: CognitoIdentity,
  nowMs: number,
): Promise<IdentityUserRow> {
  const providerResult = await client.query<ProviderIdentityRow>(
    `SELECT
       identity_user.id AS provider_user_id,
       identity_user.id,
       identity_user.normalized_email,
       identity_user.status,
       identity_user.session_version
     FROM identity_provider_identities AS provider_identity
     JOIN identity_users AS identity_user ON identity_user.id = provider_identity.user_id
    WHERE provider_identity.provider = 'cognito'
      AND provider_identity.provider_subject = $1
    FOR UPDATE OF provider_identity, identity_user`,
    [identity.subject],
  )

  let user: IdentityUserRow | undefined = providerResult.rows[0]
  if (!user) {
    const emailResult = await client.query<IdentityUserRow>(
      `SELECT id, normalized_email, status, session_version
         FROM identity_users
        WHERE normalized_email = $1
        FOR UPDATE`,
      [identity.normalizedEmail],
    )
    user = emailResult.rows[0]
    if (!user) throw new SessionCreationError('IDENTITY_NOT_INVITED')
    if (user.status === 'disabled') throw new SessionCreationError('USER_DISABLED')

    const existingProviderForUser = await client.query<{ provider_subject: string }>(
      `SELECT provider_subject
         FROM identity_provider_identities
        WHERE provider = 'cognito'
          AND user_id = $1
        FOR UPDATE`,
      [user.id],
    )
    if (
      existingProviderForUser.rows[0] &&
      existingProviderForUser.rows[0].provider_subject !== identity.subject
    ) {
      throw new SessionCreationError('PROVIDER_ALREADY_LINKED')
    }

    await client.query(
      `INSERT INTO identity_provider_identities (
         id, user_id, provider, provider_subject, created_at, updated_at
       ) VALUES ($1, $2, 'cognito', $3, $4, $4)
       ON CONFLICT (provider, provider_subject) DO NOTHING`,
      [randomUUID(), user.id, identity.subject, new Date(nowMs)],
    )
    const linkedProvider = await client.query<{ user_id: string }>(
      `SELECT user_id
         FROM identity_provider_identities
        WHERE provider = 'cognito'
          AND provider_subject = $1
        FOR UPDATE`,
      [identity.subject],
    )
    if (linkedProvider.rows[0]?.user_id !== user.id) {
      throw new SessionCreationError('PROVIDER_ALREADY_LINKED')
    }
  } else if (user.normalized_email !== identity.normalizedEmail) {
    const collision = await client.query<{ id: string }>(
      `SELECT id
         FROM identity_users
        WHERE normalized_email = $1
          AND id <> $2
        FOR UPDATE`,
      [identity.normalizedEmail, user.id],
    )
    if (collision.rows[0]) throw new SessionCreationError('PROVIDER_ALREADY_LINKED')
    await client.query(
      `UPDATE identity_users
          SET normalized_email = $2,
              record_version = record_version + 1,
              updated_at = $3
        WHERE id = $1`,
      [user.id, identity.normalizedEmail, new Date(nowMs)],
    )
    user = { ...user, normalized_email: identity.normalizedEmail }
  }

  if (user.status === 'invited') {
    await client.query(
      `UPDATE identity_users
          SET status = 'active',
              record_version = record_version + 1,
              updated_at = $2
        WHERE id = $1
          AND status = 'invited'`,
      [user.id, new Date(nowMs)],
    )
    user = { ...user, status: 'active' }
  }
  return user
}

async function findActiveMembershipRole(
  client: DatabaseClient,
  userId: string,
): Promise<MembershipRoleRow | undefined> {
  const result = await client.query<MembershipRoleRow>(
    `SELECT
       membership.organization_id,
       membership.id AS membership_id,
       role_binding.id AS role_binding_id,
       role_binding.role
     FROM access_organization_memberships AS membership
     JOIN access_organizations AS organization
       ON organization.id = membership.organization_id
     JOIN access_role_bindings AS role_binding
       ON role_binding.membership_id = membership.id
      AND role_binding.organization_id = membership.organization_id
      AND role_binding.user_id = membership.user_id
    WHERE membership.user_id = $1
      AND membership.status = 'active'
      AND organization.status = 'active'
      AND role_binding.status = 'active'
      AND role_binding.role IN ('founder', 'admin', 'advisor')
    ORDER BY CASE role_binding.role
      WHEN 'founder' THEN 1
      WHEN 'admin' THEN 2
      WHEN 'advisor' THEN 3
      ELSE 4
    END
    LIMIT 1
    FOR SHARE OF membership, organization, role_binding`,
    [userId],
  )
  return result.rows[0]
}

async function expireOrRevokeSession(
  client: DatabaseClient,
  sessionId: string,
  code: string,
): Promise<void> {
  const status = code === 'SESSION_ABSOLUTE_EXPIRED' || code === 'SESSION_IDLE_EXPIRED' ? 'expired' : 'revoked'
  await client.query(
    `UPDATE identity_sessions
        SET status = $2,
            revoked_at = CASE WHEN $2 = 'revoked' THEN transaction_timestamp() ELSE NULL END,
            revoke_reason = CASE WHEN $2 = 'revoked' THEN $3 ELSE NULL END,
            record_version = record_version + 1,
            updated_at = transaction_timestamp()
      WHERE id = $1
        AND status = 'active'`,
    [sessionId, status, code.toLowerCase()],
  )
}

function toSafeInteger(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Database version is invalid')
  return parsed
}

function toMillis(value: Date | string): number {
  const millis = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(millis)) throw new Error('Database timestamp is invalid')
  return millis
}
