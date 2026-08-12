-- P3-03 is an additive, pre-use schema contract. Production execution and the
-- CaseWorkflow adapter remain separately gated by P3-08/P3-19.

CREATE TABLE cases_reconstructions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  -- A pilot can be reconstructed before a real ServiceCase is attached.
  service_case_id uuid,
  pilot_reference text NOT NULL,
  assigned_advisor_user_id uuid NOT NULL REFERENCES identity_users (id),
  current_version_id uuid NOT NULL,
  current_version_no integer NOT NULL DEFAULT 1,
  activated_version_id uuid,
  state text NOT NULL DEFAULT 'draft',
  review_cycle integer NOT NULL DEFAULT 0,
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT cases_reconstructions_case_fk FOREIGN KEY (service_case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT cases_reconstructions_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT cases_reconstructions_pilot_key UNIQUE (organization_id, pilot_reference),
  CONSTRAINT cases_reconstructions_pilot_ref_check CHECK (pilot_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT cases_reconstructions_state_check CHECK (state IN ('draft', 'submitted', 'changes_requested', 'approved', 'activated', 'needs_human')),
  CONSTRAINT cases_reconstructions_cycle_check CHECK (review_cycle BETWEEN 0 AND 3),
  CONSTRAINT cases_reconstructions_version_check CHECK (current_version_no >= 1 AND record_version >= 1),
  -- This is the database-representable half of the attach-required activation rule.
  CONSTRAINT cases_reconstructions_activation_case_check CHECK (state <> 'activated' OR service_case_id IS NOT NULL),
  CONSTRAINT cases_reconstructions_timestamps_check CHECK (updated_at >= created_at)
);

CREATE TABLE cases_reconstruction_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  reconstruction_id uuid NOT NULL,
  version_no integer NOT NULL,
  review_cycle integer NOT NULL,
  state text NOT NULL,
  recorder_user_id uuid NOT NULL REFERENCES identity_users (id),
  reviewer_user_id uuid REFERENCES identity_users (id),
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  CONSTRAINT cases_reconstruction_versions_parent_fk FOREIGN KEY (reconstruction_id, organization_id)
    REFERENCES cases_reconstructions (id, organization_id),
  CONSTRAINT cases_reconstruction_versions_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT cases_reconstruction_versions_number_key UNIQUE (organization_id, reconstruction_id, version_no),
  CONSTRAINT cases_reconstruction_versions_state_check CHECK (state IN ('draft', 'submitted', 'changes_requested', 'approved', 'activated', 'needs_human')),
  CONSTRAINT cases_reconstruction_versions_cycle_check CHECK (review_cycle BETWEEN 0 AND 3),
  CONSTRAINT cases_reconstruction_versions_recorder_reviewer_check CHECK (reviewer_user_id IS NULL OR reviewer_user_id <> recorder_user_id),
  CONSTRAINT cases_reconstruction_versions_record_version_check CHECK (version_no >= 1 AND record_version >= 1)
);

