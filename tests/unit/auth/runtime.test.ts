import assert from 'node:assert/strict'
import { createHash, createSign, generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { getAuthConfig, getCognitoAuthConfig, AuthConfigurationError } from '../../../modules/identity/infrastructure/auth-config.ts'
import { buildCognitoLogoutUrl, verifyCognitoIdentity } from '../../../modules/identity/infrastructure/cognito-client.ts'
import { createPkcePair, equalsSecret } from '../../../modules/identity/infrastructure/pkce.ts'
import { decryptProviderTokens, encryptProviderTokens } from '../../../modules/identity/infrastructure/session-crypto.ts'

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    COGNITO_REGION: 'ap-east-1',
    COGNITO_USER_POOL_ID: 'ap-east-1_example',
    COGNITO_APP_CLIENT_ID: 'exampleclientid',
    COGNITO_DOMAIN: 'example.auth.ap-east-1.amazoncognito.com',
    COGNITO_REDIRECT_URI: 'https://erp.example.com/api/auth/callback',
    COGNITO_LOGOUT_URI: 'https://erp.example.com/login',
    DATABASE_URL: 'postgresql://example.invalid/db',
    SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  }
}

test('auth config rejects missing server variables without exposing values', () => {
  assert.throws(
    () => getAuthConfig(environment({ DATABASE_URL: '' })),
    (error: unknown) => error instanceof AuthConfigurationError && error.variable === 'DATABASE_URL',
  )
  assert.throws(
    () => getAuthConfig(environment({ COGNITO_REDIRECT_URI: 'http://public.example.com/callback' })),
    (error: unknown) => error instanceof AuthConfigurationError && error.variable === 'COGNITO_REDIRECT_URI',
  )
  assert.throws(
    () => getAuthConfig(environment({ SESSION_ENCRYPTION_KEY: 'not-a-key' })),
    (error: unknown) => error instanceof AuthConfigurationError && error.variable === 'SESSION_ENCRYPTION_KEY',
  )
})

test('Cognito login bootstrap does not require session persistence variables', () => {
  const config = getCognitoAuthConfig(environment({
    DATABASE_URL: undefined,
    SESSION_ENCRYPTION_KEY: undefined,
  }))

  assert.equal(config.cognitoRegion, 'ap-east-1')
  assert.equal(config.cognitoUserPoolId, 'ap-east-1_example')
  assert.equal(config.cognitoAppClientId, 'exampleclientid')
  assert.equal(config.cognitoDomain, 'https://example.auth.ap-east-1.amazoncognito.com')
  assert.equal(
    buildCognitoLogoutUrl(config),
    'https://example.auth.ap-east-1.amazoncognito.com/logout?client_id=exampleclientid&logout_uri=https%3A%2F%2Ferp.example.com%2Flogin',
  )
})

test('PKCE pair uses S256 and compares state as a secret', () => {
  const pair = createPkcePair()
  assert.equal(pair.codeChallenge, createHash('sha256').update(pair.codeVerifier).digest('base64url'))
  assert.equal(equalsSecret(pair.state, pair.state), true)
  assert.equal(equalsSecret(pair.state, `${pair.state}x`), false)
  assert.ok(pair.codeVerifier.length >= 43)
})

test('provider tokens round-trip through authenticated encryption', () => {
  const key = Buffer.alloc(32, 11).toString('base64')
  const tokens = {
    accessToken: 'access-token-value',
    idToken: 'id-token-value',
    refreshToken: 'refresh-token-value',
  }
  const encrypted = encryptProviderTokens(tokens, key)
  assert.equal(encrypted.includes(Buffer.from(tokens.accessToken)), false)
  assert.deepEqual(decryptProviderTokens(encrypted, key), tokens)
  assert.throws(() => decryptProviderTokens(encrypted, Buffer.alloc(32, 12).toString('base64')))
})

test('Cognito verification checks issuer, token use, audience/client id and signature', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const exportedJwk = publicKey.export({ format: 'jwk' })
  const jwk = { ...exportedJwk, kty: 'RSA', kid: 'test-key', alg: 'RS256', use: 'sig' }
  const config = {
    cognitoRegion: 'ap-east-1',
    cognitoUserPoolId: 'ap-east-1_example',
    cognitoAppClientId: 'exampleclientid',
  } as const
  const issuer = `https://cognito-idp.${config.cognitoRegion}.amazonaws.com/${config.cognitoUserPoolId}`
  const now = Math.floor(Date.now() / 1_000)
  const idToken = signJwt(privateKey, {
    iss: issuer,
    sub: 'provider-subject',
    aud: config.cognitoAppClientId,
    token_use: 'id',
    email: 'Founder@Example.com',
    email_verified: true,
    iat: now,
    exp: now + 300,
  })
  const accessToken = signJwt(privateKey, {
    iss: issuer,
    sub: 'provider-subject',
    client_id: config.cognitoAppClientId,
    token_use: 'access',
    iat: now,
    exp: now + 300,
  })
  const fetchImplementation: typeof fetch = async () =>
    new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })

  const identity = await verifyCognitoIdentity(config, {
    idToken,
    accessToken,
  }, Date.now(), fetchImplementation)
  assert.deepEqual(identity, {
    subject: 'provider-subject',
    normalizedEmail: 'founder@example.com',
    emailVerified: true,
  })

  await assert.rejects(
    verifyCognitoIdentity(config, {
      idToken: `${idToken.split('.')[0]}.e30.${idToken.split('.')[2]}`,
      accessToken,
    }, Date.now(), fetchImplementation),
  )

  const futureIdToken = signJwt(privateKey, {
    iss: issuer,
    sub: 'provider-subject',
    aud: config.cognitoAppClientId,
    token_use: 'id',
    email: 'founder@example.com',
    email_verified: true,
    iat: now + 120,
    exp: now + 300,
  })
  await assert.rejects(
    verifyCognitoIdentity(config, { idToken: futureIdToken, accessToken }, Date.now(), fetchImplementation),
  )
})

function signJwt(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
  const payload = encode(claims)
  const input = `${header}.${payload}`
  const signer = createSign('RSA-SHA256')
  signer.update(input)
  signer.end()
  return `${input}.${signer.sign(privateKey).toString('base64url')}`
}
