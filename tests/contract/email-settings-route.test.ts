import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { EMAIL_SETTINGS_BODY_MAX_BYTES, EmailSettingsRequestError, readSaveEmailSettingsRequest } from '../../app/api/v1/email/settings/route-contract.ts'

test('email settings command requires idempotency and rejects unknown fields', async () => {
  const request = new Request('https://app.example.test.invalid/api/v1/email/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'settings-1' },
    body: JSON.stringify({ api_key: 're_synthetic_secret_value', from_email: 'accounts@example.test.invalid', from_name: '天星顧問', expected_record_version: null }),
  })
  assert.deepEqual(await readSaveEmailSettingsRequest(request), {
    apiKey: 're_synthetic_secret_value',
    fromEmail: 'accounts@example.test.invalid',
    fromName: '天星顧問',
    expectedRecordVersion: null,
    idempotencyKey: 'settings-1',
  })
  await assert.rejects(readSaveEmailSettingsRequest(new Request(request.url, { method: 'PUT', headers: { 'content-type': 'application/json', 'idempotency-key': 'settings-2' }, body: JSON.stringify({ api_key: 're_synthetic_secret_value', from_email: 'accounts@example.test.invalid', from_name: null, expected_record_version: null, raw_secret: true }) })), EmailSettingsRequestError)
  await assert.rejects(readSaveEmailSettingsRequest(new Request(request.url, { method: 'PUT', headers: { 'content-type': 'text/plain', 'idempotency-key': 'settings-3' }, body: '{}' })), EmailSettingsRequestError)
  await assert.rejects(readSaveEmailSettingsRequest(new Request(request.url, { method: 'PUT', headers: { 'content-type': 'application/json', 'idempotency-key': 'settings-4' }, body: 'x'.repeat(EMAIL_SETTINGS_BODY_MAX_BYTES + 1) })), EmailSettingsRequestError)
})

test('settings route never serializes an API key or encrypted secret in GET data', async () => {
  const source = await readFile(new URL('../../app/api/v1/email/settings/route.ts', import.meta.url), 'utf8')
  const getBlock = source.slice(source.indexOf('export async function GET'), source.indexOf('export async function PUT'))
  assert.doesNotMatch(getBlock, /api_key|ciphertext|auth_tag|key_version/)
  assert.match(getBlock, /configured/)
  assert.match(source, /requireApiRequestAccessContext/)
})
