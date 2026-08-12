-- Cases owns this immutable PII-free handoff. Billing has no tenant-detail grant.

CREATE TABLE cases_billing_projection_events (
  event_id text NOT NULL PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  case_id uuid NOT NULL,
  stage text NOT NULL,
  effective_at timestamptz NOT NULL,
  case_version integer NOT NULL,
  CONSTRAINT cases_billing_projection_case_fk FOREIGN KEY (case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT cases_billing_projection_event_check
    CHECK (event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT cases_billing_projection_stage_check CHECK (stage IN (
    'signed', 'background_collection', 'school_selection_confirmed',
    'interview_preparation', 'application_submitted', 'awaiting_result',
    'offer_confirmed', 'closed', 'pending_delete'
  )),
  CONSTRAINT cases_billing_projection_version_check CHECK (case_version >= 1),
  CONSTRAINT cases_billing_projection_order_key UNIQUE (organization_id, case_id, case_version)
);

CREATE TABLE platform_billing_projection_checkpoints (
  organization_id uuid PRIMARY KEY REFERENCES access_organizations (id),
  source_projection_version bigint NOT NULL,
  last_event_id text,
  consumed_at timestamptz NOT NULL,
  record_version integer NOT NULL DEFAULT 1,
  CONSTRAINT platform_billing_projection_checkpoint_event_fk
    FOREIGN KEY (last_event_id) REFERENCES cases_billing_projection_events (event_id),
  CONSTRAINT platform_billing_projection_checkpoint_version_check
    CHECK (source_projection_version >= 0 AND record_version >= 1)
);

CREATE FUNCTION cases_billing_projection_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
    CONSTRAINT = 'cases_billing_projection_append_only',
    MESSAGE = 'case billing projection events are immutable';
END;
$$;

CREATE TRIGGER cases_billing_projection_immutable_trg
BEFORE UPDATE OR DELETE ON cases_billing_projection_events
FOR EACH ROW EXECUTE FUNCTION cases_billing_projection_reject_mutation();

ALTER TABLE cases_billing_projection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_billing_projection_events FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_projection_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_projection_checkpoints FORCE ROW LEVEL SECURITY;

CREATE POLICY cases_billing_projection_tenant_write ON cases_billing_projection_events
  FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY cases_billing_projection_platform_read ON cases_billing_projection_events
  FOR SELECT TO platform_billing USING (platform_billing_assert_actor());
CREATE POLICY platform_billing_checkpoint_control ON platform_billing_projection_checkpoints
  FOR ALL TO platform_billing
  USING (platform_billing_assert_actor()) WITH CHECK (platform_billing_assert_actor());

REVOKE ALL ON cases_billing_projection_events, platform_billing_projection_checkpoints FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_billing_projection_reject_mutation() FROM PUBLIC;
GRANT SELECT, INSERT ON cases_billing_projection_events TO tianxing_app;
GRANT SELECT ON cases_billing_projection_events TO platform_billing;
GRANT SELECT, INSERT, UPDATE ON platform_billing_projection_checkpoints TO platform_billing;
