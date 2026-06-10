import { NextResponse } from 'next/server'
import { getSchools } from '@/lib/crawler/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getSchools())
}
