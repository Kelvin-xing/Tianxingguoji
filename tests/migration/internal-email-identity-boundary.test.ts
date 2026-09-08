import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('055 adds internal credentials and keeps session provider tokens null', async () => {
  const sql = await readFile('db/migrations/202609070010_055_internal_email_identity.sql', 'utf8')
  assert.match(sql, /CREATE TABLE identity_internal_credentials/)
  assert.match(sql, /INSERT INTO identity_internal_credentials[\s\S]*identity_database_test_credentials[\s\S]*role_binding\.role = 'founder'/)
  assert.match(sql, /session_kind IN \('cognito', 'local_synthetic', 'database_test', 'internal_email'\)/)
  assert.match(sql, /identity_sessions_one_active_internal_email_per_user_idx/)
  assert.match(sql, /CREATE FUNCTION identity_internal_email_lookup_credential/)
  assert.match(sql, /CREATE FUNCTION identity_internal_email_complete_login/)
  assert.match(sql, /CREATE FUNCTION identity_internal_email_resolve_session/)
  assert.match(sql, /CREATE FUNCTION identity_internal_email_revoke_session/)
  assert.match(sql, /identity_internal_email_activate_invite[\s\S]*v_now := transaction_timestamp\(\)[\s\S]*v_invite\.expires_at <= v_now/)
  assert.match(sql, /GRANT UPDATE \(receipt_reference, delivered_at\)/)
  assert.match(sql, /provider_token_ciphertext IS NULL/)
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i)
})
