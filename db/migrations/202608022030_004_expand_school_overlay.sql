CREATE TABLE schools_schools (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  source_school_key text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT schools_schools_composite_key UNIQUE (id, organization_id),
  CONSTRAINT schools_schools_source_key_check CHECK (
    source_school_key IS NULL OR btrim(source_school_key) <> ''
  ),
  CONSTRAINT schools_schools_record_version_check CHECK (record_version >= 1),
  CONSTRAINT schools_schools_timestamps_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX schools_schools_source_key_idx
  ON schools_schools (organization_id, source_school_key)
  WHERE source_school_key IS NOT NULL;

CREATE TABLE schools_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  source_release_id text NOT NULL,
  manifest_sha256 char(64) NOT NULL,
  file_set_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'candidate',
  record_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT schools_snapshots_composite_key UNIQUE (id, organization_id),
  CONSTRAINT schools_snapshots_release_check CHECK (btrim(source_release_id) <> ''),
  CONSTRAINT schools_snapshots_manifest_hash_check CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT schools_snapshots_file_set_check CHECK (jsonb_typeof(file_set_json) = 'object'),
  CONSTRAINT schools_snapshots_status_check CHECK (status IN ('candidate', 'active', 'retired')),
  CONSTRAINT schools_snapshots_record_count_check CHECK (record_count >= 0),
  CONSTRAINT schools_snapshots_timestamps_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX schools_snapshots_one_active_idx
  ON schools_snapshots (organization_id)
  WHERE status = 'active';

CREATE TABLE schools_snapshot_records (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  school_id uuid NOT NULL,
  source_school_key text NOT NULL,
  fields_json jsonb NOT NULL,
  provenance_json jsonb NOT NULL,
  record_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT schools_snapshot_records_snapshot_fk FOREIGN KEY (
    snapshot_id,
    organization_id
  ) REFERENCES schools_snapshots (id, organization_id),
  CONSTRAINT schools_snapshot_records_school_fk FOREIGN KEY (
    school_id,
    organization_id
  ) REFERENCES schools_schools (id, organization_id),
  CONSTRAINT schools_snapshot_records_source_key_check CHECK (btrim(source_school_key) <> ''),
  CONSTRAINT schools_snapshot_records_fields_check CHECK (jsonb_typeof(fields_json) = 'object'),
  CONSTRAINT schools_snapshot_records_provenance_check CHECK (
    jsonb_typeof(provenance_json) = 'object'
  ),
  CONSTRAINT schools_snapshot_records_hash_check CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT schools_snapshot_records_snapshot_source_key_key UNIQUE (
    organization_id,
    snapshot_id,
    source_school_key
  ),
  CONSTRAINT schools_snapshot_records_snapshot_school_key UNIQUE (
    organization_id,
    snapshot_id,
    school_id
  )
);

CREATE TABLE schools_overlay_revisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  base_snapshot_id uuid NOT NULL,
  revision_number bigint NOT NULL,
  status text NOT NULL DEFAULT 'candidate',
  requested_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  reason text NOT NULL,
  approved_by_user_id uuid REFERENCES identity_users (id),
  approved_role text,
  approved_at timestamptz,
  disabled_by_user_id uuid REFERENCES identity_users (id),
  disabled_at timestamptz,
  disable_reason text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT schools_overlay_revisions_school_fk FOREIGN KEY (
    school_id,
    organization_id
  ) REFERENCES schools_schools (id, organization_id),
  CONSTRAINT schools_overlay_revisions_snapshot_fk FOREIGN KEY (
    base_snapshot_id,
    organization_id
  ) REFERENCES schools_snapshots (id, organization_id),
  CONSTRAINT schools_overlay_revisions_composite_key UNIQUE (
    id,
    organization_id,
    school_id
  ),
  CONSTRAINT schools_overlay_revisions_number_key UNIQUE (
    organization_id,
    school_id,
    revision_number
  ),
  CONSTRAINT schools_overlay_revisions_number_check CHECK (revision_number >= 1),
  CONSTRAINT schools_overlay_revisions_status_check CHECK (
    status IN ('candidate', 'approved', 'disabled', 'rejected')
  ),
  CONSTRAINT schools_overlay_revisions_role_check CHECK (
    approved_role IS NULL OR approved_role IN ('founder', 'data_reviewer')
  ),
  CONSTRAINT schools_overlay_revisions_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT schools_overlay_revisions_receipt_check CHECK (
    (
      status = 'candidate'
      AND approved_by_user_id IS NULL
      AND approved_role IS NULL
      AND approved_at IS NULL
      AND disabled_by_user_id IS NULL
      AND disabled_at IS NULL
      AND disable_reason IS NULL
    )
    OR (
      status = 'rejected'
      AND approved_by_user_id IS NULL
      AND approved_role IS NULL
      AND approved_at IS NULL
      AND disabled_by_user_id IS NULL
      AND disabled_at IS NULL
      AND disable_reason IS NULL
    )
    OR (
      status = 'approved'
      AND approved_by_user_id IS NOT NULL
      AND approved_role IS NOT NULL
      AND approved_at IS NOT NULL
      AND disabled_by_user_id IS NULL
      AND disabled_at IS NULL
      AND disable_reason IS NULL
    )
    OR (
      status = 'disabled'
      AND approved_by_user_id IS NOT NULL
      AND approved_role IS NOT NULL
      AND approved_at IS NOT NULL
      AND disabled_by_user_id IS NOT NULL
      AND disabled_at IS NOT NULL
      AND disable_reason IS NOT NULL
      AND btrim(disable_reason) <> ''
    )
  ),
  CONSTRAINT schools_overlay_revisions_record_version_check CHECK (record_version >= 1),
  CONSTRAINT schools_overlay_revisions_timestamps_check CHECK (updated_at >= created_at)
);

