CREATE TABLE crm_duplicate_candidates (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  entity_type text NOT NULL,
  left_record_id uuid NOT NULL,
  right_record_id uuid NOT NULL,
  left_display_label text NOT NULL,
  right_display_label text NOT NULL,
  matching_signals text[] NOT NULL,
  status text NOT NULL DEFAULT 'review_required',
  merge_id uuid,
  record_version bigint NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT crm_duplicate_candidates_entity_check CHECK (entity_type IN ('student','guardian')),
  CONSTRAINT crm_duplicate_candidates_pair_order_check CHECK (left_record_id < right_record_id),
  CONSTRAINT crm_duplicate_candidates_labels_check CHECK (
    btrim(left_display_label) <> '' AND btrim(right_display_label) <> ''
  ),
  CONSTRAINT crm_duplicate_candidates_signals_check CHECK (
    cardinality(matching_signals) BETWEEN 1 AND 4
    AND matching_signals <@ ARRAY['display_name','date_of_birth','email','phone']::text[]
  ),
  CONSTRAINT crm_duplicate_candidates_status_check CHECK (status IN ('review_required','merged')),
  CONSTRAINT crm_duplicate_candidates_merge_state_check CHECK (
    (status = 'review_required' AND merge_id IS NULL) OR (status = 'merged' AND merge_id IS NOT NULL)
  ),
  CONSTRAINT crm_duplicate_candidates_version_check CHECK (record_version >= 1),
  CONSTRAINT crm_duplicate_candidates_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT crm_duplicate_candidates_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT crm_duplicate_candidates_pair_key UNIQUE (
    organization_id, entity_type, left_record_id, right_record_id
  )
);

CREATE TABLE crm_duplicate_merges (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  candidate_id uuid NOT NULL,
  entity_type text NOT NULL,
  source_record_id uuid NOT NULL,
  canonical_record_id uuid NOT NULL,
  provenance_revision_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  correction_id uuid,
  reason_code text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  approved_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT crm_duplicate_merges_candidate_fk FOREIGN KEY (candidate_id, organization_id)
    REFERENCES crm_duplicate_candidates (id, organization_id),
  CONSTRAINT crm_duplicate_merges_entity_check CHECK (entity_type IN ('student','guardian')),
  CONSTRAINT crm_duplicate_merges_pair_check CHECK (source_record_id <> canonical_record_id),
  CONSTRAINT crm_duplicate_merges_reason_check CHECK (reason_code = 'duplicate.confirmed'),
  CONSTRAINT crm_duplicate_merges_status_check CHECK (status IN ('active','corrected')),
  CONSTRAINT crm_duplicate_merges_correction_state_check CHECK (
    (status = 'active' AND correction_id IS NULL) OR (status = 'corrected' AND correction_id IS NOT NULL)
  ),
  CONSTRAINT crm_duplicate_merges_version_check CHECK (record_version >= 1),
  CONSTRAINT crm_duplicate_merges_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT crm_duplicate_merges_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT crm_duplicate_merges_candidate_key UNIQUE (candidate_id)
);

ALTER TABLE crm_duplicate_candidates
  ADD CONSTRAINT crm_duplicate_candidates_merge_fk FOREIGN KEY (merge_id, organization_id)
  REFERENCES crm_duplicate_merges (id, organization_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE crm_duplicate_alias_revisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  merge_id uuid NOT NULL,
  correction_id uuid,
  entity_type text NOT NULL,
  source_record_id uuid NOT NULL,
  target_record_id uuid NOT NULL,
  revision_number bigint NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT crm_duplicate_alias_merge_fk FOREIGN KEY (merge_id, organization_id)
    REFERENCES crm_duplicate_merges (id, organization_id),
  CONSTRAINT crm_duplicate_alias_entity_check CHECK (entity_type IN ('student','guardian')),
  CONSTRAINT crm_duplicate_alias_revision_check CHECK (revision_number >= 1),
  CONSTRAINT crm_duplicate_alias_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT crm_duplicate_alias_revision_key UNIQUE (
    organization_id, entity_type, source_record_id, revision_number
  )
);

