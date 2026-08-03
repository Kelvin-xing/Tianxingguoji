CREATE TABLE documents_documents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  owner_kind text NOT NULL,
  student_id uuid,
  service_case_id uuid,
  task_id uuid,
  classification text NOT NULL,
  lifecycle_state text NOT NULL DEFAULT 'active',
  active_document_version_id uuid,
  legal_hold boolean NOT NULL DEFAULT false,
  legal_hold_reason text,
  soft_deleted_at timestamptz,
  retention_ends_at timestamptz,
  purge_approved_by_user_id uuid REFERENCES identity_users (id),
  purge_approved_at timestamptz,
  purge_reason text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT documents_documents_student_fk FOREIGN KEY (student_id, organization_id)
    REFERENCES crm_students (id, organization_id),
  CONSTRAINT documents_documents_case_fk FOREIGN KEY (service_case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT documents_documents_task_fk FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks_tasks (id, organization_id),
  CONSTRAINT documents_documents_composite_key UNIQUE (id, organization_id),
  CONSTRAINT documents_documents_owner_check CHECK (
    (
      owner_kind = 'student'
      AND student_id IS NOT NULL
      AND service_case_id IS NULL
      AND task_id IS NULL
    )
    OR (
      owner_kind = 'case'
      AND student_id IS NULL
      AND service_case_id IS NOT NULL
      AND task_id IS NULL
    )
    OR (
      owner_kind = 'task'
      AND student_id IS NULL
      AND service_case_id IS NULL
      AND task_id IS NOT NULL
    )
  ),
  CONSTRAINT documents_documents_classification_check CHECK (btrim(classification) <> ''),
  CONSTRAINT documents_documents_lifecycle_check CHECK (
    lifecycle_state IN ('active', 'pending_delete', 'deleted')
  ),
  CONSTRAINT documents_documents_delete_receipt_check CHECK (
    (
      lifecycle_state = 'active'
      AND soft_deleted_at IS NULL
    )
    OR (
      lifecycle_state = 'pending_delete'
      AND soft_deleted_at IS NOT NULL
    )
    OR (
      lifecycle_state = 'deleted'
      AND soft_deleted_at IS NOT NULL
      AND active_document_version_id IS NULL
    )
  ),
  CONSTRAINT documents_documents_legal_hold_check CHECK (
    (
      legal_hold = false
      AND legal_hold_reason IS NULL
    )
    OR (
      legal_hold = true
      AND legal_hold_reason IS NOT NULL
      AND btrim(legal_hold_reason) <> ''
    )
  ),
  CONSTRAINT documents_documents_retention_check CHECK (
    retention_ends_at IS NULL
    OR (
      soft_deleted_at IS NOT NULL
      AND retention_ends_at >= soft_deleted_at
    )
  ),
  CONSTRAINT documents_documents_purge_approval_check CHECK (
    (
      lifecycle_state <> 'deleted'
      AND purge_approved_by_user_id IS NULL
      AND purge_approved_at IS NULL
      AND purge_reason IS NULL
    )
    OR (
      lifecycle_state = 'deleted'
      AND purge_approved_by_user_id IS NOT NULL
      AND purge_approved_at IS NOT NULL
      AND purge_reason IS NOT NULL
      AND btrim(purge_reason) <> ''
    )
  ),
  CONSTRAINT documents_documents_purge_timestamp_check CHECK (
    purge_approved_at IS NULL
    OR (
      soft_deleted_at IS NOT NULL
      AND purge_approved_at >= soft_deleted_at
    )
  ),
  CONSTRAINT documents_documents_record_version_check CHECK (record_version >= 1),
  CONSTRAINT documents_documents_timestamps_check CHECK (updated_at >= created_at)
);

