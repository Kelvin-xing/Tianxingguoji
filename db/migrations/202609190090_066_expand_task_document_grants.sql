-- The one-role baseline has deliberately revoked its own REFERENCES privileges.
-- Open only an installation window; retain separate-owner application grants.
DO $$ BEGIN
  IF current_user='tianxing_app' THEN
    GRANT REFERENCES ON access_organizations,identity_users,tasks_tasks,documents_documents TO tianxing_app;
  END IF;
END; $$;
-- BR-015: explicit task links never grant access to the rest of the case.
CREATE TABLE documents_task_links (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations(id),
  task_id uuid NOT NULL,
  document_id uuid NOT NULL,
  allowed_actions text[] NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
  changed_by_user_id uuid NOT NULL REFERENCES identity_users(id),
  record_version bigint NOT NULL DEFAULT 1 CHECK(record_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT documents_task_links_task_fk FOREIGN KEY(task_id,organization_id) REFERENCES tasks_tasks(id,organization_id),
  CONSTRAINT documents_task_links_document_fk FOREIGN KEY(document_id,organization_id) REFERENCES documents_documents(id,organization_id),
  CONSTRAINT documents_task_links_unique UNIQUE(organization_id,task_id,document_id),
  CONSTRAINT documents_task_links_actions CHECK (
    array_position(allowed_actions,NULL) IS NULL AND
    allowed_actions <@ ARRAY['document.read','document.upload','document.download']::text[] AND
    (cardinality(allowed_actions)=0 OR 'document.read'=ANY(allowed_actions)))
);
CREATE FUNCTION documents_validate_task_link() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE task_case uuid; document_case uuid; kind text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.organization_id,NEW.task_id,NEW.document_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.task_id,OLD.document_id,OLD.created_at)
      OR NEW.record_version<>OLD.record_version+1 THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='task link identity immutable and version must increment';
    END IF;
  ELSIF NEW.record_version<>1 THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='task link starts at version one';
  END IF;
  SELECT service_case_id,task_kind INTO task_case,kind FROM tasks_tasks
    WHERE id=NEW.task_id AND organization_id=NEW.organization_id;
  SELECT service_case_id INTO document_case FROM documents_documents
    WHERE id=NEW.document_id AND organization_id=NEW.organization_id AND owner_kind='case';
  IF task_case IS NULL OR document_case IS DISTINCT FROM task_case THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='task document must belong to the same case';
  END IF;
  IF kind='interview_support' AND 'document.download'=ANY(NEW.allowed_actions) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='interview document download forbidden';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER documents_task_links_validate BEFORE INSERT OR UPDATE ON documents_task_links
  FOR EACH ROW EXECUTE FUNCTION documents_validate_task_link();
ALTER TABLE documents_task_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents_task_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON documents_task_links
  USING(organization_id::text=current_setting('app.organization_id',true))
  WITH CHECK(organization_id::text=current_setting('app.organization_id',true));
REVOKE ALL ON documents_task_links FROM PUBLIC;
REVOKE ALL ON FUNCTION documents_validate_task_link() FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON documents_task_links TO tianxing_app;

DO $$ BEGIN
  IF current_user='tianxing_app' THEN
    REVOKE REFERENCES ON access_organizations,identity_users,tasks_tasks,documents_documents FROM tianxing_app;
  END IF;
END; $$;

-- Keep task and document identifiers in the same audited grant event.
-- Extend only the UUID field; preserve all existing redaction and envelope checks.
DO $$
DECLARE definition text; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['audit_validate_event_write()','audit_outbox_validate_write()'] LOOP
    SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
    IF position($field$'record_version',$field$ IN definition)=0 THEN
      RAISE EXCEPTION 'audit field allowlist anchor missing';
    END IF;
    definition:=replace(definition,$field$'record_version',$field$,$field$'document_id', 'record_version',$field$);
    EXECUTE definition;
  END LOOP;
END; $$;
CREATE FUNCTION documents_deny_task_link_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='task document link history cannot be removed';
END; $$;
CREATE TRIGGER documents_task_links_no_delete BEFORE DELETE ON documents_task_links
  FOR EACH ROW EXECUTE FUNCTION documents_deny_task_link_delete();
CREATE TRIGGER documents_task_links_no_truncate BEFORE TRUNCATE ON documents_task_links
  FOR EACH STATEMENT EXECUTE FUNCTION documents_deny_task_link_delete();
REVOKE ALL ON FUNCTION documents_deny_task_link_delete() FROM PUBLIC;
