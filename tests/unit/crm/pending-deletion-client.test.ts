import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError } from '../../../lib/api/client.ts'
import {
  PendingDeletionIdempotencyAttempt,
  classifyPendingDeletionFailure,
  getStudent,
  listPendingDeletionRequests,
  pendingDeletionFingerprint,
  requestPendingDeletion,
} from '../../../modules/crm/client.ts'

const STUDENT_ID = '10000000-0000-4000-8000-000000000001'
const GUARDIAN_ID = '20000000-0000-4000-8000-000000000001'

test('Student and Guardian requests send only the fixed lifecycle body and exact idempotency header', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  let request = 0
  globalThis.fetch = async (input, init) => {
    request += 1
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      expected_record_version: request,
      reason_code: 'record.lifecycle.pending_delete_requested',
    })
    assert.equal(new Headers(init?.headers).get('idempotency-key'), `pending-deletion:test-${request}`)
    if (request === 1) {
      assert.equal(input, `/api/v1/students/${STUDENT_ID}/deletion-requests`)
      return apiResponse(receipt('student', STUDENT_ID, 2))
    }
    assert.equal(input, `/api/v1/guardians/${GUARDIAN_ID}/deletion-requests`)
    return apiResponse(receipt('guardian', GUARDIAN_ID, 3))
  }

  const student = await requestPendingDeletion('student', STUDENT_ID, 1, 'pending-deletion:test-1')
  const guardian = await requestPendingDeletion('guardian', GUARDIAN_ID, 2, 'pending-deletion:test-2')
  assert.equal(student.status, 'pending_delete')
  assert.equal(guardian.entity_type, 'guardian')
  assert.equal(Object.isFrozen(student), true)
})

test('write receipt decoder is exact, PII-free and matches the requested target', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  const malformed = [
    { ...receipt('student', STUDENT_ID, 2), unexpected: true },
    { ...receipt('student', STUDENT_ID, 2), entity_type: 'guardian' },
    { ...receipt('student', STUDENT_ID, 2), entity_id: GUARDIAN_ID },
    { ...receipt('student', STUDENT_ID, 2), status: 'active' },
    { ...receipt('student', STUDENT_ID, 2), record_version: 0 },
    { ...receipt('student', STUDENT_ID, 2), display_label: 'PII does not belong in a write receipt' },
  ]
  for (const value of malformed) {
    globalThis.fetch = async () => apiResponse(value)
    await assert.rejects(
      requestPendingDeletion('student', STUDENT_ID, 1, 'pending-deletion:strict'),
      malformedResponse,
    )
  }
})

test('Founder queue uses one optional enum query and strictly decodes the six-key ordered array', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  let request = 0
  const items = [
    summary('student', STUDENT_ID, '2026-08-23T02:00:00.000Z', 2),
    summary('guardian', GUARDIAN_ID, '2026-08-23T01:00:00.000Z', 3),
  ]
  globalThis.fetch = async (input, init) => {
    request += 1
    assert.equal(init?.method, 'GET')
    assert.equal(input, request === 1 ? '/api/v1/crm/deletion-requests' : '/api/v1/crm/deletion-requests?entity_type=guardian')
    return apiResponse(request === 1 ? items : [items[1]])
  }
  const all = await listPendingDeletionRequests()
  const guardians = await listPendingDeletionRequests('guardian')
  assert.equal(all.length, 2)
  assert.equal(guardians[0]?.entity_type, 'guardian')
  assert.equal(Object.isFrozen(all), true)

  for (const malformed of [
    [{ ...items[0], email: 'not-allowed@example.invalid' }],
    [{ ...items[0], status: 'active' }],
    [items[1], items[0]],
    Array.from({ length: 101 }, (_, index) => summary('student', syntheticUuid(index), `2026-08-22T${String(23 - (index % 24)).padStart(2, '0')}:00:00.000Z`, 2)),
  ]) {
    globalThis.fetch = async () => apiResponse(malformed)
    await assert.rejects(listPendingDeletionRequests(), malformedResponse)
  }
})