CREATE TABLE documents_document_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  document_id uuid NOT NULL,
  object_storage_region text NOT NULL DEFAULT 'ap-east-1',
  object_bucket text NOT NULL,
  object_key text NOT NULL,
  object_version_id text,
  checksum_sha256 char(64) NOT NULL,
  size_bytes bigint NOT NULL,
  detected_content_type text NOT NULL,
  uploaded_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  state text NOT NULL DEFAULT 'pending_upload',
  revoked_at timestamptz,
  revoke_reason text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT documents_document_versions_document_fk FOREIGN KEY (document_id, organization_id)
    REFERENCES documents_documents (id, organization_id),
  CONSTRAINT documents_document_versions_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT documents_document_versions_composite_key UNIQUE (id, organization_id, document_id),
  CONSTRAINT documents_document_versions_region_check CHECK (
    object_storage_region = 'ap-east-1'
  ),
  CONSTRAINT documents_document_versions_bucket_check CHECK (btrim(object_bucket) <> ''),
  CONSTRAINT documents_document_versions_key_check CHECK (
    object_key ~ '^documents/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/versions/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT documents_document_versions_provider_version_check CHECK (
    object_version_id IS NULL
    OR (
      btrim(object_version_id) <> ''
      AND object_version_id !~ '[[:space:]]'
    )
  ),
  CONSTRAINT documents_document_versions_checksum_check CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT documents_document_versions_size_check CHECK (size_bytes >= 0),
  CONSTRAINT documents_document_versions_content_type_check CHECK (
    btrim(detected_content_type) <> ''
  ),
  CONSTRAINT documents_document_versions_state_check CHECK (
    state IN (
      'pending_upload',
      'quarantined',
      'scanning',
      'available',
      'rejected',
      'scan_failed',
      'superseded',
      'pending_delete',
      'deleted'
    )
  ),
  CONSTRAINT documents_document_versions_revocation_check CHECK (
    (
      revoked_at IS NULL
      AND revoke_reason IS NULL
    )
    OR (
      revoked_at IS NOT NULL
      AND revoke_reason IS NOT NULL
      AND btrim(revoke_reason) <> ''
    )
  ),
  CONSTRAINT documents_document_versions_available_check CHECK (
    state <> 'available' OR revoked_at IS NULL
  ),
  CONSTRAINT documents_document_versions_record_version_check CHECK (record_version >= 1),
  CONSTRAINT documents_document_versions_timestamps_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX documents_document_versions_object_key_idx
  ON documents_document_versions (organization_id, object_key);

CREATE UNIQUE INDEX documents_document_versions_provider_version_idx
  ON documents_document_versions (organization_id, object_bucket, object_key, object_version_id)
  WHERE object_version_id IS NOT NULL;

