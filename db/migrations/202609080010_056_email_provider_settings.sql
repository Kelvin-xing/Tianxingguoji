-- Organization-scoped Resend configuration managed by active Admin users.
-- API keys are encrypted by the application with AES-256-GCM before storage.

CREATE TABLE email_provider_settings (
  organization_id uuid PRIMARY KEY REFERENCES access_organizations (id),
  provider text NOT NULL,
  from_email text NOT NULL,
  from_name text,
  api_key_ciphertext bytea NOT NULL,
  api_key_iv bytea NOT NULL,
  api_key_auth_tag bytea NOT NULL,
  encryption_key_version text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  updated_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT email_provider_settings_provider_check CHECK (provider = 'resend'),
  CONSTRAINT email_provider_settings_from_email_check CHECK (
    from_email = lower(btrim(from_email))
    AND length(from_email) BETWEEN 3 AND 320
    AND from_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  CONSTRAINT email_provider_settings_from_name_check CHECK (
    from_name IS NULL OR (
      from_name = btrim(from_name)
      AND length(from_name) BETWEEN 1 AND 100
      AND from_name !~ '[<>[:cntrl:]]'
    )
  ),
  CONSTRAINT email_provider_settings_ciphertext_check CHECK (
    octet_length(api_key_ciphertext) BETWEEN 11 AND 512
    AND octet_length(api_key_iv) = 12
    AND octet_length(api_key_auth_tag) = 16
  ),
  CONSTRAINT email_provider_settings_key_version_check CHECK (
    encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  CONSTRAINT email_provider_settings_record_version_check CHECK (record_version >= 1),
  CONSTRAINT email_provider_settings_timestamps_check CHECK (updated_at >= created_at)
);

CREATE FUNCTION email_validate_provider_settings_write()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'email_provider_settings_identity_immutable_check',
        MESSAGE = 'email provider settings identity is immutable';
    END IF;
    IF NEW.record_version <> OLD.record_version + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'email_provider_settings_version_check',
        MESSAGE = 'email provider settings must increment record_version exactly once';
    END IF;
    NEW.updated_at := transaction_timestamp();
  ELSIF NEW.record_version <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'email_provider_settings_initial_version_check',
      MESSAGE = 'email provider settings must begin at version one';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION email_reject_provider_settings_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    CONSTRAINT = 'email_provider_settings_no_delete',
    MESSAGE = 'email provider settings cannot be deleted';
END;
$function$;

CREATE TRIGGER email_provider_settings_validate_write
BEFORE INSERT OR UPDATE ON email_provider_settings
FOR EACH ROW EXECUTE FUNCTION email_validate_provider_settings_write();

CREATE TRIGGER email_provider_settings_reject_delete
BEFORE DELETE ON email_provider_settings
FOR EACH ROW EXECUTE FUNCTION email_reject_provider_settings_delete();

REVOKE ALL ON TABLE email_provider_settings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE email_provider_settings TO tianxing_app;

ALTER TABLE email_provider_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON email_provider_settings
  FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));

REVOKE ALL ON FUNCTION email_validate_provider_settings_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION email_reject_provider_settings_delete() FROM PUBLIC;
