-- R1X-05/07 additive source artifact. Execution remains separately approved.
-- Platform control data is aggregate-only and deliberately outside tenant audit.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_billing') THEN
    CREATE ROLE platform_billing LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_billing_reader') THEN
    CREATE ROLE platform_billing_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

GRANT rds_iam TO platform_billing;
GRANT rds_iam TO platform_billing_reader;
DO $$
DECLARE
  target_database text := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO platform_billing', target_database);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO platform_billing_reader', target_database);
END;
$$;

CREATE TABLE platform_billing_actors (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  status text NOT NULL,
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT platform_billing_actors_role_check
    CHECK (role IN ('platform_finance', 'platform_billing_approver')),
  CONSTRAINT platform_billing_actors_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT platform_billing_actors_version_check CHECK (record_version >= 1),
  CONSTRAINT platform_billing_actors_time_check CHECK (updated_at >= created_at)
);

CREATE TABLE platform_billing_contract_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  contract_number text NOT NULL,
  currency text NOT NULL,
  -- Opaque approved source reference only; no fee/payable semantics.
  contract_value_minor bigint NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  source_reference text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_by_actor_id uuid NOT NULL REFERENCES platform_billing_actors (id),
  approved_by_actor_id uuid REFERENCES platform_billing_actors (id),
  approved_at timestamptz,
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  CONSTRAINT platform_billing_contract_versions_org_number_key
    UNIQUE (organization_id, contract_number),
  CONSTRAINT platform_billing_contract_versions_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT platform_billing_contract_versions_currency_check
    CHECK (currency IN ('HKD', 'USD', 'CNY')),
  CONSTRAINT platform_billing_contract_versions_value_check CHECK (contract_value_minor >= 0),
  CONSTRAINT platform_billing_contract_versions_period_check
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT platform_billing_contract_versions_status_check
    CHECK (status IN ('draft', 'active', 'superseded')),
  CONSTRAINT platform_billing_contract_versions_approval_check CHECK (
    (status = 'draft' AND approved_by_actor_id IS NULL AND approved_at IS NULL)
    OR (status IN ('active', 'superseded') AND approved_by_actor_id IS NOT NULL
      AND approved_at IS NOT NULL AND created_by_actor_id <> approved_by_actor_id)
  ),
  CONSTRAINT platform_billing_contract_versions_version_check CHECK (record_version >= 1),
  CONSTRAINT platform_billing_contract_versions_source_check
    CHECK (source_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);

CREATE TABLE platform_billing_metric_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  billing_month text NOT NULL,
  revision integer NOT NULL,
  advancing_case_count integer NOT NULL,
  count_policy_version text NOT NULL,
  source_cutoff_at timestamptz NOT NULL,
  source_projection_version bigint NOT NULL,
  generated_by_actor_id uuid NOT NULL REFERENCES platform_billing_actors (id),
  generated_at timestamptz NOT NULL,
  CONSTRAINT platform_billing_metric_snapshots_revision_key
    UNIQUE (organization_id, billing_month, revision),
  CONSTRAINT platform_billing_metric_snapshots_month_check
    CHECK (billing_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT platform_billing_metric_snapshots_count_check CHECK (advancing_case_count >= 0),
  CONSTRAINT platform_billing_metric_snapshots_policy_check
    CHECK (count_policy_version = 'advancing_case_count_v1'),
  CONSTRAINT platform_billing_metric_snapshots_version_check
    CHECK (revision >= 1 AND source_projection_version >= 0)
);

CREATE TABLE platform_billing_subscription_projections (
  organization_id uuid PRIMARY KEY REFERENCES access_organizations (id),
  status text NOT NULL,
  aggregate_exception text,
  record_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL,
  CONSTRAINT platform_billing_subscription_status_check CHECK (status IN ('active', 'past_due')),
  CONSTRAINT platform_billing_subscription_exception_check CHECK (
    (status = 'active' AND aggregate_exception IS NULL)
    OR (status = 'past_due' AND aggregate_exception = 'past_due')
  ),
  CONSTRAINT platform_billing_subscription_version_check CHECK (record_version >= 1)
);

