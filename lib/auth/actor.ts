import { cookies } from 'next/headers'
import { createApiError, type ApiContractError } from '@/modules/shared/api-contract'
import type { OrganizationRole } from '@/modules/access/contract'
import { AuthConfigurationError } from './config'
import { SESSION_COOKIE_NAME } from './cookies'
import { findActorBySecret, type SessionActor, SessionAccessError } from './session-service'

export type { SessionActor }

export async function requireActor(): Promise<SessionActor> {
  const cookieStore = await cookies()
  const secret = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (!secret) throw createApiError('UNAUTHENTICATED')

  try {
    return await findActorBySecret(secret)
  } catch (error) {
    if (error instanceof SessionAccessError) {
      throw createApiError('UNAUTHENTICATED')
    }
    if (error instanceof AuthConfigurationError) {
      throw createApiError('SERVICE_UNAVAILABLE')
    }
    throw createApiError('SERVICE_UNAVAILABLE')
  }
}

export function requireRole(
  actor: SessionActor,
  allowedRoles: readonly OrganizationRole[],
): SessionActor {
  if (!allowedRoles.includes(actor.role)) {
    throw createApiError('FORBIDDEN')
  }
  return actor
}

export function isApiContractError(error: unknown): error is ApiContractError {
  return error instanceof Error && error.name === 'ApiContractError'
}

