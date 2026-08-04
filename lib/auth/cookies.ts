const SECURE_COOKIE_PREFIX = process.env.NODE_ENV === 'production' ? '__Host-' : ''

export const SESSION_COOKIE_NAME = `${SECURE_COOKIE_PREFIX}tx_session`
export const COGNITO_STATE_COOKIE_NAME = `${SECURE_COOKIE_PREFIX}tx_cognito_state`
export const COGNITO_VERIFIER_COOKIE_NAME = `${SECURE_COOKIE_PREFIX}tx_cognito_verifier`

export const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60
export const COGNITO_COOKIE_MAX_AGE_SECONDS = 10 * 60

export const authCookieOptions = Object.freeze({
  httpOnly: true,
  secure: process.env.NODE_ENV !== 'development',
  sameSite: 'lax' as const,
  path: '/',
})

export const sessionCookieOptions = Object.freeze({
  ...authCookieOptions,
  maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
})

export const cognitoFlowCookieOptions = Object.freeze({
  ...authCookieOptions,
  maxAge: COGNITO_COOKIE_MAX_AGE_SECONDS,
})

export function clearAuthCookie(response: Response, name: string): void {
  response.headers.append(
    'set-cookie',
    `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${authCookieOptions.secure ? '; Secure' : ''}`,
  )
}
