-- P1-BE-02: corrective identity/access boundary. Historical migrations remain immutable.

ALTER TABLE identity_users
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_by_user_id uuid REFERENCES identity_users (id),
  ADD COLUMN disable_reason_code text;

UPDATE identity_users
   SET activated_at = COALESCE(activated_at, created_at)
 WHERE status = 'active';

UPDATE identity_users
   SET activated_at = COALESCE(activated_at, created_at),
       disabled_at = COALESCE(disabled_at, updated_at),
       disable_reason_code = COALESCE(disable_reason_code, 'legacy_disabled')
 WHERE status = 'disabled';

ALTER TABLE identity_users
  ADD CONSTRAINT identity_users_lifecycle_check CHECK (
    (status = 'invited' AND activated_at IS NULL AND disabled_at IS NULL AND disable_reason_code IS NULL)
    OR (status = 'active' AND activated_at IS NOT NULL AND disabled_at IS NULL AND disable_reason_code IS NULL)
    OR (status = 'disabled' AND activated_at IS NOT NULL AND disabled_at IS NOT NULL
      AND disable_reason_code IS NOT NULL AND btrim(disable_reason_code) <> '')
  );

CREATE OR REPLACE FUNCTION identity_validate_user_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.normalized_email IS DISTINCT FROM OLD.normalized_email THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'identity_users_email_immutable_check',
      MESSAGE = 'normalized email is immutable after user creation';
  END IF;
  IF NEW.status <> OLD.status
     AND NOT (OLD.status = 'invited' AND NEW.status = 'active')
     AND NOT (OLD.status = 'active' AND NEW.status = 'disabled') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'identity_users_status_transition_check',
      MESSAGE = 'invalid identity user lifecycle transition';
  END IF;
  IF NEW.status = 'active' AND NEW.activated_at IS NULL THEN
    NEW.activated_at := transaction_timestamp();
  END IF;
  IF NEW.status = 'disabled' AND NEW.disabled_at IS NULL THEN
    NEW.disabled_at := transaction_timestamp();
  END IF;
  IF NEW.status = 'disabled' AND (NEW.disable_reason_code IS NULL OR btrim(NEW.disable_reason_code) = '') THEN
    NEW.disable_reason_code := 'disabled';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS identity_users_validate_lifecycle ON identity_users;
CREATE TRIGGER identity_users_validate_lifecycle
BEFORE UPDATE ON identity_users
FOR EACH ROW EXECUTE FUNCTION identity_validate_user_lifecycle();

ALTER TABLE access_organization_memberships
  ADD CONSTRAINT access_organization_memberships_id_organization_key UNIQUE (id, organization_id);

UPDATE access_role_bindings
   SET status = 'revoked',
       record_version = record_version + 1,
       updated_at = transaction_timestamp()
 WHERE role = 'data_reviewer' AND status = 'active';

ALTER TABLE access_organization_memberships
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_by_user_id uuid REFERENCES identity_users (id),
  ADD COLUMN disable_reason_code text;

UPDATE access_organization_memberships
   SET activated_at = COALESCE(activated_at, created_at)
 WHERE status = 'active';

UPDATE access_organization_memberships
   SET activated_at = COALESCE(activated_at, created_at),
       disabled_at = COALESCE(disabled_at, updated_at),
       disable_reason_code = COALESCE(disable_reason_code, 'legacy_disabled')
 WHERE status = 'disabled';

ALTER TABLE access_organization_memberships
  ADD CONSTRAINT access_memberships_lifecycle_check CHECK (
    (status = 'invited' AND activated_at IS NULL AND disabled_at IS NULL AND disable_reason_code IS NULL)
    OR (status = 'active' AND activated_at IS NOT NULL AND disabled_at IS NULL AND disable_reason_code IS NULL)
    OR (status = 'disabled' AND activated_at IS NOT NULL AND disabled_at IS NOT NULL
      AND disable_reason_code IS NOT NULL AND btrim(disable_reason_code) <> '')
  );

