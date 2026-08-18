import { cookies } from 'next/headers'
import { createApiError, type ApiContractError } from '../../shared/public.ts'
import type { OrganizationRole } from '../../access/public.ts'
import { SESSION_COOKIE_NAME } from './cookies.ts'
import { IdentityServiceError } from '../application/service.ts'
import { getIdentityRuntime, IdentityRuntimeUnavailable } from './runtime.ts'
import type { SessionActor } from './postgresql-session-service.ts'
import type { IdentitySessionActor } from '../domain/actor.ts'

export type { SessionActor }

export async function requireActor(): Promise<SessionActor> {
  const cookieStore = await cookies()
  const secret = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (!secret) throw createApiError('UNAUTHENTICATED')

  try {
    return await getIdentityRuntime().legacySessionReader.findByCookieSecret(secret)
  } catch (error) {
    if (error instanceof IdentityServiceError) {
      throw createApiError('UNAUTHENTICATED')
    }
    if (error instanceof IdentityRuntimeUnavailable) {
      throw createApiError('SERVICE_UNAVAILABLE')
    }
    throw createApiError('SERVICE_UNAVAILABLE')
  }
}

export async function requireIdentityActor(): Promise<IdentitySessionActor> {
  const cookieStore = await cookies()
  const secret = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (!secret) throw createApiError('UNAUTHENTICATED')

  try {
    return await getIdentityRuntime().service.requireSession({
      cookieSecret: secret,
      sensitiveAction: false,
    })
  } catch (error) {
    if (error instanceof IdentityServiceError) throw createApiError('UNAUTHENTICATED')
    if (error instanceof IdentityRuntimeUnavailable) throw createApiError('SERVICE_UNAVAILABLE')
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
