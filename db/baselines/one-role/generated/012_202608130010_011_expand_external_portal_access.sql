CREATE TABLE portal_viewers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  service_case_id uuid NOT NULL,
  subject_type text NOT NULL,
  guardian_relationship_id uuid,
  applicant_student_id uuid,
  status text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT portal_viewers_case_fk FOREIGN KEY (service_case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT portal_viewers_guardian_relationship_fk FOREIGN KEY (guardian_relationship_id, organization_id)
    REFERENCES crm_student_guardian_relationships (id, organization_id),
  CONSTRAINT portal_viewers_applicant_student_fk FOREIGN KEY (applicant_student_id, organization_id)
    REFERENCES crm_students (id, organization_id),
  CONSTRAINT portal_viewers_subject_check CHECK (subject_type IN ('guardian', 'applicant')),
  CONSTRAINT portal_viewers_subject_reference_check CHECK (
    (subject_type = 'guardian' AND guardian_relationship_id IS NOT NULL AND applicant_student_id IS NULL)
    OR (subject_type = 'applicant' AND guardian_relationship_id IS NULL AND applicant_student_id IS NOT NULL)
  ),
  CONSTRAINT portal_viewers_status_check CHECK (status IN ('active', 'inactive')),
  CONSTRAINT portal_viewers_version_check CHECK (record_version >= 1),
  CONSTRAINT portal_viewers_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT portal_viewers_tenant_case_key UNIQUE (id, organization_id, service_case_id)
);

CREATE FUNCTION portal_validate_viewer_case_subject()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  case_student_id uuid;
  relationship_student_id uuid;
BEGIN
  SELECT student_id
    INTO case_student_id
    FROM cases_service_cases
   WHERE id = NEW.service_case_id
     AND organization_id = NEW.organization_id
   FOR SHARE;

  IF NEW.subject_type = 'guardian' THEN
    SELECT student_id
      INTO relationship_student_id
      FROM crm_student_guardian_relationships
     WHERE id = NEW.guardian_relationship_id
       AND organization_id = NEW.organization_id
     FOR SHARE;
    IF relationship_student_id IS DISTINCT FROM case_student_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'portal_viewers_guardian_case_locality_check',
        MESSAGE = 'portal guardian relationship must belong to the service case student';
    END IF;
  ELSIF NEW.applicant_student_id IS DISTINCT FROM case_student_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'portal_viewers_applicant_case_locality_check',
      MESSAGE = 'portal applicant must be the service case student';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER portal_viewers_validate_case_subject
BEFORE INSERT OR UPDATE ON portal_viewers
FOR EACH ROW EXECUTE FUNCTION portal_validate_viewer_case_subject();