CREATE OR REPLACE FUNCTION access_validate_membership_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'access_memberships_identity_immutable_check',
      MESSAGE = 'membership identity is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status <> OLD.status
     AND NOT (OLD.status = 'invited' AND NEW.status = 'active')
     AND NOT (OLD.status = 'active' AND NEW.status = 'disabled') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'access_memberships_status_transition_check',
      MESSAGE = 'invalid membership lifecycle transition';
  END IF;
  IF NEW.status = 'active' AND NEW.activated_at IS NULL THEN NEW.activated_at := transaction_timestamp(); END IF;
  IF NEW.status = 'disabled' AND NEW.disabled_at IS NULL THEN NEW.disabled_at := transaction_timestamp(); END IF;
  IF NEW.status = 'disabled' AND (NEW.disable_reason_code IS NULL OR btrim(NEW.disable_reason_code) = '') THEN
    NEW.disable_reason_code := 'disabled';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS access_memberships_validate_lifecycle ON access_organization_memberships;
CREATE TRIGGER access_memberships_validate_lifecycle
BEFORE UPDATE ON access_organization_memberships
FOR EACH ROW EXECUTE FUNCTION access_validate_membership_lifecycle();

CREATE TABLE access_employee_profiles (
  membership_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  display_name text NOT NULL,
  employment_type text NOT NULL,
  avatar_key text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT access_employee_profiles_membership_fk FOREIGN KEY (
    membership_id, organization_id
  ) REFERENCES access_organization_memberships (id, organization_id),
  CONSTRAINT access_employee_profiles_display_name_check CHECK (btrim(display_name) <> ''),
  CONSTRAINT access_employee_profiles_employment_type_check CHECK (employment_type IN ('FULL_TIME', 'PART_TIME')),
  CONSTRAINT access_employee_profiles_record_version_check CHECK (record_version >= 1),
  CONSTRAINT access_employee_profiles_timestamps_check CHECK (updated_at >= created_at)
);

CREATE OR REPLACE FUNCTION access_validate_employee_profile_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'access_employee_profiles_identity_immutable_check',
      MESSAGE = 'employee profile identity is immutable';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'access_employee_profiles_version_check',
      MESSAGE = 'employee profile updates must increment record_version exactly once';
  END IF;
  NEW.display_name := btrim(NEW.display_name);
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER access_employee_profiles_validate_update
BEFORE UPDATE ON access_employee_profiles
FOR EACH ROW EXECUTE FUNCTION access_validate_employee_profile_write();

ALTER TABLE access_role_bindings
  ADD CONSTRAINT access_role_bindings_active_role_vocabulary_check CHECK (
    status <> 'active' OR role IN ('founder', 'admin', 'advisor', 'contractor')
  );

CREATE OR REPLACE FUNCTION access_validate_role_binding_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_count integer;
  existing_contractor boolean;
  employment text;
