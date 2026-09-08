import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { EmailSecretBox, EncryptedEmailSecret } from '../domain/contract.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export class EmailSecretBoxUnavailable extends Error {
  constructor() { super('Email settings encryption is unavailable.'); this.name = 'EmailSecretBoxUnavailable' }
}

export class AesGcmEmailSecretBox implements EmailSecretBox {
  private readonly key: Buffer
  private readonly keyVersion: string

  constructor(key: Uint8Array, keyVersion: string) {
    if (key.byteLength !== 32 || !KEY_VERSION.test(keyVersion)) throw new EmailSecretBoxUnavailable()
    this.key = Buffer.from(key)
    this.keyVersion = keyVersion
  }

  seal(input: Readonly<{ organizationId: string; plaintext: string }>): EncryptedEmailSecret {
    if (!UUID.test(input.organizationId) || !input.plaintext) throw new EmailSecretBoxUnavailable()
    const iv = randomBytes(12)
    const plaintext = Buffer.from(input.plaintext, 'utf8')
    try {
      const cipher = createCipheriv('aes-256-gcm', this.key, iv)
      cipher.setAAD(aad(input.organizationId, this.keyVersion))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return Object.freeze({ ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: this.keyVersion })
    } finally {
      plaintext.fill(0)
    }
  }

  open(input: Readonly<{ organizationId: string; secret: EncryptedEmailSecret }>): string {
    if (!UUID.test(input.organizationId) || input.secret.iv.byteLength !== 12 || input.secret.authTag.byteLength !== 16 || !KEY_VERSION.test(input.secret.keyVersion)) throw new EmailSecretBoxUnavailable()
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, input.secret.iv)
      decipher.setAAD(aad(input.organizationId, input.secret.keyVersion))
      decipher.setAuthTag(Buffer.from(input.secret.authTag))
      const plaintext = Buffer.concat([decipher.update(input.secret.ciphertext), decipher.final()])
      try { return plaintext.toString('utf8') } finally { plaintext.fill(0) }
    } catch {
      throw new EmailSecretBoxUnavailable()
    }
  }
}

export function loadEmailSecretBox(environment: Readonly<Record<string, string | undefined>> = process.env): EmailSecretBox {
  const encoded = environment.EMAIL_SETTINGS_MASTER_KEY?.trim()
  const version = environment.EMAIL_SETTINGS_MASTER_KEY_VERSION?.trim() || 'v1'
  if (!encoded) throw new EmailSecretBoxUnavailable()
  let key: Buffer
  try { key = Buffer.from(encoded, 'base64url') } catch { throw new EmailSecretBoxUnavailable() }
  try { return new AesGcmEmailSecretBox(key, version) } finally { key.fill(0) }
}

function aad(organizationId: string, keyVersion: string): Buffer {
  return Buffer.from(`tianxing-email-settings|${organizationId}|resend|${keyVersion}`, 'utf8')
}
