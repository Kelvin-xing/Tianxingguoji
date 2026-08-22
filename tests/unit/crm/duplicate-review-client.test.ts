import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError } from '../../../lib/api/client.ts'
import {
  DuplicateMutationIdempotencyAttempt,
  classifyDuplicateRequestFailure,
  correctDuplicateMerge,
  createDuplicateCandidate,
  duplicateCandidateFingerprint,
  duplicateCorrectionFingerprint,
  duplicateMergeFingerprint,
  getDuplicateCandidate,
  listDuplicateCandidates,
  mergeDuplicateCandidate,
  searchDuplicateRecords,
  type DuplicateMergeDraft,
} from '../../../modules/crm/client.ts'

const CANDIDATE_ID = '10000000-0000-4000-8000-000000000001'
const LEFT_ID = '20000000-0000-4000-8000-000000000001'
const RIGHT_ID = '20000000-0000-4000-8000-000000000002'
const MERGE_ID = '30000000-0000-4000-8000-000000000001'
const PROVENANCE_ID = '40000000-0000-4000-8000-000000000001'
const CORRECTION_ID = '50000000-0000-4000-8000-000000000001'
const STUDENT_FIELDS = ['display_name', 'date_of_birth', 'contact_email', 'contact_phone'] as const

test('duplicate record search uses non-mutating POST with no idempotency key or PII URL', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (input, init) => {
    assert.equal(input, '/api/v1/crm/duplicate-records/search')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), { entity_type: 'student', query: 'Synthetic' })
    assert.equal(new Headers(init?.headers).has('idempotency-key'), false)
    return apiResponse([{ id: LEFT_ID, entity_type: 'student', display_label: 'Student A', contact_hint: 's***@example.invalid' }])
  }
  const results = await searchDuplicateRecords('student', '  Synthetic  ')
  assert.equal(results[0]?.id, LEFT_ID)
  assert.equal(Object.isFrozen(results), true)
  assert.throws(() => searchDuplicateRecords('student', 'x'), /search query/)
})

test('candidate list and create share one exact summary and fixed enum-only query', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  let request = 0
  globalThis.fetch = async (input, init) => {
    request += 1
    if (request === 1) {
      assert.equal(input, '/api/v1/crm/duplicate-candidates?entity_type=student&status=review_required')
      assert.equal(init?.method, 'GET')
      return apiResponse([candidateFixture()])
    }
    assert.equal(input, '/api/v1/crm/duplicate-candidates')
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init?.headers).get('idempotency-key'), 'duplicate-candidate:test')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      entity_type: 'student',
      left_record_id: LEFT_ID,
      right_record_id: RIGHT_ID,
    })
    return apiResponse(candidateFixture(), 201)
  }
  const list = await listDuplicateCandidates('student', 'review_required')
  const created = await createDuplicateCandidate('student', LEFT_ID, RIGHT_ID, 'duplicate-candidate:test')
  assert.deepEqual(created, list[0])
  assert.equal(created.matching_signals.join(','), 'display_name,date_of_birth')
})

test('detail decoder accepts only canonical Student fields and current active merge authority', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => apiResponse(detailFixture({ merged: true, corrected: false }))
  const detail = await getDuplicateCandidate(CANDIDATE_ID)
  assert.equal(detail.candidate.status, 'merged')
  assert.equal(detail.merge?.status, 'active')
  assert.deepEqual(detail.supported_fields, STUDENT_FIELDS)
  assert.equal(detail.left_profile.id, LEFT_ID)
})

test('detail decoder accepts only the frozen Guardian profile and field order', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => apiResponse({
    candidate: {
      ...candidateFixture(),
      entity_type: 'guardian',
      matching_signals: ['display_name', 'email', 'phone'],
    },
    left_profile: guardianProfile(LEFT_ID),
    right_profile: guardianProfile(RIGHT_ID),
    supported_fields: ['display_name', 'email', 'phone'],
    merge: null,
  })
  const detail = await getDuplicateCandidate(CANDIDATE_ID)
  assert.equal(detail.candidate.entity_type, 'guardian')
  assert.deepEqual(detail.supported_fields, ['display_name', 'email', 'phone'])

  globalThis.fetch = async () => apiResponse({
    candidate: { ...candidateFixture(), entity_type: 'guardian', matching_signals: ['display_name'] },
    left_profile: { ...guardianProfile(LEFT_ID), contact_email: null },
    right_profile: guardianProfile(RIGHT_ID),
    supported_fields: ['display_name', 'email', 'phone'],
    merge: null,
  })
  await assert.rejects(getDuplicateCandidate(CANDIDATE_ID), malformedResponse)
})