CREATE TABLE documents_scan_results (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  scan_policy_version text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  engine text,
  signature text,
  attempt_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT documents_scan_results_version_fk FOREIGN KEY (
    document_version_id,
    organization_id
  ) REFERENCES documents_document_versions (id, organization_id),
  CONSTRAINT documents_scan_results_composite_key UNIQUE (
    id,
    organization_id,
    document_version_id
  ),
  CONSTRAINT documents_scan_results_work_key UNIQUE (
    organization_id,
    document_version_id,
    scan_policy_version
  ),
  CONSTRAINT documents_scan_results_policy_check CHECK (btrim(scan_policy_version) <> ''),
  CONSTRAINT documents_scan_results_state_check CHECK (
    state IN ('queued', 'running', 'clean', 'rejected', 'failed')
  ),
  CONSTRAINT documents_scan_results_attempt_check CHECK (attempt_count >= 0),
  CONSTRAINT documents_scan_results_completed_check CHECK (
    state IN ('queued', 'running')
    OR (
      engine IS NOT NULL
      AND btrim(engine) <> ''
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT documents_scan_results_timestamps_check CHECK (
    updated_at >= created_at
    AND (started_at IS NULL OR started_at >= created_at)
    AND (completed_at IS NULL OR completed_at >= COALESCE(started_at, created_at))
  ),
  CONSTRAINT documents_scan_results_record_version_check CHECK (record_version >= 1)
);

ALTER TABLE documents_documents
  ADD CONSTRAINT documents_documents_active_version_fk FOREIGN KEY (
    active_document_version_id,
    organization_id,
    id
  ) REFERENCES documents_document_versions (id, organization_id, document_id);

CREATE FUNCTION documents_assert_active_founder(
  target_organization_id uuid,
  target_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM access_role_bindings AS role_binding
      JOIN access_organization_memberships AS membership
        ON membership.id = role_binding.membership_id
       AND membership.organization_id = role_binding.organization_id
       AND membership.user_id = role_binding.user_id
      JOIN access_organizations AS organization
        ON organization.id = role_binding.organization_id
      JOIN identity_users AS identity_user
        ON identity_user.id = role_binding.user_id
     WHERE role_binding.organization_id = target_organization_id
       AND role_binding.user_id = target_user_id
       AND role_binding.role = 'founder'
       AND role_binding.status = 'active'
       AND membership.status = 'active'
       AND organization.status = 'active'
       AND identity_user.status = 'active'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      CONSTRAINT = 'documents_documents_purge_approval_check',
      MESSAGE = 'document purge requires an active Founder approval';
  END IF;
END;
$$;

CREATE FUNCTION documents_reject_immutable_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = TG_ARGV[0],
    MESSAGE = 'document metadata, versions, and scan history are immutable';
END;
$$;

CREATE FUNCTION documents_validate_document_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_version_state text;
  active_version_revoked_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.lifecycle_state <> 'active' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_documents_initial_state_check',
      MESSAGE = 'documents must enter as active';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
       OR NEW.student_id IS DISTINCT FROM OLD.student_id
       OR NEW.service_case_id IS DISTINCT FROM OLD.service_case_id
       OR NEW.task_id IS DISTINCT FROM OLD.task_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_documents_identity_immutable_check',
        MESSAGE = 'document identity and owner are immutable';
    END IF;

    IF OLD.lifecycle_state = 'deleted' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_documents_deleted_immutable_check',
        MESSAGE = 'deleted document tombstone is immutable';
    END IF;

    IF NEW.record_version <> OLD.record_version + 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_documents_record_version_transition_check',
        MESSAGE = 'document record_version must increase exactly once';
    END IF;

    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_documents_updated_at_transition_check',
        MESSAGE = 'document updated_at cannot move backward';
    END IF;

    IF NEW.lifecycle_state <> OLD.lifecycle_state
       AND NOT (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state = 'pending_delete')
       AND NOT (OLD.lifecycle_state = 'pending_delete' AND NEW.lifecycle_state = 'active')
       AND NOT (OLD.lifecycle_state = 'pending_delete' AND NEW.lifecycle_state = 'deleted') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_documents_lifecycle_transition_check',
        MESSAGE = 'document lifecycle transition is not allowed';
    END IF;

    IF OLD.lifecycle_state = 'pending_delete'
       AND NEW.lifecycle_state IN ('pending_delete', 'deleted')
       AND NEW.soft_deleted_at IS DISTINCT FROM OLD.soft_deleted_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_documents_soft_deleted_at_immutable_check',
        MESSAGE = 'document soft-deleted timestamp cannot be reset';
    END IF;

    IF OLD.lifecycle_state = 'pending_delete'
       AND OLD.retention_ends_at IS NOT NULL
       AND NEW.lifecycle_state IN ('pending_delete', 'deleted')
       AND NEW.retention_ends_at IS DISTINCT FROM OLD.retention_ends_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_documents_retention_ends_at_immutable_check',
        MESSAGE = 'document retention end cannot be moved after assignment';
    END IF;

    IF OLD.lifecycle_state = 'pending_delete' AND NEW.lifecycle_state = 'deleted' THEN
      IF OLD.legal_hold OR NEW.legal_hold THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'documents_documents_legal_hold_purge_check',
          MESSAGE = 'document under legal hold cannot be purged';
      END IF;

      IF OLD.soft_deleted_at IS NULL
         OR transaction_timestamp() < OLD.soft_deleted_at + interval '30 days' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'documents_documents_soft_delete_window_check',
          MESSAGE = 'document soft-delete recovery window is still active';
      END IF;

      IF OLD.retention_ends_at IS NULL
         OR transaction_timestamp() < OLD.retention_ends_at THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'documents_documents_retention_policy_check',
          MESSAGE = 'document retention policy is missing or has not ended';
      END IF;

      PERFORM documents_assert_active_founder(
        NEW.organization_id,
        NEW.purge_approved_by_user_id
      );
    END IF;

  END IF;

  IF NEW.active_document_version_id IS NOT NULL THEN
    SELECT version.state, version.revoked_at
      INTO active_version_state, active_version_revoked_at
      FROM documents_document_versions AS version
     WHERE version.id = NEW.active_document_version_id
       AND version.organization_id = NEW.organization_id
       AND version.document_id = NEW.id;

    IF NOT FOUND
       OR active_version_state IS DISTINCT FROM 'available'
       OR active_version_revoked_at IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_documents_active_version_check',
        MESSAGE = 'active document version must be available and not revoked';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION documents_validate_version_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  clean_scan_exists boolean;
  matching_scan_exists boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending_upload' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_document_versions_initial_state_check',
        MESSAGE = 'document versions must enter as pending_upload';
    END IF;
    IF NEW.object_key <> format(
      'documents/%s/versions/%s',
      lower(NEW.document_id::text),
      lower(NEW.id::text)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_document_versions_object_key_identity_check',
        MESSAGE = 'document version object key must use opaque document and version UUIDs';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.object_storage_region IS DISTINCT FROM OLD.object_storage_region
     OR NEW.object_bucket IS DISTINCT FROM OLD.object_bucket
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.object_version_id IS DISTINCT FROM OLD.object_version_id
     OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.detected_content_type IS DISTINCT FROM OLD.detected_content_type
     OR NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_content_immutable_check',
      MESSAGE = 'document version content and object identity are immutable';
  END IF;

  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_record_version_transition_check',
      MESSAGE = 'document version record_version must increase exactly once';
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_updated_at_transition_check',
      MESSAGE = 'document version updated_at cannot move backward';
  END IF;

  IF NEW.object_key <> format(
    'documents/%s/versions/%s',
    lower(NEW.document_id::text),
    lower(NEW.id::text)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_object_key_identity_check',
      MESSAGE = 'document version object key must use opaque document and version UUIDs';
  END IF;

  IF OLD.state = 'deleted' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_deleted_immutable_check',
      MESSAGE = 'deleted document version is immutable';
  END IF;

  IF OLD.state = 'available'
     AND NEW.state <> 'available'
     AND EXISTS (
       SELECT 1
         FROM documents_documents AS document
        WHERE document.organization_id = OLD.organization_id
          AND document.id = OLD.document_id
          AND document.active_document_version_id = OLD.id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_active_pointer_check',
      MESSAGE = 'active document version must be replaced before it is superseded or deleted';
  END IF;

  IF NOT (
    (OLD.state = 'pending_upload' AND NEW.state = 'quarantined')
    OR (OLD.state = 'quarantined' AND NEW.state = 'scanning')
    OR (OLD.state = 'scanning' AND NEW.state IN ('available', 'rejected', 'scan_failed'))
    OR (OLD.state = 'scan_failed' AND NEW.state = 'scanning')
    OR (OLD.state = 'available' AND NEW.state IN ('superseded', 'pending_delete', 'deleted'))
    OR (OLD.state = 'superseded' AND NEW.state IN ('pending_delete', 'deleted'))
    OR (OLD.state = 'rejected' AND NEW.state = 'deleted')
    OR (OLD.state = 'pending_delete' AND NEW.state = 'deleted')
    OR (OLD.state = NEW.state)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_state_transition_check',
      MESSAGE = 'document version state transition is not allowed';
  END IF;

  IF OLD.state = 'scanning' AND NEW.state = 'available' THEN
    SELECT EXISTS (
      SELECT 1
        FROM documents_scan_results AS scan
       WHERE scan.organization_id = NEW.organization_id
         AND scan.document_version_id = NEW.id
         AND scan.state = 'clean'
    ) INTO clean_scan_exists;
    IF NOT clean_scan_exists THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_document_versions_clean_scan_check',
        MESSAGE = 'available document version requires a clean scan result';
    END IF;
  END IF;

  IF OLD.state = 'scanning' AND NEW.state IN ('rejected', 'scan_failed') THEN
    SELECT EXISTS (
      SELECT 1
        FROM documents_scan_results AS scan
       WHERE scan.organization_id = NEW.organization_id
         AND scan.document_version_id = NEW.id
         AND scan.state = CASE
           WHEN NEW.state = 'rejected' THEN 'rejected'
           ELSE 'failed'
         END
    ) INTO matching_scan_exists;
    IF NOT matching_scan_exists THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_document_versions_scan_result_check',
        MESSAGE = 'document version state requires a matching scan result';
    END IF;
  END IF;

  IF OLD.revoked_at IS NOT NULL
     AND (
       NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_revocation_immutable_check',
      MESSAGE = 'document version revocation cannot be undone';
  END IF;

  IF NEW.state = 'available' AND NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_available_revocation_check',
      MESSAGE = 'revoked document version cannot be available';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION documents_validate_scan_result_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_scan_results_initial_state_check',
        MESSAGE = 'scan results must enter as queued';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
     OR NEW.scan_policy_version IS DISTINCT FROM OLD.scan_policy_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_identity_immutable_check',
      MESSAGE = 'scan result identity is immutable';
  END IF;

  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_record_version_transition_check',
      MESSAGE = 'scan result record_version must increase exactly once';
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_updated_at_transition_check',
      MESSAGE = 'scan result updated_at cannot move backward';
  END IF;

  IF NOT (
    (OLD.state = 'queued' AND NEW.state = 'running')
    OR (OLD.state = 'running' AND NEW.state IN ('clean', 'rejected', 'failed'))
    OR (OLD.state = 'failed' AND NEW.state = 'running')
    OR (OLD.state = NEW.state)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_state_transition_check',
      MESSAGE = 'scan result state transition is not allowed';
  END IF;

  IF OLD.state IN ('clean', 'rejected')
     AND (
       NEW.state <> OLD.state
       OR NEW.engine IS DISTINCT FROM OLD.engine
       OR NEW.signature IS DISTINCT FROM OLD.signature
       OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_terminal_check',
      MESSAGE = 'terminal scan result cannot be reopened';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_documents_write_trg
BEFORE INSERT OR UPDATE ON documents_documents
FOR EACH ROW
EXECUTE FUNCTION documents_validate_document_write();

CREATE TRIGGER documents_document_versions_write_trg
BEFORE INSERT OR UPDATE ON documents_document_versions
FOR EACH ROW
EXECUTE FUNCTION documents_validate_version_write();

CREATE TRIGGER documents_scan_results_write_trg
BEFORE INSERT OR UPDATE ON documents_scan_results
FOR EACH ROW
EXECUTE FUNCTION documents_validate_scan_result_write();

CREATE TRIGGER documents_documents_delete_trg
BEFORE DELETE ON documents_documents
FOR EACH ROW
EXECUTE FUNCTION documents_reject_immutable_delete('documents_documents_delete_immutable_check');

CREATE TRIGGER documents_document_versions_delete_trg
BEFORE DELETE ON documents_document_versions
FOR EACH ROW
EXECUTE FUNCTION documents_reject_immutable_delete('documents_document_versions_delete_immutable_check');

CREATE TRIGGER documents_scan_results_delete_trg
BEFORE DELETE ON documents_scan_results
FOR EACH ROW
EXECUTE FUNCTION documents_reject_immutable_delete('documents_scan_results_delete_immutable_check');
