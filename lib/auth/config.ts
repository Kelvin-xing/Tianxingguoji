export class AuthConfigurationError extends Error {
  readonly variable: string

  constructor(variable: string) {
    super(`Missing or invalid server configuration: ${variable}`)
    this.name = 'AuthConfigurationError'
    this.variable = variable
  }
}

export interface AuthConfig {
  cognitoRegion: string
  cognitoUserPoolId: string
  cognitoAppClientId: string
  cognitoDomain: string
  cognitoRedirectUri: string
  cognitoLogoutUri: string
  databaseUrl: string
  sessionEncryptionKey: string
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>

export function getAuthConfig(environment: RuntimeEnvironment = process.env): AuthConfig {
  const cognitoRegion = required(environment, 'COGNITO_REGION')
  const cognitoUserPoolId = required(environment, 'COGNITO_USER_POOL_ID')
  const cognitoAppClientId = required(environment, 'COGNITO_APP_CLIENT_ID')
  const cognitoDomain = normalizeCognitoDomain(required(environment, 'COGNITO_DOMAIN'))
  const allowLocalHttp = environment.NODE_ENV !== 'production'
  const cognitoRedirectUri = validatedUrl(environment, 'COGNITO_REDIRECT_URI', allowLocalHttp)
  const cognitoLogoutUri = validatedUrl(environment, 'COGNITO_LOGOUT_URI', allowLocalHttp)
  const databaseUrl = getDatabaseUrl(environment)
  const sessionEncryptionKey = required(environment, 'SESSION_ENCRYPTION_KEY')

  if (!/^[a-z]{2}-[a-z]+-\d$/.test(cognitoRegion)) {
    throw new AuthConfigurationError('COGNITO_REGION')
  }
  if (!/^[\w-]+_[A-Za-z0-9]+$/.test(cognitoUserPoolId)) {
    throw new AuthConfigurationError('COGNITO_USER_POOL_ID')
  }
  if (!/^[A-Za-z0-9]+$/.test(cognitoAppClientId)) {
    throw new AuthConfigurationError('COGNITO_APP_CLIENT_ID')
  }
  const decodedSessionKey = /^[0-9a-f]{64}$/i.test(sessionEncryptionKey)
    ? Buffer.from(sessionEncryptionKey, 'hex')
    : Buffer.from(sessionEncryptionKey, 'base64')
  if (decodedSessionKey.length !== 32) {
    throw new AuthConfigurationError('SESSION_ENCRYPTION_KEY')
  }

  return Object.freeze({
    cognitoRegion,
    cognitoUserPoolId,
    cognitoAppClientId,
    cognitoDomain,
    cognitoRedirectUri,
    cognitoLogoutUri,
    databaseUrl,
    sessionEncryptionKey,
  })
}

export function getDatabaseUrl(environment: RuntimeEnvironment = process.env): string {
  return required(environment, 'DATABASE_URL')
}

function required(environment: RuntimeEnvironment, variable: string): string {
  const value = environment[variable]?.trim()
  if (!value || /[\r\n]/.test(value)) {
    throw new AuthConfigurationError(variable)
  }
  return value
}

function normalizeCognitoDomain(value: string): string {
  const candidate = value.startsWith('http://') || value.startsWith('https://')
    ? value
    : `https://${value}`
  const parsed = parseUrl(candidate, 'COGNITO_DOMAIN')
  if (parsed.protocol !== 'https:' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new AuthConfigurationError('COGNITO_DOMAIN')
  }
  return parsed.toString().replace(/\/$/, '')
}

function validatedUrl(
  environment: RuntimeEnvironment,
  variable: 'COGNITO_REDIRECT_URI' | 'COGNITO_LOGOUT_URI',
  allowHttp: boolean,
): string {
  const value = required(environment, variable)
  const parsed = parseUrl(value, variable)
  if (
    (!allowHttp && parsed.protocol !== 'https:') ||
    (allowHttp && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new AuthConfigurationError(variable)
  }
  return parsed.toString()
}

function parseUrl(value: string, variable: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new AuthConfigurationError(variable)
  }
}