test('strict detail decoder rejects extra keys, reordered fields, noncanonical signals and inconsistent correction state', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  const malformed = [
    { ...detailFixture(), unexpected: true },
    { ...detailFixture(), supported_fields: ['date_of_birth', 'display_name', 'contact_email', 'contact_phone'] },
    { ...detailFixture(), candidate: { ...candidateFixture(), matching_signals: ['date_of_birth', 'display_name'] } },
    { ...detailFixture(), right_profile: { ...studentProfile(RIGHT_ID), id: LEFT_ID } },
    { ...detailFixture({ merged: true }), merge: { ...mergeView(false), status: 'corrected', correction_id: null } },
  ]
  for (const payload of malformed) {
    globalThis.fetch = async () => apiResponse(payload)
    await assert.rejects(getDuplicateCandidate(CANDIDATE_ID), malformedResponse)
  }
})

test('merge and correction requests encode only frozen fields and decode exact receipts', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  const draft = mergeDraft()
  let request = 0
  globalThis.fetch = async (input, init) => {
    request += 1
    const headers = new Headers(init?.headers)
    if (request === 1) {
      assert.equal(input, `/api/v1/crm/duplicate-candidates/${CANDIDATE_ID}/merges`)
      assert.equal(init?.method, 'POST')
      assert.equal(headers.get('idempotency-key'), 'duplicate-merge:test')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        ...draft,
        field_selections: draft.field_selections.map((selection) => ({ ...selection })),
        reason_code: 'duplicate.confirmed',
      })
      return apiResponse({
        merge_id: MERGE_ID,
        candidate_id: CANDIDATE_ID,
        entity_type: 'student',
        source_record_id: LEFT_ID,
        canonical_record_id: RIGHT_ID,
        provenance_revision_id: PROVENANCE_ID,
        record_version: 1,
      })
    }
    assert.equal(input, `/api/v1/crm/duplicate-merges/${MERGE_ID}/corrections`)
    assert.equal(init?.method, 'POST')
    assert.equal(headers.get('idempotency-key'), 'duplicate-correction:test')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      expected_merge_record_version: 1,
      reason_code: 'duplicate.merge.corrected',
    })
    return apiResponse({
      corrective_revision_id: CORRECTION_ID,
      merge_id: MERGE_ID,
      source_record_id: LEFT_ID,
      canonical_record_id: RIGHT_ID,
      restored_alias_target_id: LEFT_ID,
      record_version: 2,
    })
  }
  const merged = await mergeDuplicateCandidate(CANDIDATE_ID, 'student', draft, STUDENT_FIELDS, 'duplicate-merge:test')
  const corrected = await correctDuplicateMerge(MERGE_ID, 1, 'duplicate-correction:test')
  assert.equal(merged.provenance_revision_id, PROVENANCE_ID)
  assert.equal(corrected.restored_alias_target_id, LEFT_ID)
})

test('duplicate mutation attempts reuse uncertain retries and rotate on business changes', () => {
  let sequence = 0
  const attempt = new DuplicateMutationIdempotencyAttempt('merge', () => `duplicate-merge:${++sequence}`)
  const firstFingerprint = duplicateMergeFingerprint('student', mergeDraft(), STUDENT_FIELDS)
  const firstKey = attempt.keyFor(firstFingerprint)
  assert.equal(attempt.keyFor(firstFingerprint), firstKey)
  const changedDraft = { ...mergeDraft(), field_selections: mergeDraft().field_selections.map((selection, index) => index === 0 ? { ...selection, source_record_id: RIGHT_ID } : selection) }
  const changedKey = attempt.keyFor(duplicateMergeFingerprint('student', changedDraft, STUDENT_FIELDS))
  assert.notEqual(changedKey, firstKey)
  assert.equal(attempt.operationName(), 'merge')
  assert.notEqual(duplicateCandidateFingerprint('student', LEFT_ID, RIGHT_ID), duplicateCandidateFingerprint('guardian', LEFT_ID, RIGHT_ID))
  assert.equal(duplicateCorrectionFingerprint(MERGE_ID, 1), `${MERGE_ID}:1`)
})

