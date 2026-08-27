ALTER TABLE shared_idempotency_records
  ADD COLUMN actor_kind text,
  ADD COLUMN actor_opaque_id text;

DROP TRIGGER shared_idempotency_records_write_trg ON shared_idempotency_records;

UPDATE shared_idempotency_records
   SET actor_kind = 'user',
       actor_opaque_id = actor_user_id::text;

ALTER TABLE shared_idempotency_records
  ALTER COLUMN actor_kind SET NOT NULL,
  ALTER COLUMN actor_opaque_id SET NOT NULL,
  ALTER COLUMN actor_user_id DROP NOT NULL,
  DROP CONSTRAINT shared_idempotency_records_scope_key,
  ADD CONSTRAINT shared_idempotency_records_scope_key UNIQUE (
    organization_id,
    actor_kind,
    actor_opaque_id,
    operation,
    idempotency_key
  ),
  ADD CONSTRAINT shared_idempotency_records_legacy_user_scope_key UNIQUE (
    organization_id,
    actor_user_id,
    operation,
    idempotency_key
  ),
  ADD CONSTRAINT shared_idempotency_records_actor_kind_check CHECK (
    actor_kind IN ('user', 'portal', 'worker', 'system')
  ),
  ADD CONSTRAINT shared_idempotency_records_actor_opaque_id_check CHECK (
    actor_opaque_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  ADD CONSTRAINT shared_idempotency_records_legacy_user_check CHECK (
    (actor_kind = 'user' AND actor_user_id IS NOT NULL
      AND actor_opaque_id = actor_user_id::text)
    OR (actor_kind IN ('portal', 'worker', 'system') AND actor_user_id IS NULL)
  );

CREATE OR REPLACE FUNCTION shared_validate_idempotency_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.actor_kind IS NULL
       AND NEW.actor_opaque_id IS NULL
       AND NEW.actor_user_id IS NOT NULL THEN
      NEW.actor_kind := 'user';
      NEW.actor_opaque_id := NEW.actor_user_id::text;
    END IF;
    IF NEW.operation !~ '^[a-z][a-z0-9._:-]{0,127}$'
       OR NEW.idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       OR NEW.record_version <> 1
       OR NEW.state <> 'in_progress' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'shared_idempotency_records_initial_state_check',
        MESSAGE = 'idempotency records must begin in progress with immutable scope';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.actor_kind IS DISTINCT FROM OLD.actor_kind
     OR NEW.actor_opaque_id IS DISTINCT FROM OLD.actor_opaque_id
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'shared_idempotency_records_immutable_scope_check',
      MESSAGE = 'idempotency scope and request hash are immutable';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'shared_idempotency_records_record_version_check',
      MESSAGE = 'idempotency record_version must increase exactly once';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'shared_idempotency_records_timestamp_transition_check',
      MESSAGE = 'idempotency updated_at cannot move backward';
  END IF;
  IF OLD.state <> 'in_progress' OR NEW.state NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'shared_idempotency_records_terminal_state_check',
      MESSAGE = 'idempotency terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER shared_idempotency_records_write_trg
BEFORE INSERT OR UPDATE ON shared_idempotency_records
FOR EACH ROW EXECUTE FUNCTION shared_validate_idempotency_write();

CREATE FUNCTION shared_reject_idempotency_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'shared_idempotency_records_append_only',
    MESSAGE = 'idempotency records cannot be deleted';
END;
$$;

CREATE TRIGGER shared_idempotency_records_delete_trg
BEFORE DELETE ON shared_idempotency_records
FOR EACH ROW EXECUTE FUNCTION shared_reject_idempotency_delete();

CREATE TRIGGER shared_idempotency_records_truncate_trg
BEFORE TRUNCATE ON shared_idempotency_records
FOR EACH STATEMENT EXECUTE FUNCTION shared_reject_idempotency_delete();

REVOKE ALL ON TABLE shared_idempotency_records FROM PUBLIC;
REVOKE ALL ON TABLE shared_idempotency_records FROM tianxing_app;
GRANT SELECT, INSERT, UPDATE ON TABLE shared_idempotency_records TO tianxing_app;

ALTER TABLE shared_idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_idempotency_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tianxing_tenant_boundary ON shared_idempotency_records;
CREATE POLICY tianxing_tenant_boundary ON shared_idempotency_records
  FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
