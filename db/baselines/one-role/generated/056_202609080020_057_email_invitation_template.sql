-- Organization-scoped internal invitation template managed by active Admin users.
-- Only plain text is stored; secure activation controls remain application-owned.

CREATE TABLE email_templates (
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  template_kind text NOT NULL,
  subject_template text NOT NULL,
  body_text_template text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  updated_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id, template_kind),
  CONSTRAINT email_templates_kind_check CHECK (template_kind = 'internal_user_invitation'),
  CONSTRAINT email_templates_subject_check CHECK (
    subject_template = btrim(subject_template)
    AND length(subject_template) BETWEEN 1 AND 160
    AND subject_template !~ '[[:cntrl:]]'
  ),
  CONSTRAINT email_templates_body_check CHECK (
    body_text_template = btrim(body_text_template)
    AND length(body_text_template) BETWEEN 1 AND 4000
  ),
  CONSTRAINT email_templates_record_version_check CHECK (record_version >= 1),
  CONSTRAINT email_templates_timestamps_check CHECK (updated_at >= created_at)
);

CREATE FUNCTION email_validate_template_write()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.template_kind IS DISTINCT FROM OLD.template_kind
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'email_templates_identity_immutable_check',
        MESSAGE = 'email template identity is immutable';
    END IF;
    IF NEW.record_version <> OLD.record_version + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'email_templates_version_check',
        MESSAGE = 'email template must increment record_version exactly once';
    END IF;
    NEW.updated_at := transaction_timestamp();
  ELSIF NEW.record_version <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'email_templates_initial_version_check',
      MESSAGE = 'email template must begin at version one';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION email_reject_template_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    CONSTRAINT = 'email_templates_no_delete',
    MESSAGE = 'email templates cannot be deleted';
END;
$function$;

CREATE TRIGGER email_templates_validate_write
BEFORE INSERT OR UPDATE ON email_templates
FOR EACH ROW EXECUTE FUNCTION email_validate_template_write();

CREATE TRIGGER email_templates_reject_delete
BEFORE DELETE ON email_templates
FOR EACH ROW EXECUTE FUNCTION email_reject_template_delete();

REVOKE ALL ON TABLE email_templates FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE email_templates TO tianxing_app;

ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON email_templates
  FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));

REVOKE ALL ON FUNCTION email_validate_template_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION email_reject_template_delete() FROM PUBLIC;