CREATE TABLE platform_audit_events (
  id uuid PRIMARY KEY,
  platform_actor_id uuid NOT NULL REFERENCES platform_billing_actors (id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  request_id text NOT NULL,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT platform_audit_events_idempotency_key
    UNIQUE (platform_actor_id, action, resource_type, resource_id, idempotency_key),
  CONSTRAINT platform_audit_events_text_check CHECK (
    action ~ '^[a-z][a-z0-9._:-]{0,127}$'
    AND resource_type ~ '^[a-z][a-z0-9._:-]{0,63}$'
    AND request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT platform_audit_events_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT platform_audit_events_metadata_allowlist_check CHECK (
    metadata - ARRAY['organization_id', 'billing_month', 'record_version', 'count_policy_version'] = '{}'::jsonb
  ),
  CONSTRAINT platform_audit_events_metadata_values_check CHECK (
    (NOT (metadata ? 'organization_id') OR metadata->>'organization_id' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    AND (NOT (metadata ? 'billing_month') OR metadata->>'billing_month' ~
      '^[0-9]{4}-(0[1-9]|1[0-2])$')
    AND (NOT (metadata ? 'record_version') OR (
      jsonb_typeof(metadata->'record_version') = 'number'
      AND (metadata->>'record_version')::bigint >= 1
    ))
    AND (NOT (metadata ? 'count_policy_version')
      OR metadata->>'count_policy_version' = 'advancing_case_count_v1')
  )
);

CREATE TABLE platform_billing_idempotency (
  id uuid PRIMARY KEY,
  platform_actor_id uuid NOT NULL REFERENCES platform_billing_actors (id),
  operation text NOT NULL,
  target_reference text NOT NULL,
  expected_version bigint,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL,
  result_reference text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT platform_billing_idempotency_scope_key UNIQUE NULLS NOT DISTINCT
    (platform_actor_id, operation, target_reference, expected_version, idempotency_key),
  CONSTRAINT platform_billing_idempotency_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT platform_billing_idempotency_state_check
    CHECK (state IN ('in_progress', 'completed', 'failed_reconcilable')),
  CONSTRAINT platform_billing_idempotency_time_check CHECK (updated_at >= created_at)
);

CREATE FUNCTION platform_billing_assert_actor()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_billing_actors
    WHERE id::text = current_setting('app.platform_actor_id', true) AND status = 'active'
  );
$$;

CREATE FUNCTION platform_billing_reject_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
    CONSTRAINT = 'platform_billing_append_only', MESSAGE = 'platform control history is append-only';
END;
$$;

CREATE FUNCTION platform_billing_validate_contract_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM platform_billing_contract_versions current_version
    WHERE current_version.organization_id = NEW.organization_id
      AND current_version.id <> NEW.id
      AND current_version.status = 'active'
      AND NEW.status = 'active'
      AND tstzrange(current_version.effective_from, current_version.effective_to, '[]')
        && tstzrange(NEW.effective_from, NEW.effective_to, '[]')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'exclusion_violation',
      CONSTRAINT = 'platform_billing_contract_effective_period_overlap';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.contract_number IS DISTINCT FROM OLD.contract_number
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.contract_value_minor IS DISTINCT FROM OLD.contract_value_minor
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
    OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
    OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      CONSTRAINT = 'platform_billing_contract_source_append_only';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'serialization_failure',
      CONSTRAINT = 'platform_billing_contract_version_transition';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'active')
    OR (OLD.status = 'active' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      CONSTRAINT = 'platform_billing_contract_state_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_billing_contract_write_trg
BEFORE INSERT OR UPDATE ON platform_billing_contract_versions
FOR EACH ROW EXECUTE FUNCTION platform_billing_validate_contract_write();
CREATE TRIGGER platform_billing_contract_delete_trg
BEFORE DELETE ON platform_billing_contract_versions
FOR EACH ROW EXECUTE FUNCTION platform_billing_reject_immutable();
CREATE TRIGGER platform_billing_metric_immutable_trg
BEFORE UPDATE OR DELETE ON platform_billing_metric_snapshots
FOR EACH ROW EXECUTE FUNCTION platform_billing_reject_immutable();
CREATE TRIGGER platform_audit_immutable_trg
BEFORE UPDATE OR DELETE ON platform_audit_events
FOR EACH ROW EXECUTE FUNCTION platform_billing_reject_immutable();

ALTER TABLE platform_billing_actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_actors FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_contract_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_contract_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_metric_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_metric_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_subscription_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_subscription_projections FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_idempotency FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_actor_self ON platform_billing_actors TO platform_billing
  USING (id::text = current_setting('app.platform_actor_id', true));
CREATE POLICY platform_contract_control ON platform_billing_contract_versions TO platform_billing
  USING (platform_billing_assert_actor()) WITH CHECK (platform_billing_assert_actor());
CREATE POLICY platform_metric_control ON platform_billing_metric_snapshots TO platform_billing
  USING (platform_billing_assert_actor()) WITH CHECK (platform_billing_assert_actor());
CREATE POLICY platform_subscription_control ON platform_billing_subscription_projections TO platform_billing
  USING (platform_billing_assert_actor()) WITH CHECK (platform_billing_assert_actor());
CREATE POLICY platform_audit_control ON platform_audit_events TO platform_billing
  USING (platform_billing_assert_actor()) WITH CHECK (platform_billing_assert_actor());
CREATE POLICY platform_idempotency_control ON platform_billing_idempotency TO platform_billing
  USING (platform_billing_assert_actor()) WITH CHECK (platform_billing_assert_actor());

CREATE POLICY platform_contract_aggregate_read ON platform_billing_contract_versions
  FOR SELECT TO platform_billing_reader USING (true);
CREATE POLICY platform_metric_aggregate_read ON platform_billing_metric_snapshots
  FOR SELECT TO platform_billing_reader USING (true);
CREATE POLICY platform_subscription_aggregate_read ON platform_billing_subscription_projections
  FOR SELECT TO platform_billing_reader USING (true);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM platform_billing;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM platform_billing_reader;
REVOKE ALL ON FUNCTION platform_billing_assert_actor() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_billing_reject_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_billing_validate_contract_write() FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO platform_billing;
GRANT USAGE ON SCHEMA public TO platform_billing_reader;
GRANT SELECT ON platform_billing_actors TO platform_billing;
GRANT SELECT, INSERT, UPDATE ON platform_billing_contract_versions TO platform_billing;
GRANT SELECT, INSERT ON platform_billing_metric_snapshots, platform_audit_events TO platform_billing;
GRANT SELECT, INSERT, UPDATE ON platform_billing_subscription_projections, platform_billing_idempotency TO platform_billing;
GRANT EXECUTE ON FUNCTION platform_billing_assert_actor() TO platform_billing;
GRANT SELECT (organization_id, contract_number, source_reference, status)
  ON platform_billing_contract_versions TO platform_billing_reader;
GRANT SELECT (organization_id, billing_month, revision, advancing_case_count,
  count_policy_version, source_cutoff_at, source_projection_version, generated_at)
  ON platform_billing_metric_snapshots TO platform_billing_reader;
GRANT SELECT (organization_id, status, aggregate_exception, record_version, updated_at)
  ON platform_billing_subscription_projections TO platform_billing_reader;
