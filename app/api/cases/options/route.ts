import { handleApiRequest, createApiError, type JsonValue } from '@/modules/shared/public'
import { requireActor, requireRole } from '@/modules/identity/web'
import { listCaseOptions } from '@/modules/cases/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    const actor = requireRole(await requireActor(), ['founder', 'admin', 'advisor'])
    try {
      return { options: await listCaseOptions(actor) } satisfies JsonValue
    } catch {
      throw createApiError('SERVICE_UNAVAILABLE')
    }
  })
}