ALTER TABLE cases_reconstructions
  ADD CONSTRAINT cases_reconstructions_current_version_fk
    FOREIGN KEY (current_version_id, organization_id)
    REFERENCES cases_reconstruction_versions (id, organization_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT cases_reconstructions_activated_version_fk
    FOREIGN KEY (activated_version_id, organization_id)
    REFERENCES cases_reconstruction_versions (id, organization_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE cases_reconstruction_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  reconstruction_version_id uuid NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  sequence_no integer NOT NULL,
  recorder_user_id uuid NOT NULL REFERENCES identity_users (id),
  corrected_by_user_id uuid REFERENCES identity_users (id),
  reported_actor_ref text,
  evidence_type text NOT NULL,
  evidence_ref text NOT NULL,
  correction_of_event_id uuid,
  correction_reason_code text,
  expected_record_version integer NOT NULL DEFAULT 1,
  CONSTRAINT cases_reconstruction_events_version_fk FOREIGN KEY (reconstruction_version_id, organization_id)
    REFERENCES cases_reconstruction_versions (id, organization_id),
  CONSTRAINT cases_reconstruction_events_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT cases_reconstruction_events_correction_fk FOREIGN KEY (correction_of_event_id, organization_id)
    REFERENCES cases_reconstruction_events (id, organization_id),
  CONSTRAINT cases_reconstruction_events_order_key UNIQUE (organization_id, reconstruction_version_id, occurred_at, sequence_no),
  CONSTRAINT cases_reconstruction_events_type_check CHECK (event_type IN ('service_case.stage_changed.v1', 'school_target.state_changed.v1', 'task.state_changed.v1', 'document.metadata_recorded.v1')),
  CONSTRAINT cases_reconstruction_events_time_check CHECK (occurred_at <= recorded_at),
  CONSTRAINT cases_reconstruction_events_sequence_check CHECK (sequence_no >= 1),
  CONSTRAINT cases_reconstruction_events_evidence_type_check CHECK (evidence_type IN ('customer_record', 'document_metadata', 'system_record')),
  CONSTRAINT cases_reconstruction_events_evidence_ref_check CHECK (evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT cases_reconstruction_events_actor_ref_check CHECK (reported_actor_ref IS NULL OR reported_actor_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT cases_reconstruction_events_expected_version_check CHECK (expected_record_version >= 1),
  CONSTRAINT cases_reconstruction_events_correction_check CHECK (
    (correction_of_event_id IS NULL AND correction_reason_code IS NULL AND corrected_by_user_id IS NULL)
    OR (correction_of_event_id IS NOT NULL AND correction_reason_code IN ('SOURCE_UNAVAILABLE', 'SOURCE_CONFLICT', 'OCCURRED_AT_UNKNOWN') AND corrected_by_user_id IS NOT NULL)
  )
);

CREATE TABLE cases_reconstruction_gaps (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  reconstruction_version_id uuid NOT NULL,
  gap_type text NOT NULL,
  reason_code text NOT NULL,
  owner_ref text NOT NULL,
  resolution_target_at timestamptz NOT NULL,
  founder_decision text NOT NULL DEFAULT 'pending',
  decided_by_user_id uuid REFERENCES identity_users (id),
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  CONSTRAINT cases_reconstruction_gaps_version_fk FOREIGN KEY (reconstruction_version_id, organization_id)
    REFERENCES cases_reconstruction_versions (id, organization_id),
  CONSTRAINT cases_reconstruction_gaps_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT cases_reconstruction_gaps_type_check CHECK (gap_type IN ('missing_event', 'missing_evidence', 'uncertain_order')),
  CONSTRAINT cases_reconstruction_gaps_reason_check CHECK (reason_code IN ('SOURCE_UNAVAILABLE', 'SOURCE_CONFLICT', 'OCCURRED_AT_UNKNOWN')),
  CONSTRAINT cases_reconstruction_gaps_owner_check CHECK (owner_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT cases_reconstruction_gaps_decision_check CHECK (
    (founder_decision = 'pending' AND decided_by_user_id IS NULL AND decided_at IS NULL)
    OR (founder_decision = 'approved' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT cases_reconstruction_gaps_record_version_check CHECK (record_version >= 1)
);

CREATE TABLE cases_reconstruction_activations (
  reconstruction_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  reconstruction_version_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  audit_event_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  activated_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  activated_at timestamptz NOT NULL,
  PRIMARY KEY (reconstruction_id, organization_id),
  CONSTRAINT cases_reconstruction_activations_parent_fk FOREIGN KEY (reconstruction_id, organization_id)
    REFERENCES cases_reconstructions (id, organization_id),
  CONSTRAINT cases_reconstruction_activations_version_fk FOREIGN KEY (reconstruction_version_id, organization_id)
    REFERENCES cases_reconstruction_versions (id, organization_id),
  CONSTRAINT cases_reconstruction_activations_case_fk FOREIGN KEY (service_case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT cases_reconstruction_activations_audit_fk FOREIGN KEY (audit_event_id, organization_id)
    REFERENCES audit_events (id, organization_id),
  CONSTRAINT cases_reconstruction_activations_outbox_fk FOREIGN KEY (outbox_id, organization_id)
    REFERENCES audit_outbox (id, organization_id),
  CONSTRAINT cases_reconstruction_activations_outbox_key UNIQUE (outbox_id)
);

-- The receipt is scoped by tenant, actor, operation, target and expected
-- version. The request hash is over the same scope plus normalized business
-- payload; request IDs, timestamps, generated IDs and the key are excluded.
CREATE TABLE cases_reconstruction_idempotency (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  actor_user_id uuid NOT NULL REFERENCES identity_users (id),
  command_type text NOT NULL,
  aggregate_id uuid,
  pilot_reference text,
  expected_record_version integer,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL,
  result_reference text,
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT cases_reconstruction_idempotency_scope_key UNIQUE NULLS NOT DISTINCT (
    organization_id, actor_user_id, command_type, aggregate_id, pilot_reference,
    expected_record_version, idempotency_key
  ),
  CONSTRAINT cases_reconstruction_idempotency_state_check CHECK (state IN ('in_progress', 'completed', 'failed_reconcilable')),
  CONSTRAINT cases_reconstruction_idempotency_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT cases_reconstruction_idempotency_target_check CHECK (aggregate_id IS NOT NULL OR pilot_reference IS NOT NULL),
  CONSTRAINT cases_reconstruction_idempotency_timestamps_check CHECK (updated_at >= created_at)
);

CREATE INDEX cases_reconstructions_case_idx ON cases_reconstructions (organization_id, service_case_id);
CREATE INDEX cases_reconstruction_events_version_idx ON cases_reconstruction_events (organization_id, reconstruction_version_id, occurred_at, sequence_no);
CREATE INDEX cases_reconstruction_gaps_version_idx ON cases_reconstruction_gaps (organization_id, reconstruction_version_id);

CREATE FUNCTION cases_reconstruction_reject_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
    CONSTRAINT = 'cases_reconstruction_append_only',
    MESSAGE = 'reconstruction history is append-only';
END;
$$;

CREATE FUNCTION cases_reconstruction_validate_correction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_correction_id uuid;
  target_reconstruction_id uuid;
  target_version_id uuid;
  parent_activated_version_id uuid;
  new_reconstruction_id uuid;
BEGIN
  IF NEW.correction_of_event_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT reconstruction_version_id, correction_of_event_id
    INTO target_version_id, target_correction_id
    FROM cases_reconstruction_events
    WHERE id = NEW.correction_of_event_id AND organization_id = NEW.organization_id;
  IF target_correction_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      CONSTRAINT = 'cases_reconstruction_no_correction_chain',
      MESSAGE = 'a correction cannot target another correction';
  END IF;
  SELECT reconstruction_id INTO target_reconstruction_id
    FROM cases_reconstruction_versions
    WHERE id = (SELECT reconstruction_version_id FROM cases_reconstruction_events WHERE id = NEW.correction_of_event_id AND organization_id = NEW.organization_id)
      AND organization_id = NEW.organization_id;
  SELECT reconstruction_id INTO new_reconstruction_id
    FROM cases_reconstruction_versions
    WHERE id = NEW.reconstruction_version_id AND organization_id = NEW.organization_id;
  IF target_reconstruction_id IS NULL OR target_reconstruction_id <> new_reconstruction_id THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      CONSTRAINT = 'cases_reconstruction_correction_target_aggregate',
      MESSAGE = 'correction target must belong to the same reconstruction aggregate';
  END IF;
  SELECT reconstruction.activated_version_id
    INTO parent_activated_version_id
    FROM cases_reconstructions AS reconstruction
    WHERE reconstruction.id = target_reconstruction_id
      AND reconstruction.organization_id = NEW.organization_id;
  IF target_version_id IS DISTINCT FROM parent_activated_version_id THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      CONSTRAINT = 'cases_reconstruction_correction_target_activated_version',
      MESSAGE = 'correction target must belong to the aggregate activated version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_reconstruction_events_validate_correction
BEFORE INSERT ON cases_reconstruction_events
FOR EACH ROW EXECUTE FUNCTION cases_reconstruction_validate_correction();

CREATE TRIGGER cases_reconstruction_events_append_only
BEFORE UPDATE OR DELETE ON cases_reconstruction_events
FOR EACH ROW EXECUTE FUNCTION cases_reconstruction_reject_history_mutation();

CREATE TRIGGER cases_reconstruction_activations_append_only
BEFORE UPDATE OR DELETE ON cases_reconstruction_activations
FOR EACH ROW EXECUTE FUNCTION cases_reconstruction_reject_history_mutation();

ALTER TABLE cases_reconstructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_reconstructions FORCE ROW LEVEL SECURITY;
ALTER TABLE cases_reconstruction_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_reconstruction_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE cases_reconstruction_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_reconstruction_events FORCE ROW LEVEL SECURITY;
ALTER TABLE cases_reconstruction_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_reconstruction_gaps FORCE ROW LEVEL SECURITY;
ALTER TABLE cases_reconstruction_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_reconstruction_activations FORCE ROW LEVEL SECURITY;
ALTER TABLE cases_reconstruction_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_reconstruction_idempotency FORCE ROW LEVEL SECURITY;

CREATE POLICY tianxing_tenant_boundary ON cases_reconstructions
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY tianxing_tenant_boundary ON cases_reconstruction_versions
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY tianxing_tenant_boundary ON cases_reconstruction_events
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY tianxing_tenant_boundary ON cases_reconstruction_gaps
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY tianxing_tenant_boundary ON cases_reconstruction_activations
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY tianxing_tenant_boundary ON cases_reconstruction_idempotency
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));

-- P3-19 remains the approval authority. This migration intentionally creates no
-- pilot-approval table, seed row, backfill, production role grant, or runtime DDL.
