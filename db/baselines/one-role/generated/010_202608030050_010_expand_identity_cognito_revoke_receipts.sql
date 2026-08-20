CREATE TABLE identity_cognito_revoke_receipts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  outbox_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity_users (id),
  effect_idempotency_key text NOT NULL,
  outcome text NOT NULL,
  attempt_count integer NOT NULL,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT identity_cognito_revoke_receipts_outbox_fk FOREIGN KEY (outbox_id, organization_id)
    REFERENCES audit_outbox (id, organization_id),
  CONSTRAINT identity_cognito_revoke_receipts_effect_key UNIQUE (
    organization_id,
    effect_idempotency_key
  ),
  CONSTRAINT identity_cognito_revoke_receipts_outcome_check CHECK (
    outcome IN ('delivered', 'failed')
  ),
  CONSTRAINT identity_cognito_revoke_receipts_attempt_check CHECK (
    attempt_count BETWEEN 1 AND 3
  ),
  CONSTRAINT identity_cognito_revoke_receipts_effect_key_check CHECK (
    effect_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT identity_cognito_revoke_receipts_failure_check CHECK (
    failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_:-]{0,127}$'
  ),
  CONSTRAINT identity_cognito_revoke_receipts_outcome_failure_check CHECK (
    (outcome = 'delivered' AND failure_code IS NULL)
    OR (outcome = 'failed' AND failure_code IS NOT NULL)
  )
);

CREATE FUNCTION identity_validate_cognito_revoke_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  outbox_row record;
BEGIN
  SELECT aggregate_type, aggregate_id, idempotency_key, status, attempt_count
    INTO outbox_row
    FROM audit_outbox
   WHERE id = NEW.outbox_id
     AND organization_id = NEW.organization_id
   FOR NO KEY UPDATE;

  IF NOT FOUND
     OR outbox_row.aggregate_type IS DISTINCT FROM 'IdentityUser'
     OR outbox_row.aggregate_id IS DISTINCT FROM NEW.user_id
     OR outbox_row.idempotency_key IS DISTINCT FROM NEW.effect_idempotency_key
     OR outbox_row.attempt_count IS DISTINCT FROM NEW.attempt_count
     OR (NEW.outcome = 'delivered' AND outbox_row.status IS DISTINCT FROM 'delivered')
     OR (NEW.outcome = 'failed' AND outbox_row.status IS DISTINCT FROM 'dead_letter') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'identity_cognito_revoke_receipts_outbox_context_check',
      MESSAGE = 'Cognito revoke receipt must match one terminal IdentityUser outbox effect';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION identity_reject_cognito_revoke_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'identity_cognito_revoke_receipts_append_only',
    MESSAGE = 'Cognito revoke receipts are append-only';
END;
$$;

CREATE TRIGGER identity_cognito_revoke_receipts_validate_insert
BEFORE INSERT ON identity_cognito_revoke_receipts
FOR EACH ROW EXECUTE FUNCTION identity_validate_cognito_revoke_receipt();

CREATE TRIGGER identity_cognito_revoke_receipts_append_only
BEFORE UPDATE OR DELETE ON identity_cognito_revoke_receipts
FOR EACH ROW EXECUTE FUNCTION identity_reject_cognito_revoke_receipt_mutation();

REVOKE ALL ON TABLE identity_cognito_revoke_receipts FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE identity_cognito_revoke_receipts TO tianxing_app;
ALTER TABLE identity_cognito_revoke_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON identity_cognito_revoke_receipts
  FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
