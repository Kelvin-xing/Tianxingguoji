-- BR-014/015: explicit trial invitations, no automatic legacy enrollment.
ALTER TABLE identity_invites DROP CONSTRAINT identity_invites_role_check;
ALTER TABLE identity_invites ADD CONSTRAINT identity_invites_role_check
  CHECK (requested_role IN ('founder','admin','advisor','data_reviewer','contractor','l1','l2','l3'));
ALTER TABLE identity_invites ADD COLUMN trial_categories text[];
ALTER TABLE identity_invites ADD CONSTRAINT identity_invites_trial_scope_check CHECK (
  (trial_categories IS NULL AND (requested_role IS NULL OR requested_role IN ('founder','admin','advisor','data_reviewer','contractor')))
  OR (trial_categories IS NOT NULL AND requested_role IS NOT NULL AND requested_role IN ('founder','l1','l2','l3')
    AND trial_categories IN ('{}'::text[],ARRAY['international_school'],ARRAY['local_school'],ARRAY['international_school','local_school'])
    AND (requested_role='l2' OR cardinality(trial_categories)=0))
);

CREATE FUNCTION identity_require_current_inviter(p_organization_id uuid,p_actor_user_id uuid,p_model text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE v_trial access_trial_members%ROWTYPE;
BEGIN
  IF p_organization_id::text IS DISTINCT FROM current_setting('app.organization_id',true) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='FOUNDER_REQUIRED';
  END IF;
  -- Trial writes already serialize on this organization lock. Take it first.
  PERFORM 1 FROM access_organizations WHERE id=p_organization_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='FOUNDER_REQUIRED'; END IF;
  SELECT * INTO v_trial FROM access_trial_members
    WHERE organization_id=p_organization_id AND user_id=p_actor_user_id FOR SHARE;
  IF (FOUND AND (v_trial.level<>'founder' OR v_trial.status<>'active' OR p_model='legacy'))
    OR (NOT FOUND AND p_model='trial') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='FOUNDER_REQUIRED';
  END IF;
  PERFORM 1 FROM identity_users u
    JOIN access_organization_memberships m ON m.user_id=u.id AND m.organization_id=p_organization_id
    JOIN access_role_bindings b ON b.membership_id=m.id AND b.organization_id=m.organization_id AND b.user_id=u.id
    WHERE u.id=p_actor_user_id AND u.status='active' AND m.status='active'
      AND b.status='active' AND b.role='founder' FOR SHARE OF u,m,b;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='FOUNDER_REQUIRED'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION identity_require_current_inviter(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_require_current_inviter(uuid,uuid,text) TO tianxing_app;

CREATE FUNCTION identity_preserve_invite_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id OR NEW.invited_by_user_id IS DISTINCT FROM OLD.invited_by_user_id
    OR NEW.requested_role IS DISTINCT FROM OLD.requested_role OR NEW.trial_categories IS DISTINCT FROM OLD.trial_categories
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='invitation identity and original scope are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_invites_preserve_identity BEFORE UPDATE ON identity_invites
  FOR EACH ROW EXECUTE FUNCTION identity_preserve_invite_identity();
REVOKE ALL ON FUNCTION identity_preserve_invite_identity() FROM PUBLIC;

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
  p_expires_at timestamptz,
  p_trial_categories text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM identity_require_current_inviter(p_organization_id,p_invited_by_user_id,
    CASE WHEN p_trial_categories IS NULL THEN 'legacy' ELSE 'trial' END);
  IF p_trial_categories IS NULL THEN
    IF p_role NOT IN ('founder','admin','advisor','contractor') THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='invalid legacy invitation role';
    END IF;
  ELSE
    IF p_role NOT IN ('founder','l1','l2','l3') OR
      p_trial_categories NOT IN ('{}'::text[],ARRAY['international_school'],ARRAY['local_school'],ARRAY['international_school','local_school']) OR
      (p_role<>'l2' AND cardinality(p_trial_categories)<>0) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='invalid trial invitation scope';
    END IF;
  END IF;
  INSERT INTO identity_users (id, normalized_email, status, created_by_user_id)
  VALUES (p_user_id, p_normalized_email, 'invited', p_invited_by_user_id);
  INSERT INTO access_organization_memberships (id, organization_id, user_id, status, created_by_user_id)
  VALUES (p_membership_id, p_organization_id, p_user_id, 'invited', p_invited_by_user_id);
  INSERT INTO access_employee_profiles (membership_id, organization_id, display_name, employment_type)
  VALUES (p_membership_id, p_organization_id, p_display_name, p_employment_type);
  IF p_trial_categories IS NOT NULL THEN
    INSERT INTO access_trial_members(membership_id,organization_id,user_id,level,categories,created_by_user_id,updated_by_user_id)
    VALUES(p_membership_id,p_organization_id,p_user_id,p_role,p_trial_categories,p_invited_by_user_id,p_invited_by_user_id);
  END IF;
  INSERT INTO access_role_bindings (id, organization_id, membership_id, user_id, role, status, created_by_user_id)
  VALUES (p_role_binding_id, p_organization_id, p_membership_id, p_user_id, p_role, 'active', p_invited_by_user_id);
  INSERT INTO identity_invites (
    id, organization_id, target_user_id, invited_by_user_id, requested_role,
    secret_hash, status, expires_at, credential_version, trial_categories
  ) VALUES (
    p_invite_id, p_organization_id, p_user_id, p_invited_by_user_id, p_role,
    p_secret_hash, 'created', p_expires_at, 'v1', p_trial_categories
  );
END;
$function$;

REVOKE ALL ON FUNCTION identity_internal_email_create_invite(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,timestamptz,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_internal_email_create_invite(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,timestamptz,text[]) TO tianxing_app;

CREATE OR REPLACE FUNCTION identity_internal_email_create_invite(
  p_invite_id uuid,p_user_id uuid,p_membership_id uuid,p_role_binding_id uuid,p_organization_id uuid,
  p_invited_by_user_id uuid,p_normalized_email text,p_role text,p_employment_type text,p_display_name text,
  p_secret_hash bytea,p_expires_at timestamptz
) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
  SELECT identity_internal_email_create_invite(p_invite_id,p_user_id,p_membership_id,p_role_binding_id,p_organization_id,
    p_invited_by_user_id,p_normalized_email,p_role,p_employment_type,p_display_name,p_secret_hash,p_expires_at,NULL::text[]);
$$;
REVOKE ALL ON FUNCTION identity_internal_email_create_invite(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_internal_email_create_invite(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,timestamptz) TO tianxing_app;

CREATE OR REPLACE FUNCTION identity_internal_email_activate_invite(
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
  v_trial access_trial_members%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_now IS NULL
     OR p_now < transaction_timestamp() - interval '5 minutes'
     OR p_now > transaction_timestamp() + interval '5 minutes' THEN
    RETURN QUERY SELECT false, 'INVITE_NOT_FOUND', NULL::uuid, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  -- Serialize against permission changes before locking the invitation or target.
  PERFORM 1 FROM access_organizations WHERE id=p_organization_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'INVITE_NOT_REDEEMABLE', NULL::uuid, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT t.* INTO v_trial FROM access_trial_members t
    WHERE t.organization_id=p_organization_id AND t.user_id=p_target_user_id FOR SHARE OF t;
  IF FOUND AND v_trial.status<>'active' THEN
    RETURN QUERY SELECT false, 'INVITE_NOT_REDEEMABLE', NULL::uuid, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::bigint, NULL::timestamptz;
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
  PERFORM set_config('app.actor_user_id',p_target_user_id::text,true);
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
  IF v_user.status <> 'invited' OR v_membership.status <> 'invited' OR v_role_binding.id IS NULL
     OR (v_invite.trial_categories IS NOT NULL AND v_trial.membership_id IS NULL)
     OR (v_trial.membership_id IS NOT NULL AND v_role_binding.role IS DISTINCT FROM v_trial.level) THEN
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
  PERFORM set_config('app.actor_user_id',p_target_user_id::text,true);
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


-- Trial invitation changes are inseparable from their audit/outbox facts.
CREATE FUNCTION identity_audit_trial_invitation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.actor_user_id',true),'')::uuid;
  event_name text;
  event_time timestamptz := clock_timestamp();
  fact_id uuid := gen_random_uuid();
  outbox_id uuid := gen_random_uuid();
  request_key text := COALESCE(nullif(current_setting('app.request_id',true),''),gen_random_uuid()::text);
BEGIN
  IF NEW.trial_categories IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN event_name := 'identity.trial_invite.created';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN event_name := 'identity.trial_invite.'||NEW.status;
  ELSIF NEW.secret_hash IS DISTINCT FROM OLD.secret_hash THEN event_name := 'identity.trial_invite.rotated';
  ELSE RETURN NEW; END IF;
  IF actor_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='invitation audit actor required'; END IF;
  INSERT INTO audit_events(id,organization_id,actor_user_id,actor_kind,event_type,event_version,action,
    resource_type,resource_id,outcome,request_id,occurred_at,metadata)
  VALUES(fact_id,NEW.organization_id,actor_id,'user',event_name,1,'record_invitation',
    'IdentityInvite',NEW.id,'succeeded',request_key,event_time,
    jsonb_build_object('effect_type',event_name,'record_version',NEW.record_version,'status',NEW.status));
  INSERT INTO audit_outbox(id,audit_event_id,organization_id,aggregate_type,aggregate_id,event_type,event_version,
    idempotency_key,request_id,payload,status,available_at,created_at,updated_at)
  VALUES(outbox_id,fact_id,NEW.organization_id,'IdentityInvite',NEW.id,event_name,1,
    'trial-invite-'||NEW.id::text||'-v'||NEW.record_version::text,request_key,
    jsonb_build_object('aggregate_id',NEW.id,'effect_type',event_name,'record_version',NEW.record_version,
      'request_id',request_key,'status',NEW.status),'pending',event_time,event_time,event_time);
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_invites_trial_audit AFTER INSERT OR UPDATE ON identity_invites
  FOR EACH ROW EXECUTE FUNCTION identity_audit_trial_invitation();
REVOKE ALL ON FUNCTION identity_audit_trial_invitation() FROM PUBLIC;
