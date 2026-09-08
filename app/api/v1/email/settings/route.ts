import { requireApiRequestAccessContext } from '@/app/api/v1/request-access'
import {
  EmailSettingsRequestError,
  readSaveEmailSettingsRequest,
} from '@/app/api/v1/email/settings/route-contract'
import {
  EmailSettingsRuntimeUnavailable,
  getEmailSettingsRuntime,
  isEmailSettingsError,
} from '@/modules/email/server'
import { createApiError, handleApiRequest } from '@/modules/shared/public'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext()
      const status = await getEmailSettingsRuntime().service.getStatus(actor)
      return {
        configured: status.configured,
        provider: status.provider,
        from_email: status.fromEmail,
        from_name: status.fromName,
        record_version: status.recordVersion,
        updated_at: status.updatedAt,
      }
    } catch (error) {
      throw mapEmailSettingsError(error)
    }
  })
}

export async function PUT(request: Request): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const command = await readSaveEmailSettingsRequest(request)
      const actor = await requireApiRequestAccessContext()
      const receipt = await getEmailSettingsRuntime().service.save({
        actor,
        command: { ...command, requestId: requestContext.requestId },
      })
      return {
        settings_id: receipt.settingsId,
        record_version: receipt.recordVersion,
        updated_at: receipt.updatedAt,
        replayed: receipt.replayed,
      }
    } catch (error) {
      throw mapEmailSettingsError(error)
    }
  })
}

function mapEmailSettingsError(error: unknown): Error {
  if (error instanceof EmailSettingsRequestError) return createApiError('INVALID_REQUEST')
  if (error instanceof EmailSettingsRuntimeUnavailable) return createApiError('SERVICE_UNAVAILABLE')
  if (isEmailSettingsError(error, 'FORBIDDEN')) return createApiError('FORBIDDEN')
  if (isEmailSettingsError(error, 'INVALID')) return createApiError('INVALID_REQUEST')
  if (isEmailSettingsError(error, 'STALE_VERSION')) return createApiError('STALE_VERSION')
  if (isEmailSettingsError(error, 'IDEMPOTENCY_CONFLICT')) return createApiError('CONFLICT')
  if (isEmailSettingsError(error, 'UNAVAILABLE')) return createApiError('SERVICE_UNAVAILABLE')
  return error instanceof Error ? error : new Error('Email settings failed.')
}
