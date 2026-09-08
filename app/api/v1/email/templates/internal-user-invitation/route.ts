import { requireApiRequestAccessContext } from '@/app/api/v1/request-access'
import {
  EmailTemplateRequestError,
  readSaveEmailTemplateRequest,
} from '@/app/api/v1/email/templates/internal-user-invitation/route-contract'
import {
  DEFAULT_INTERNAL_INVITATION_TEMPLATE,
  EmailTemplateRuntimeUnavailable,
  getEmailTemplateRuntime,
  isEmailTemplateError,
} from '@/modules/email/server'
import { createApiError, handleApiRequest } from '@/modules/shared/public'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext()
      const template = await getEmailTemplateRuntime().service.get(actor)
      return {
        template_kind: template.kind,
        template_name: '使用者註冊邀請',
        subject: template.subject,
        body_text: template.bodyText,
        customized: template.customized,
        record_version: template.recordVersion,
        updated_at: template.updatedAt,
        default_subject: DEFAULT_INTERNAL_INVITATION_TEMPLATE.subject,
        default_body_text: DEFAULT_INTERNAL_INVITATION_TEMPLATE.bodyText,
      }
    } catch (error) {
      throw mapEmailTemplateError(error)
    }
  })
}

export async function PUT(request: Request): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const command = await readSaveEmailTemplateRequest(request)
      const actor = await requireApiRequestAccessContext()
      const receipt = await getEmailTemplateRuntime().service.save({
        actor,
        command: { ...command, requestId: requestContext.requestId },
      })
      return {
        template_kind: receipt.templateKind,
        record_version: receipt.recordVersion,
        updated_at: receipt.updatedAt,
        replayed: receipt.replayed,
      }
    } catch (error) {
      throw mapEmailTemplateError(error)
    }
  })
}

function mapEmailTemplateError(error: unknown): Error {
  if (error instanceof EmailTemplateRequestError) return createApiError('INVALID_REQUEST')
  if (error instanceof EmailTemplateRuntimeUnavailable) return createApiError('SERVICE_UNAVAILABLE')
  if (isEmailTemplateError(error, 'FORBIDDEN')) return createApiError('FORBIDDEN')
  if (isEmailTemplateError(error, 'INVALID')) return createApiError('INVALID_REQUEST')
  if (isEmailTemplateError(error, 'STALE_VERSION')) return createApiError('STALE_VERSION')
  if (isEmailTemplateError(error, 'IDEMPOTENCY_CONFLICT')) return createApiError('CONFLICT')
  if (isEmailTemplateError(error, 'UNAVAILABLE')) return createApiError('SERVICE_UNAVAILABLE')
  return error instanceof Error ? error : new Error('Email template failed.')
}
