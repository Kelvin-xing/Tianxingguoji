import { NextResponse } from 'next/server'
import { getKnowledgeBase, saveKnowledgeBase } from '@/lib/knowledge/db'

export async function GET() {
  try {
    const kb = await getKnowledgeBase()
    return NextResponse.json(kb ?? { data: {}, schoolNames: {}, updatedAt: null })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const updatedAt = await saveKnowledgeBase({ data: body.data, schoolNames: body.schoolNames })
    return NextResponse.json({ ok: true, updatedAt })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
