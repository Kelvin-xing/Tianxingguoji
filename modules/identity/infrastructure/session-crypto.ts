import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { AuthConfigurationError } from './auth-config.ts'

export interface ProviderTokenBundle {
  accessToken: string
  idToken: string
  refreshToken?: string
}

export function createSessionSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function hashSessionSecret(secret: string): Buffer {
  const bytes = Buffer.from(secret, 'base64url')
  if (bytes.length !== 32) throw new Error('Session secret has invalid length')
  return createHash('sha256').update(bytes).digest()
}

export function encryptProviderTokens(bundle: ProviderTokenBundle, rawKey: string): Buffer {
  const key = decodeEncryptionKey(rawKey)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(bundle), 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext])
}

export function decryptProviderTokens(payload: Buffer, rawKey: string): ProviderTokenBundle {
  const key = decodeEncryptionKey(rawKey)
  if (payload.length <= 28) throw new Error('Encrypted provider token payload is invalid')
  const iv = payload.subarray(0, 12)
  const authTag = payload.subarray(12, 28)
  const ciphertext = payload.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  const parsed: unknown = JSON.parse(plaintext)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).accessToken !== 'string' ||
    typeof (parsed as Record<string, unknown>).idToken !== 'string'
  ) {
    throw new Error('Encrypted provider token payload is invalid')
  }
  return parsed as ProviderTokenBundle
}

function decodeEncryptionKey(rawKey: string): Buffer {
  const value = rawKey.trim()
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64')
  if (key.length !== 32) throw new AuthConfigurationError('SESSION_ENCRYPTION_KEY')
  return key
}
