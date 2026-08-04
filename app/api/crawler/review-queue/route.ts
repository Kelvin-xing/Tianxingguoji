import { NextResponse } from 'next/server'
import { getReviewQueue } from '@/lib/crawler/server'
import { isResponse, requireLegacyActor } from '@/lib/auth/legacy-route'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const actor = await requireLegacyActor(request, ['founder', 'admin', 'advisor', 'data_reviewer'])
  if (isResponse(actor)) return actor
  return NextResponse.json(await getReviewQueue())
}
