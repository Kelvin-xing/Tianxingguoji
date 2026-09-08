import { cookies } from 'next/headers'

import { resolveRequestAccessContext, RequestAccessContextError } from '@/modules/access/server'
import { getIdentityRuntime, InternalEmailServiceError, SESSION_COOKIE_NAME } from '@/modules/identity/server'
import { createApiError, handleApiRequest } from '@/modules/shared/public'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export async function POST(request: Request, context: { readonly params: Promise<{ readonly inviteId: string }> }): Promise<Response> {
  return handleApiRequest(request, async () => {
    const { inviteId } = await context.params
    const idempotencyKey = request.headers.get('idempotency-key')?.trim()
    if (!UUID.test(inviteId) || !idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw createApiError('INVALID_REQUEST')
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value
    if (!cookieSecret) throw createApiError('UNAUTHENTICATED')
    try {
      const access = await resolveRequestAccessContext({ cookieSecret, sensitiveAction: true })
      const runtime = getIdentityRuntime()
      if (runtime.authMode !== 'internal-email' || !runtime.internalEmail) throw createApiError('SERVICE_UNAVAILABLE')
      const invite = await runtime.internalEmail.resendFounderInvite({ actor: { userId: access.userId, organizationId: access.organizationId, roles: access.roles }, inviteId })
      return { invite_id: invite.inviteId, target_user_id: invite.targetUserId, expires_at_ms: invite.expiresAtMs, delivery_receipt: { channel_policy_id: invite.deliveryReceipt.channelPolicyId, receipt_reference: invite.deliveryReceipt.receiptReference, delivered_at_ms: invite.deliveryReceipt.deliveredAtMs } }
    } catch (error) {
      if (error instanceof RequestAccessContextError) {
        if (error.code === 'REQUEST_ACCESS_UNAUTHENTICATED') throw createApiError('UNAUTHENTICATED')
        if (error.code === 'REQUEST_ACCESS_FORBIDDEN') throw createApiError('FORBIDDEN')
        throw createApiError('SERVICE_UNAVAILABLE')
      }
      if (error instanceof InternalEmailServiceError) {
        if (error.code === 'FOUNDER_REQUIRED') throw createApiError('FORBIDDEN')
        if (error.code === 'INVITE_NOT_FOUND') throw createApiError('NOT_FOUND')
        if (error.code === 'INVITE_NOT_REDEEMABLE' || error.code === 'INVITE_EXPIRED') throw createApiError('CONFLICT')
        if (error.code === 'INVITE_DELIVERY_FAILED') throw createApiError('SERVICE_UNAVAILABLE')
        throw createApiError('VALIDATION_FAILED')
      }
      throw error
    }
  })
}
