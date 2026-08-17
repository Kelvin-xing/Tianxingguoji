import { NextResponse } from 'next/server'
import { createTicket, hasSchoolKey, listTickets, updateTicket } from '@/modules/schools/crawler-server'
import { isResponse, requireLegacyActor } from '@/modules/identity/web'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const actor = await requireLegacyActor(request, ['founder', 'admin', 'advisor'])
  if (isResponse(actor)) return actor
  return NextResponse.json(await listTickets())
}

export async function POST(request: Request) {
  const actor = await requireLegacyActor(request, ['founder', 'admin', 'advisor'])
  if (isResponse(actor)) return actor
  const body = await request.json()
  if (!body.school_key || !(await hasSchoolKey(body.school_key))) {
    return NextResponse.json({ error: 'Unknown school_key' }, { status: 400 })
  }
  if (!String(body.description || '').trim()) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 })
  }
  return NextResponse.json(await createTicket({ ...body, reporter: actor.normalizedEmail }), { status: 201 })
}

export async function PATCH(request: Request) {
  const actor = await requireLegacyActor(request, ['founder', 'admin', 'advisor'])
  if (isResponse(actor)) return actor
  const body = await request.json()
  if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const ticket = await updateTicket(body)
  if (!ticket) return NextResponse.json({ error: 'ticket not found' }, { status: 404 })
  return NextResponse.json(ticket)
}
