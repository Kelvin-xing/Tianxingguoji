import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { AuthConfigurationError, getAuthConfig } from '@/lib/auth/config'
import { exchangeAuthorizationCode, CognitoVerificationError, verifyCognitoIdentity } from '@/lib/auth/cognito'
import {
  COGNITO_STATE_COOKIE_NAME,
  COGNITO_VERIFIER_COOKIE_NAME,
  clearAuthCookie,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from '@/lib/auth/cookies'
import { equalsSecret } from '@/lib/auth/pkce'
import { createSessionForIdentity, SessionCreationError } from '@/lib/auth/session-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url)
  const cookieStore = await cookies()
  const storedState = cookieStore.get(COGNITO_STATE_COOKIE_NAME)?.value
  const codeVerifier = cookieStore.get(COGNITO_VERIFIER_COOKIE_NAME)?.value
  const returnedState = requestUrl.searchParams.get('state') ?? undefined
  const code = requestUrl.searchParams.get('code')

  if (!code || !equalsSecret(storedState, returnedState) || !codeVerifier) {
    return authFailure(request, 'invalid_callback')
  }

  try {
    const config = getAuthConfig()
    const tokens = await exchangeAuthorizationCode(config, code, codeVerifier)
    const identity = await verifyCognitoIdentity(config, tokens)
    if (!identity.emailVerified) return authFailure(request, 'email_not_verified')

    const session = await createSessionForIdentity(identity, tokens)
    const response = NextResponse.redirect(new URL('/today', request.url))
    response.cookies.set(SESSION_COOKIE_NAME, session.secret, sessionCookieOptions)
    clearAuthCookie(response, COGNITO_STATE_COOKIE_NAME)
    clearAuthCookie(response, COGNITO_VERIFIER_COOKIE_NAME)
    return response
  } catch (error) {
    if (error instanceof SessionCreationError) {
      const errorCode = error.code === 'IDENTITY_NOT_INVITED'
        ? 'not_invited'
        : error.code === 'USER_DISABLED'
          ? 'access_disabled'
          : error.code === 'SESSION_LIMIT_REACHED'
            ? 'session_limit'
            : 'access_denied'
      return authFailure(request, errorCode)
    }
    if (error instanceof AuthConfigurationError) return authFailure(request, 'configuration')
    if (error instanceof CognitoVerificationError) return authFailure(request, 'authentication_failed')
    console.error('Authentication callback failed')
    return authFailure(request, 'authentication_failed')
  }
}

function authFailure(request: Request, code: string): Response {
  const response = NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(code)}`, request.url))
  clearAuthCookie(response, COGNITO_STATE_COOKIE_NAME)
  clearAuthCookie(response, COGNITO_VERIFIER_COOKIE_NAME)
  return response
}

