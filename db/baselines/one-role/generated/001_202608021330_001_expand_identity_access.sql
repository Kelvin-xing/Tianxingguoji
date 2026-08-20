CREATE TABLE identity_users (
  id uuid PRIMARY KEY,
  normalized_email text NOT NULL,
  status text NOT NULL,
  session_version bigint NOT NULL DEFAULT 1,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by_user_id uuid,
  CONSTRAINT identity_users_normalized_email_check CHECK (
    normalized_email <> ''
    AND normalized_email = lower(btrim(normalized_email))
  ),
  CONSTRAINT identity_users_status_check CHECK (status IN ('invited', 'active', 'disabled')),
  CONSTRAINT identity_users_session_version_check CHECK (session_version >= 1),
  CONSTRAINT identity_users_record_version_check CHECK (record_version >= 1),
  CONSTRAINT identity_users_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT identity_users_normalized_email_key UNIQUE (normalized_email)
);

ALTER TABLE identity_users
  ADD CONSTRAINT identity_users_created_by_user_fk
  FOREIGN KEY (created_by_user_id) REFERENCES identity_users (id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE identity_provider_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity_users (id),
  provider text NOT NULL,
  provider_subject text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by_user_id uuid REFERENCES identity_users (id),
  CONSTRAINT identity_provider_identities_provider_check CHECK (provider = 'cognito'),
  CONSTRAINT identity_provider_identities_subject_check CHECK (btrim(provider_subject) <> ''),
  CONSTRAINT identity_provider_identities_record_version_check CHECK (record_version >= 1),
  CONSTRAINT identity_provider_identities_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT identity_provider_identities_provider_subject_key UNIQUE (
    provider,
    provider_subject
  ),
  CONSTRAINT identity_provider_identities_user_provider_key UNIQUE (user_id, provider)
);

CREATE TABLE access_organizations (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by_user_id uuid REFERENCES identity_users (id),
  CONSTRAINT access_organizations_display_name_check CHECK (btrim(display_name) <> ''),
  CONSTRAINT access_organizations_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT access_organizations_record_version_check CHECK (record_version >= 1),
  CONSTRAINT access_organizations_timestamps_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX access_organizations_one_active_idx
  ON access_organizations ((1))
  WHERE status = 'active';

CREATE TABLE access_organization_memberships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  user_id uuid NOT NULL REFERENCES identity_users (id),
  status text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by_user_id uuid REFERENCES identity_users (id),
  CONSTRAINT access_organization_memberships_status_check CHECK (
    status IN ('invited', 'active', 'disabled')
  ),
  CONSTRAINT access_organization_memberships_record_version_check CHECK (record_version >= 1),
  CONSTRAINT access_organization_memberships_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT access_organization_memberships_organization_user_key UNIQUE (
    organization_id,
    user_id
  ),
  CONSTRAINT access_organization_memberships_composite_key UNIQUE (
    id,
    organization_id,
    user_id
  )
);

CREATE TABLE access_role_bindings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  status text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by_user_id uuid REFERENCES identity_users (id),
  CONSTRAINT access_role_bindings_membership_fk FOREIGN KEY (
    membership_id,
    organization_id,
    user_id
  ) REFERENCES access_organization_memberships (id, organization_id, user_id),
  CONSTRAINT access_role_bindings_role_check CHECK (
    role IN ('founder', 'admin', 'advisor', 'data_reviewer', 'contractor')
  ),
  CONSTRAINT access_role_bindings_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT access_role_bindings_record_version_check CHECK (record_version >= 1),
  CONSTRAINT access_role_bindings_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT access_role_bindings_composite_key UNIQUE (
    id,
    organization_id,
    membership_id,
    user_id,
    role
  )
);

CREATE UNIQUE INDEX access_role_bindings_one_active_role_idx
  ON access_role_bindings (membership_id, role)
  WHERE status = 'active';