CREATE TABLE crm_duplicate_field_provenance_revisions (
  revision_id uuid NOT NULL,
  field_name text NOT NULL,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  merge_id uuid NOT NULL,
  correction_id uuid,
  entity_type text NOT NULL,
  selected_record_id uuid NOT NULL,
  revision_number bigint NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (revision_id, field_name),
  CONSTRAINT crm_duplicate_provenance_merge_fk FOREIGN KEY (merge_id, organization_id)
    REFERENCES crm_duplicate_merges (id, organization_id),
  CONSTRAINT crm_duplicate_provenance_entity_check CHECK (entity_type IN ('student','guardian')),
  CONSTRAINT crm_duplicate_provenance_field_check CHECK (
    field_name IN ('display_name','date_of_birth','contact_email','contact_phone','email','phone')
  ),
  CONSTRAINT crm_duplicate_provenance_revision_check CHECK (revision_number >= 1)
);

CREATE TABLE crm_duplicate_merge_corrections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  merge_id uuid NOT NULL,
  source_record_id uuid NOT NULL,
  canonical_record_id uuid NOT NULL,
  restored_alias_target_id uuid NOT NULL,
  reason_code text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  corrected_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT crm_duplicate_corrections_merge_fk FOREIGN KEY (merge_id, organization_id)
    REFERENCES crm_duplicate_merges (id, organization_id),
  CONSTRAINT crm_duplicate_corrections_restore_check CHECK (
    source_record_id <> canonical_record_id AND restored_alias_target_id = source_record_id
  ),
  CONSTRAINT crm_duplicate_corrections_reason_check CHECK (reason_code = 'duplicate.merge.corrected'),
  CONSTRAINT crm_duplicate_corrections_version_check CHECK (record_version >= 1),
  CONSTRAINT crm_duplicate_corrections_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT crm_duplicate_corrections_merge_key UNIQUE (merge_id)
);

