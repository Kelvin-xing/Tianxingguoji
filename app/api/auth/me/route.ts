import { handleApiRequest, type JsonValue } from '@/modules/shared/api-contract'
import { requireActor } from '@/lib/auth/actor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    const actor = await requireActor()
    return {
      user_id: actor.userId,
      email: actor.normalizedEmail,
      organization_id: actor.organizationId,
      membership_id: actor.membershipId,
      role: actor.role,
    } satisfies JsonValue
  })
}