BEGIN
  IF NEW.status = 'active' THEN
    IF NEW.role = 'data_reviewer' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'access_role_bindings_active_role_vocabulary_check',
        MESSAGE = 'data reviewer is not an active release role';
    END IF;
    SELECT count(*) FILTER (WHERE status = 'active'),
           bool_or(status = 'active' AND role = 'contractor')
      INTO active_count, existing_contractor
      FROM access_role_bindings
     WHERE membership_id = NEW.membership_id
       AND organization_id = NEW.organization_id
       AND user_id = NEW.user_id
       AND id IS DISTINCT FROM NEW.id;
    IF (NEW.role = 'contractor' AND active_count > 0)
       OR (NEW.role <> 'contractor' AND COALESCE(existing_contractor, false)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'access_role_bindings_contractor_exclusive_check',
        MESSAGE = 'contractor must be the only active role';
    END IF;
    SELECT employment_type INTO employment
      FROM access_employee_profiles
     WHERE membership_id = NEW.membership_id
       AND organization_id = NEW.organization_id;
    IF (employment = 'FULL_TIME' AND NEW.role = 'contractor')
       OR (employment = 'PART_TIME' AND NEW.role IN ('founder', 'advisor')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'access_role_bindings_employment_type_check',
        MESSAGE = 'role is incompatible with employee employment type';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.role = 'founder' AND OLD.status = 'active'
     AND NEW.status = 'revoked' THEN
    SELECT count(*) INTO active_count
      FROM access_role_bindings AS remaining_role
      JOIN access_organization_memberships AS remaining_membership
        ON remaining_membership.id = remaining_role.membership_id
       AND remaining_membership.organization_id = remaining_role.organization_id
       AND remaining_membership.status = 'active'
     WHERE remaining_role.organization_id = OLD.organization_id
       AND remaining_role.role = 'founder'
       AND remaining_role.status = 'active'
       AND remaining_role.id IS DISTINCT FROM OLD.id;
    IF active_count = 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'access_role_bindings_last_founder_check',
        MESSAGE = 'organization must retain an active founder';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER access_role_bindings_validate_write
BEFORE INSERT OR UPDATE ON access_role_bindings
FOR EACH ROW EXECUTE FUNCTION access_validate_role_binding_write();

ALTER TABLE identity_invites
  ALTER COLUMN requested_role DROP NOT NULL,
  ADD COLUMN credential_version text NOT NULL DEFAULT 'v1',
  ADD COLUMN expired_at timestamptz,
  ADD COLUMN revoked_by_user_id uuid REFERENCES identity_users (id),
  ADD COLUMN revoke_reason_code text;

UPDATE identity_invites
   SET expired_at = COALESCE(expired_at, updated_at)
 WHERE status = 'expired';
UPDATE identity_invites
   SET revoke_reason_code = COALESCE(revoke_reason_code, revoke_reason, 'legacy_revoked')
 WHERE status = 'revoked';

ALTER TABLE identity_invites DROP CONSTRAINT identity_invites_state_receipt_check;
ALTER TABLE identity_invites
  ADD CONSTRAINT identity_invites_lifecycle_check CHECK (
    expires_at <= created_at + interval '72 hours'
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

CREATE OR REPLACE FUNCTION identity_validate_invite_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.requested_role = 'data_reviewer' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'identity_invites_role_check',
      MESSAGE = 'data reviewer cannot be requested for a new invite';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status <> OLD.status
     AND NOT (OLD.status = 'created' AND NEW.status IN ('redeemed', 'expired', 'revoked')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'identity_invites_status_transition_check',
      MESSAGE = 'invite terminal state is immutable';
  END IF;
  IF NEW.status = 'expired' AND NEW.expired_at IS NULL THEN NEW.expired_at := transaction_timestamp(); END IF;
  IF NEW.status = 'revoked' AND NEW.revoke_reason_code IS NULL THEN NEW.revoke_reason_code := NEW.revoke_reason; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS identity_invites_validate_status_transition ON identity_invites;
CREATE TRIGGER identity_invites_validate_write
BEFORE INSERT OR UPDATE ON identity_invites
FOR EACH ROW EXECUTE FUNCTION identity_validate_invite_write();

ALTER TABLE identity_sessions
  ALTER COLUMN organization_id DROP NOT NULL,
  ALTER COLUMN membership_id DROP NOT NULL;
ALTER TABLE identity_sessions DROP CONSTRAINT identity_sessions_membership_fk;
ALTER TABLE identity_sessions DROP CONSTRAINT identity_sessions_time_window_check;
ALTER TABLE identity_sessions
  ADD CONSTRAINT identity_sessions_p1_time_window_check CHECK (
    last_seen_at >= created_at
    AND idle_expires_at > last_seen_at
    AND idle_expires_at <= last_seen_at + interval '8 hours'
    AND absolute_expires_at > created_at
    AND absolute_expires_at <= created_at + interval '24 hours'
    AND idle_expires_at <= absolute_expires_at
    AND (reauthenticated_at IS NULL OR reauthenticated_at BETWEEN created_at AND absolute_expires_at)
  );

CREATE OR REPLACE FUNCTION identity_validate_session_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_user_status text;
  current_session_version bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
    OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
    OR NEW.captured_session_version IS DISTINCT FROM OLD.captured_session_version
    OR NEW.session_slot IS DISTINCT FROM OLD.session_slot
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'identity_sessions_immutable_fields_check',
      MESSAGE = 'identity session facts are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status <> OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status IN ('revoked', 'expired')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'identity_sessions_status_transition_check',
      MESSAGE = 'invalid identity session status transition';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status = 'active' THEN
    SELECT status, session_version INTO current_user_status, current_session_version
      FROM identity_users WHERE id = NEW.user_id FOR SHARE;
    IF current_user_status IS DISTINCT FROM 'active'
       OR current_session_version IS DISTINCT FROM NEW.captured_session_version THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'identity_sessions_current_user_version_check',
        MESSAGE = 'active session must capture the current active User version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION identity_resolve_session_principal(
  p_secret_hash bytea,
  p_now timestamptz,
  p_sensitive_action boolean
)
RETURNS TABLE (
  allowed boolean,
  user_id uuid,
  session_id uuid,
  captured_session_version bigint,
  reauthenticated_at timestamptz,
  denial_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_session public.identity_sessions%ROWTYPE;
  v_user public.identity_users%ROWTYPE;
  v_now timestamptz;
  v_denial text;
BEGIN
  IF p_secret_hash IS NULL OR octet_length(p_secret_hash) <> 32 OR p_now IS NULL
     OR p_sensitive_action IS NULL
     OR p_now < transaction_timestamp() - interval '5 minutes'
     OR p_now > transaction_timestamp() + interval '5 minutes' THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::bigint, NULL::timestamptz, 'SESSION_NOT_FOUND'::text;
    RETURN;
  END IF;
  v_now := transaction_timestamp();
  SELECT session.* INTO v_session
    FROM public.identity_sessions AS session
   WHERE session.secret_hash = p_secret_hash
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::bigint, NULL::timestamptz, 'SESSION_NOT_FOUND'::text;
    RETURN;
  END IF;
  SELECT identity_user.* INTO v_user
    FROM public.identity_users AS identity_user
   WHERE identity_user.id = v_session.user_id
   FOR SHARE;
  IF NOT FOUND OR v_user.status <> 'active' THEN v_denial := 'USER_DISABLED';
  ELSIF v_session.status <> 'active' THEN v_denial := 'SESSION_NOT_ACTIVE';
  ELSIF v_session.captured_session_version <> v_user.session_version THEN v_denial := 'SESSION_VERSION_STALE';
  ELSIF v_now >= v_session.absolute_expires_at THEN v_denial := 'SESSION_ABSOLUTE_EXPIRED';
  ELSIF v_now >= v_session.idle_expires_at THEN v_denial := 'SESSION_IDLE_EXPIRED';
  ELSIF p_sensitive_action AND (v_session.reauthenticated_at IS NULL
    OR v_session.reauthenticated_at > v_now
    OR v_now - v_session.reauthenticated_at > interval '5 minutes') THEN
    v_denial := 'SENSITIVE_REAUTH_REQUIRED';
  END IF;
  IF v_denial IS NOT NULL THEN
    UPDATE public.identity_sessions
       SET status = CASE WHEN v_denial IN ('SESSION_ABSOLUTE_EXPIRED', 'SESSION_IDLE_EXPIRED')
                         THEN 'expired' ELSE 'revoked' END,
           revoked_at = CASE WHEN v_denial IN ('SESSION_ABSOLUTE_EXPIRED', 'SESSION_IDLE_EXPIRED')
                             THEN NULL ELSE v_now END,
           revoke_reason = CASE WHEN v_denial IN ('SESSION_ABSOLUTE_EXPIRED', 'SESSION_IDLE_EXPIRED')
                                THEN NULL ELSE lower(v_denial) END,
           record_version = record_version + 1,
           updated_at = v_now
     WHERE id = v_session.id AND status = 'active';
    RETURN QUERY SELECT false, NULL::uuid, v_session.id, v_session.captured_session_version,
      v_session.reauthenticated_at, v_denial;
    RETURN;
  END IF;
  UPDATE public.identity_sessions
     SET last_seen_at = v_now,
         idle_expires_at = least(v_now + interval '8 hours', absolute_expires_at),
         record_version = record_version + 1,
         updated_at = v_now
   WHERE id = v_session.id AND status = 'active';
  RETURN QUERY SELECT true, v_session.user_id, v_session.id, v_session.captured_session_version,
    v_session.reauthenticated_at, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION identity_resolve_session_principal(bytea, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_resolve_session_principal(bytea, timestamptz, boolean) TO tianxing_app;

CREATE OR REPLACE FUNCTION access_resolve_workspace_context(p_user_id uuid)
RETURNS TABLE (
  user_id uuid,
  organization_id uuid,
  membership_id uuid,
  role_binding_id uuid,
  role text,
  membership_record_version bigint,
  role_binding_record_version bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT membership.user_id,
         membership.organization_id,
         membership.id,
         role_binding.id,
         role_binding.role,
         membership.record_version,
         role_binding.record_version
    FROM public.identity_users AS identity_user
    JOIN public.access_organization_memberships AS membership
      ON membership.user_id = identity_user.id
     AND membership.status = 'active'
    JOIN public.access_organizations AS organization
      ON organization.id = membership.organization_id
     AND organization.status = 'active'
    JOIN public.access_role_bindings AS role_binding
      ON role_binding.organization_id = membership.organization_id
     AND role_binding.membership_id = membership.id
     AND role_binding.user_id = membership.user_id
     AND role_binding.status = 'active'
     AND role_binding.role IN ('founder', 'admin', 'advisor', 'contractor')
   WHERE identity_user.id = p_user_id
     AND identity_user.status = 'active'
   ORDER BY role_binding.id;
$$;

REVOKE ALL ON FUNCTION access_resolve_workspace_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access_resolve_workspace_context(uuid) TO tianxing_app;

ALTER TABLE access_scope_grants
  ADD COLUMN expired_at timestamptz,
  ADD COLUMN revoke_reason_code text;

CREATE UNIQUE INDEX access_scope_grants_one_current_scope_idx
  ON access_scope_grants (collaborator_id, scope)
  WHERE status IN ('pending_approval', 'active');

CREATE OR REPLACE FUNCTION access_validate_scope_grant_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE collaborator_expires timestamptz;
BEGIN
  SELECT expires_at INTO collaborator_expires
    FROM access_case_collaborators
   WHERE id = NEW.collaborator_id
     AND organization_id = NEW.organization_id
     AND case_id = NEW.case_id;
  IF collaborator_expires IS NULL OR NEW.expires_at > collaborator_expires THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'access_scope_grants_collaborator_window_check',
      MESSAGE = 'scope grant cannot outlive its collaborator';
  END IF;
  IF NEW.status = 'expired' AND NEW.expired_at IS NULL THEN NEW.expired_at := transaction_timestamp(); END IF;
  IF NEW.status = 'revoked' AND NEW.revoke_reason_code IS NULL THEN NEW.revoke_reason_code := NEW.revoke_reason; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER access_scope_grants_validate_boundary
BEFORE INSERT OR UPDATE ON access_scope_grants
FOR EACH ROW EXECUTE FUNCTION access_validate_scope_grant_boundary();

CREATE OR REPLACE FUNCTION access_reject_physical_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'identity/access history is append-only';
END;
$$;

CREATE TRIGGER access_memberships_reject_delete
BEFORE DELETE ON access_organization_memberships FOR EACH ROW EXECUTE FUNCTION access_reject_physical_delete();
CREATE TRIGGER access_roles_reject_delete
BEFORE DELETE ON access_role_bindings FOR EACH ROW EXECUTE FUNCTION access_reject_physical_delete();
CREATE TRIGGER access_employee_profiles_reject_delete
BEFORE DELETE ON access_employee_profiles FOR EACH ROW EXECUTE FUNCTION access_reject_physical_delete();
CREATE TRIGGER access_collaborators_reject_delete
BEFORE DELETE ON access_case_collaborators FOR EACH ROW EXECUTE FUNCTION access_reject_physical_delete();
CREATE TRIGGER access_grants_reject_delete
BEFORE DELETE ON access_scope_grants FOR EACH ROW EXECUTE FUNCTION access_reject_physical_delete();
CREATE TRIGGER identity_provider_bindings_reject_delete
BEFORE DELETE ON identity_provider_identities FOR EACH ROW EXECUTE FUNCTION access_reject_physical_delete();
CREATE TRIGGER identity_invites_reject_delete
BEFORE DELETE ON identity_invites FOR EACH ROW EXECUTE FUNCTION access_reject_physical_delete();

REVOKE DELETE ON TABLE access_employee_profiles FROM PUBLIC, tianxing_app;
GRANT SELECT, INSERT, UPDATE ON TABLE access_employee_profiles TO tianxing_app;
ALTER TABLE access_employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_employee_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tianxing_employee_profile_tenant_boundary ON access_employee_profiles
  FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));

REVOKE DELETE ON TABLE access_organization_memberships, access_role_bindings,
  access_case_collaborators, access_scope_grants FROM tianxing_app;

ALTER TABLE access_organization_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE access_role_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE access_case_collaborators FORCE ROW LEVEL SECURITY;
ALTER TABLE access_scope_grants FORCE ROW LEVEL SECURITY;
