-- P5-BE-08 corrective boundary. Historical rows remain readable; new Release 1
-- rows are Guardian-only and use one fixed seven-day grant lifetime.
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_actor_kind_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_kind_check
  CHECK (actor_kind IN ('user','portal','system','worker'));
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_actor_presence_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_presence_check CHECK (
  (actor_kind = 'user' AND actor_user_id IS NOT NULL)
  OR (actor_kind IN ('portal','system','worker') AND actor_user_id IS NULL)
);

CREATE OR REPLACE FUNCTION portal_validate_release1_viewer()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.subject_type <> 'guardian' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='portal_release1_guardian_only_check',
      MESSAGE='Release 1 portal viewers must be Guardian relationships';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS portal_release1_viewer_guardian_only ON portal_viewers;
CREATE TRIGGER portal_release1_viewer_guardian_only
BEFORE INSERT OR UPDATE ON portal_viewers
FOR EACH ROW EXECUTE FUNCTION portal_validate_release1_viewer();

CREATE OR REPLACE FUNCTION portal_validate_release1_grant_lifetime()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.expires_at IS DISTINCT FROM NEW.issued_at + interval '7 days' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='portal_release1_fixed_seven_day_check',
      MESSAGE='Release 1 portal grants have a fixed seven-day lifetime';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='portal_release1_expiry_immutable_check',
      MESSAGE='Portal grant expiry is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS portal_release1_grant_lifetime ON portal_access_grants;
CREATE TRIGGER portal_release1_grant_lifetime
BEFORE INSERT OR UPDATE ON portal_access_grants
FOR EACH ROW EXECUTE FUNCTION portal_validate_release1_grant_lifetime();

CREATE UNIQUE INDEX IF NOT EXISTS portal_access_grants_one_active_case_viewer_idx
  ON portal_access_grants (organization_id, service_case_id, portal_viewer_id)
  WHERE status = 'active';

COMMENT ON TABLE portal_access_grants IS 'Release 1: Primary Advisor issue/reissue; Primary Advisor or Founder revoke; fixed seven-day bearer grants with keyed hashes only.';
COMMENT ON TABLE portal_sessions IS 'Release 1: three active sessions maximum, fifteen-minute idle and eight-hour absolute windows, keyed hashes only.';