test('Student detail requires the one new Guardian lifecycle field and rejects other lifecycle values', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => apiResponse({ student: studentDetail('pending_delete') })
  const detail = await getStudent(STUDENT_ID)
  assert.equal(detail.guardians[0]?.status, 'pending_delete')

  const withoutStatus = Object.fromEntries(
    Object.entries(studentDetail('active').guardians[0]!).filter(([key]) => key !== 'status'),
  )
  for (const guardian of [withoutStatus, { ...studentDetail('active').guardians[0], status: 'purged' }, { ...studentDetail('active').guardians[0], lifecycle: 'active' }]) {
    globalThis.fetch = async () => apiResponse({ student: { ...studentDetail('active'), guardians: [guardian] } })
    await assert.rejects(getStudent(STUDENT_ID), malformedResponse)
  }
})

test('lifecycle attempts reuse uncertain retries and rotate for target, version, or completion', () => {
  let sequence = 0
  const attempt = new PendingDeletionIdempotencyAttempt(() => `pending-deletion:${++sequence}`)
  const firstFingerprint = pendingDeletionFingerprint('student', STUDENT_ID, 1)
  const first = attempt.keyFor(firstFingerprint)
  assert.equal(attempt.keyFor(firstFingerprint), first)
  assert.notEqual(attempt.keyFor(pendingDeletionFingerprint('student', STUDENT_ID, 2)), first)
  const guardian = attempt.keyFor(pendingDeletionFingerprint('guardian', GUARDIAN_ID, 1))
  attempt.rotate()
  assert.notEqual(attempt.keyFor(pendingDeletionFingerprint('guardian', GUARDIAN_ID, 1)), guardian)
  attempt.complete()
  assert.notEqual(attempt.keyFor(firstFingerprint), first)
})

test('deletion failures remain distinct and unknown errors fail closed', () => {
  assert.equal(classifyPendingDeletionFailure(apiError('UNAUTHENTICATED', 401)), 'unauthenticated')
  assert.equal(classifyPendingDeletionFailure(apiError('FORBIDDEN', 403)), 'forbidden')
  assert.equal(classifyPendingDeletionFailure(apiError('NOT_FOUND', 404)), 'not_found')
  assert.equal(classifyPendingDeletionFailure(apiError('VALIDATION_FAILED', 422)), 'validation')
  assert.equal(classifyPendingDeletionFailure(apiError('STALE_VERSION', 409)), 'stale')
  assert.equal(classifyPendingDeletionFailure(apiError('CONFLICT', 409)), 'conflict')
  assert.equal(classifyPendingDeletionFailure(apiError('SERVICE_UNAVAILABLE', 503)), 'unavailable')
  assert.equal(classifyPendingDeletionFailure(new Error('private details')), 'unavailable')
})

function receipt(entityType: 'student' | 'guardian', entityId: string, recordVersion: number) {
  return {
    entity_type: entityType,
    entity_id: entityId,
    status: 'pending_delete',
    deletion_requested_at: '2026-08-23T00:00:00.000Z',
    record_version: recordVersion,
  }
}

function summary(entityType: 'student' | 'guardian', entityId: string, requestedAt: string, recordVersion: number) {
  return { ...receipt(entityType, entityId, recordVersion), display_label: entityType === 'student' ? 'Synthetic Student' : 'Synthetic Guardian', deletion_requested_at: requestedAt }
}

function studentDetail(guardianStatus: 'active' | 'pending_delete') {
  return {
    id: STUDENT_ID,
    displayName: 'Synthetic Student',
    dateOfBirth: null,
    status: 'active',
    primaryGuardianName: 'Synthetic Guardian',
    updatedAt: '2026-08-23T00:00:00.000Z',
    contactEmail: null,
    contactPhone: null,
    recordVersion: 1,
    guardians: [{
      id: GUARDIAN_ID,
      displayName: 'Synthetic Guardian',
      email: null,
      phone: 'synthetic-phone',
      status: guardianStatus,
      recordVersion: 1,
      relationshipType: 'father',
      isLegalGuardian: true,
      isPrimaryContact: true,
      isEmergencyContact: false,
      isBillingContact: false,
      notificationConsent: false,
    }],
  }
}

function syntheticUuid(index: number): string {
  return `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function apiResponse(data: unknown): Response {
  return Response.json({ api_version: 'v1', request_id: 'pending-deletion-client-test', data }, { headers: { 'x-request-id': 'pending-deletion-client-test' } })
}

function malformedResponse(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === 'MALFORMED_RESPONSE'
}

function apiError(code: string, status: number): ApiClientError {
  return new ApiClientError({ code, status, retryable: false, requestId: 'pending-deletion-client-test' })
}
