import { NextResponse } from 'next/server'
import { createTicket, listTickets, updateTicket } from '@/lib/crawler/db'
import { hasSchoolKey } from '@/lib/crawler/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await listTickets())
}

export async function POST(request: Request) {
  const body = await request.json()
  if (!body.school_key || !(await hasSchoolKey(body.school_key))) {
    return NextResponse.json({ error: 'Unknown school_key' }, { status: 400 })
  }
  if (!String(body.description || '').trim()) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 })
  }
  return NextResponse.json(await createTicket(body), { status: 201 })
}

export async function PATCH(request: Request) {
  const body = await request.json()
  if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const ticket = await updateTicket(body)
  if (!ticket) return NextResponse.json({ error: 'ticket not found' }, { status: 404 })
  return NextResponse.json(ticket)
}
