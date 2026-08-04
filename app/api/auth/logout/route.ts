import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { clearAuthCookie, SESSION_COOKIE_NAME } from '@/lib/auth/cookies'
import { revokeSessionBySecret } from '@/lib/auth/session-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const cookieStore = await cookies()
  const secret = cookieStore.get(SESSION_COOKIE_NAME)?.value
  let logoutError = false

  if (secret) {
    try {
      await revokeSessionBySecret(secret)
    } catch {
      logoutError = true
    }
  }

  const destination = logoutError ? '/login?error=logout_pending' : '/login'
  const response = NextResponse.redirect(new URL(destination, request.url))
  clearAuthCookie(response, SESSION_COOKIE_NAME)
  return response
}