ALTER TABLE crm_duplicate_merges
  ADD CONSTRAINT crm_duplicate_merges_correction_fk FOREIGN KEY (correction_id, organization_id)
  REFERENCES crm_duplicate_merge_corrections (id, organization_id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX crm_duplicate_candidates_queue_idx
  ON crm_duplicate_candidates (organization_id, entity_type, status, created_at, id);
CREATE INDEX crm_duplicate_alias_current_idx
  ON crm_duplicate_alias_revisions (organization_id, entity_type, source_record_id, revision_number DESC);
CREATE INDEX crm_duplicate_alias_target_idx
  ON crm_duplicate_alias_revisions (organization_id, entity_type, target_record_id, revision_number DESC);
CREATE INDEX crm_duplicate_provenance_merge_idx
  ON crm_duplicate_field_provenance_revisions (organization_id, merge_id, revision_number, field_name);

CREATE FUNCTION crm_validate_duplicate_candidate_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'review_required' OR NEW.merge_id IS NOT NULL OR NEW.record_version <> 1 THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='crm_duplicate_candidate_initial_check';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.entity_type IS DISTINCT FROM OLD.entity_type OR NEW.left_record_id IS DISTINCT FROM OLD.left_record_id
     OR NEW.right_record_id IS DISTINCT FROM OLD.right_record_id
     OR NEW.left_display_label IS DISTINCT FROM OLD.left_display_label
     OR NEW.right_display_label IS DISTINCT FROM OLD.right_display_label
     OR NEW.matching_signals IS DISTINCT FROM OLD.matching_signals
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.status <> 'review_required' OR NEW.status <> 'merged'
     OR OLD.merge_id IS NOT NULL OR NEW.merge_id IS NULL
     OR NEW.record_version <> OLD.record_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='crm_duplicate_candidate_transition_check';
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION crm_validate_duplicate_merge_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.correction_id IS NOT NULL OR NEW.record_version <> 1 THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='crm_duplicate_merge_initial_check';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.source_record_id IS DISTINCT FROM OLD.source_record_id
     OR NEW.canonical_record_id IS DISTINCT FROM OLD.canonical_record_id
     OR NEW.provenance_revision_id IS DISTINCT FROM OLD.provenance_revision_id
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.status <> 'active'
     OR NEW.status <> 'corrected' OR OLD.correction_id IS NOT NULL OR NEW.correction_id IS NULL
     OR NEW.record_version <> OLD.record_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='crm_duplicate_merge_transition_check';
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION crm_reject_duplicate_revision_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='crm_duplicate_revision_append_only_check';
END; $$;

CREATE TRIGGER crm_duplicate_candidates_write_trg
BEFORE INSERT OR UPDATE ON crm_duplicate_candidates
FOR EACH ROW EXECUTE FUNCTION crm_validate_duplicate_candidate_write();
CREATE TRIGGER crm_duplicate_candidates_delete_trg
BEFORE DELETE ON crm_duplicate_candidates
FOR EACH ROW EXECUTE FUNCTION crm_reject_duplicate_revision_change();
CREATE TRIGGER crm_duplicate_merges_write_trg
BEFORE INSERT OR UPDATE ON crm_duplicate_merges
FOR EACH ROW EXECUTE FUNCTION crm_validate_duplicate_merge_write();
CREATE TRIGGER crm_duplicate_merges_delete_trg
BEFORE DELETE ON crm_duplicate_merges
FOR EACH ROW EXECUTE FUNCTION crm_reject_duplicate_revision_change();
CREATE TRIGGER crm_duplicate_alias_append_only_trg
BEFORE UPDATE OR DELETE ON crm_duplicate_alias_revisions
FOR EACH ROW EXECUTE FUNCTION crm_reject_duplicate_revision_change();
CREATE TRIGGER crm_duplicate_provenance_append_only_trg
BEFORE UPDATE OR DELETE ON crm_duplicate_field_provenance_revisions
FOR EACH ROW EXECUTE FUNCTION crm_reject_duplicate_revision_change();
CREATE TRIGGER crm_duplicate_corrections_append_only_trg
BEFORE UPDATE OR DELETE ON crm_duplicate_merge_corrections
FOR EACH ROW EXECUTE FUNCTION crm_reject_duplicate_revision_change();

ALTER TABLE crm_duplicate_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_duplicate_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_duplicate_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_duplicate_merges FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_duplicate_alias_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_duplicate_alias_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_duplicate_field_provenance_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_duplicate_field_provenance_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_duplicate_merge_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_duplicate_merge_corrections FORCE ROW LEVEL SECURITY;

CREATE POLICY crm_duplicate_candidates_tenant_policy ON crm_duplicate_candidates
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY crm_duplicate_merges_tenant_policy ON crm_duplicate_merges
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY crm_duplicate_alias_tenant_policy ON crm_duplicate_alias_revisions
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY crm_duplicate_provenance_tenant_policy ON crm_duplicate_field_provenance_revisions
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY crm_duplicate_corrections_tenant_policy ON crm_duplicate_merge_corrections
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON crm_duplicate_candidates TO tianxing_app;
GRANT SELECT, INSERT, UPDATE ON crm_duplicate_merges TO tianxing_app;
GRANT SELECT, INSERT ON crm_duplicate_alias_revisions TO tianxing_app;
GRANT SELECT, INSERT ON crm_duplicate_field_provenance_revisions TO tianxing_app;
GRANT SELECT, INSERT ON crm_duplicate_merge_corrections TO tianxing_app;

REVOKE ALL ON FUNCTION crm_validate_duplicate_candidate_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_validate_duplicate_merge_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_reject_duplicate_revision_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_validate_duplicate_candidate_write() TO tianxing_app;
GRANT EXECUTE ON FUNCTION crm_validate_duplicate_merge_write() TO tianxing_app;
GRANT EXECUTE ON FUNCTION crm_reject_duplicate_revision_change() TO tianxing_app;