test('duplicate errors preserve distinct validation, stale, conflict, denial and unavailable states', () => {
  assert.equal(classifyDuplicateRequestFailure(apiError('UNAUTHENTICATED', 401)), 'unauthenticated')
  assert.equal(classifyDuplicateRequestFailure(apiError('FORBIDDEN', 403)), 'forbidden')
  assert.equal(classifyDuplicateRequestFailure(apiError('NOT_FOUND', 404)), 'not_found')
  assert.equal(classifyDuplicateRequestFailure(apiError('VALIDATION_FAILED', 422)), 'validation')
  assert.equal(classifyDuplicateRequestFailure(apiError('STALE_VERSION', 409)), 'stale')
  assert.equal(classifyDuplicateRequestFailure(apiError('CONFLICT', 409)), 'conflict')
  assert.equal(classifyDuplicateRequestFailure(apiError('SERVICE_UNAVAILABLE', 503, true)), 'unavailable')
  assert.equal(classifyDuplicateRequestFailure(new Error('private details')), 'unavailable')
})

function candidateFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: CANDIDATE_ID,
    entity_type: 'student',
    left_record: { id: LEFT_ID, display_label: 'Student A' },
    right_record: { id: RIGHT_ID, display_label: 'Student B' },
    matching_signals: ['display_name', 'date_of_birth'],
    status: 'review_required',
    merge_id: null,
    record_version: 1,
    ...overrides,
  }
}

function detailFixture(options: { readonly merged?: boolean; readonly corrected?: boolean } = {}) {
  const merged = options.merged ?? false
  return {
    candidate: candidateFixture(merged ? { status: 'merged', merge_id: MERGE_ID, record_version: 2 } : {}),
    left_profile: studentProfile(LEFT_ID),
    right_profile: studentProfile(RIGHT_ID),
    supported_fields: [...STUDENT_FIELDS],
    merge: merged ? mergeView(options.corrected ?? false) : null,
  }
}

function studentProfile(id: string) {
  return {
    id,
    display_name: id === LEFT_ID ? 'Student A' : 'Student B',
    date_of_birth: '2012-06-01',
    contact_email: null,
    contact_phone: null,
    record_version: 1,
  }
}

function guardianProfile(id: string) {
  return {
    id,
    display_name: id === LEFT_ID ? 'Guardian A' : 'Guardian B',
    email: id === LEFT_ID ? 'guardian-a@example.invalid' : null,
    phone: id === RIGHT_ID ? 'synthetic-phone' : null,
    record_version: 1,
  }
}

function mergeView(corrected: boolean) {
  return {
    id: MERGE_ID,
    source_record_id: LEFT_ID,
    canonical_record_id: RIGHT_ID,
    provenance_revision_id: PROVENANCE_ID,
    status: corrected ? 'corrected' : 'active',
    record_version: corrected ? 2 : 1,
    correction_id: corrected ? CORRECTION_ID : null,
  }
}

function mergeDraft(): DuplicateMergeDraft {
  return {
    source_record_id: LEFT_ID,
    canonical_record_id: RIGHT_ID,
    expected_candidate_record_version: 1,
    expected_source_record_version: 1,
    expected_canonical_record_version: 1,
    field_selections: STUDENT_FIELDS.map((field_name, index) => ({ field_name, source_record_id: index % 2 === 0 ? LEFT_ID : RIGHT_ID })),
  }
}

function malformedResponse(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === 'MALFORMED_RESPONSE'
}

function apiResponse(data: unknown, status = 200): Response {
  return Response.json({ api_version: 'v1', request_id: 'crm04-client-test', data }, { status, headers: { 'x-request-id': 'crm04-client-test' } })
}

function apiError(code: string, status: number, retryable = false): ApiClientError {
  return new ApiClientError({ code, status, retryable, requestId: 'crm04-client-test' })
}
