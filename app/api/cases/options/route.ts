import { handleApiRequest, createApiError, type JsonValue } from '@/modules/shared/api-contract'
import { requireActor, requireRole } from '@/lib/auth/actor'
import { listCaseOptions } from '@/lib/cases/service'

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

