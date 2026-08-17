import { createPublicKey, verify as verifySignature } from 'node:crypto'
import type { AuthConfig } from './config.ts'

export interface CognitoTokenSet {
  accessToken: string
  idToken: string
  refreshToken?: string
}

export interface CognitoIdentity {
  subject: string
  normalizedEmail: string
  emailVerified: boolean
}

interface JwtHeader {
  alg?: unknown
  kid?: unknown
  typ?: unknown
}

interface JwtClaims {
  sub?: unknown
  iss?: unknown
  exp?: unknown
  iat?: unknown
  token_use?: unknown
  aud?: unknown
  client_id?: unknown
  email?: unknown
  email_verified?: unknown
}

interface VerifiedJwtClaims extends JwtClaims {
  sub: string
  iss: string
  exp: number
  token_use: 'id' | 'access'
}

interface CognitoJwk {
  [key: string]: unknown
  kty: 'RSA'
  n: string
  e: string
  kid: string
  alg?: string
  use?: string
}

interface JwksResponse {
  keys?: CognitoJwk[]
}

interface CachedJwks {
  expiresAt: number
  keys: readonly CognitoJwk[]
}

export class CognitoVerificationError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super('Cognito token verification failed')
    this.name = 'CognitoVerificationError'
    this.reason = reason
  }
}

const JWKS_CACHE_TTL_MS = 5 * 60 * 1_000
const jwksCache = new Map<string, CachedJwks>()

export function buildCognitoAuthorizeUrl(
  config: Pick<AuthConfig, 'cognitoDomain' | 'cognitoAppClientId' | 'cognitoRedirectUri'>,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL('/oauth2/authorize', config.cognitoDomain)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.cognitoAppClientId,
    redirect_uri: config.cognitoRedirectUri,
    scope: 'openid email profile',
    state,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  }).toString()
  return url.toString()
}

export function buildCognitoLogoutUrl(
  config: Pick<AuthConfig, 'cognitoDomain' | 'cognitoAppClientId' | 'cognitoLogoutUri'>,
): string {
  const url = new URL('/logout', config.cognitoDomain)
  url.search = new URLSearchParams({
    client_id: config.cognitoAppClientId,
    logout_uri: config.cognitoLogoutUri,
  }).toString()
  return url.toString()
}

export async function exchangeAuthorizationCode(
  config: Pick<AuthConfig, 'cognitoDomain' | 'cognitoAppClientId' | 'cognitoRedirectUri'>,
  code: string,
  codeVerifier: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<CognitoTokenSet> {
  const response = await fetchImplementation(new URL('/oauth2/token', config.cognitoDomain), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.cognitoAppClientId,
      code,
      redirect_uri: config.cognitoRedirectUri,
      code_verifier: codeVerifier,
    }),
  })

  if (!response.ok) {
    throw new CognitoVerificationError('token_exchange_failed')
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new CognitoVerificationError('token_response_invalid')
  }

  if (!isRecord(body) || typeof body.access_token !== 'string' || typeof body.id_token !== 'string') {
    throw new CognitoVerificationError('token_response_missing_tokens')
  }

  return {
    accessToken: body.access_token,
    idToken: body.id_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
  }
}

export async function verifyCognitoIdentity(
  config: Pick<AuthConfig, 'cognitoRegion' | 'cognitoUserPoolId' | 'cognitoAppClientId'>,
  tokens: CognitoTokenSet,
  nowMs = Date.now(),
  fetchImplementation: typeof fetch = fetch,
): Promise<CognitoIdentity> {
  const issuer = `https://cognito-idp.${config.cognitoRegion}.amazonaws.com/${config.cognitoUserPoolId}`
  const idClaims = await verifyJwt(
    tokens.idToken,
    { issuer, clientId: config.cognitoAppClientId, tokenUse: 'id' },
    nowMs,
    fetchImplementation,
  )
  const accessClaims = await verifyJwt(
    tokens.accessToken,
    { issuer, clientId: config.cognitoAppClientId, tokenUse: 'access' },
    nowMs,
    fetchImplementation,
  )

  const subject = idClaims.sub
  if (typeof subject !== 'string' || subject !== accessClaims.sub || typeof idClaims.email !== 'string') {
    throw new CognitoVerificationError('identity_claims_mismatch')
  }

  const normalizedEmail = idClaims.email.trim().toLowerCase()
  if (!normalizedEmail || normalizedEmail.length > 320) {
    throw new CognitoVerificationError('identity_email_invalid')
  }

  return {
    subject,
    normalizedEmail,
    emailVerified: idClaims.email_verified === true,
  }
}