CREATE TABLE identity_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity_users (id),
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  secret_hash bytea NOT NULL,
  captured_session_version bigint NOT NULL,
  session_slot smallint NOT NULL,
  status text NOT NULL,
  provider_token_ciphertext bytea,
  provider_token_key_version text,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  reauthenticated_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES identity_users (id),
  revoke_reason text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT identity_sessions_membership_fk FOREIGN KEY (
    membership_id,
    organization_id,
    user_id
  ) REFERENCES access_organization_memberships (id, organization_id, user_id),
  CONSTRAINT identity_sessions_secret_hash_check CHECK (octet_length(secret_hash) = 32),
  CONSTRAINT identity_sessions_captured_version_check CHECK (captured_session_version >= 1),
  CONSTRAINT identity_sessions_slot_check CHECK (session_slot BETWEEN 1 AND 3),
  CONSTRAINT identity_sessions_status_check CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT identity_sessions_active_token_check CHECK (
    status <> 'active'
    OR (
      provider_token_ciphertext IS NOT NULL
      AND provider_token_key_version IS NOT NULL
      AND btrim(provider_token_key_version) <> ''
    )
  ),
  CONSTRAINT identity_sessions_time_window_check CHECK (
    last_seen_at >= created_at
    AND idle_expires_at > last_seen_at
    AND idle_expires_at <= last_seen_at + interval '15 minutes'
    AND absolute_expires_at > created_at
    AND absolute_expires_at <= created_at + interval '8 hours'
    AND idle_expires_at <= absolute_expires_at
    AND (reauthenticated_at IS NULL OR reauthenticated_at BETWEEN created_at AND absolute_expires_at)
  ),
  CONSTRAINT identity_sessions_revocation_check CHECK (
    (
      status = 'revoked'
      AND revoked_at IS NOT NULL
      AND revoke_reason IS NOT NULL
      AND btrim(revoke_reason) <> ''
    )
    OR (status <> 'revoked' AND revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoke_reason IS NULL)
  ),
  CONSTRAINT identity_sessions_record_version_check CHECK (record_version >= 1),
  CONSTRAINT identity_sessions_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT identity_sessions_secret_hash_key UNIQUE (secret_hash)
);

CREATE UNIQUE INDEX identity_sessions_active_slot_idx
  ON identity_sessions (user_id, session_slot)
  WHERE status = 'active';

