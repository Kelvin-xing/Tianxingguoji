import assert from 'node:assert/strict'
import test from 'node:test'

import {
  INVITE_ACTIVATION_BODY_MAX_BYTES,
  InviteActivationRequestError,
  readInviteActivationRequest,
} from '../../app/api/v1/auth/invite-activations/route-contract.ts'

test('activation accepts exactly the four form fields', async () => {
  const body = new URLSearchParams({
    activation_credential: 'v1.synthetic',
    display_name: '邀請顧問',
    password: 'Synthetic9!Password',
    password_confirmation: 'Synthetic9!Password',
  })
  assert.deepEqual(await readInviteActivationRequest(request(body)), {
    activationCredential: 'v1.synthetic',
    displayName: '邀請顧問',
    password: 'Synthetic9!Password',
    passwordConfirmation: 'Synthetic9!Password',
  })
})

test('activation rejects wrong media types, unknown fields, duplicates and oversized bodies', async () => {
  const valid = new URLSearchParams({ activation_credential: 'v1.synthetic', display_name: '顧問', password: 'password', password_confirmation: 'password' })
  await assert.rejects(readInviteActivationRequest(new Request('https://app.example.invalid/api/v1/auth/invite-activations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })), InviteActivationRequestError)
  const unknown = new URLSearchParams(valid); unknown.set('role', 'founder')
  await assert.rejects(readInviteActivationRequest(request(unknown)), InviteActivationRequestError)
  const duplicate = new URLSearchParams(valid); duplicate.append('password', 'second')
  await assert.rejects(readInviteActivationRequest(request(duplicate)), InviteActivationRequestError)
  const oversized = new URLSearchParams(valid); oversized.set('display_name', 'x'.repeat(INVITE_ACTIVATION_BODY_MAX_BYTES))
  await assert.rejects(readInviteActivationRequest(request(oversized)), InviteActivationRequestError)
})

function request(body: URLSearchParams): Request {
  return new Request('https://app.example.invalid/api/v1/auth/invite-activations', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  })
}
