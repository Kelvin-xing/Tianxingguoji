CREATE FUNCTION audit_assert_safe_json(payload jsonb)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  item record;
  nested jsonb;
  scalar text;
BEGIN
  IF payload IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_safe_json_check',
      MESSAGE = 'safe JSON payload cannot be null';
  END IF;

  IF jsonb_typeof(payload) = 'object' THEN
    FOR item IN
      SELECT object_key, object_value
        FROM jsonb_each(payload) AS pair(object_key, object_value)
    LOOP
      IF item.object_key ~* '(email|phone|name|birth|dob|address|token|secret|password|cookie|content|body|message|url|pii)' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'audit_safe_json_check',
          MESSAGE = 'sensitive JSON field is not permitted';
      END IF;
      PERFORM audit_assert_safe_json(item.object_value);
    END LOOP;
  ELSIF jsonb_typeof(payload) = 'array' THEN
    FOR nested IN SELECT value FROM jsonb_array_elements(payload) AS array_item(value) LOOP
      PERFORM audit_assert_safe_json(nested);
    END LOOP;
  ELSIF jsonb_typeof(payload) = 'string' THEN
    scalar := payload #>> '{}';
    IF scalar !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'audit_safe_json_check',
        MESSAGE = 'PII-shaped JSON value is not permitted';
    END IF;
  END IF;
END;
$$;

