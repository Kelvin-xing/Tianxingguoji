-- Internal email identity: Founder-invite only, no public registration.

CREATE TABLE identity_internal_credentials (
  user_id uuid PRIMARY KEY REFERENCES identity_users (id),
  verifier_version text NOT NULL,
  password_salt bytea NOT NULL,
  password_verifier bytea NOT NULL,
  status text NOT NULL DEFAULT 'active',
  failed_attempt_count smallint NOT NULL DEFAULT 0,
  failure_window_started_at timestamptz,
  locked_until timestamptz,
  credential_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT identity_internal_credentials_version_check CHECK (verifier_version = 'scrypt-v1'),
  CONSTRAINT identity_internal_credentials_salt_check CHECK (octet_length(password_salt) = 32),
  CONSTRAINT identity_internal_credentials_verifier_check CHECK (octet_length(password_verifier) = 64),
  CONSTRAINT identity_internal_credentials_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT identity_internal_credentials_failures_check CHECK (
    failed_attempt_count BETWEEN 0 AND 5
    AND (locked_until IS NULL OR failure_window_started_at IS NOT NULL)
  ),
  CONSTRAINT identity_internal_credentials_version_number_check CHECK (credential_version >= 1),
  CONSTRAINT identity_internal_credentials_timestamps_check CHECK (updated_at >= created_at)
);

-- Preserve access for an already-active Founder during the one-time move from
-- the synthetic email/password runtime. Only the scrypt verifier is copied;
-- no plaintext password or provider credential exists in either table.
INSERT INTO identity_internal_credentials (
  user_id, verifier_version, password_salt, password_verifier,
  status, credential_version, created_at, updated_at
)
SELECT DISTINCT ON (credential.user_id)
       credential.user_id, credential.verifier_version,
       credential.password_salt, credential.password_verifier,
       'active', credential.credential_version,
       transaction_timestamp(), transaction_timestamp()
  FROM identity_database_test_credentials AS credential
  JOIN identity_users AS identity_user
    ON identity_user.id = credential.user_id AND identity_user.status = 'active'
  JOIN access_organization_memberships AS membership
    ON membership.user_id = identity_user.id AND membership.status = 'active'
  JOIN access_role_bindings AS role_binding
    ON role_binding.membership_id = membership.id
   AND role_binding.organization_id = membership.organization_id
   AND role_binding.user_id = membership.user_id
   AND role_binding.status = 'active' AND role_binding.role = 'founder'
 WHERE credential.status = 'active'
 ORDER BY credential.user_id;

ALTER TABLE identity_invites DROP CONSTRAINT identity_invites_lifecycle_check;
ALTER TABLE identity_invites
  ADD CONSTRAINT identity_invites_lifecycle_check CHECK (
    expires_at <= updated_at + interval '72 hours'
    AND (
      (status = 'created' AND consumed_at IS NULL AND expired_at IS NULL AND revoked_at IS NULL
        AND revoke_reason IS NULL AND revoke_reason_code IS NULL)
      OR (status = 'redeemed' AND consumed_at IS NOT NULL AND expired_at IS NULL AND revoked_at IS NULL)
      OR (status = 'expired' AND consumed_at IS NULL AND expired_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND consumed_at IS NULL AND expired_at IS NULL AND revoked_at IS NOT NULL
        AND COALESCE(revoke_reason_code, revoke_reason) IS NOT NULL
        AND btrim(COALESCE(revoke_reason_code, revoke_reason)) <> '')
    )
  );

REVOKE ALL ON TABLE identity_internal_credentials FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE identity_internal_credentials TO tianxing_app;
ALTER TABLE identity_internal_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON identity_internal_credentials
  FOR ALL TO tianxing_app
  USING (
    EXISTS (
      SELECT 1
        FROM access_organization_memberships membership
       WHERE membership.user_id = identity_internal_credentials.user_id
         AND membership.organization_id::text = current_setting('app.organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM access_organization_memberships membership
       WHERE membership.user_id = identity_internal_credentials.user_id
         AND membership.organization_id::text = current_setting('app.organization_id', true)
    )
  );

ALTER TABLE identity_sessions
  DROP CONSTRAINT identity_sessions_kind_check;
ALTER TABLE identity_sessions
  ADD CONSTRAINT identity_sessions_kind_check CHECK (
    session_kind IN ('cognito', 'local_synthetic', 'database_test', 'internal_email')
  );

ALTER TABLE identity_sessions
  DROP CONSTRAINT identity_sessions_active_credential_check;
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
      session_kind IN ('local_synthetic', 'database_test', 'internal_email')
      AND provider_token_ciphertext IS NULL
      AND provider_token_key_version IS NULL
    )
  );

