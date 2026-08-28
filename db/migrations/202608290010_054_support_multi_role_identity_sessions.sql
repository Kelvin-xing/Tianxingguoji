-- Database-test Identity keeps one deterministic compatibility role while
-- request-time Access resolves the complete active role union.
CREATE OR REPLACE FUNCTION identity_database_test_complete_login(
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
  v_credential public.identity_database_test_credentials%ROWTYPE;
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
  IF p_user_id IS NULL
     OR p_expected_credential_version IS NULL
     OR p_password_matched IS NULL
     OR p_session_id IS NULL
     OR p_secret_hash IS NULL
     OR p_now IS NULL
     OR p_now < transaction_timestamp() - interval '5 minutes'
     OR p_now > transaction_timestamp() + interval '5 minutes'
     OR octet_length(p_secret_hash) <> 32 THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  v_now := transaction_timestamp();

  SELECT credential.* INTO v_credential
    FROM public.identity_database_test_credentials AS credential
   WHERE credential.user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_credential.status <> 'active'
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
    UPDATE public.identity_database_test_credentials
       SET failed_attempt_count = v_failed_count,
           failure_window_started_at = CASE
             WHEN v_failed_count = 1 THEN v_now
             ELSE failure_window_started_at
           END,
           locked_until = CASE
             WHEN v_failed_count >= 5 THEN v_now + interval '15 minutes'
             ELSE NULL
           END,
           updated_at = v_now
     WHERE identity_database_test_credentials.user_id = p_user_id;
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT identity_user.normalized_email,
         identity_user.status,
         identity_user.session_version,
         membership.organization_id,
         membership.id
    INTO v_normalized_email, v_user_status, v_session_version,
         v_organization_id, v_membership_id
    FROM public.identity_users AS identity_user
    JOIN public.access_organization_memberships AS membership
      ON membership.user_id = identity_user.id
     AND membership.status = 'active'
    JOIN public.access_organizations AS organization
      ON organization.id = membership.organization_id
     AND organization.status = 'active'
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
     AND role_binding.user_id = p_user_id
     AND role_binding.status = 'active';
  IF v_role_count < 1 THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT role_binding.id, role_binding.role
    INTO v_role_binding_id, v_role
    FROM public.access_role_bindings AS role_binding
   WHERE role_binding.membership_id = v_membership_id
     AND role_binding.organization_id = v_organization_id
     AND role_binding.user_id = p_user_id
     AND role_binding.status = 'active'
   ORDER BY CASE role_binding.role
     WHEN 'founder' THEN 1
     WHEN 'admin' THEN 2
     WHEN 'advisor' THEN 3
     WHEN 'contractor' THEN 4
     ELSE 5
   END, role_binding.id
   LIMIT 1
   FOR SHARE;

  UPDATE public.identity_database_test_credentials
     SET failed_attempt_count = 0,
         failure_window_started_at = NULL,
         locked_until = NULL,
         updated_at = v_now
   WHERE identity_database_test_credentials.user_id = p_user_id;
  UPDATE public.identity_sessions
     SET status = 'revoked',
         revoked_at = v_now,
         revoke_reason = 'database_test_relogin',
         record_version = record_version + 1,
         updated_at = v_now
   WHERE identity_sessions.user_id = p_user_id
     AND identity_sessions.session_kind = 'database_test'
     AND identity_sessions.status = 'active';
  INSERT INTO public.identity_sessions (
    id, user_id, organization_id, membership_id, secret_hash,
    captured_session_version, session_slot, status, session_kind,
    provider_token_ciphertext, provider_token_key_version,
    last_seen_at, idle_expires_at, absolute_expires_at, reauthenticated_at,
    created_at, updated_at
  ) VALUES (
    p_session_id, p_user_id, v_organization_id, v_membership_id, p_secret_hash,
    v_session_version, 1, 'active', 'database_test', NULL, NULL,
    v_now, v_now + interval '15 minutes', v_now + interval '8 hours', v_now,
    v_now, v_now
  );

  RETURN QUERY SELECT true, p_user_id, v_normalized_email, v_organization_id,
    v_membership_id, v_role_binding_id, v_role, p_session_id, v_session_version, v_now;
END;
$function$;

CREATE OR REPLACE FUNCTION identity_database_test_resolve_session(
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
  IF p_secret_hash IS NULL
     OR p_now IS NULL
     OR p_sensitive_action IS NULL
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
     AND session.session_kind = 'database_test'
   FOR UPDATE;
  IF NOT FOUND OR v_session.status <> 'active' THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT identity_user.normalized_email, identity_user.status, identity_user.session_version,
         organization.status, membership.status
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
     AND role_binding.user_id = v_session.user_id
     AND role_binding.status = 'active';

  IF NOT v_identity_found
     OR v_user_status <> 'active'
     OR v_current_session_version <> v_session.captured_session_version
     OR v_organization_status <> 'active'
     OR v_membership_status <> 'active'
     OR v_role_count < 1 THEN
    UPDATE public.identity_sessions
       SET status = 'revoked', revoked_at = v_now,
           revoke_reason = 'database_test_identity_inactive',
           record_version = record_version + 1, updated_at = v_now
     WHERE id = v_session.id AND status = 'active';
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_now >= v_session.absolute_expires_at OR v_now >= v_session.idle_expires_at THEN
    UPDATE public.identity_sessions
       SET status = 'expired', record_version = record_version + 1,
           updated_at = v_now
     WHERE id = v_session.id AND status = 'active';
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_sensitive_action AND (
    v_session.reauthenticated_at IS NULL
    OR v_now > v_session.reauthenticated_at + interval '5 minutes'
  ) THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT role_binding.id, role_binding.role
    INTO v_role_binding_id, v_role
    FROM public.access_role_bindings AS role_binding
   WHERE role_binding.membership_id = v_session.membership_id
     AND role_binding.organization_id = v_session.organization_id
     AND role_binding.user_id = v_session.user_id
     AND role_binding.status = 'active'
   ORDER BY CASE role_binding.role
     WHEN 'founder' THEN 1
     WHEN 'admin' THEN 2
     WHEN 'advisor' THEN 3
     WHEN 'contractor' THEN 4
     ELSE 5
   END, role_binding.id
   LIMIT 1
   FOR SHARE;
  UPDATE public.identity_sessions
     SET last_seen_at = v_now,
         idle_expires_at = least(v_now + interval '15 minutes', absolute_expires_at),
         record_version = record_version + 1,
         updated_at = v_now
   WHERE id = v_session.id AND status = 'active';

  RETURN QUERY SELECT true, v_session.user_id, v_normalized_email,
    v_session.organization_id, v_session.membership_id, v_role_binding_id, v_role,
    v_session.id, v_session.captured_session_version, v_session.reauthenticated_at;
END;
$function$;

CREATE OR REPLACE FUNCTION identity_database_test_provision_credential(
  p_normalized_email text,
  p_verifier_version text,
  p_password_salt bytea,
  p_password_verifier bytea,
  p_rotate boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_user_id uuid;
  v_credential_exists boolean;
  v_membership_count integer;
  v_role_count integer;
BEGIN
  IF p_normalized_email IS NULL
     OR p_verifier_version IS NULL
     OR p_password_salt IS NULL
     OR p_password_verifier IS NULL
     OR p_rotate IS NULL
     OR p_normalized_email <> lower(btrim(p_normalized_email))
     OR p_normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.invalid$'
     OR p_verifier_version <> 'scrypt-v1'
     OR octet_length(p_password_salt) <> 32
     OR octet_length(p_password_verifier) <> 64 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'database test credential input rejected';
  END IF;

  SELECT identity_user.id INTO v_user_id
    FROM public.identity_users AS identity_user
   WHERE identity_user.normalized_email = p_normalized_email
     AND identity_user.status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'identity_not_found';
  END IF;
  SELECT count(*) INTO v_membership_count
    FROM public.access_organization_memberships AS membership
    JOIN public.access_organizations AS organization
      ON organization.id = membership.organization_id AND organization.status = 'active'
   WHERE membership.user_id = v_user_id AND membership.status = 'active';
  SELECT count(*) INTO v_role_count
    FROM public.access_role_bindings AS role_binding
    JOIN public.access_organization_memberships AS membership
      ON membership.id = role_binding.membership_id
   WHERE membership.user_id = v_user_id
     AND membership.status = 'active'
     AND role_binding.status = 'active';
  IF v_membership_count <> 1 OR v_role_count < 1 THEN
    RETURN 'identity_not_eligible';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.identity_database_test_credentials AS credential
     WHERE credential.user_id = v_user_id
  ) INTO v_credential_exists;
  IF v_credential_exists AND NOT p_rotate THEN
    RETURN 'rotation_required';
  END IF;

  INSERT INTO public.identity_database_test_credentials (
    user_id, verifier_version, password_salt, password_verifier
  ) VALUES (
    v_user_id, p_verifier_version, p_password_salt, p_password_verifier
  )
  ON CONFLICT (user_id) DO UPDATE
    SET verifier_version = EXCLUDED.verifier_version,
        password_salt = EXCLUDED.password_salt,
        password_verifier = EXCLUDED.password_verifier,
        status = 'active', failed_attempt_count = 0,
        failure_window_started_at = NULL, locked_until = NULL,
        credential_version = identity_database_test_credentials.credential_version + 1,
        updated_at = transaction_timestamp();
  UPDATE public.identity_sessions
     SET status = 'revoked', revoked_at = transaction_timestamp(),
         revoke_reason = 'database_test_credential_rotated',
         record_version = record_version + 1, updated_at = transaction_timestamp()
   WHERE user_id = v_user_id AND session_kind = 'database_test' AND status = 'active';
  RETURN CASE WHEN v_credential_exists THEN 'rotated' ELSE 'created' END;
END;
$function$;
