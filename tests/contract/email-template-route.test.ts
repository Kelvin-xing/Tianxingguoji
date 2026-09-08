import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { EMAIL_TEMPLATE_BODY_MAX_BYTES, EmailTemplateRequestError, readSaveEmailTemplateRequest } from '../../app/api/v1/email/templates/internal-user-invitation/route-contract.ts'

test('email template command accepts only the current plain-text fields', async () => {
  const url = 'https://app.example.test.invalid/api/v1/email/templates/internal-user-invitation'
  const request = new Request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'template-1' },
    body: JSON.stringify({ subject: '歡迎加入', body_text: '請設定帳戶。', expected_record_version: null }),
  })
  assert.deepEqual(await readSaveEmailTemplateRequest(request), { subject: '歡迎加入', bodyText: '請設定帳戶。', expectedRecordVersion: null, idempotencyKey: 'template-1' })
  await assert.rejects(readSaveEmailTemplateRequest(new Request(url, { method: 'PUT', headers: { 'content-type': 'application/json', 'idempotency-key': 'template-2' }, body: JSON.stringify({ subject: '歡迎加入', body_text: '請設定帳戶。', expected_record_version: null, html: '<script />' }) })), EmailTemplateRequestError)
  await assert.rejects(readSaveEmailTemplateRequest(new Request(url, { method: 'PUT', headers: { 'content-type': 'text/plain', 'idempotency-key': 'template-3' }, body: '{}' })), EmailTemplateRequestError)
  await assert.rejects(readSaveEmailTemplateRequest(new Request(url, { method: 'PUT', headers: { 'content-type': 'application/json', 'idempotency-key': 'template-4' }, body: 'x'.repeat(EMAIL_TEMPLATE_BODY_MAX_BYTES + 1) })), EmailTemplateRequestError)
})

test('template route is Admin-authorized and exposes no raw HTML field', async () => {
  const source = await readFile(new URL('../../app/api/v1/email/templates/internal-user-invitation/route.ts', import.meta.url), 'utf8')
  assert.match(source, /requireApiRequestAccessContext/)
  assert.match(source, /getEmailTemplateRuntime/)
  assert.doesNotMatch(source, /html_template|raw_html/)
})