CREATE TABLE schools_overlay_fields (
  organization_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  school_id uuid NOT NULL,
  field_name text NOT NULL,
  field_class text NOT NULL,
  proposed_value_json jsonb NOT NULL,
  base_value_sha256 char(64) NOT NULL,
  evidence_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id, revision_id, school_id, field_name),
  CONSTRAINT schools_overlay_fields_revision_fk FOREIGN KEY (
    revision_id,
    organization_id,
    school_id
  ) REFERENCES schools_overlay_revisions (id, organization_id, school_id),
  CONSTRAINT schools_overlay_fields_name_check CHECK (btrim(field_name) <> ''),
  CONSTRAINT schools_overlay_fields_class_check CHECK (field_class IN ('identity', 'general')),
  CONSTRAINT schools_overlay_fields_identity_class_check CHECK (
    field_name NOT IN ('school_key', 'school_name_zh', 'school_name_en', 'official_website')
    OR field_class = 'identity'
  ),
  CONSTRAINT schools_overlay_fields_hash_check CHECK (base_value_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT schools_overlay_fields_evidence_check CHECK (jsonb_typeof(evidence_json) = 'object')
);

CREATE TABLE schools_overlay_review_queue (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  field_name text NOT NULL,
  kind text NOT NULL,
  previous_base_value_sha256 char(64) NOT NULL,
  current_base_value_sha256 char(64) NOT NULL,
  status text NOT NULL DEFAULT 'open',
  resolved_by_user_id uuid REFERENCES identity_users (id),
  resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT schools_overlay_review_queue_revision_fk FOREIGN KEY (
    revision_id,
    organization_id,
    school_id
  ) REFERENCES schools_overlay_revisions (id, organization_id, school_id),
  CONSTRAINT schools_overlay_review_queue_kind_check CHECK (kind = 'base_changed'),
  CONSTRAINT schools_overlay_review_queue_status_check CHECK (
    status IN ('open', 'resolved', 'dismissed')
  ),
  CONSTRAINT schools_overlay_review_queue_previous_hash_check CHECK (
    previous_base_value_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT schools_overlay_review_queue_current_hash_check CHECK (
    current_base_value_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT schools_overlay_review_queue_resolution_check CHECK (
    (
      status = 'open'
      AND resolved_by_user_id IS NULL
      AND resolution_reason IS NULL
    )
    OR (
      status IN ('resolved', 'dismissed')
      AND resolved_by_user_id IS NOT NULL
      AND resolution_reason IS NOT NULL
      AND btrim(resolution_reason) <> ''
    )
  ),
  CONSTRAINT schools_overlay_review_queue_unique_key UNIQUE (
    organization_id,
    revision_id,
    field_name,
    previous_base_value_sha256,
    current_base_value_sha256
  )
);

CREATE TABLE schools_resolved_revisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  base_snapshot_id uuid NOT NULL,
  overlay_revision_id uuid,
  resolution_sha256 char(64) NOT NULL,
  fields_json jsonb NOT NULL,
  provenance_json jsonb NOT NULL,
  conflicts_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT schools_resolved_revisions_school_fk FOREIGN KEY (
    school_id,
    organization_id
  ) REFERENCES schools_schools (id, organization_id),
  CONSTRAINT schools_resolved_revisions_snapshot_fk FOREIGN KEY (
    base_snapshot_id,
    organization_id
  ) REFERENCES schools_snapshots (id, organization_id),
  CONSTRAINT schools_resolved_revisions_overlay_fk FOREIGN KEY (
    overlay_revision_id,
    organization_id,
    school_id
  ) REFERENCES schools_overlay_revisions (id, organization_id, school_id),
  CONSTRAINT schools_resolved_revisions_composite_key UNIQUE (id, organization_id, school_id),
  CONSTRAINT schools_resolved_revisions_hash_check CHECK (resolution_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT schools_resolved_revisions_fields_check CHECK (jsonb_typeof(fields_json) = 'object'),
  CONSTRAINT schools_resolved_revisions_provenance_check CHECK (
    jsonb_typeof(provenance_json) = 'object'
  ),
  CONSTRAINT schools_resolved_revisions_conflicts_check CHECK (
    jsonb_typeof(conflicts_json) = 'array'
  ),
  CONSTRAINT schools_resolved_revisions_unique_hash UNIQUE (
    organization_id,
    school_id,
    resolution_sha256
  )
);

ALTER TABLE cases_school_targets
  ADD CONSTRAINT cases_targets_pinned_resolution_fk FOREIGN KEY (
    pinned_resolved_revision_id,
    organization_id,
    school_id
  ) REFERENCES schools_resolved_revisions (id, organization_id, school_id);

CREATE FUNCTION schools_reject_immutable_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = TG_ARGV[0],
    MESSAGE = 'school snapshot, overlay, or resolved revision history is immutable';
END;
$$;

CREATE FUNCTION schools_validate_school_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.source_school_key IS DISTINCT FROM OLD.source_school_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'schools_schools_identity_immutable_check',
      MESSAGE = 'school identity is immutable in P0-08';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION schools_validate_snapshot_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.source_release_id IS DISTINCT FROM OLD.source_release_id
     OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
     OR NEW.file_set_json IS DISTINCT FROM OLD.file_set_json
     OR NEW.record_count IS DISTINCT FROM OLD.record_count
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'schools_snapshots_content_immutable_check',
      MESSAGE = 'snapshot content is immutable';
  END IF;

  IF OLD.status = 'candidate' AND NEW.status NOT IN ('candidate', 'active', 'retired') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'schools_snapshots_status_transition_check',
      MESSAGE = 'invalid snapshot status';
  END IF;
  IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'retired') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'schools_snapshots_status_transition_check',
      MESSAGE = 'active snapshot cannot return to candidate';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'schools_snapshots_status_transition_check',
      MESSAGE = 'retired snapshot cannot be reactivated';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION schools_validate_snapshot_record_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'schools_snapshot_records_immutable_check',
    MESSAGE = 'snapshot records are immutable';
END;
$$;

CREATE FUNCTION schools_validate_overlay_field_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status
      INTO revision_status
      FROM schools_overlay_revisions
     WHERE id = NEW.revision_id
       AND organization_id = NEW.organization_id
       AND school_id = NEW.school_id;
    IF revision_status IS DISTINCT FROM 'candidate' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'schools_overlay_fields_candidate_only_check',
        MESSAGE = 'overlay fields may only be added to candidate revisions';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'schools_overlay_fields_immutable_check',
    MESSAGE = 'overlay fields are immutable';
END;
$$;

CREATE FUNCTION schools_validate_review_queue_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.school_id IS DISTINCT FROM OLD.school_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.field_name IS DISTINCT FROM OLD.field_name
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.previous_base_value_sha256 IS DISTINCT FROM OLD.previous_base_value_sha256
     OR NEW.current_base_value_sha256 IS DISTINCT FROM OLD.current_base_value_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.status <> 'open'
     OR NEW.status NOT IN ('resolved', 'dismissed')
     OR NEW.resolved_by_user_id IS NULL
     OR NEW.resolution_reason IS NULL
     OR btrim(NEW.resolution_reason) = ''
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'schools_overlay_review_queue_immutable_check',
      MESSAGE = 'review queue history is immutable after one resolution receipt';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION schools_validate_overlay_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  field_classes text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'candidate' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'schools_overlay_candidate_insert_check',
        MESSAGE = 'overlay revisions must enter as candidate';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.school_id IS DISTINCT FROM OLD.school_id
     OR NEW.base_snapshot_id IS DISTINCT FROM OLD.base_snapshot_id
     OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'schools_overlay_revision_content_immutable_check',
      MESSAGE = 'overlay revision content is immutable';
  END IF;

  IF OLD.status = 'candidate' AND NEW.status = 'approved' THEN
    IF NEW.approved_by_user_id IS NULL
       OR NEW.approved_role IS NULL
       OR NEW.approved_at IS NULL
       OR NEW.approved_by_user_id = NEW.requested_by_user_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'schools_overlay_reviewer_separation_check',
        MESSAGE = 'overlay approval requires a separate reviewer';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM identity_users AS reviewer
        JOIN access_role_bindings AS binding
          ON binding.user_id = reviewer.id
         AND binding.organization_id = NEW.organization_id
         AND binding.role = NEW.approved_role
         AND binding.status = 'active'
       WHERE reviewer.id = NEW.approved_by_user_id
         AND reviewer.status = 'active'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        CONSTRAINT = 'schools_overlay_reviewer_role_check',
        MESSAGE = 'overlay reviewer has no active role binding';
    END IF;

    SELECT array_agg(DISTINCT field_class)
      INTO field_classes
      FROM schools_overlay_fields
     WHERE organization_id = NEW.organization_id
       AND revision_id = NEW.id
       AND school_id = NEW.school_id;

    IF field_classes IS NULL OR cardinality(field_classes) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'schools_overlay_fields_required_check',
        MESSAGE = 'overlay approval requires fields';
    END IF;
    IF 'identity' = ANY(field_classes) AND NEW.approved_role <> 'founder' THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        CONSTRAINT = 'schools_overlay_identity_founder_check',
        MESSAGE = 'identity overlay changes require Founder approval';
    END IF;
  ELSIF OLD.status = 'candidate' AND NEW.status = 'rejected' THEN
    IF NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'schools_overlay_rejection_receipt_check',
        MESSAGE = 'rejected overlay cannot carry approval receipt';
    END IF;
  ELSIF OLD.status = 'approved' AND NEW.status = 'disabled' THEN
    IF NEW.disabled_by_user_id IS NULL
       OR NEW.disabled_at IS NULL
       OR NEW.disable_reason IS NULL
       OR btrim(NEW.disable_reason) = ''
       OR NEW.disabled_by_user_id = NEW.requested_by_user_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'schools_overlay_disable_receipt_check',
        MESSAGE = 'overlay disable requires separate actor, time, and reason';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM identity_users AS disabler
        JOIN access_role_bindings AS binding
          ON binding.user_id = disabler.id
         AND binding.organization_id = NEW.organization_id
         AND binding.role IN ('founder', 'data_reviewer')
         AND binding.status = 'active'
       WHERE disabler.id = NEW.disabled_by_user_id
         AND disabler.status = 'active'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        CONSTRAINT = 'schools_overlay_disabler_role_check',
        MESSAGE = 'overlay rollback requires an active Founder or Data Reviewer';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'schools_overlay_status_transition_check',
      MESSAGE = 'overlay status transition is not allowed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION schools_validate_resolution_pin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_sha256 char(64);
BEGIN
  IF NEW.pinned_resolved_revision_id IS NULL THEN
    IF NEW.pinned_resolution_sha256 IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_targets_pinned_resolution_pair_check',
        MESSAGE = 'resolution hash requires a pinned resolution';
    END IF;
    RETURN NEW;
  END IF;

  SELECT resolution_sha256
    INTO expected_sha256
    FROM schools_resolved_revisions
   WHERE id = NEW.pinned_resolved_revision_id
     AND organization_id = NEW.organization_id
     AND school_id = NEW.school_id;
  IF expected_sha256 IS NULL OR NEW.pinned_resolution_sha256 IS DISTINCT FROM expected_sha256 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_targets_pinned_resolution_hash_check',
      MESSAGE = 'pinned resolution hash does not match the immutable resolution';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION schools_validate_resolved_revision_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'schools_resolved_revisions_immutable_check',
    MESSAGE = 'resolved revisions are immutable';
END;
$$;

CREATE TRIGGER schools_schools_write_trg
BEFORE INSERT OR UPDATE ON schools_schools
FOR EACH ROW EXECUTE FUNCTION schools_validate_school_write();

CREATE TRIGGER schools_snapshots_write_trg
BEFORE INSERT OR UPDATE ON schools_snapshots
FOR EACH ROW EXECUTE FUNCTION schools_validate_snapshot_write();

CREATE TRIGGER schools_snapshot_records_write_trg
BEFORE INSERT OR UPDATE ON schools_snapshot_records
FOR EACH ROW EXECUTE FUNCTION schools_validate_snapshot_record_write();

CREATE TRIGGER schools_overlay_fields_write_trg
BEFORE INSERT OR UPDATE ON schools_overlay_fields
FOR EACH ROW EXECUTE FUNCTION schools_validate_overlay_field_write();

CREATE TRIGGER schools_overlay_review_queue_write_trg
BEFORE UPDATE ON schools_overlay_review_queue
FOR EACH ROW EXECUTE FUNCTION schools_validate_review_queue_write();

CREATE TRIGGER schools_overlay_revisions_write_trg
BEFORE INSERT OR UPDATE ON schools_overlay_revisions
FOR EACH ROW EXECUTE FUNCTION schools_validate_overlay_approval();

CREATE TRIGGER schools_resolved_revisions_write_trg
BEFORE INSERT OR UPDATE ON schools_resolved_revisions
FOR EACH ROW EXECUTE FUNCTION schools_validate_resolved_revision_write();

CREATE TRIGGER schools_schools_delete_trg
BEFORE DELETE ON schools_schools
FOR EACH ROW EXECUTE FUNCTION schools_reject_immutable_delete('schools_schools_delete_rejected');

CREATE TRIGGER schools_snapshots_delete_trg
BEFORE DELETE ON schools_snapshots
FOR EACH ROW EXECUTE FUNCTION schools_reject_immutable_delete('schools_snapshots_delete_rejected');

CREATE TRIGGER schools_snapshot_records_delete_trg
BEFORE DELETE ON schools_snapshot_records
FOR EACH ROW EXECUTE FUNCTION schools_reject_immutable_delete('schools_snapshot_records_delete_rejected');

CREATE TRIGGER schools_overlay_fields_delete_trg
BEFORE DELETE ON schools_overlay_fields
FOR EACH ROW EXECUTE FUNCTION schools_reject_immutable_delete('schools_overlay_fields_delete_rejected');

CREATE TRIGGER schools_overlay_review_queue_delete_trg
BEFORE DELETE ON schools_overlay_review_queue
FOR EACH ROW EXECUTE FUNCTION schools_reject_immutable_delete('schools_overlay_review_queue_delete_rejected');

CREATE TRIGGER schools_resolved_revisions_delete_trg
BEFORE DELETE ON schools_resolved_revisions
FOR EACH ROW EXECUTE FUNCTION schools_reject_immutable_delete('schools_resolved_revisions_delete_rejected');

CREATE TRIGGER cases_targets_resolution_pin_trg
BEFORE INSERT OR UPDATE ON cases_school_targets
FOR EACH ROW EXECUTE FUNCTION schools_validate_resolution_pin();