CREATE UNIQUE INDEX identity_sessions_one_active_internal_email_per_user_idx
  ON identity_sessions (user_id)
  WHERE session_kind = 'internal_email' AND status = 'active';

-- Login starts before tenant context exists. These narrow Identity commands
-- locate the tenant, enforce lifecycle/lockout rules, and return only the
-- session actor needed to establish request-time Access context.
CREATE FUNCTION identity_internal_email_lookup_credential(p_normalized_email text)
RETURNS TABLE (
  user_id uuid,
  verifier_version text,
  password_salt bytea,
  password_verifier bytea,
  credential_version bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT credential.user_id, credential.verifier_version,
         credential.password_salt, credential.password_verifier,
         credential.credential_version
    FROM public.identity_internal_credentials AS credential
    JOIN public.identity_users AS identity_user ON identity_user.id = credential.user_id
   WHERE identity_user.normalized_email = p_normalized_email
     AND identity_user.status = 'active'
     AND credential.status = 'active'
   LIMIT 1
$function$;

CREATE FUNCTION identity_internal_email_complete_login(
  p_user_id uuid,
  p_expected_credential_version bigint,
  p_password_matched boolean,
  p_session_id uuid,
  p_secret_hash bytea,
  p_now timestamptz
)
RETURNS TABLE (
  allowed boolean,
  user_id uuid,
  normalized_email text,
  organization_id uuid,
  membership_id uuid,
  role_binding_id uuid,
  role text,
  session_id uuid,
  captured_session_version bigint,
  reauthenticated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_credential public.identity_internal_credentials%ROWTYPE;
  v_normalized_email text;
  v_user_status text;
  v_session_version bigint;
  v_organization_id uuid;
  v_membership_id uuid;
  v_role_binding_id uuid;
  v_role text;
  v_role_count integer;
  v_failed_count integer;
  v_now timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_expected_credential_version IS NULL
     OR p_password_matched IS NULL OR p_session_id IS NULL
     OR p_secret_hash IS NULL OR p_now IS NULL
     OR p_now < transaction_timestamp() - interval '5 minutes'
     OR p_now > transaction_timestamp() + interval '5 minutes'
     OR octet_length(p_secret_hash) <> 32 THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  v_now := transaction_timestamp();
  SELECT credential.* INTO v_credential
    FROM public.identity_internal_credentials AS credential
   WHERE credential.user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND OR v_credential.status <> 'active'
     OR v_credential.credential_version <> p_expected_credential_version
     OR (v_credential.locked_until IS NOT NULL AND v_credential.locked_until > v_now) THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  IF NOT p_password_matched THEN
    v_failed_count := CASE
      WHEN v_credential.failure_window_started_at IS NULL
        OR v_credential.failure_window_started_at < v_now - interval '15 minutes' THEN 1
      ELSE least(v_credential.failed_attempt_count + 1, 5)
    END;
    UPDATE public.identity_internal_credentials
       SET failed_attempt_count = v_failed_count,
           failure_window_started_at = CASE WHEN v_failed_count = 1 THEN v_now ELSE failure_window_started_at END,
           locked_until = CASE WHEN v_failed_count >= 5 THEN v_now + interval '15 minutes' ELSE NULL END,
           updated_at = v_now
     WHERE identity_internal_credentials.user_id = p_user_id;
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT identity_user.normalized_email, identity_user.status,
         identity_user.session_version, membership.organization_id, membership.id
    INTO v_normalized_email, v_user_status, v_session_version,
         v_organization_id, v_membership_id
    FROM public.identity_users AS identity_user
    JOIN public.access_organization_memberships AS membership
      ON membership.user_id = identity_user.id AND membership.status = 'active'
    JOIN public.access_organizations AS organization
      ON organization.id = membership.organization_id AND organization.status = 'active'
   WHERE identity_user.id = p_user_id
   FOR SHARE OF identity_user, membership, organization;
  IF NOT FOUND OR v_user_status <> 'active' THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT count(*) INTO v_role_count
    FROM public.access_role_bindings AS role_binding
   WHERE role_binding.membership_id = v_membership_id
     AND role_binding.organization_id = v_organization_id
     AND role_binding.user_id = p_user_id AND role_binding.status = 'active';
  IF v_role_count < 1 THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT role_binding.id, role_binding.role INTO v_role_binding_id, v_role
    FROM public.access_role_bindings AS role_binding
   WHERE role_binding.membership_id = v_membership_id
     AND role_binding.organization_id = v_organization_id
     AND role_binding.user_id = p_user_id AND role_binding.status = 'active'
   ORDER BY CASE role_binding.role WHEN 'founder' THEN 1 WHEN 'admin' THEN 2
     WHEN 'advisor' THEN 3 WHEN 'contractor' THEN 4 ELSE 5 END, role_binding.id
   LIMIT 1 FOR SHARE;
  UPDATE public.identity_internal_credentials
     SET failed_attempt_count = 0, failure_window_started_at = NULL,
         locked_until = NULL, updated_at = v_now
   WHERE identity_internal_credentials.user_id = p_user_id;
  UPDATE public.identity_sessions
     SET status = 'revoked', revoked_at = v_now,
         revoke_reason = 'internal_email_relogin',
         record_version = record_version + 1, updated_at = v_now
   WHERE identity_sessions.user_id = p_user_id
     AND identity_sessions.session_kind = 'internal_email'
     AND identity_sessions.status = 'active';
  INSERT INTO public.identity_sessions (
    id, user_id, organization_id, membership_id, secret_hash,
    captured_session_version, session_slot, status, session_kind,
    provider_token_ciphertext, provider_token_key_version, last_seen_at,
    idle_expires_at, absolute_expires_at, reauthenticated_at, created_at, updated_at
  ) VALUES (
    p_session_id, p_user_id, v_organization_id, v_membership_id, p_secret_hash,
    v_session_version, 1, 'active', 'internal_email', NULL, NULL, v_now,
    v_now + interval '8 hours', v_now + interval '24 hours', v_now, v_now, v_now
  );
  RETURN QUERY SELECT true, p_user_id, v_normalized_email, v_organization_id,
    v_membership_id, v_role_binding_id, v_role, p_session_id, v_session_version, v_now;
END;
$function$;

CREATE FUNCTION identity_internal_email_resolve_session(
  p_secret_hash bytea,
  p_now timestamptz,
  p_sensitive_action boolean
)
RETURNS TABLE (
  allowed boolean,
  user_id uuid,
  normalized_email text,
  organization_id uuid,
  membership_id uuid,
  role_binding_id uuid,
  role text,
  session_id uuid,
  captured_session_version bigint,
  reauthenticated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_session public.identity_sessions%ROWTYPE;
  v_normalized_email text;
  v_user_status text;
  v_current_session_version bigint;
  v_organization_status text;
  v_membership_status text;
  v_role_binding_id uuid;
  v_role text;
  v_role_count integer;
  v_identity_found boolean;
  v_now timestamptz;
BEGIN
  IF p_secret_hash IS NULL OR p_now IS NULL OR p_sensitive_action IS NULL
     OR p_now < transaction_timestamp() - interval '5 minutes'
     OR p_now > transaction_timestamp() + interval '5 minutes'
     OR octet_length(p_secret_hash) <> 32 THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  v_now := transaction_timestamp();
  SELECT session.* INTO v_session
    FROM public.identity_sessions AS session
   WHERE session.secret_hash = p_secret_hash
     AND session.session_kind = 'internal_email'
   FOR UPDATE;
  IF NOT FOUND OR v_session.status <> 'active' THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT identity_user.normalized_email, identity_user.status,
         identity_user.session_version, organization.status, membership.status
    INTO v_normalized_email, v_user_status, v_current_session_version,
         v_organization_status, v_membership_status
    FROM public.identity_users AS identity_user
    JOIN public.access_organization_memberships AS membership
      ON membership.id = v_session.membership_id
     AND membership.organization_id = v_session.organization_id
     AND membership.user_id = v_session.user_id
    JOIN public.access_organizations AS organization ON organization.id = v_session.organization_id
   WHERE identity_user.id = v_session.user_id
   FOR SHARE OF identity_user, membership, organization;
  v_identity_found := FOUND;
  SELECT count(*) INTO v_role_count
    FROM public.access_role_bindings AS role_binding
   WHERE role_binding.membership_id = v_session.membership_id
     AND role_binding.organization_id = v_session.organization_id
     AND role_binding.user_id = v_session.user_id AND role_binding.status = 'active';
  IF NOT v_identity_found OR v_user_status <> 'active'
     OR v_current_session_version <> v_session.captured_session_version
     OR v_organization_status <> 'active' OR v_membership_status <> 'active'
     OR v_role_count < 1 THEN
    UPDATE public.identity_sessions SET status = 'revoked', revoked_at = v_now,
      revoke_reason = 'internal_email_identity_inactive',
      record_version = record_version + 1, updated_at = v_now
     WHERE id = v_session.id AND status = 'active';
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_now >= v_session.absolute_expires_at OR v_now >= v_session.idle_expires_at THEN
    UPDATE public.identity_sessions SET status = 'expired',
      record_version = record_version + 1, updated_at = v_now
     WHERE id = v_session.id AND status = 'active';
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_sensitive_action AND (v_session.reauthenticated_at IS NULL
     OR v_now > v_session.reauthenticated_at + interval '5 minutes') THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT role_binding.id, role_binding.role INTO v_role_binding_id, v_role
    FROM public.access_role_bindings AS role_binding
   WHERE role_binding.membership_id = v_session.membership_id
     AND role_binding.organization_id = v_session.organization_id
     AND role_binding.user_id = v_session.user_id AND role_binding.status = 'active'
   ORDER BY CASE role_binding.role WHEN 'founder' THEN 1 WHEN 'admin' THEN 2
     WHEN 'advisor' THEN 3 WHEN 'contractor' THEN 4 ELSE 5 END, role_binding.id
   LIMIT 1 FOR SHARE;
  UPDATE public.identity_sessions
     SET last_seen_at = v_now,
         idle_expires_at = least(v_now + interval '8 hours', absolute_expires_at),
         record_version = record_version + 1, updated_at = v_now
   WHERE id = v_session.id AND status = 'active';
  RETURN QUERY SELECT true, v_session.user_id, v_normalized_email,
    v_session.organization_id, v_session.membership_id, v_role_binding_id, v_role,
    v_session.id, v_session.captured_session_version, v_session.reauthenticated_at;
END;
$function$;

CREATE FUNCTION identity_internal_email_revoke_session(p_secret_hash bytea, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_secret_hash IS NULL OR octet_length(p_secret_hash) <> 32
     OR p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 128 THEN
    RETURN false;
  END IF;
  UPDATE public.identity_sessions
     SET status = 'revoked', revoked_at = transaction_timestamp(), revoke_reason = p_reason,
         record_version = record_version + 1, updated_at = transaction_timestamp()
   WHERE secret_hash = p_secret_hash AND session_kind = 'internal_email' AND status = 'active';
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION identity_internal_email_lookup_credential(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity_internal_email_complete_login(uuid, bigint, boolean, uuid, bytea, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity_internal_email_resolve_session(bytea, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity_internal_email_revoke_session(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_internal_email_lookup_credential(text) TO tianxing_app;
GRANT EXECUTE ON FUNCTION identity_internal_email_complete_login(uuid, bigint, boolean, uuid, bytea, timestamptz) TO tianxing_app;
GRANT EXECUTE ON FUNCTION identity_internal_email_resolve_session(bytea, timestamptz, boolean) TO tianxing_app;
GRANT EXECUTE ON FUNCTION identity_internal_email_revoke_session(bytea, text) TO tianxing_app;

-- Access-owned membership/profile/role writes stay behind these Identity
-- command functions so an Identity repository never writes Access tables.
CREATE FUNCTION identity_internal_email_create_invite(
  p_invite_id uuid,
  p_user_id uuid,
  p_membership_id uuid,
  p_role_binding_id uuid,
  p_organization_id uuid,
  p_invited_by_user_id uuid,
  p_normalized_email text,
  p_role text,
  p_employment_type text,
  p_display_name text,
  p_secret_hash bytea,
  p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM identity_users u
      JOIN access_organization_memberships m ON m.user_id = u.id
       AND m.organization_id = p_organization_id AND m.status = 'active'
      JOIN access_role_bindings r ON r.membership_id = m.id
       AND r.organization_id = m.organization_id AND r.user_id = u.id
       AND r.role = 'founder' AND r.status = 'active'
     WHERE u.id = p_invited_by_user_id AND u.status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FOUNDER_REQUIRED';
  END IF;
  INSERT INTO identity_users (id, normalized_email, status, created_by_user_id)
  VALUES (p_user_id, p_normalized_email, 'invited', p_invited_by_user_id);
  INSERT INTO access_organization_memberships (id, organization_id, user_id, status, created_by_user_id)
  VALUES (p_membership_id, p_organization_id, p_user_id, 'invited', p_invited_by_user_id);
  INSERT INTO access_employee_profiles (membership_id, organization_id, display_name, employment_type)
  VALUES (p_membership_id, p_organization_id, p_display_name, p_employment_type);
  INSERT INTO access_role_bindings (id, organization_id, membership_id, user_id, role, status, created_by_user_id)
  VALUES (p_role_binding_id, p_organization_id, p_membership_id, p_user_id, p_role, 'active', p_invited_by_user_id);
  INSERT INTO identity_invites (
    id, organization_id, target_user_id, invited_by_user_id, requested_role,
    secret_hash, status, expires_at, credential_version
  ) VALUES (
    p_invite_id, p_organization_id, p_user_id, p_invited_by_user_id, p_role,
    p_secret_hash, 'created', p_expires_at, 'v1'
  );
END;
$function$;

REVOKE ALL ON FUNCTION identity_internal_email_create_invite(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, bytea, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_internal_email_create_invite(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, bytea, timestamptz) TO tianxing_app;

CREATE FUNCTION identity_internal_email_activate_invite(
  p_organization_id uuid,
  p_invite_id uuid,
  p_target_user_id uuid,
  p_secret_hash bytea,
  p_password_salt bytea,
  p_password_verifier bytea,
  p_display_name text,
  p_session_id uuid,
  p_session_secret_hash bytea,
  p_now timestamptz
)
RETURNS TABLE (
  allowed boolean,
  denial_code text,
  user_id uuid,
  normalized_email text,
  membership_id uuid,
  role_binding_id uuid,
  role text,
  session_id uuid,
  captured_session_version bigint,
  reauthenticated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_invite identity_invites%ROWTYPE;
  v_user identity_users%ROWTYPE;
  v_membership access_organization_memberships%ROWTYPE;
  v_role_binding access_role_bindings%ROWTYPE;
  v_slot smallint;
  v_now timestamptz;
BEGIN
  IF p_now IS NULL
     OR p_now < transaction_timestamp() - interval '5 minutes'
     OR p_now > transaction_timestamp() + interval '5 minutes' THEN
    RETURN QUERY SELECT false, 'INVITE_NOT_FOUND', NULL::uuid, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  v_now := transaction_timestamp();
  SELECT * INTO v_invite
    FROM identity_invites
   WHERE id = p_invite_id AND organization_id = p_organization_id
     AND target_user_id = p_target_user_id AND secret_hash = p_secret_hash
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'INVITE_NOT_FOUND', NULL::uuid, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_invite.status <> 'created' THEN
    RETURN QUERY SELECT false, 'INVITE_NOT_REDEEMABLE', NULL::uuid, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_invite.expires_at <= v_now THEN
    UPDATE identity_invites SET status = 'expired', expired_at = v_now, record_version = record_version + 1, updated_at = v_now WHERE id = p_invite_id;
    RETURN QUERY SELECT false, 'INVITE_EXPIRED', NULL::uuid, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT identity_user.* INTO v_user
    FROM identity_users AS identity_user
   WHERE identity_user.id = p_target_user_id FOR UPDATE;
  SELECT membership.* INTO v_membership
    FROM access_organization_memberships AS membership
   WHERE membership.user_id = p_target_user_id
     AND membership.organization_id = p_organization_id FOR UPDATE;
  SELECT role_binding.* INTO v_role_binding
    FROM access_role_bindings AS role_binding
   WHERE role_binding.membership_id = v_membership.id
     AND role_binding.organization_id = p_organization_id
     AND role_binding.user_id = p_target_user_id
     AND role_binding.status = 'active'
   ORDER BY CASE role_binding.role WHEN 'founder' THEN 1 WHEN 'admin' THEN 2
     WHEN 'advisor' THEN 3 ELSE 4 END, role_binding.id LIMIT 1;
  IF v_user.status <> 'invited' OR v_membership.status <> 'invited' OR v_role_binding.id IS NULL THEN
    RETURN QUERY SELECT false, 'INVITE_NOT_REDEEMABLE', NULL::uuid, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT candidate INTO v_slot
    FROM generate_series(1, 3) candidate
   WHERE NOT EXISTS (SELECT 1 FROM identity_sessions s WHERE s.user_id = p_target_user_id AND s.status = 'active' AND s.session_slot = candidate)
   ORDER BY candidate LIMIT 1;
  IF v_slot IS NULL THEN
    RETURN QUERY SELECT false, 'SESSION_LIMIT_REACHED', NULL::uuid, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  INSERT INTO identity_internal_credentials (user_id, verifier_version, password_salt, password_verifier)
  VALUES (p_target_user_id, 'scrypt-v1', p_password_salt, p_password_verifier);
  UPDATE access_employee_profiles AS profile
     SET display_name = p_display_name, record_version = record_version + 1, updated_at = transaction_timestamp()
   WHERE profile.membership_id = v_membership.id AND profile.organization_id = p_organization_id;
  UPDATE identity_users AS identity_user
     SET status = 'active', record_version = record_version + 1, updated_at = transaction_timestamp()
   WHERE identity_user.id = p_target_user_id;
  UPDATE access_organization_memberships AS membership
     SET status = 'active', record_version = record_version + 1, updated_at = transaction_timestamp()
   WHERE membership.id = v_membership.id;
  UPDATE identity_invites AS invite
     SET status = 'redeemed', consumed_at = transaction_timestamp(), record_version = record_version + 1, updated_at = transaction_timestamp()
   WHERE invite.id = p_invite_id;
  INSERT INTO identity_sessions (
    id, user_id, organization_id, membership_id, secret_hash, captured_session_version,
    session_slot, status, session_kind, provider_token_ciphertext, provider_token_key_version,
    last_seen_at, idle_expires_at, absolute_expires_at, reauthenticated_at, created_at, updated_at
  ) VALUES (
    p_session_id, p_target_user_id, p_organization_id, v_membership.id, p_session_secret_hash,
    v_user.session_version, v_slot, 'active', 'internal_email', NULL, NULL,
    v_now, v_now + interval '8 hours', v_now + interval '24 hours', v_now, v_now, v_now
  );
  RETURN QUERY SELECT true, NULL::text, p_target_user_id, v_user.normalized_email, v_membership.id,
    v_role_binding.id, v_role_binding.role, p_session_id, v_user.session_version, v_now;
END;
$function$;

REVOKE ALL ON FUNCTION identity_internal_email_activate_invite(uuid, uuid, uuid, bytea, bytea, bytea, text, uuid, bytea, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_internal_email_activate_invite(uuid, uuid, uuid, bytea, bytea, bytea, text, uuid, bytea, timestamptz) TO tianxing_app;

-- A resend keeps the immutable invite identity but replaces its latest
-- provider receipt after the activation secret has been rotated.
GRANT UPDATE (receipt_reference, delivered_at)
  ON identity_invite_delivery_receipts TO tianxing_app;