CREATE TABLE portal_access_grants (
  id uuid PRIMARY KEY,
  lifecycle_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  portal_viewer_id uuid NOT NULL,
  keyed_secret_hash bytea,
  secret_fingerprint char(64) NOT NULL,
  capability_set_version text NOT NULL,
  status text NOT NULL,
  issued_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_by_user_id uuid REFERENCES identity_users (id),
  revoked_at timestamptz,
  revoke_reason_code text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT portal_access_grants_viewer_fk FOREIGN KEY (
    portal_viewer_id,
    organization_id,
    service_case_id
  ) REFERENCES portal_viewers (id, organization_id, service_case_id),
  CONSTRAINT portal_access_grants_tenant_case_key UNIQUE (id, organization_id, service_case_id),
  CONSTRAINT portal_access_grants_hash_check CHECK (
    keyed_secret_hash IS NULL OR octet_length(keyed_secret_hash) = 32
  ),
  CONSTRAINT portal_access_grants_fingerprint_check CHECK (
    secret_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT portal_access_grants_capability_check CHECK (
    capability_set_version = 'portal_case_read_v1'
  ),
  CONSTRAINT portal_access_grants_status_check CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT portal_access_grants_expiry_check CHECK (
    expires_at > issued_at
    AND expires_at <= issued_at + interval '7 days'
  ),
  CONSTRAINT portal_access_grants_revocation_check CHECK (
    (status = 'revoked' AND revoked_by_user_id IS NOT NULL AND revoked_at IS NOT NULL
      AND revoke_reason_code IS NOT NULL AND btrim(revoke_reason_code) <> '')
    OR (status <> 'revoked' AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND revoke_reason_code IS NULL)
  ),
  CONSTRAINT portal_access_grants_version_check CHECK (record_version >= 1),
  CONSTRAINT portal_access_grants_timestamps_check CHECK (
    issued_at = created_at
    AND updated_at >= created_at
    AND (revoked_at IS NULL OR revoked_at BETWEEN issued_at AND updated_at)
  ),
  CONSTRAINT portal_access_grants_keyed_hash_key UNIQUE (keyed_secret_hash),
  CONSTRAINT portal_access_grants_fingerprint_key UNIQUE (secret_fingerprint)
);

CREATE UNIQUE INDEX portal_access_grants_one_active_lifecycle_idx
  ON portal_access_grants (lifecycle_id)
  WHERE status = 'active';

CREATE FUNCTION portal_validate_grant_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.lifecycle_id IS DISTINCT FROM OLD.lifecycle_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.service_case_id IS DISTINCT FROM OLD.service_case_id
       OR NEW.portal_viewer_id IS DISTINCT FROM OLD.portal_viewer_id
       OR NEW.secret_fingerprint IS DISTINCT FROM OLD.secret_fingerprint
       OR NEW.capability_set_version IS DISTINCT FROM OLD.capability_set_version
       OR NEW.issued_by_user_id IS DISTINCT FROM OLD.issued_by_user_id
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'portal_access_grants_immutable_fields_check',
        MESSAGE = 'portal grant identity, scope, and lifetime are immutable';
    END IF;
    IF NEW.keyed_secret_hash IS DISTINCT FROM OLD.keyed_secret_hash
       AND NOT (OLD.keyed_secret_hash IS NOT NULL AND NEW.keyed_secret_hash IS NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'portal_access_grants_hash_clear_only_check',
        MESSAGE = 'portal keyed hash may only be cleared';
    END IF;
    IF NEW.status <> OLD.status
       AND NOT (OLD.status = 'active' AND NEW.status IN ('revoked', 'expired')) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'portal_access_grants_status_transition_check',
        MESSAGE = 'invalid portal grant status transition';
    END IF;
    IF NEW.record_version <> OLD.record_version + 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'portal_access_grants_version_transition_check',
        MESSAGE = 'portal grant record version must increase exactly once';
    END IF;
  ELSIF NEW.status <> 'active' OR NEW.keyed_secret_hash IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'portal_access_grants_initial_state_check',
      MESSAGE = 'portal grants must begin active with a keyed hash';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portal_access_grants_validate_write
BEFORE INSERT OR UPDATE ON portal_access_grants
FOR EACH ROW EXECUTE FUNCTION portal_validate_grant_write();

CREATE TABLE portal_sessions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  session_slot smallint NOT NULL,
  keyed_session_hash bytea,
  status text NOT NULL,
  grant_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason_code text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT portal_sessions_grant_fk FOREIGN KEY (grant_id, organization_id, service_case_id)
    REFERENCES portal_access_grants (id, organization_id, service_case_id),
  CONSTRAINT portal_sessions_tenant_case_key UNIQUE (id, organization_id, service_case_id),
  CONSTRAINT portal_sessions_slot_check CHECK (session_slot BETWEEN 1 AND 3),
  CONSTRAINT portal_sessions_hash_check CHECK (
    keyed_session_hash IS NULL OR octet_length(keyed_session_hash) = 32
  ),
  CONSTRAINT portal_sessions_status_check CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT portal_sessions_time_window_check CHECK (
    last_seen_at >= created_at
    AND idle_expires_at > last_seen_at
    AND idle_expires_at <= last_seen_at + interval '15 minutes'
    AND absolute_expires_at > created_at
    AND absolute_expires_at <= created_at + interval '8 hours'
    AND idle_expires_at <= absolute_expires_at
    AND absolute_expires_at <= grant_expires_at
  ),
  CONSTRAINT portal_sessions_revocation_check CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason_code IS NOT NULL
      AND btrim(revoke_reason_code) <> '')
    OR (status <> 'revoked' AND revoked_at IS NULL AND revoke_reason_code IS NULL)
  ),
  CONSTRAINT portal_sessions_version_check CHECK (record_version >= 1),
  CONSTRAINT portal_sessions_timestamps_check CHECK (
    updated_at >= created_at AND (revoked_at IS NULL OR revoked_at BETWEEN created_at AND updated_at)
  ),
  CONSTRAINT portal_sessions_keyed_hash_key UNIQUE (keyed_session_hash)
);

CREATE UNIQUE INDEX portal_sessions_active_slot_idx
  ON portal_sessions (grant_id, session_slot)
  WHERE status = 'active';

