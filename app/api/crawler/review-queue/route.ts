import { NextResponse } from 'next/server'
import { getReviewQueue } from '@/modules/schools/crawler-server'
import { isResponse, requireLegacyActor } from '@/modules/identity/web'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const actor = await requireLegacyActor(request, ['founder', 'admin', 'advisor', 'data_reviewer'])
  if (isResponse(actor)) return actor
  return NextResponse.json(await getReviewQueue())
}
