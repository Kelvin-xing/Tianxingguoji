import { NextResponse } from 'next/server'
import { getCrawlerSummary } from '@/lib/crawler/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getCrawlerSummary())
}
