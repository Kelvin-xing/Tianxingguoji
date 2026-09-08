import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const MIGRATION = new URL('../../db/migrations/202609080010_056_email_provider_settings.sql', import.meta.url)

test('056 stores one encrypted Resend configuration per organization', async () => {
  const sql = await readFile(MIGRATION, 'utf8')
  assert.match(sql, /CREATE TABLE email_provider_settings/)
  assert.match(sql, /organization_id uuid PRIMARY KEY/)
  assert.match(sql, /api_key_ciphertext bytea NOT NULL/)
  assert.match(sql, /octet_length\(api_key_iv\) = 12/)
  assert.match(sql, /octet_length\(api_key_auth_tag\) = 16/)
  assert.doesNotMatch(sql, /api_key_plaintext|RESEND_API_KEY/)
})

test('056 enforces tenant isolation, immutable history and no delete privilege', async () => {
  const sql = await readFile(MIGRATION, 'utf8')
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/)
  assert.match(sql, /current_setting\('app\.organization_id', true\)/)
  assert.match(sql, /email_provider_settings_identity_immutable_check/)
  assert.match(sql, /email_provider_settings_no_delete/)
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE email_provider_settings TO tianxing_app/)
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE[^;]*email_provider_settings/i)
})
