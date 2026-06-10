import { NextResponse } from 'next/server'
import { getCrawlerConfig, saveCrawlerConfig } from '@/lib/crawler/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getCrawlerConfig())
}

export async function PUT(request: Request) {
  return NextResponse.json(await saveCrawlerConfig(await request.json()))
}
