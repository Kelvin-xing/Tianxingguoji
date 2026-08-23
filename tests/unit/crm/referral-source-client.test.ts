import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError } from '../../../lib/api/client.ts'
import {
  ReferralSourceIdempotencyAttempt,
  classifyReferralSourceFailure,
  createReferralSource,
  getReferralSource,
  listReferralSources,
  referralSourceCreateFingerprint,
  referralSourceUpdateFingerprint,
  updateReferralSource,
} from '../../../modules/crm/client.ts'

const SOURCE_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_SOURCE_ID = '10000000-0000-4000-8000-000000000002'

test('ReferralSource list/detail decode exact five-key DTOs and canonical order', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  let request = 0
  const sources = [source(SOURCE_ID, 'Alpha Bank', 'bank', 'active', 1), source(OTHER_SOURCE_ID, 'Beta Partner', 'other_partner', 'inactive', 2)]
  globalThis.fetch = async (input, init) => {
    request += 1
    assert.equal(init?.method, 'GET')
    assert.equal(input, request === 1 ? '/api/v1/referral-sources' : request === 2 ? '/api/v1/referral-sources?status=active' : `/api/v1/referral-sources/${SOURCE_ID}`)
    return apiResponse(request === 1 ? sources : request === 2 ? [sources[0]] : sources[0])
  }
  assert.equal((await listReferralSources()).length, 2)
  assert.equal((await listReferralSources('active'))[0]?.status, 'active')
  assert.equal((await getReferralSource(SOURCE_ID)).id, SOURCE_ID)
})

test('ReferralSource list rejects extra fields, invalid enums, filter drift, order drift and over-limit data', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  const valid = source(SOURCE_ID, 'Alpha Bank', 'bank', 'active', 1)
  const invalidLists = [
    [{ ...valid, email: 'not-allowed@example.invalid' }],
    [{ ...valid, source_type: 'broker' }],
    [{ ...valid, status: 'archived' }],
    [source(OTHER_SOURCE_ID, 'Beta', 'bank', 'inactive', 1), valid],
    Array.from({ length: 101 }, (_, index) => source(syntheticUuid(index), `Source ${String(index).padStart(3, '0')}`, 'bank', 'active', 1)),
  ]
  for (const invalid of invalidLists) {
    globalThis.fetch = async () => apiResponse(invalid)
    await assert.rejects(listReferralSources(), malformedResponse)
  }
  globalThis.fetch = async () => apiResponse([{ ...valid, status: 'inactive' }])
  await assert.rejects(listReferralSources('active'), malformedResponse)
})

test('create and PATCH send exact bodies and decode only exact two-key acknowledgements', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  let request = 0
  globalThis.fetch = async (input, init) => {
    request += 1
    assert.equal(new Headers(init?.headers).get('idempotency-key'), `referral-source:test-${request}`)
    if (request === 1) {
      assert.equal(input, '/api/v1/referral-sources')
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init.body)), { display_name: 'Synthetic Bank', source_type: 'bank' })
      return apiResponse({ id: SOURCE_ID, record_version: 1 })
    }
    assert.equal(input, `/api/v1/referral-sources/${SOURCE_ID}`)
    assert.equal(init?.method, 'PATCH')
    assert.deepEqual(JSON.parse(String(init.body)), { expected_record_version: 1, display_name: 'Synthetic Bank Updated', status: 'inactive' })
    return apiResponse({ id: SOURCE_ID, record_version: 2 })
  }
  assert.deepEqual(await createReferralSource({ display_name: 'Synthetic Bank', source_type: 'bank' }, 'referral-source:test-1'), { id: SOURCE_ID, record_version: 1 })
  assert.deepEqual(await updateReferralSource(SOURCE_ID, { expected_record_version: 1, display_name: 'Synthetic Bank Updated', status: 'inactive' }, 'referral-source:test-2'), { id: SOURCE_ID, record_version: 2 })
})

test('write acknowledgement rejects mutable views, extra keys, wrong IDs and wrong versions', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  for (const invalid of [
    { id: SOURCE_ID, record_version: 1, display_name: 'must not be copied into receipt' },
    { id: SOURCE_ID, record_version: 2 },
    { id: 'invalid', record_version: 1 },
  ]) {
    globalThis.fetch = async () => apiResponse(invalid)
    await assert.rejects(createReferralSource({ display_name: 'Synthetic Bank', source_type: 'bank' }, 'referral-source:strict'), malformedResponse)
  }
  for (const invalid of [{ id: OTHER_SOURCE_ID, record_version: 2 }, { id: SOURCE_ID, record_version: 3 }]) {
    globalThis.fetch = async () => apiResponse(invalid)
    await assert.rejects(updateReferralSource(SOURCE_ID, { expected_record_version: 1, display_name: 'Updated', status: 'active' }, 'referral-source:strict'), malformedResponse)
  }
})

test('ReferralSource idempotency keys reuse uncertain retries and rotate for business changes or completion', () => {
  let sequence = 0
  const attempt = new ReferralSourceIdempotencyAttempt(() => `referral-source:${++sequence}`)
  const create = referralSourceCreateFingerprint({ display_name: 'Synthetic Bank', source_type: 'bank' })
  const first = attempt.keyFor(create)
  assert.equal(attempt.keyFor(create), first)
  assert.notEqual(attempt.keyFor(referralSourceCreateFingerprint({ display_name: 'Synthetic Bank 2', source_type: 'bank' })), first)
  const update = referralSourceUpdateFingerprint(SOURCE_ID, { expected_record_version: 1, display_name: 'Synthetic Bank 2', status: 'active' })
  const updateKey = attempt.keyFor(update)
  attempt.rotate()
  assert.notEqual(attempt.keyFor(update), updateKey)
  attempt.complete()
  assert.notEqual(attempt.keyFor(create), first)
})

test('ReferralSource failures stay distinct and unknown errors fail closed', () => {
  assert.equal(classifyReferralSourceFailure(apiError('UNAUTHENTICATED', 401)), 'unauthenticated')
  assert.equal(classifyReferralSourceFailure(apiError('FORBIDDEN', 403)), 'forbidden')
  assert.equal(classifyReferralSourceFailure(apiError('NOT_FOUND', 404)), 'not_found')
  assert.equal(classifyReferralSourceFailure(apiError('VALIDATION_FAILED', 422)), 'validation')
  assert.equal(classifyReferralSourceFailure(apiError('STALE_VERSION', 409)), 'stale')
  assert.equal(classifyReferralSourceFailure(apiError('CONFLICT', 409)), 'conflict')
  assert.equal(classifyReferralSourceFailure(new Error('private details')), 'unavailable')
})

function source(id: string, displayName: string, type: 'bank' | 'insurance' | 'other_partner', status: 'active' | 'inactive', version: number) {
  return { id, display_name: displayName, source_type: type, status, record_version: version }
}

function syntheticUuid(index: number): string {
  return `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function apiResponse(data: unknown): Response {
  return Response.json({ api_version: 'v1', request_id: 'referral-source-test', data }, { headers: { 'x-request-id': 'referral-source-test' } })
}

function malformedResponse(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === 'MALFORMED_RESPONSE'
}

function apiError(code: string, status: number): ApiClientError {
  return new ApiClientError({ code, status, retryable: false, requestId: 'referral-source-test' })
}
