ALTER TABLE identity_sessions
  ADD COLUMN session_kind text NOT NULL DEFAULT 'cognito';

ALTER TABLE identity_sessions
  ADD CONSTRAINT identity_sessions_kind_check CHECK (
    session_kind IN ('cognito', 'local_synthetic')
  );

ALTER TABLE identity_sessions
  DROP CONSTRAINT identity_sessions_active_token_check;

ALTER TABLE identity_sessions
  ADD CONSTRAINT identity_sessions_active_credential_check CHECK (
    status <> 'active'
    OR (
      session_kind = 'cognito'
      AND provider_token_ciphertext IS NOT NULL
      AND provider_token_key_version IS NOT NULL
      AND btrim(provider_token_key_version) <> ''
    )
    OR (
      session_kind = 'local_synthetic'
      AND provider_token_ciphertext IS NULL
      AND provider_token_key_version IS NULL
    )
  );
