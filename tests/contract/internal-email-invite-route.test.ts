import assert from 'node:assert/strict'
import test from 'node:test'

import {
  INTERNAL_EMAIL_INVITE_BODY_MAX_BYTES,
  InternalEmailInviteRequestError,
  readInternalEmailInviteRequest,
} from '../../app/api/v1/auth/invites/route-contract.ts'

test('Legacy Founder invite accepts the four compatibility roles and normalized fields', async () => {
  const result = await readInternalEmailInviteRequest(request({
    normalized_email: 'advisor@example.test.invalid', role: 'advisor', employment_type: 'FULL_TIME', display_name: '顧問',
  }))
  assert.deepEqual(result, {
    normalizedEmail: 'advisor@example.test.invalid', role: 'advisor', employmentType: 'FULL_TIME', displayName: '顧問', idempotencyKey: 'invite-test-1',
  })
  for (const role of ['founder', 'admin', 'advisor', 'contractor']) {
    assert.equal((await readInternalEmailInviteRequest(request({ normalized_email: `${role}@example.test.invalid`, role }))).role, role)
  }
  await assert.rejects(readInternalEmailInviteRequest(request({ normalized_email: 'reviewer@example.test.invalid', role: 'data_reviewer' })), validationFailure)
})

test('Founder invite rejects missing idempotency, unknown fields and oversized JSON', async () => {
  const body = { normalized_email: 'advisor@example.test.invalid', role: 'advisor' }
  await assert.rejects(readInternalEmailInviteRequest(request(body, false)), invalidRequest)
  await assert.rejects(readInternalEmailInviteRequest(request({ ...body, actor_role: 'founder' })), invalidRequest)
  await assert.rejects(readInternalEmailInviteRequest(request({ ...body, display_name: 'x'.repeat(INTERNAL_EMAIL_INVITE_BODY_MAX_BYTES) })), invalidRequest)
  await assert.rejects(readInternalEmailInviteRequest(new Request('https://app.example.invalid/api/v1/auth/invites', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'invite-test-1' }, body: Uint8Array.of(0xff),
  })), invalidRequest)
})

function request(body: Record<string, unknown>, includeKey = true): Request {
  return new Request('https://app.example.invalid/api/v1/auth/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=UTF-8', ...(includeKey ? { 'idempotency-key': 'invite-test-1' } : {}) },
    body: JSON.stringify(body),
  })
}

function invalidRequest(error: unknown): boolean {
  return error instanceof InternalEmailInviteRequestError && error.code === 'INVALID_REQUEST'
}

function validationFailure(error: unknown): boolean {
  return error instanceof InternalEmailInviteRequestError && error.code === 'VALIDATION_FAILED'
}

test('trial invitation requires explicit categories and rejects scope injection', async () => {
  const base = { normalized_email:'trial@example.test.invalid', role:'l2', trial_categories:['local_school','international_school'], employment_type:'PART_TIME' };
  const parsed = await readInternalEmailInviteRequest(request(base));
  assert.equal(parsed.role,'l2');
  assert.deepEqual(parsed.trialCategories,['international_school','local_school']);
  for (const role of ['founder','l1','l3']) assert.deepEqual((await readInternalEmailInviteRequest(request({...base,role,trial_categories:[]}))).trialCategories,[]);
  for (const invalid of [
    {...base,trial_categories:undefined}, {...base,trial_categories:['international_school','international_school']},
    {...base,trial_categories:['other_business']}, {...base,role:'l3'}, {...base,role:'admin',trial_categories:[]},
  ]) await assert.rejects(readInternalEmailInviteRequest(request(invalid)),validationFailure);
  await assert.rejects(readInternalEmailInviteRequest(request({...base,trial_level:'founder'})),invalidRequest);
});
