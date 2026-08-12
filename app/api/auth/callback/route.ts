import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const target = new URL('/api/v1/auth/callback', request.url)
  target.search = new URL(request.url).search
  return NextResponse.redirect(target, 307)
}
