import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError } from '../../../lib/api/client.ts'
import {
  CaseReferralSourceIdempotencyAttempt,
  assignCaseReferralSource,
  caseReferralSourceFingerprint,
  classifyCaseReferralSourceFailure,
  getCaseReferralSourceAssignments,
} from '../../../modules/cases/client.ts'

const CASE_ID = '10000000-0000-4000-8000-000000000001'
const SOURCE_ID = '20000000-0000-4000-8000-000000000001'
const ASSIGNMENT_ID = '30000000-0000-4000-8000-000000000001'
const CLOSED_ID = '30000000-0000-4000-8000-000000000002'

test('assignment GET strictly decodes current and canonically ordered history', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (input, init) => {
    assert.equal(input, `/api/v1/cases/${CASE_ID}/referral-source-assignments`)
    assert.equal(init?.method, 'GET')
    return apiResponse({ current: assignment(ASSIGNMENT_ID, null, 2), history: [assignment(CLOSED_ID, '2026-08-22T02:00:00.000Z', 2)] })
  }
  const view = await getCaseReferralSourceAssignments(CASE_ID)
  assert.equal(view.current?.id, ASSIGNMENT_ID)
  assert.equal(view.history[0]?.ends_at, '2026-08-22T02:00:00.000Z')
  assert.equal(Object.isFrozen(view.history), true)
})

test('assignment GET rejects extra fields, state drift, current duplication, invalid order and over-limit history', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  const current = assignment(ASSIGNMENT_ID, null)
  const invalid = [
    { current: { ...current, case_id: CASE_ID }, history: [] },
    { current: assignment(ASSIGNMENT_ID, '2026-08-23T00:00:00.000Z'), history: [] },
    { current, history: [assignment(ASSIGNMENT_ID, '2026-08-22T00:00:00.000Z')] },
    { current, history: [assignment(CLOSED_ID, '2026-08-22T00:00:00.000Z', 2)] },
    { current: assignment(ASSIGNMENT_ID, null, 3), history: [assignment(CLOSED_ID, '2026-08-22T00:00:00.000Z', 3), assignment('30000000-0000-4000-8000-000000000003', '2026-08-21T00:00:00.000Z', 1)] },
    { current: null, history: [assignment(CLOSED_ID, '2026-08-20T00:00:00.000Z'), assignment(ASSIGNMENT_ID, '2026-08-22T00:00:00.000Z')] },
    { current: null, history: Array.from({ length: 101 }, (_, index) => assignment(syntheticUuid(index), `2026-08-${String(22 - (index % 20)).padStart(2, '0')}T00:00:00.000Z`)) },
  ]
  for (const value of invalid) {
    globalThis.fetch = async () => apiResponse(value)
    await assert.rejects(getCaseReferralSourceAssignments(CASE_ID), malformedResponse)
  }
})

test('assignment POST sends exact source/version body and accepts only the two-key receipt', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (input, init) => {
    assert.equal(input, `/api/v1/cases/${CASE_ID}/referral-source-assignments`)
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init.headers).get('idempotency-key'), 'case-referral-source:test')
    assert.deepEqual(JSON.parse(String(init.body)), { referral_source_id: SOURCE_ID, expected_current_assignment_record_version: null })
    return apiResponse({ id: ASSIGNMENT_ID, record_version: 1 })
  }
  assert.deepEqual(await assignCaseReferralSource(CASE_ID, { referral_source_id: SOURCE_ID, expected_current_assignment_record_version: null }, 'case-referral-source:test'), { id: ASSIGNMENT_ID, record_version: 1 })

  globalThis.fetch = async () => apiResponse({ id: CLOSED_ID, record_version: 2 })
  assert.deepEqual(await assignCaseReferralSource(CASE_ID, { referral_source_id: SOURCE_ID, expected_current_assignment_record_version: 1 }, 'case-referral-source:replacement'), { id: CLOSED_ID, record_version: 2 })

  for (const invalid of [{ id: ASSIGNMENT_ID, record_version: 3 }, { id: ASSIGNMENT_ID, record_version: 2, source_display_name: 'not allowed' }]) {
    globalThis.fetch = async () => apiResponse(invalid)
    await assert.rejects(assignCaseReferralSource(CASE_ID, { referral_source_id: SOURCE_ID, expected_current_assignment_record_version: 1 }, 'case-referral-source:strict'), malformedResponse)
  }
})

test('assignment attempts rotate only for a changed source/version or known completion', () => {
  let sequence = 0
  const attempt = new CaseReferralSourceIdempotencyAttempt(() => `case-referral-source:${++sequence}`)
  const firstDraft = { referral_source_id: SOURCE_ID, expected_current_assignment_record_version: null } as const
  const firstFingerprint = caseReferralSourceFingerprint(CASE_ID, firstDraft)
  const first = attempt.keyFor(firstFingerprint)
  assert.equal(attempt.keyFor(firstFingerprint), first)
  const changed = caseReferralSourceFingerprint(CASE_ID, { ...firstDraft, expected_current_assignment_record_version: 1 })
  assert.notEqual(attempt.keyFor(changed), first)
  attempt.complete()
  assert.notEqual(attempt.keyFor(firstFingerprint), first)
})

test('assignment receipt version follows the monotonic Case association chain', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => apiResponse({ id: ASSIGNMENT_ID, record_version: 4 })
  const receipt = await assignCaseReferralSource(CASE_ID, { referral_source_id: SOURCE_ID, expected_current_assignment_record_version: 3 }, 'case-referral-source:chain')
  assert.equal(receipt.record_version, 4)
  globalThis.fetch = async () => apiResponse({ id: ASSIGNMENT_ID, record_version: 1 })
  await assert.rejects(assignCaseReferralSource(CASE_ID, { referral_source_id: SOURCE_ID, expected_current_assignment_record_version: 3 }, 'case-referral-source:chain-bad'), malformedResponse)
})

test('assignment failures stay distinct and unknown errors fail closed', () => {
  assert.equal(classifyCaseReferralSourceFailure(apiError('UNAUTHENTICATED', 401)), 'unauthenticated')
  assert.equal(classifyCaseReferralSourceFailure(apiError('FORBIDDEN', 403)), 'forbidden')
  assert.equal(classifyCaseReferralSourceFailure(apiError('NOT_FOUND', 404)), 'not_found')
  assert.equal(classifyCaseReferralSourceFailure(apiError('VALIDATION_FAILED', 422)), 'validation')
  assert.equal(classifyCaseReferralSourceFailure(apiError('STALE_VERSION', 409)), 'stale')
  assert.equal(classifyCaseReferralSourceFailure(apiError('CONFLICT', 409)), 'conflict')
  assert.equal(classifyCaseReferralSourceFailure(new Error('private details')), 'unavailable')
})

function assignment(id: string, endsAt: string | null, recordVersion = endsAt === null ? 1 : 2) {
  return { id, referral_source_id: SOURCE_ID, source_display_name: 'Synthetic Partner', source_type: 'bank', source_record_version: 1, starts_at: '2026-08-20T00:00:00.000Z', ends_at: endsAt, record_version: recordVersion }
}

function syntheticUuid(index: number): string {
  return `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function apiResponse(data: unknown): Response {
  return Response.json({ api_version: 'v1', request_id: 'case-referral-source-test', data }, { headers: { 'x-request-id': 'case-referral-source-test' } })
}

function malformedResponse(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === 'MALFORMED_RESPONSE'
}

function apiError(code: string, status: number): ApiClientError {
  return new ApiClientError({ code, status, retryable: false, requestId: 'case-referral-source-test' })
}
