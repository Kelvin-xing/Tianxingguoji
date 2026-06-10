import { NextResponse } from 'next/server'
import { listReviewDecisions, upsertReviewDecision } from '@/lib/crawler/db'
import { hasSchoolKey } from '@/lib/crawler/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await listReviewDecisions())
}

export async function POST(request: Request) {
  const body = await request.json()
  if (!body.school_key || !(await hasSchoolKey(body.school_key))) {
    return NextResponse.json({ error: 'Unknown school_key' }, { status: 400 })
  }
  if (body.status !== 'approved' && body.status !== 'needs_changes') {
    return NextResponse.json({ error: 'status must be approved or needs_changes' }, { status: 400 })
  }
  return NextResponse.json(await upsertReviewDecision(body))
}
