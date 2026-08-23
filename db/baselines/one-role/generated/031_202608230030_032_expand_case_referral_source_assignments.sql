CREATE TABLE cases_case_referral_source_assignments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  case_id uuid NOT NULL,
  referral_source_id uuid NOT NULL,
  source_display_name text NOT NULL,
  source_type text NOT NULL,
  source_record_version bigint NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  ends_at timestamptz,
  ended_by_assignment_id uuid,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_case_referral_source_assignments_case_fk
    FOREIGN KEY (case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT cases_case_referral_source_assignments_source_fk
    FOREIGN KEY (referral_source_id, organization_id)
    REFERENCES crm_referral_sources (id, organization_id),
  CONSTRAINT cases_case_referral_source_assignments_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT cases_case_referral_source_assignments_successor_fk
    FOREIGN KEY (ended_by_assignment_id, organization_id)
    REFERENCES cases_case_referral_source_assignments (id, organization_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT cases_case_referral_source_assignments_display_name_check
    CHECK (char_length(btrim(source_display_name)) BETWEEN 1 AND 200),
  CONSTRAINT cases_case_referral_source_assignments_type_check
    CHECK (source_type IN ('bank', 'insurance', 'other_partner')),
  CONSTRAINT cases_case_referral_source_assignments_source_version_check
    CHECK (source_record_version >= 1),
  CONSTRAINT cases_case_referral_source_assignments_record_version_check
    CHECK (record_version >= 1),
  CONSTRAINT cases_case_referral_source_assignments_close_check CHECK (
    (ends_at IS NULL AND ended_by_assignment_id IS NULL)
    OR (ends_at IS NOT NULL AND ended_by_assignment_id IS NOT NULL AND ends_at >= starts_at)
  ),
  CONSTRAINT cases_case_referral_source_assignments_timestamps_check CHECK (
    created_at >= starts_at AND updated_at >= created_at
  )
);

CREATE UNIQUE INDEX cases_case_referral_source_assignments_one_current_idx
  ON cases_case_referral_source_assignments (organization_id, case_id)
  WHERE ends_at IS NULL;

CREATE INDEX cases_case_referral_source_assignments_history_idx
  ON cases_case_referral_source_assignments (organization_id, case_id, ends_at DESC, id);

CREATE FUNCTION cases_validate_case_referral_source_assignment_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ends_at IS NOT NULL
       OR NEW.ended_by_assignment_id IS NOT NULL
       OR NEW.created_at IS DISTINCT FROM NEW.updated_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_case_referral_source_assignments_initial_state_check',
        MESSAGE = 'case referral source assignments must begin current';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_case_referral_source_assignments_delete_check',
      MESSAGE = 'case referral source assignment history cannot be deleted';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.referral_source_id IS DISTINCT FROM OLD.referral_source_id
     OR NEW.source_display_name IS DISTINCT FROM OLD.source_display_name
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_record_version IS DISTINCT FROM OLD.source_record_version
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.ends_at IS NOT NULL
     OR OLD.ended_by_assignment_id IS NOT NULL
     OR NEW.ends_at IS NULL
     OR NEW.ended_by_assignment_id IS NULL
     OR NEW.ended_by_assignment_id = OLD.id
     OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_case_referral_source_assignments_close_transition_check',
      MESSAGE = 'only one controlled close transition is permitted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_case_referral_source_assignments_write_trg
BEFORE INSERT OR UPDATE OR DELETE ON cases_case_referral_source_assignments
FOR EACH ROW EXECUTE FUNCTION cases_validate_case_referral_source_assignment_write();

ALTER TABLE cases_case_referral_source_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_case_referral_source_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY cases_case_referral_source_assignments_tenant_policy
ON cases_case_referral_source_assignments
USING (
  organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
)
WITH CHECK (
  organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
);

REVOKE ALL ON TABLE cases_case_referral_source_assignments FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE cases_case_referral_source_assignments TO tianxing_app;
GRANT UPDATE (ends_at, ended_by_assignment_id, record_version, updated_at)
  ON TABLE cases_case_referral_source_assignments TO tianxing_app;

REVOKE ALL ON FUNCTION cases_validate_case_referral_source_assignment_write() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases_validate_case_referral_source_assignment_write() TO tianxing_app;