CREATE TABLE identity_invites (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  target_user_id uuid NOT NULL REFERENCES identity_users (id),
  invited_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  requested_role text NOT NULL,
  secret_hash bytea NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT identity_invites_role_check CHECK (
    requested_role IN ('founder', 'admin', 'advisor', 'data_reviewer', 'contractor')
  ),
  CONSTRAINT identity_invites_secret_hash_check CHECK (octet_length(secret_hash) = 32),
  CONSTRAINT identity_invites_status_check CHECK (
    status IN ('created', 'redeemed', 'expired', 'revoked')
  ),
  CONSTRAINT identity_invites_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT identity_invites_state_receipt_check CHECK (
    (status = 'created' AND consumed_at IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'redeemed' AND consumed_at IS NOT NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'expired' AND consumed_at IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (
      status = 'revoked'
      AND consumed_at IS NULL
      AND revoked_at IS NOT NULL
      AND revoke_reason IS NOT NULL
      AND btrim(revoke_reason) <> ''
    )
  ),
  CONSTRAINT identity_invites_record_version_check CHECK (record_version >= 1),
  CONSTRAINT identity_invites_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT identity_invites_secret_hash_key UNIQUE (secret_hash)
);

CREATE UNIQUE INDEX identity_invites_one_created_target_idx
  ON identity_invites (organization_id, target_user_id)
  WHERE status = 'created';

CREATE TABLE access_case_collaborators (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  case_id uuid NOT NULL,
  user_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  advisor_role_binding_id uuid NOT NULL,
  required_role text NOT NULL DEFAULT 'advisor',
  status text NOT NULL,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  granted_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  removed_at timestamptz,
  removed_by_user_id uuid REFERENCES identity_users (id),
  removal_reason text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT access_case_collaborators_membership_fk FOREIGN KEY (
    membership_id,
    organization_id,
    user_id
  ) REFERENCES access_organization_memberships (id, organization_id, user_id),
  CONSTRAINT access_case_collaborators_advisor_role_fk FOREIGN KEY (
    advisor_role_binding_id,
    organization_id,
    membership_id,
    user_id,
    required_role
  ) REFERENCES access_role_bindings (id, organization_id, membership_id, user_id, role),
  CONSTRAINT access_case_collaborators_required_role_check CHECK (required_role = 'advisor'),
  CONSTRAINT access_case_collaborators_status_check CHECK (
    status IN ('active', 'removed', 'expired')
  ),
  CONSTRAINT access_case_collaborators_duration_check CHECK (
    expires_at > starts_at
    AND expires_at <= starts_at + interval '7 days'
  ),
  CONSTRAINT access_case_collaborators_removal_check CHECK (
    (
      status = 'removed'
      AND removed_at IS NOT NULL
      AND removed_by_user_id IS NOT NULL
      AND removal_reason IS NOT NULL
      AND btrim(removal_reason) <> ''
    )
    OR (status <> 'removed' AND removed_at IS NULL AND removed_by_user_id IS NULL AND removal_reason IS NULL)
  ),
  CONSTRAINT access_case_collaborators_record_version_check CHECK (record_version >= 1),
  CONSTRAINT access_case_collaborators_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT access_case_collaborators_grant_composite_key UNIQUE (id, organization_id, case_id)
);

CREATE UNIQUE INDEX access_case_collaborators_one_active_user_idx
  ON access_case_collaborators (organization_id, case_id, user_id)
  WHERE status = 'active';

CREATE TABLE access_scope_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  case_id uuid NOT NULL,
  collaborator_id uuid NOT NULL,
  scope text NOT NULL,
  capability text NOT NULL,
  status text NOT NULL,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  requested_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  request_reason text,
  approved_by_user_id uuid REFERENCES identity_users (id),
  approved_at timestamptz,
  revoked_by_user_id uuid REFERENCES identity_users (id),
  revoked_at timestamptz,
  revoke_reason text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT access_scope_grants_collaborator_fk FOREIGN KEY (
    collaborator_id,
    organization_id,
    case_id
  ) REFERENCES access_case_collaborators (id, organization_id, case_id),
  CONSTRAINT access_scope_grants_scope_check CHECK (
    scope IN (
      'case_summary',
      'education_profile',
      'school_targets',
      'task_workspace',
      'communications',
      'identity_contact',
      'internal_notes'
    )
  ),
  CONSTRAINT access_scope_grants_capability_check CHECK (
    capability IN ('view', 'comment', 'edit')
  ),
  CONSTRAINT access_scope_grants_status_check CHECK (
    status IN ('pending_approval', 'active', 'revoked', 'expired')
  ),
  CONSTRAINT access_scope_grants_duration_check CHECK (
    expires_at > starts_at
    AND expires_at <= starts_at + interval '7 days'
  ),
  CONSTRAINT access_scope_grants_sensitive_approval_check CHECK (
    scope NOT IN ('identity_contact', 'internal_notes')
    OR (
      request_reason IS NOT NULL
      AND btrim(request_reason) <> ''
      AND (
        status <> 'active'
        OR (
          approved_by_user_id IS NOT NULL
          AND approved_at IS NOT NULL
          AND approved_by_user_id <> requested_by_user_id
        )
      )
    )
  ),
  CONSTRAINT access_scope_grants_revocation_check CHECK (
    (
      status = 'revoked'
      AND revoked_by_user_id IS NOT NULL
      AND revoked_at IS NOT NULL
      AND revoke_reason IS NOT NULL
      AND btrim(revoke_reason) <> ''
    )
    OR (status <> 'revoked' AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
  ),
  CONSTRAINT access_scope_grants_record_version_check CHECK (record_version >= 1),
  CONSTRAINT access_scope_grants_timestamps_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX access_scope_grants_one_active_equivalent_idx
  ON access_scope_grants (collaborator_id, scope, capability)
  WHERE status = 'active';

CREATE FUNCTION identity_validate_user_session_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> OLD.status
     AND NOT (OLD.status = 'invited' AND NEW.status = 'active')
     AND NOT (OLD.status = 'active' AND NEW.status = 'disabled') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'identity_users_status_transition_check',
      MESSAGE = 'invalid identity user status transition';
  END IF;

  IF NEW.session_version < OLD.session_version THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'identity_users_session_version_transition_check',
      MESSAGE = 'session_version cannot decrease';
  END IF;

  IF OLD.status <> 'disabled'
     AND NEW.status = 'disabled'
     AND NEW.session_version <> OLD.session_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'identity_users_disable_session_version_check',
      MESSAGE = 'disabling a user must increment session_version exactly once';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER identity_users_validate_session_version
BEFORE UPDATE OF status, session_version ON identity_users
FOR EACH ROW
EXECUTE FUNCTION identity_validate_user_session_version();

CREATE FUNCTION identity_validate_session_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_user_status text;
  current_session_version bigint;
  current_membership_status text;
  current_organization_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
       OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
       OR NEW.captured_session_version IS DISTINCT FROM OLD.captured_session_version
       OR NEW.session_slot IS DISTINCT FROM OLD.session_slot
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'identity_sessions_immutable_fields_check',
        MESSAGE = 'identity session ownership and absolute lifetime are immutable';
    END IF;

    IF NEW.status <> OLD.status
       AND NOT (
         OLD.status = 'active'
         AND NEW.status IN ('revoked', 'expired')
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'identity_sessions_status_transition_check',
        MESSAGE = 'invalid identity session status transition';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status = 'active' THEN
    SELECT status, session_version
      INTO current_user_status, current_session_version
      FROM identity_users
     WHERE id = NEW.user_id
       FOR SHARE;

    IF current_user_status IS DISTINCT FROM 'active'
       OR current_session_version IS DISTINCT FROM NEW.captured_session_version THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'identity_sessions_current_user_version_check',
        MESSAGE = 'active session must capture the current version of an active user';
    END IF;

    SELECT membership.status, organization.status
      INTO current_membership_status, current_organization_status
      FROM access_organization_memberships AS membership
      JOIN access_organizations AS organization
        ON organization.id = membership.organization_id
     WHERE membership.id = NEW.membership_id
       AND membership.organization_id = NEW.organization_id
       AND membership.user_id = NEW.user_id
       FOR SHARE OF membership, organization;

    IF current_membership_status IS DISTINCT FROM 'active'
       OR current_organization_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'identity_sessions_active_membership_check',
        MESSAGE = 'active session requires an active organization membership';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER identity_sessions_validate_insert
BEFORE INSERT ON identity_sessions
FOR EACH ROW
EXECUTE FUNCTION identity_validate_session_write();

CREATE TRIGGER identity_sessions_validate_status_transition
BEFORE UPDATE ON identity_sessions
FOR EACH ROW
EXECUTE FUNCTION identity_validate_session_write();

CREATE FUNCTION identity_validate_invite_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> OLD.status
     AND NOT (
       OLD.status = 'created'
       AND NEW.status IN ('redeemed', 'expired', 'revoked')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'identity_invites_status_transition_check',
      MESSAGE = 'invalid identity invite status transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER identity_invites_validate_status_transition
BEFORE UPDATE OF status ON identity_invites
FOR EACH ROW
EXECUTE FUNCTION identity_validate_invite_status_transition();

CREATE FUNCTION access_validate_scope_grant_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.scope IN ('identity_contact', 'internal_notes')
       AND NEW.status = 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'access_scope_grants_sensitive_initial_state_check',
        MESSAGE = 'sensitive grants must begin pending approval';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.collaborator_id IS DISTINCT FROM OLD.collaborator_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.capability IS DISTINCT FROM OLD.capability
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (
       OLD.status <> 'pending_approval'
       AND (
         NEW.request_reason IS DISTINCT FROM OLD.request_reason
         OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
         OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'access_scope_grants_immutable_fields_check',
      MESSAGE = 'scope grant decision fields are immutable';
  END IF;

  IF NEW.status <> OLD.status
     AND NOT (
       OLD.status = 'pending_approval'
       AND NEW.status = 'active'
     )
     AND NOT (
       OLD.status = 'active'
       AND NEW.status IN ('revoked', 'expired')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'access_scope_grants_status_transition_check',
      MESSAGE = 'invalid access scope grant status transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER access_scope_grants_validate_insert
BEFORE INSERT ON access_scope_grants
FOR EACH ROW
EXECUTE FUNCTION access_validate_scope_grant_status_transition();

CREATE TRIGGER access_scope_grants_validate_status_transition
BEFORE UPDATE ON access_scope_grants
FOR EACH ROW
EXECUTE FUNCTION access_validate_scope_grant_status_transition();

CREATE FUNCTION identity_revoke_stale_sessions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.session_version > OLD.session_version THEN
    UPDATE identity_sessions
       SET status = 'revoked',
           revoked_at = transaction_timestamp(),
           revoke_reason = 'session_version_changed',
           record_version = record_version + 1,
           updated_at = transaction_timestamp()
     WHERE user_id = NEW.id
       AND status = 'active';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER identity_users_revoke_stale_sessions
AFTER UPDATE OF session_version ON identity_users
FOR EACH ROW
EXECUTE FUNCTION identity_revoke_stale_sessions();

COMMENT ON COLUMN access_case_collaborators.case_id IS
  'ServiceCase foreign key is added by P0-07 after the case schema exists.';