async function verifyJwt(
  token: string,
  expected: { issuer: string; clientId: string; tokenUse: 'id' | 'access' },
  nowMs: number,
  fetchImplementation: typeof fetch,
): Promise<VerifiedJwtClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new CognitoVerificationError('jwt_shape_invalid')

  const header = decodeJson<JwtHeader>(parts[0])
  const claims = decodeJson<JwtClaims>(parts[1])
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || claims.token_use !== expected.tokenUse) {
    throw new CognitoVerificationError('jwt_header_or_use_invalid')
  }
  if (!isVerifiedJwtClaims(claims, expected, nowMs)) {
    throw new CognitoVerificationError('jwt_claims_invalid')
  }

  const jwksUrl = `${expected.issuer}/.well-known/jwks.json`
  let jwks = await getJwks(jwksUrl, fetchImplementation)
  let key = jwks.keys.find((candidate) => candidate.kid === header.kid)
  if (!key) {
    jwks = await getJwks(jwksUrl, fetchImplementation, true)
    key = jwks.keys.find((candidate) => candidate.kid === header.kid)
  }
  if (!key) throw new CognitoVerificationError('jwt_key_not_found')

  const signedPayload = Buffer.from(`${parts[0]}.${parts[1]}`)
  const signature = Buffer.from(parts[2], 'base64url')
  let validSignature = false
  try {
    validSignature = verifySignature(
      'RSA-SHA256',
      signedPayload,
      createPublicKey({ key, format: 'jwk' }),
      signature,
    )
  } catch {
    throw new CognitoVerificationError('jwt_signature_invalid')
  }
  if (!validSignature) throw new CognitoVerificationError('jwt_signature_invalid')

  return claims
}

function isVerifiedJwtClaims(
  claims: JwtClaims,
  expected: { issuer: string; clientId: string; tokenUse: 'id' | 'access' },
  nowMs: number,
): claims is VerifiedJwtClaims {
  const nowSeconds = Math.floor(nowMs / 1_000)
  return (
    claims.token_use === expected.tokenUse &&
    claims.iss === expected.issuer &&
    !(claims.aud !== undefined && expected.tokenUse === 'access') &&
    !(expected.tokenUse === 'id' && claims.aud !== expected.clientId) &&
    !(expected.tokenUse === 'access' && claims.client_id !== expected.clientId) &&
    typeof claims.sub === 'string' &&
    typeof claims.exp === 'number' &&
    Number.isSafeInteger(claims.exp) &&
    claims.exp > nowSeconds &&
    (claims.iat === undefined || (
      typeof claims.iat === 'number' &&
      Number.isSafeInteger(claims.iat) &&
      claims.iat <= nowSeconds + 60
    ))
  )
}

async function getJwks(
  url: string,
  fetchImplementation: typeof fetch,
  forceRefresh = false,
): Promise<{ keys: readonly CognitoJwk[] }> {
  const cached = jwksCache.get(url)
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached

  const response = await fetchImplementation(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new CognitoVerificationError('jwks_fetch_failed')

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new CognitoVerificationError('jwks_response_invalid')
  }
  if (!isRecord(body) || !Array.isArray(body.keys)) {
    throw new CognitoVerificationError('jwks_response_invalid')
  }
  const keys = body.keys.filter(isCognitoJwk)
  if (keys.length === 0) throw new CognitoVerificationError('jwks_empty')

  const result = Object.freeze({
    expiresAt: Date.now() + JWKS_CACHE_TTL_MS,
    keys: Object.freeze(keys),
  })
  jwksCache.set(url, result)
  return result
}

function decodeJson<T>(segment: string): T {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T
  } catch {
    throw new CognitoVerificationError('jwt_encoding_invalid')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCognitoJwk(value: unknown): value is CognitoJwk {
  return (
    isRecord(value) &&
    value.kty === 'RSA' &&
    typeof value.n === 'string' &&
    typeof value.e === 'string' &&
    typeof value.kid === 'string'
  )
}
