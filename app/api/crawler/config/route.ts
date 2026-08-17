import { NextResponse } from 'next/server'
import { getCrawlerConfig, saveCrawlerConfig } from '@/modules/schools/crawler-server'
import { isResponse, requireLegacyActor } from '@/modules/identity/web'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const actor = await requireLegacyActor(request, ['founder', 'admin'])
  if (isResponse(actor)) return actor
  return NextResponse.json(await getCrawlerConfig())
}

export async function PUT(request: Request) {
  const actor = await requireLegacyActor(request, ['founder', 'admin'])
  if (isResponse(actor)) return actor
  return NextResponse.json(await saveCrawlerConfig(await request.json()))
}
