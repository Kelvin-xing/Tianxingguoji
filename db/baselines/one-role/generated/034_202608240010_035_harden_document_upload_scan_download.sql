DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM documents_documents AS document
      LEFT JOIN documents_document_versions AS version
        ON version.organization_id=document.organization_id
       AND version.document_id=document.id
       AND version.id=document.active_document_version_id
     WHERE document.active_document_version_id IS NOT NULL
       AND (
         version.id IS NULL
         OR version.state IS DISTINCT FROM 'available'
         OR version.revoked_at IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_documents_doc02_active_pointer_preflight',
      MESSAGE = 'DOC-02 cannot migrate an unsafe active document version pointer';
  END IF;

  IF EXISTS (
    SELECT 1 FROM documents_document_versions
     WHERE size_bytes < 1 OR size_bytes > 10485760
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_doc02_size_preflight',
      MESSAGE = 'DOC-02 cannot migrate document versions with an unsafe size';
  END IF;

  IF EXISTS (
    SELECT 1 FROM documents_document_versions
     WHERE detected_content_type NOT IN ('application/pdf', 'image/jpeg', 'image/png')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_doc02_content_type_preflight',
      MESSAGE = 'DOC-02 cannot migrate document versions with an unsupported content type';
  END IF;

  IF EXISTS (
    SELECT 1 FROM documents_document_versions
     WHERE object_version_id IS NOT NULL
       AND (length(object_version_id) NOT BETWEEN 1 AND 1024 OR object_version_id ~ '[[:space:]]')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_doc02_provider_version_preflight',
      MESSAGE = 'DOC-02 cannot migrate an invalid provider version identifier';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM documents_scan_results AS scan
      JOIN documents_document_versions AS version
        ON version.id=scan.document_version_id
       AND version.organization_id=scan.organization_id
     WHERE version.object_version_id IS NULL
        OR scan.scan_policy_version <> 'clamav-release1-v1'
        OR (scan.state='queued' AND version.state <> 'quarantined')
        OR (scan.state='running' AND version.state <> 'scanning')
        OR (scan.state='failed' AND version.state <> 'scan_failed')
        OR (scan.state='rejected' AND version.state NOT IN ('rejected','deleted'))
        OR (scan.state='clean' AND version.state NOT IN (
          'available','superseded','pending_delete','deleted'
        ))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_doc02_object_preflight',
      MESSAGE = 'DOC-02 cannot migrate an unbound or non-current scan fact';
  END IF;

  IF EXISTS (
    SELECT 1 FROM documents_scan_results
     WHERE attempt_count < 0 OR attempt_count > 3
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_doc02_attempt_preflight',
      MESSAGE = 'DOC-02 cannot migrate a scan fact outside the bounded attempt policy';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM documents_scan_results
     WHERE NOT (
       (
         state='queued' AND engine IS NULL AND signature IS NULL
         AND attempt_count=0 AND started_at IS NULL AND completed_at IS NULL
       )
       OR (
         state='running' AND engine IS NULL AND signature IS NULL
         AND attempt_count BETWEEN 1 AND 3
         AND started_at IS NOT NULL AND completed_at IS NULL
       )
       OR (
         state IN ('clean','rejected','failed')
         AND engine IS NOT DISTINCT FROM 'clamav-release1'
         AND signature IS NULL AND attempt_count BETWEEN 1 AND 3
         AND started_at IS NOT NULL AND completed_at IS NOT NULL
       )
     )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_doc02_semantics_preflight',
      MESSAGE = 'DOC-02 cannot migrate a scan fact with incompatible attempt semantics';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM documents_document_versions AS version
     WHERE version.state IN ('quarantined','scanning','available','scan_failed')
       AND NOT EXISTS (
         SELECT 1
           FROM documents_scan_results AS scan
          WHERE scan.organization_id=version.organization_id
            AND scan.document_version_id=version.id
            AND scan.scan_policy_version='clamav-release1-v1'
            AND scan.state=CASE version.state
              WHEN 'quarantined' THEN 'queued'
              WHEN 'scanning' THEN 'running'
              WHEN 'available' THEN 'clean'
              ELSE 'failed'
            END
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_doc02_scan_preflight',
      MESSAGE = 'DOC-02 cannot migrate a version without its corresponding scan fact';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM documents_document_versions
     WHERE state IN ('pending_upload', 'quarantined', 'scanning')
     GROUP BY organization_id,document_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_doc02_inflight_preflight',
      MESSAGE = 'DOC-02 cannot migrate duplicate in-flight document versions';
  END IF;
END;
$$;

ALTER TABLE documents_document_versions
  DROP CONSTRAINT documents_document_versions_size_check;

ALTER TABLE documents_document_versions
  ADD CONSTRAINT documents_document_versions_size_check CHECK (
    size_bytes BETWEEN 1 AND 10485760
  );

ALTER TABLE documents_document_versions
  DROP CONSTRAINT documents_document_versions_content_type_check;

ALTER TABLE documents_document_versions
  ADD CONSTRAINT documents_document_versions_content_type_check CHECK (
    detected_content_type IN ('application/pdf', 'image/jpeg', 'image/png')
  );

ALTER TABLE documents_document_versions
  DROP CONSTRAINT documents_document_versions_state_check,
  ADD CONSTRAINT documents_document_versions_state_check CHECK (
    state IN (
      'pending_upload',
      'quarantined',
      'scanning',
      'available',
      'rejected',
      'scan_failed',
      'abandoned',
      'superseded',
      'pending_delete',
      'deleted'
    )
  );

ALTER TABLE documents_document_versions
  ADD CONSTRAINT documents_document_versions_bound_object_check CHECK (
    state = 'pending_upload'
    OR (state = 'abandoned' AND object_version_id IS NULL)
    OR (state NOT IN ('pending_upload','abandoned') AND object_version_id IS NOT NULL)
  );

ALTER TABLE documents_document_versions
  DROP CONSTRAINT documents_document_versions_provider_version_check,
  ADD CONSTRAINT documents_document_versions_provider_version_check CHECK (
    object_version_id IS NULL OR (
      length(object_version_id) BETWEEN 1 AND 1024
      AND object_version_id !~ '[[:space:]]'
    )
  );

ALTER TABLE documents_document_versions
  ADD COLUMN upload_generation bigint;

-- ALTER TABLE above retains an ACCESS EXCLUSIVE lock through this migration.
-- Remove the legacy trigger only for the deterministic new-column backfill so
-- immutable deleted rows can receive a generation; the final trigger is
-- installed again below before commit.
DROP TRIGGER documents_document_versions_write_trg ON documents_document_versions;

WITH ranked_versions AS (
  SELECT id,organization_id,
    row_number() OVER (
      PARTITION BY organization_id,document_id
      ORDER BY created_at,id
    ) AS upload_generation
    FROM documents_document_versions
)
UPDATE documents_document_versions AS version
   SET upload_generation=ranked.upload_generation,
       record_version=version.record_version+1,
       updated_at=GREATEST(version.updated_at,transaction_timestamp())
  FROM ranked_versions AS ranked
 WHERE ranked.id=version.id
   AND ranked.organization_id=version.organization_id;

ALTER TABLE documents_document_versions
  ALTER COLUMN upload_generation SET NOT NULL,
  ADD CONSTRAINT documents_document_versions_generation_check CHECK (
    upload_generation >= 1
  ),
  ADD CONSTRAINT documents_document_versions_generation_key UNIQUE (
    organization_id,document_id,upload_generation
  );

ALTER TABLE documents_scan_results
  ADD COLUMN object_bucket text,
  ADD COLUMN object_key text,
  ADD COLUMN object_version_id text;

UPDATE documents_scan_results AS scan
   SET object_bucket=version.object_bucket,
       object_key=version.object_key,
       object_version_id=version.object_version_id,
       record_version=scan.record_version+1,
       updated_at=GREATEST(scan.updated_at,transaction_timestamp())
  FROM documents_document_versions AS version
 WHERE version.id=scan.document_version_id
   AND version.organization_id=scan.organization_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM documents_scan_results
     WHERE object_bucket IS NULL OR object_key IS NULL OR object_version_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_doc02_backfill_preflight',
      MESSAGE = 'DOC-02 could not bind a historical scan fact to its exact object';
  END IF;
END;
$$;

ALTER TABLE documents_scan_results
  DROP CONSTRAINT documents_scan_results_attempt_check,
  DROP CONSTRAINT documents_scan_results_completed_check,
  ALTER COLUMN object_bucket SET NOT NULL,
  ALTER COLUMN object_key SET NOT NULL,
  ALTER COLUMN object_version_id SET NOT NULL,
  ADD CONSTRAINT documents_scan_results_object_key_check CHECK (
    object_key ~ '^documents/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/versions/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  ADD CONSTRAINT documents_scan_results_provider_version_check CHECK (
    length(object_version_id) BETWEEN 1 AND 1024
    AND object_version_id !~ '[[:space:]]'
  ),
  ADD CONSTRAINT documents_scan_results_attempt_check CHECK (
    attempt_count BETWEEN 0 AND 3
  ),
  ADD CONSTRAINT documents_scan_results_completed_check CHECK (
    (
      state = 'queued'
      AND engine IS NULL
      AND signature IS NULL
      AND attempt_count = 0
      AND started_at IS NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'running'
      AND engine IS NULL
      AND signature IS NULL
      AND attempt_count BETWEEN 1 AND 3
      AND started_at IS NOT NULL
      AND completed_at IS NULL
    )
    OR (
      state IN ('clean', 'rejected', 'failed')
      AND engine IS NOT DISTINCT FROM 'clamav-release1'
      AND signature IS NULL
      AND attempt_count BETWEEN 1 AND 3
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT documents_scan_results_object_work_key UNIQUE (
    organization_id,object_bucket,object_key,object_version_id,scan_policy_version
  );

CREATE UNIQUE INDEX documents_document_versions_one_in_flight_idx
  ON documents_document_versions (organization_id, document_id)
  WHERE state IN ('pending_upload', 'quarantined', 'scanning');

CREATE OR REPLACE FUNCTION documents_validate_version_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  clean_scan_exists boolean;
  expected_upload_generation bigint;
  matching_scan_exists boolean;
  provider_version_binding boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM documents_documents AS document
     WHERE document.id=NEW.document_id
       AND document.organization_id=NEW.organization_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_document_versions_generation_parent_check',
        MESSAGE = 'document version generation requires one locked parent document';
    END IF;
    SELECT COALESCE(max(version.upload_generation),0)+1
      INTO expected_upload_generation
      FROM documents_document_versions AS version
     WHERE version.organization_id=NEW.organization_id
       AND version.document_id=NEW.document_id;

    IF NEW.state <> 'pending_upload'
       OR NEW.object_version_id IS NOT NULL
       OR NEW.upload_generation IS DISTINCT FROM expected_upload_generation
       OR NEW.record_version <> 1
       OR NEW.revoked_at IS NOT NULL
       OR NEW.revoke_reason IS NOT NULL
       OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
       OR NEW.updated_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_document_versions_initial_state_check',
        MESSAGE = 'document versions must enter as the next unbound pending upload generation';
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

  provider_version_binding :=
    NEW.object_version_id IS NOT NULL
    AND btrim(NEW.object_version_id) <> ''
    AND NEW.object_version_id !~ '[[:space:]]'
    AND OLD.state = 'pending_upload'
    AND NEW.state IN ('quarantined', 'rejected')
    AND (
      (OLD.object_version_id IS NULL AND NEW.object_version_id IS NOT NULL)
      OR NEW.object_version_id IS NOT DISTINCT FROM OLD.object_version_id
    );

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.object_storage_region IS DISTINCT FROM OLD.object_storage_region
     OR NEW.object_bucket IS DISTINCT FROM OLD.object_bucket
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR (
       NEW.object_version_id IS DISTINCT FROM OLD.object_version_id
       AND NOT provider_version_binding
     )
     OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.detected_content_type IS DISTINCT FROM OLD.detected_content_type
     OR NEW.upload_generation IS DISTINCT FROM OLD.upload_generation
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

  IF OLD.state = 'abandoned' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_abandoned_immutable_check',
      MESSAGE = 'abandoned document version is immutable';
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
    (OLD.state = 'pending_upload' AND NEW.state IN ('quarantined', 'rejected', 'abandoned'))
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

  IF OLD.state = 'pending_upload'
     AND NEW.state IN ('quarantined', 'rejected')
     AND NOT provider_version_binding THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_provider_version_binding_check',
      MESSAGE = 'object provider version must be bound exactly once at receipt';
  END IF;

  IF OLD.state = 'pending_upload' AND NEW.state = 'abandoned'
     AND (
       OLD.object_version_id IS NOT NULL
       OR NEW.object_version_id IS NOT NULL
       OR NEW.revoked_at IS NOT NULL
       OR NEW.revoke_reason IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_abandoned_unbound_check',
      MESSAGE = 'abandoned pending upload must remain unbound and unrevoked';
  END IF;

  IF OLD.state = 'scan_failed' AND NEW.state = 'scanning' AND EXISTS (
    SELECT 1
      FROM documents_document_versions AS newer_version
     WHERE newer_version.organization_id=OLD.organization_id
       AND newer_version.document_id=OLD.document_id
       AND newer_version.upload_generation > OLD.upload_generation
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_stale_retry_check',
      MESSAGE = 'an older failed document version cannot retry after a newer version exists';
  END IF;

  IF OLD.state = 'scanning' AND NEW.state = 'available' THEN
    IF EXISTS (
      SELECT 1
        FROM documents_document_versions AS newer_version
       WHERE newer_version.organization_id=OLD.organization_id
         AND newer_version.document_id=OLD.document_id
         AND newer_version.upload_generation > OLD.upload_generation
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_document_versions_stale_activation_check',
        MESSAGE = 'an older document version cannot activate after a newer version exists';
    END IF;
    SELECT EXISTS (
      SELECT 1
        FROM documents_scan_results AS scan
       WHERE scan.organization_id = NEW.organization_id
         AND scan.document_version_id = NEW.id
         AND scan.scan_policy_version = 'clamav-release1-v1'
         AND scan.object_bucket = NEW.object_bucket
         AND scan.object_key = NEW.object_key
         AND scan.object_version_id = NEW.object_version_id
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
         AND scan.scan_policy_version = 'clamav-release1-v1'
         AND scan.object_bucket = NEW.object_bucket
         AND scan.object_key = NEW.object_key
         AND scan.object_version_id = NEW.object_version_id
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

CREATE TRIGGER documents_document_versions_write_trg
BEFORE INSERT OR UPDATE ON documents_document_versions
FOR EACH ROW
EXECUTE FUNCTION documents_validate_version_write();

CREATE OR REPLACE FUNCTION documents_validate_scan_result_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_state text;
  parent_bucket text;
  parent_key text;
  parent_version_id text;
BEGIN
  SELECT version.state,version.object_bucket,version.object_key,version.object_version_id
    INTO parent_state,parent_bucket,parent_key,parent_version_id
    FROM documents_document_versions AS version
   WHERE version.id=NEW.document_version_id
     AND version.organization_id=NEW.organization_id
   FOR UPDATE;

  IF NOT FOUND
     OR parent_version_id IS NULL
     OR NEW.scan_policy_version <> 'clamav-release1-v1'
     OR NEW.object_bucket IS DISTINCT FROM parent_bucket
     OR NEW.object_key IS DISTINCT FROM parent_key
     OR NEW.object_version_id IS DISTINCT FROM parent_version_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_exact_object_check',
      MESSAGE = 'scan result must bind the frozen policy and exact provider object';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued'
       OR parent_state <> 'quarantined'
       OR NEW.attempt_count <> 0
       OR NEW.engine IS NOT NULL
       OR NEW.signature IS NOT NULL
       OR NEW.started_at IS NOT NULL
       OR NEW.completed_at IS NOT NULL
       OR NEW.record_version <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_scan_results_initial_state_check',
        MESSAGE = 'scan results must enter queued for one quarantined exact object';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
     OR NEW.scan_policy_version IS DISTINCT FROM OLD.scan_policy_version
     OR NEW.object_bucket IS DISTINCT FROM OLD.object_bucket
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.object_version_id IS DISTINCT FROM OLD.object_version_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_identity_immutable_check',
      MESSAGE = 'scan result identity and exact object are immutable';
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
    (OLD.state = 'queued' AND NEW.state = 'running' AND parent_state='quarantined')
    OR (OLD.state = 'running' AND NEW.state IN ('clean', 'rejected', 'failed') AND parent_state='scanning')
    OR (OLD.state = 'failed' AND NEW.state = 'running' AND parent_state='scan_failed')
    OR (OLD.state = NEW.state)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_state_transition_check',
      MESSAGE = 'scan result state transition is not allowed for the parent version';
  END IF;

  IF OLD.state IN ('queued', 'failed') AND NEW.state = 'running' THEN
    IF OLD.attempt_count >= 3
       OR NEW.attempt_count <> OLD.attempt_count + 1
       OR NEW.engine IS NOT NULL
       OR NEW.signature IS NOT NULL
       OR NEW.started_at IS NULL
       OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_scan_results_attempt_transition_check',
        MESSAGE = 'scan running transition must advance exactly one bounded attempt';
    END IF;
  END IF;

  IF OLD.state = 'running' AND NEW.state IN ('clean', 'rejected', 'failed') THEN
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.completed_at IS NULL
       OR NEW.engine IS DISTINCT FROM 'clamav-release1'
       OR NEW.signature IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_scan_results_terminal_transition_check',
        MESSAGE = 'scan terminal transition must preserve its bounded attempt and start time';
    END IF;
  END IF;

  IF OLD.state = NEW.state
     AND (
       NEW.engine IS DISTINCT FROM OLD.engine
       OR NEW.signature IS DISTINCT FROM OLD.signature
       OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_same_state_semantics_check',
      MESSAGE = 'same-state scan updates cannot change attempt or scanner semantics';
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

CREATE FUNCTION documents_validate_scan_lifecycle_commit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_state text;
  exact_scan_state text;
BEGIN
  IF TG_TABLE_NAME = 'documents_document_versions' THEN
    IF NEW.state NOT IN ('quarantined','scanning','available','rejected','scan_failed') THEN
      RETURN NULL;
    END IF;

    PERFORM 1
      FROM documents_documents AS document
     WHERE document.organization_id=NEW.organization_id
       AND document.id=NEW.document_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_document_versions_scan_parent_commit_check',
        MESSAGE = 'committed scan lifecycle requires one locked parent document';
    END IF;
    IF NEW.state IN ('scanning','available') AND EXISTS (
      SELECT 1
        FROM documents_document_versions AS newer_version
       WHERE newer_version.organization_id=NEW.organization_id
         AND newer_version.document_id=NEW.document_id
         AND newer_version.upload_generation>NEW.upload_generation
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_document_versions_stale_generation_commit_check',
        MESSAGE = 'committed older scan work cannot proceed after a newer generation exists';
    END IF;

    SELECT scan.state
      INTO exact_scan_state
      FROM documents_scan_results AS scan
     WHERE scan.organization_id=NEW.organization_id
       AND scan.document_version_id=NEW.id
       AND scan.scan_policy_version='clamav-release1-v1'
       AND scan.object_bucket=NEW.object_bucket
       AND scan.object_key=NEW.object_key
       AND scan.object_version_id=NEW.object_version_id
     FOR UPDATE;

    IF NEW.state='rejected' AND NOT FOUND THEN
      RETURN NULL;
    END IF;
    IF NOT FOUND OR exact_scan_state IS DISTINCT FROM (CASE NEW.state
      WHEN 'quarantined' THEN 'queued'
      WHEN 'scanning' THEN 'running'
      WHEN 'available' THEN 'clean'
      WHEN 'rejected' THEN 'rejected'
      ELSE 'failed'
    END) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_document_versions_scan_lifecycle_commit_check',
        MESSAGE = 'committed document version state must match its exact scan fact';
    END IF;
    RETURN NULL;
  END IF;

  SELECT version.state
    INTO parent_state
    FROM documents_document_versions AS version
   WHERE version.organization_id=NEW.organization_id
     AND version.id=NEW.document_version_id
     AND version.object_bucket=NEW.object_bucket
     AND version.object_key=NEW.object_key
     AND version.object_version_id=NEW.object_version_id
   FOR UPDATE;

  IF NOT FOUND OR parent_state IS DISTINCT FROM (CASE NEW.state
    WHEN 'queued' THEN 'quarantined'
    WHEN 'running' THEN 'scanning'
    WHEN 'clean' THEN 'available'
    WHEN 'rejected' THEN 'rejected'
    ELSE 'scan_failed'
  END) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_scan_results_version_lifecycle_commit_check',
      MESSAGE = 'committed exact scan fact must match its document version state';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION documents_validate_active_pointer_commit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_state text;
  target_revoked_at timestamptz;
  active_document_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'documents_documents' THEN
    IF NEW.active_document_version_id IS NULL THEN
      RETURN NULL;
    END IF;

    SELECT version.state,version.revoked_at
      INTO target_state,target_revoked_at
      FROM documents_document_versions AS version
     WHERE version.id=NEW.active_document_version_id
       AND version.organization_id=NEW.organization_id
       AND version.document_id=NEW.id
     FOR UPDATE;

    IF NOT FOUND OR target_state IS DISTINCT FROM 'available' OR target_revoked_at IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'documents_documents_active_version_commit_check',
        MESSAGE = 'committed active document version must remain available and unrevoked';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.state = 'available' AND NEW.revoked_at IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT document.id
    INTO active_document_id
    FROM documents_documents AS document
   WHERE document.organization_id=NEW.organization_id
     AND document.id=NEW.document_id
     AND document.active_document_version_id=NEW.id
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_document_versions_active_pointer_commit_check',
      MESSAGE = 'committed non-available document version cannot remain active';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER documents_documents_active_pointer_commit_trg
AFTER INSERT OR UPDATE OF active_document_version_id ON documents_documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION documents_validate_active_pointer_commit();

CREATE CONSTRAINT TRIGGER documents_document_versions_active_pointer_commit_trg
AFTER UPDATE OF state,revoked_at ON documents_document_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION documents_validate_active_pointer_commit();

CREATE CONSTRAINT TRIGGER documents_document_versions_scan_lifecycle_commit_trg
AFTER INSERT OR UPDATE OF state,object_version_id ON documents_document_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION documents_validate_scan_lifecycle_commit();

CREATE CONSTRAINT TRIGGER documents_scan_results_version_lifecycle_commit_trg
AFTER INSERT OR UPDATE OF state ON documents_scan_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION documents_validate_scan_lifecycle_commit();

ALTER FUNCTION documents_assert_active_founder(uuid,uuid)
  SET search_path = pg_catalog, public;
ALTER FUNCTION documents_reject_immutable_delete()
  SET search_path = pg_catalog, public;
ALTER FUNCTION documents_validate_document_write()
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION documents_validate_version_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION documents_validate_scan_result_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION documents_validate_active_pointer_commit() FROM PUBLIC;
REVOKE ALL ON FUNCTION documents_validate_scan_lifecycle_commit() FROM PUBLIC;
REVOKE ALL ON FUNCTION documents_assert_active_founder(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION documents_reject_immutable_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION documents_validate_document_write() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION documents_validate_version_write() TO tianxing_app;
GRANT EXECUTE ON FUNCTION documents_validate_scan_result_write() TO tianxing_app;
GRANT EXECUTE ON FUNCTION documents_validate_active_pointer_commit() TO tianxing_app;
GRANT EXECUTE ON FUNCTION documents_validate_scan_lifecycle_commit() TO tianxing_app;
GRANT EXECUTE ON FUNCTION documents_assert_active_founder(uuid,uuid) TO tianxing_app;
GRANT EXECUTE ON FUNCTION documents_reject_immutable_delete() TO tianxing_app;
GRANT EXECUTE ON FUNCTION documents_validate_document_write() TO tianxing_app;

ALTER TABLE documents_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE documents_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents_document_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE documents_scan_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents_scan_results FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE documents_documents FROM PUBLIC;
REVOKE ALL ON TABLE documents_document_versions FROM PUBLIC;
REVOKE ALL ON TABLE documents_scan_results FROM PUBLIC;
REVOKE ALL ON TABLE documents_documents FROM tianxing_app;
REVOKE ALL ON TABLE documents_document_versions FROM tianxing_app;
REVOKE ALL ON TABLE documents_scan_results FROM tianxing_app;
GRANT SELECT, INSERT, UPDATE ON TABLE documents_documents TO tianxing_app;
GRANT SELECT, INSERT, UPDATE ON TABLE documents_document_versions TO tianxing_app;
GRANT SELECT, INSERT, UPDATE ON TABLE documents_scan_results TO tianxing_app;
