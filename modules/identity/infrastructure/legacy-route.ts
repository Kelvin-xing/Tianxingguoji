import { createApiError, errorResponse, type ApiContractError } from '../../shared/public.ts'
import type { OrganizationRole } from '../../access/public.ts'
import { requireActor, requireRole } from './web-actor.ts'
import type { SessionActor } from './postgresql-session-service.ts'

export async function requireLegacyActor(
  request: Request,
  roles: readonly OrganizationRole[],
): Promise<SessionActor | Response> {
  try {
    return requireRole(await requireActor(), roles)
  } catch (error) {
    const contractError = error instanceof Error && error.name === 'ApiContractError'
      ? error as ApiContractError
      : createApiError('SERVICE_UNAVAILABLE')
    return errorResponse({
      requestId: crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
    }, contractError)
  }
}

export function isResponse(value: SessionActor | Response): value is Response {
  return value instanceof Response
}
