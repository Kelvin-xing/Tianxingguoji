-- Open the existing one-role installation REFERENCES window only.
DO $$ BEGIN
  IF current_user='tianxing_app' THEN
    GRANT REFERENCES ON access_organizations,identity_users,identity_invites TO tianxing_app;
  END IF;
END; $$;
-- BR-014/015/075: one durable operation per caller key; no persisted activation secret.
CREATE TABLE identity_invite_operations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations(id),
  actor_user_id uuid NOT NULL REFERENCES identity_users(id),
  operation text NOT NULL CHECK(operation IN ('create','resend')),
  command_key text NOT NULL CHECK(command_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
  invite_id uuid NOT NULL REFERENCES identity_invites(id),
  invite_record_version bigint NOT NULL CHECK(invite_record_version>0),
  target_user_id uuid NOT NULL REFERENCES identity_users(id),
  expires_at timestamptz NOT NULL,
  channel_policy_id text CHECK(channel_policy_id='hk_dpa_reviewed_transactional'),
  receipt_reference text CHECK(receipt_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(organization_id,actor_user_id,operation,command_key),
  CHECK((channel_policy_id IS NULL AND receipt_reference IS NULL AND delivered_at IS NULL)
    OR (channel_policy_id IS NOT NULL AND receipt_reference IS NOT NULL AND delivered_at IS NOT NULL))
);
ALTER TABLE identity_invite_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_invite_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON identity_invite_operations FOR ALL TO tianxing_app
  USING(organization_id::text=current_setting('app.organization_id',true))
  WITH CHECK(organization_id::text=current_setting('app.organization_id',true));
REVOKE ALL ON identity_invite_operations FROM PUBLIC;
GRANT SELECT,INSERT ON identity_invite_operations TO tianxing_app;
GRANT UPDATE(channel_policy_id,receipt_reference,delivered_at) ON identity_invite_operations TO tianxing_app;

CREATE FUNCTION identity_validate_invite_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='invitation operations are retained';
  ELSIF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM identity_invites i WHERE i.id=NEW.invite_id
      AND i.organization_id=NEW.organization_id AND i.target_user_id=NEW.target_user_id
      AND i.record_version=NEW.invite_record_version AND i.expires_at=NEW.expires_at) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='invitation operation must match current invitation';
    END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['channel_policy_id','receipt_reference','delivered_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['channel_policy_id','receipt_reference','delivered_at'])
    OR OLD.receipt_reference IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='invitation operation receipt is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_invite_operations_validate BEFORE INSERT OR UPDATE OR DELETE ON identity_invite_operations
  FOR EACH ROW EXECUTE FUNCTION identity_validate_invite_operation();
CREATE TRIGGER identity_invite_operations_no_truncate BEFORE TRUNCATE ON identity_invite_operations
  FOR EACH STATEMENT EXECUTE FUNCTION identity_validate_invite_operation();
REVOKE ALL ON FUNCTION identity_validate_invite_operation() FROM PUBLIC;

DO $$ BEGIN
  IF current_user='tianxing_app' THEN
    REVOKE REFERENCES ON access_organizations,identity_users,identity_invites FROM tianxing_app;
  END IF;
END; $$;
