import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return NextResponse.redirect(new URL('/api/v1/auth/login', request.url), 307)
}
