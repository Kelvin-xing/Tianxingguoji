import { NextResponse } from 'next/server'
import { getKnowledgeBase, saveKnowledgeBase } from '@/lib/knowledge/db'
import { isResponse, requireLegacyActor } from '@/lib/auth/legacy-route'

export async function GET(request: Request) {
  const actor = await requireLegacyActor(request, ['founder', 'admin', 'data_reviewer'])
  if (isResponse(actor)) return actor
  try {
    const kb = await getKnowledgeBase()
    return NextResponse.json(kb ?? { data: {}, schoolNames: {}, updatedAt: null })
  } catch {
    return NextResponse.json({ error: 'Knowledge service unavailable' }, { status: 503 })
  }
}

export async function POST(req: Request) {
  const actor = await requireLegacyActor(req, ['founder', 'admin'])
  if (isResponse(actor)) return actor
  try {
    const body = await req.json()
    const updatedAt = await saveKnowledgeBase({ data: body.data, schoolNames: body.schoolNames })
    return NextResponse.json({ ok: true, updatedAt })
  } catch {
    return NextResponse.json({ error: 'Knowledge service unavailable' }, { status: 503 })
  }
}