CREATE FUNCTION portal_validate_session_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  grant_row portal_access_grants%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO grant_row
      FROM portal_access_grants
     WHERE id = NEW.grant_id
       AND organization_id = NEW.organization_id
       AND service_case_id = NEW.service_case_id
     FOR UPDATE;
    IF grant_row.status IS DISTINCT FROM 'active'
       OR NEW.created_at >= grant_row.expires_at
       OR NEW.grant_expires_at IS DISTINCT FROM grant_row.expires_at
       OR NEW.keyed_session_hash IS NULL
       OR NEW.status <> 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'portal_sessions_active_grant_check',
        MESSAGE = 'active portal session requires its current active grant';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.service_case_id IS DISTINCT FROM OLD.service_case_id
       OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
       OR NEW.session_slot IS DISTINCT FROM OLD.session_slot
       OR NEW.grant_expires_at IS DISTINCT FROM OLD.grant_expires_at
       OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'portal_sessions_immutable_fields_check',
        MESSAGE = 'portal session ownership and absolute lifetime are immutable';
    END IF;
    IF NEW.keyed_session_hash IS DISTINCT FROM OLD.keyed_session_hash
       AND NOT (OLD.keyed_session_hash IS NOT NULL AND NEW.keyed_session_hash IS NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'portal_sessions_hash_clear_only_check',
        MESSAGE = 'portal session keyed hash may only be cleared';
    END IF;
    IF NEW.status <> OLD.status
       AND NOT (OLD.status = 'active' AND NEW.status IN ('revoked', 'expired')) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'portal_sessions_status_transition_check',
        MESSAGE = 'invalid portal session status transition';
    END IF;
    IF NEW.record_version <> OLD.record_version + 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'portal_sessions_version_transition_check',
        MESSAGE = 'portal session record version must increase exactly once';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portal_sessions_validate_write
BEFORE INSERT OR UPDATE ON portal_sessions
FOR EACH ROW EXECUTE FUNCTION portal_validate_session_write();

CREATE FUNCTION portal_invalidate_grant_sessions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status IN ('revoked', 'expired') THEN
    UPDATE portal_sessions
       SET status = 'revoked',
           keyed_session_hash = NULL,
           revoked_at = COALESCE(NEW.revoked_at, transaction_timestamp()),
           revoke_reason_code = CASE WHEN NEW.status = 'revoked' THEN 'grant_revoked' ELSE 'grant_expired' END,
           record_version = record_version + 1,
           updated_at = transaction_timestamp()
     WHERE grant_id = NEW.id
       AND organization_id = NEW.organization_id
       AND service_case_id = NEW.service_case_id
       AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portal_access_grants_invalidate_sessions
AFTER UPDATE OF status ON portal_access_grants
FOR EACH ROW EXECUTE FUNCTION portal_invalidate_grant_sessions();

CREATE TABLE portal_security_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  audit_event_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  event_type text NOT NULL,
  outcome text NOT NULL,
  reason_code text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT portal_security_events_grant_fk FOREIGN KEY (grant_id, organization_id, service_case_id)
    REFERENCES portal_access_grants (id, organization_id, service_case_id),
  CONSTRAINT portal_security_events_audit_fk FOREIGN KEY (audit_event_id, organization_id)
    REFERENCES audit_events (id, organization_id),
  CONSTRAINT portal_security_events_outbox_fk FOREIGN KEY (outbox_id, organization_id)
    REFERENCES audit_outbox (id, organization_id),
  CONSTRAINT portal_security_events_audit_key UNIQUE (audit_event_id),
  CONSTRAINT portal_security_events_outbox_key UNIQUE (outbox_id),
  CONSTRAINT portal_security_events_event_type_check CHECK (
    event_type IN ('issue', 'redeem', 'read', 'revoke', 'rotate', 'logout', 'denied', 'rate_limited')
  ),
  CONSTRAINT portal_security_events_outcome_check CHECK (outcome IN ('succeeded', 'denied', 'failed')),
  CONSTRAINT portal_security_events_reason_check CHECK (
    reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT portal_security_events_timestamps_check CHECK (
    occurred_at <= created_at
  )
);

CREATE FUNCTION portal_validate_security_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  audit_row record;
  outbox_row record;
BEGIN
  SELECT organization_id, resource_id, event_type, outcome, request_id
    INTO audit_row
    FROM audit_events
   WHERE id = NEW.audit_event_id
     AND organization_id = NEW.organization_id
   FOR SHARE;
  SELECT organization_id, audit_event_id, aggregate_id, event_type, request_id
    INTO outbox_row
    FROM audit_outbox
   WHERE id = NEW.outbox_id
     AND organization_id = NEW.organization_id
   FOR SHARE;

  IF audit_row.organization_id IS NULL
     OR outbox_row.organization_id IS NULL
     OR audit_row.resource_id IS DISTINCT FROM NEW.grant_id
     OR outbox_row.aggregate_id IS DISTINCT FROM NEW.grant_id
     OR outbox_row.audit_event_id IS DISTINCT FROM NEW.audit_event_id
     OR audit_row.event_type IS DISTINCT FROM outbox_row.event_type
     OR audit_row.request_id IS DISTINCT FROM outbox_row.request_id
     OR audit_row.outcome IS DISTINCT FROM NEW.outcome THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'portal_security_events_audit_context_check',
      MESSAGE = 'portal security evidence must match its audit and outbox context';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portal_security_events_validate_insert
BEFORE INSERT ON portal_security_events
FOR EACH ROW EXECUTE FUNCTION portal_validate_security_event();

CREATE FUNCTION portal_reject_security_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'portal_security_events_append_only',
    MESSAGE = 'portal security evidence is append-only';
END;
$$;

CREATE TRIGGER portal_security_events_append_only
BEFORE UPDATE OR DELETE ON portal_security_events
FOR EACH ROW EXECUTE FUNCTION portal_reject_security_event_mutation();

CREATE TABLE portal_idempotency_records (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  actor_user_id uuid REFERENCES identity_users (id),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  grant_id uuid,
  service_case_id uuid NOT NULL,
  expected_record_version bigint,
  state text NOT NULL,
  response_hash char(64),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT portal_idempotency_grant_fk FOREIGN KEY (grant_id, organization_id, service_case_id)
    REFERENCES portal_access_grants (id, organization_id, service_case_id),
  CONSTRAINT portal_idempotency_scope_key UNIQUE NULLS NOT DISTINCT (
    organization_id, actor_user_id, operation, grant_id, idempotency_key
  ),
  CONSTRAINT portal_idempotency_operation_check CHECK (operation IN ('issue', 'revoke', 'rotate', 'redeem')),
  CONSTRAINT portal_idempotency_actor_check CHECK (
    (operation = 'redeem' AND actor_user_id IS NULL)
    OR (operation <> 'redeem' AND actor_user_id IS NOT NULL)
  ),
  CONSTRAINT portal_idempotency_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT portal_idempotency_state_check CHECK (state IN ('in_progress', 'completed', 'failed')),
  CONSTRAINT portal_idempotency_result_check CHECK (
    (state = 'in_progress' AND grant_id IS NULL AND response_hash IS NULL)
    OR (state IN ('completed', 'failed') AND grant_id IS NOT NULL
      AND response_hash IS NOT NULL AND response_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT portal_idempotency_expected_version_check CHECK (
    expected_record_version IS NULL OR expected_record_version >= 1
  ),
  CONSTRAINT portal_idempotency_timestamps_check CHECK (updated_at >= created_at)
);

CREATE FUNCTION portal_reject_idempotency_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'portal_idempotency_append_only',
    MESSAGE = 'portal idempotency history cannot be deleted';
END;
$$;

CREATE TRIGGER portal_idempotency_reject_delete
BEFORE DELETE ON portal_idempotency_records
FOR EACH ROW EXECUTE FUNCTION portal_reject_idempotency_delete();

ALTER TABLE portal_viewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_viewers FORCE ROW LEVEL SECURITY;
ALTER TABLE portal_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_access_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE portal_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_security_events FORCE ROW LEVEL SECURITY;
ALTER TABLE portal_idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_idempotency_records FORCE ROW LEVEL SECURITY;

CREATE POLICY tianxing_tenant_boundary ON portal_viewers FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY tianxing_tenant_boundary ON portal_access_grants FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY tianxing_tenant_boundary ON portal_sessions FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY tianxing_tenant_boundary ON portal_security_events FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY tianxing_tenant_boundary ON portal_idempotency_records FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));

REVOKE ALL ON TABLE portal_viewers, portal_access_grants, portal_sessions,
  portal_security_events, portal_idempotency_records FROM PUBLIC;
REVOKE DELETE ON TABLE portal_viewers, portal_access_grants, portal_sessions,
  portal_security_events, portal_idempotency_records FROM tianxing_app;
GRANT SELECT, INSERT, UPDATE ON TABLE portal_viewers, portal_access_grants,
  portal_sessions, portal_security_events, portal_idempotency_records TO tianxing_app;

-- one-role baseline: Portal discovery uses the canonical login and a protected function.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE FUNCTION portal_discover_grant_by_keyed_hash(candidate_hash bytea)
RETURNS TABLE (
  organization_id uuid,
  grant_id uuid,
  service_case_id uuid
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT grant_row.organization_id, grant_row.id, grant_row.service_case_id
    FROM public.portal_access_grants AS grant_row
   WHERE octet_length(candidate_hash) = 32
     AND grant_row.keyed_secret_hash = candidate_hash
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION portal_discover_grant_by_keyed_hash(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_discover_grant_by_keyed_hash(bytea) TO tianxing_app;

COMMENT ON FUNCTION portal_discover_grant_by_keyed_hash(bytea) IS
  'DEC-065 pre-tenant discovery only. Caller must open a separate tenant transaction for full authorization.';
COMMENT ON TABLE portal_security_events IS
  'Append-only, secret-free Portal security evidence linked to the shared tenant audit and outbox records.';
