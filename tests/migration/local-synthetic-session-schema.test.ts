import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("adds local synthetic sessions without changing the Cognito credential boundary", async () => {
  const [base, expansion, hardening] = await Promise.all([
    readFile("db/migrations/202608021330_001_expand_identity_access.sql", "utf8"),
    readFile("db/migrations/202608180010_017_expand_local_synthetic_sessions.sql", "utf8"),
    readFile("db/migrations/202608180020_018_harden_identity_session_validation.sql", "utf8"),
  ]);

  assert.match(base, /identity_sessions_active_token_check/);
  assert.doesNotMatch(base, /session_kind/);
  assert.match(expansion, /ADD COLUMN session_kind text NOT NULL DEFAULT 'cognito'/);
  assert.match(expansion, /session_kind IN \('cognito', 'local_synthetic'\)/);
  assert.match(expansion, /DROP CONSTRAINT identity_sessions_active_token_check/);
  assert.match(expansion, /session_kind = 'cognito'[\s\S]*provider_token_ciphertext IS NOT NULL/);
  assert.match(expansion, /session_kind = 'local_synthetic'[\s\S]*provider_token_ciphertext IS NULL/);
  assert.match(expansion, /provider_token_key_version IS NULL/);
  assert.match(hardening, /identity_validate_session_write\(\) SECURITY DEFINER/);
  assert.match(hardening, /SET search_path = pg_catalog, public/);
  assert.match(hardening, /REVOKE ALL ON FUNCTION identity_validate_session_write\(\) FROM PUBLIC/);
});