CREATE TABLE shared_idempotency_records (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  actor_user_id uuid NOT NULL REFERENCES identity_users (id),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  state text NOT NULL DEFAULT 'in_progress',
  result_reference text,
  response_hash char(64),
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT shared_idempotency_records_scope_key UNIQUE (
    organization_id,
    actor_user_id,
    operation,
    idempotency_key
  ),
  CONSTRAINT shared_idempotency_records_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shared_idempotency_records_state_check CHECK (
    state IN ('in_progress', 'completed', 'failed')
  ),
  CONSTRAINT shared_idempotency_records_result_check CHECK (
    (state = 'in_progress' AND result_reference IS NULL AND response_hash IS NULL)
    OR (
      state IN ('completed', 'failed')
      AND result_reference IS NOT NULL
      AND result_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND response_hash IS NOT NULL
      AND response_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT shared_idempotency_records_version_check CHECK (record_version >= 1),
  CONSTRAINT shared_idempotency_records_timestamps_check CHECK (updated_at >= created_at)
);

CREATE FUNCTION shared_validate_idempotency_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
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

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  actor_user_id uuid REFERENCES identity_users (id),
  actor_kind text NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  outcome text NOT NULL,
  request_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  before_hash_sha256 char(64),
  after_hash_sha256 char(64),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_events_composite_key UNIQUE (id, organization_id),
  CONSTRAINT audit_events_actor_kind_check CHECK (actor_kind IN ('user', 'system', 'worker')),
  CONSTRAINT audit_events_actor_presence_check CHECK (
    (actor_kind = 'user' AND actor_user_id IS NOT NULL)
    OR actor_kind IN ('system', 'worker')
  ),
  CONSTRAINT audit_events_event_version_check CHECK (event_version >= 1),
  CONSTRAINT audit_events_outcome_check CHECK (outcome IN ('succeeded', 'denied', 'failed')),
  CONSTRAINT audit_events_name_check CHECK (
    event_type ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
    AND action ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
    AND resource_type ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
  ),
  CONSTRAINT audit_events_request_id_check CHECK (
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT audit_events_hash_check CHECK (
    (before_hash_sha256 IS NULL OR before_hash_sha256 ~ '^[0-9a-f]{64}$')
    AND (after_hash_sha256 IS NULL OR after_hash_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT audit_events_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE FUNCTION audit_validate_event_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  metadata_key text;
BEGIN
  IF NEW.metadata IS NULL OR jsonb_typeof(NEW.metadata) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_events_metadata_object_check',
      MESSAGE = 'audit metadata must be a JSON object';
  END IF;
  FOR metadata_key IN SELECT jsonb_object_keys(NEW.metadata) LOOP
    IF metadata_key NOT IN (
      'record_version',
      'previous_version',
      'next_version',
      'reason_code',
      'effect_type',
      'request_id',
      'status',
      'retryable',
      'attempt_count'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'audit_events_metadata_fields_check',
        MESSAGE = 'audit metadata contains an unallowlisted field';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
      FROM jsonb_each(NEW.metadata) AS metadata_item(key, value)
     WHERE jsonb_typeof(metadata_item.value) NOT IN ('string', 'number', 'boolean', 'null')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_events_metadata_scalar_check',
      MESSAGE = 'audit metadata values must be scalar';
  END IF;
  PERFORM audit_assert_safe_json(NEW.metadata);
  RETURN NEW;
END;
$$;

CREATE FUNCTION audit_reject_immutable_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'audit_events_append_only',
    MESSAGE = 'audit events are append-only';
END;
$$;

CREATE TRIGGER audit_events_write_trg
BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION audit_validate_event_write();

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION audit_reject_immutable_event();

CREATE TABLE audit_outbox (
  id uuid PRIMARY KEY,
  audit_event_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL,
  idempotency_key text NOT NULL,
  request_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  leased_until timestamptz,
  lease_version bigint NOT NULL DEFAULT 1,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  last_error_code text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT audit_outbox_audit_event_fk FOREIGN KEY (audit_event_id, organization_id)
    REFERENCES audit_events (id, organization_id),
  CONSTRAINT audit_outbox_composite_key UNIQUE (id, organization_id),
  CONSTRAINT audit_outbox_idempotency_key UNIQUE (organization_id, idempotency_key),
  CONSTRAINT audit_outbox_name_check CHECK (
    aggregate_type ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
    AND event_type ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
    AND request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT audit_outbox_event_version_check CHECK (event_version >= 1),
  CONSTRAINT audit_outbox_status_check CHECK (
    status IN ('pending', 'processing', 'delivered', 'dead_letter')
  ),
  CONSTRAINT audit_outbox_attempt_check CHECK (attempt_count BETWEEN 0 AND 3),
  CONSTRAINT audit_outbox_lease_version_check CHECK (lease_version >= 1),
  CONSTRAINT audit_outbox_record_version_check CHECK (record_version >= 1),
  CONSTRAINT audit_outbox_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT audit_outbox_terminal_receipt_check CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL AND dead_lettered_at IS NULL)
    OR (status = 'dead_letter' AND dead_lettered_at IS NOT NULL AND delivered_at IS NULL)
    OR (status IN ('pending', 'processing') AND delivered_at IS NULL AND dead_lettered_at IS NULL)
  ),
  CONSTRAINT audit_outbox_payload_object_check CHECK (jsonb_typeof(payload) = 'object')
);

CREATE FUNCTION audit_outbox_validate_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_row record;
  payload_key text;
BEGIN
  IF NEW.payload IS NULL OR jsonb_typeof(NEW.payload) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_outbox_payload_object_check',
      MESSAGE = 'outbox payload must be a JSON object';
  END IF;
  FOR payload_key IN SELECT jsonb_object_keys(NEW.payload) LOOP
    IF payload_key NOT IN (
      'aggregate_id',
      'record_version',
      'request_id',
      'effect_type',
      'operation',
      'status',
      'reason_code',
      'attempt_count',
      'retryable'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'audit_outbox_payload_fields_check',
        MESSAGE = 'outbox payload contains an unallowlisted field';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
      FROM jsonb_each(NEW.payload) AS payload_item(key, value)
     WHERE jsonb_typeof(payload_item.value) NOT IN ('string', 'number', 'boolean', 'null')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_outbox_payload_scalar_check',
      MESSAGE = 'outbox payload values must be scalar';
  END IF;
  PERFORM audit_assert_safe_json(NEW.payload);
  IF NEW.payload->>'aggregate_id' IS DISTINCT FROM NEW.aggregate_id::text
     OR NEW.payload->>'request_id' IS DISTINCT FROM NEW.request_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_outbox_payload_context_check',
      MESSAGE = 'outbox payload context must match the envelope';
  END IF;

  SELECT event_type, event_version, resource_id, request_id
    INTO event_row
    FROM audit_events
   WHERE id = NEW.audit_event_id
     AND organization_id = NEW.organization_id;
  IF NOT FOUND
     OR event_row.event_type IS DISTINCT FROM NEW.event_type
     OR event_row.event_version IS DISTINCT FROM NEW.event_version
     OR event_row.resource_id IS DISTINCT FROM NEW.aggregate_id
     OR event_row.request_id IS DISTINCT FROM NEW.request_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_outbox_audit_context_check',
      MESSAGE = 'outbox must reference the matching audit event';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.attempt_count <> 0 OR NEW.record_version <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'audit_outbox_initial_state_check',
        MESSAGE = 'outbox records must begin pending with zero attempts';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.audit_event_id IS DISTINCT FROM OLD.audit_event_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
     OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.event_version IS DISTINCT FROM OLD.event_version
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_outbox_identity_immutable_check',
      MESSAGE = 'outbox identity and effect key are immutable';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_outbox_record_version_transition_check',
      MESSAGE = 'outbox record_version must increase exactly once';
  END IF;
  IF OLD.status IN ('delivered', 'dead_letter') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_outbox_terminal_immutable_check',
      MESSAGE = 'outbox terminal state is immutable';
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status = 'processing')
    OR (OLD.status = 'processing' AND NEW.status IN ('pending', 'delivered', 'dead_letter'))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_outbox_state_transition_check',
      MESSAGE = 'outbox state transition is not allowed';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'audit_outbox_attempt_monotonic_check',
      MESSAGE = 'outbox attempt count cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION audit_reject_immutable_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'audit_outbox_append_only_history',
    MESSAGE = 'audit/outbox history cannot be deleted';
END;
$$;

CREATE TRIGGER audit_outbox_write_trg
BEFORE INSERT OR UPDATE ON audit_outbox
FOR EACH ROW EXECUTE FUNCTION audit_outbox_validate_write();

CREATE TRIGGER audit_outbox_delete_trg
BEFORE DELETE ON audit_outbox
FOR EACH ROW EXECUTE FUNCTION audit_reject_immutable_delete();

CREATE TABLE notifications_notifications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  recipient_user_id uuid NOT NULL REFERENCES identity_users (id),
  outbox_id uuid NOT NULL,
  effect_type text NOT NULL,
  effect_idempotency_key text NOT NULL,
  channel text NOT NULL DEFAULT 'in_app',
  content_code text NOT NULL DEFAULT 'PENDING_ITEM',
  status text NOT NULL DEFAULT 'unread',
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT notifications_notifications_outbox_fk FOREIGN KEY (outbox_id, organization_id)
    REFERENCES audit_outbox (id, organization_id),
  CONSTRAINT notifications_notifications_composite_key UNIQUE (id, organization_id),
  CONSTRAINT notifications_notifications_effect_key UNIQUE (
    organization_id,
    effect_type,
    effect_idempotency_key
  ),
  CONSTRAINT notifications_notifications_channel_check CHECK (channel = 'in_app'),
  CONSTRAINT notifications_notifications_content_check CHECK (content_code = 'PENDING_ITEM'),
  CONSTRAINT notifications_notifications_status_check CHECK (
    status IN ('unread', 'read', 'suppressed')
  ),
  CONSTRAINT notifications_notifications_effect_name_check CHECK (
    effect_type ~ '^[a-z][a-z0-9_.:-]{0,127}$'
    AND effect_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT notifications_notifications_version_check CHECK (record_version >= 1),
  CONSTRAINT notifications_notifications_timestamps_check CHECK (updated_at >= created_at)
);

CREATE FUNCTION notifications_validate_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.channel <> 'in_app' OR NEW.content_code <> 'PENDING_ITEM' OR NEW.record_version <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'notifications_notifications_minimal_content_check',
        MESSAGE = 'Release 1 notifications are minimal in-app pending-item notices';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
     OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
     OR NEW.effect_type IS DISTINCT FROM OLD.effect_type
     OR NEW.effect_idempotency_key IS DISTINCT FROM OLD.effect_idempotency_key
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.content_code IS DISTINCT FROM OLD.content_code
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'notifications_notifications_identity_immutable_check',
      MESSAGE = 'notification effect identity and content are immutable';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'notifications_notifications_record_version_check',
      MESSAGE = 'notification record_version must increase exactly once';
  END IF;
  IF NOT (
    (OLD.status = 'unread' AND NEW.status IN ('read', 'suppressed'))
    OR (OLD.status = 'read' AND NEW.status = 'suppressed')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'notifications_notifications_state_transition_check',
      MESSAGE = 'notification state transition is not allowed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_notifications_write_trg
BEFORE INSERT OR UPDATE ON notifications_notifications
FOR EACH ROW EXECUTE FUNCTION notifications_validate_write();

CREATE TABLE notifications_delivery_receipts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  outbox_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  effect_type text NOT NULL,
  effect_idempotency_key text NOT NULL,
  outcome text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1,
  provider_reference text,
  failure_code text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT notifications_delivery_receipts_outbox_fk FOREIGN KEY (outbox_id, organization_id)
    REFERENCES audit_outbox (id, organization_id),
  CONSTRAINT notifications_delivery_receipts_notification_fk FOREIGN KEY (
    notification_id,
    organization_id
  ) REFERENCES notifications_notifications (id, organization_id),
  CONSTRAINT notifications_delivery_effect_key UNIQUE (
    organization_id,
    effect_type,
    effect_idempotency_key
  ),
  CONSTRAINT notifications_delivery_receipts_effect_name_check CHECK (
    effect_type ~ '^[a-z][a-z0-9_.:-]{0,127}$'
    AND effect_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT notifications_delivery_receipts_outcome_check CHECK (
    outcome IN ('delivered', 'failed', 'compensated')
  ),
  CONSTRAINT notifications_delivery_receipts_attempt_check CHECK (attempt_count BETWEEN 1 AND 3),
  CONSTRAINT notifications_delivery_receipts_reference_check CHECK (
    provider_reference IS NULL OR provider_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT notifications_delivery_receipts_failure_check CHECK (
    failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_:-]{0,127}$'
  ),
  CONSTRAINT notifications_delivery_receipts_version_check CHECK (record_version >= 1),
  CONSTRAINT notifications_delivery_receipts_timestamps_check CHECK (updated_at >= created_at)
);

CREATE FUNCTION notifications_validate_delivery_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  notification_row record;
BEGIN
  SELECT effect_type, effect_idempotency_key, outbox_id
    INTO notification_row
    FROM notifications_notifications
   WHERE id = NEW.notification_id
     AND organization_id = NEW.organization_id;
  IF NOT FOUND
     OR notification_row.effect_type IS DISTINCT FROM NEW.effect_type
     OR notification_row.effect_idempotency_key IS DISTINCT FROM NEW.effect_idempotency_key
     OR notification_row.outbox_id IS DISTINCT FROM NEW.outbox_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'notifications_delivery_context_check',
      MESSAGE = 'delivery receipt must match the notification effect';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.record_version <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'notifications_delivery_receipts_initial_version_check',
        MESSAGE = 'delivery receipt must begin at record_version one';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
     OR NEW.notification_id IS DISTINCT FROM OLD.notification_id
     OR NEW.effect_type IS DISTINCT FROM OLD.effect_type
     OR NEW.effect_idempotency_key IS DISTINCT FROM OLD.effect_idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'notifications_delivery_identity_immutable_check',
      MESSAGE = 'delivery effect identity is immutable';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 OR NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'notifications_delivery_version_transition_check',
      MESSAGE = 'delivery receipt version and attempts must be monotonic';
  END IF;
  IF OLD.outcome = 'compensated' OR (OLD.outcome = 'delivered' AND NEW.outcome = 'failed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'notifications_delivery_terminal_state_check',
      MESSAGE = 'delivery receipt outcome cannot regress';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_delivery_receipts_write_trg
BEFORE INSERT OR UPDATE ON notifications_delivery_receipts
FOR EACH ROW EXECUTE FUNCTION notifications_validate_delivery_write();

CREATE TRIGGER notifications_delivery_receipts_delete_trg
BEFORE DELETE ON notifications_delivery_receipts
FOR EACH ROW EXECUTE FUNCTION audit_reject_immutable_delete();
