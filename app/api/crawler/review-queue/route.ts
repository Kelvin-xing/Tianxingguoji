import { NextResponse } from 'next/server'
import { getReviewQueue } from '@/lib/crawler/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getReviewQueue())
}
