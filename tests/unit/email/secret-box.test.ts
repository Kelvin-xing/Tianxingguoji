import assert from 'node:assert/strict'
import test from 'node:test'

import { AesGcmEmailSecretBox, loadEmailSecretBox } from '../../../modules/email/infrastructure/secret-box.ts'

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_ORGANIZATION_ID = '10000000-0000-4000-8000-000000000002'

test('encrypts a Resend key with organization-bound AES-256-GCM metadata', () => {
  const box = new AesGcmEmailSecretBox(Buffer.alloc(32, 7), 'v1')
  const encrypted = box.seal({ organizationId: ORGANIZATION_ID, plaintext: 're_synthetic_secret_value' })
  assert.notEqual(Buffer.from(encrypted.ciphertext).toString('utf8'), 're_synthetic_secret_value')
  assert.equal(encrypted.iv.byteLength, 12)
  assert.equal(encrypted.authTag.byteLength, 16)
  assert.equal(box.open({ organizationId: ORGANIZATION_ID, secret: encrypted }), 're_synthetic_secret_value')
  assert.throws(() => box.open({ organizationId: OTHER_ORGANIZATION_ID, secret: encrypted }), /unavailable/i)
})

test('rejects missing or incorrectly-sized environment master keys', () => {
  assert.throws(() => loadEmailSecretBox({}), /unavailable/i)
  assert.throws(() => loadEmailSecretBox({ EMAIL_SETTINGS_MASTER_KEY: Buffer.alloc(16).toString('base64url') }), /unavailable/i)
  assert.doesNotThrow(() => loadEmailSecretBox({ EMAIL_SETTINGS_MASTER_KEY: Buffer.alloc(32, 4).toString('base64url'), EMAIL_SETTINGS_MASTER_KEY_VERSION: 'v2' }))
})
