-- BR-051: manual intake is an immutable unverified record, not a crawler snapshot.
DO $$ BEGIN
  IF current_user='tianxing_app' THEN
    GRANT REFERENCES ON schools_schools,identity_users TO tianxing_app;
  END IF;
END; $$;
CREATE TABLE schools_provisional_records (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_name_zh text,
  school_name_en text,
  district text,
  system text,
  stage text,
  reason text,
  status text NOT NULL DEFAULT 'provisional' CHECK(status='provisional'),
  record_version bigint NOT NULL DEFAULT 1 CHECK(record_version=1),
  created_by_user_id uuid NOT NULL REFERENCES identity_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT schools_provisional_school_fk FOREIGN KEY(school_id,organization_id)
    REFERENCES schools_schools(id,organization_id),
  CONSTRAINT schools_provisional_name_required CHECK(school_name_zh IS NOT NULL OR school_name_en IS NOT NULL),
  CONSTRAINT schools_provisional_zh CHECK(school_name_zh IS NULL OR length(btrim(school_name_zh)) BETWEEN 1 AND 512),
  CONSTRAINT schools_provisional_en CHECK(school_name_en IS NULL OR length(btrim(school_name_en)) BETWEEN 1 AND 512),
  CONSTRAINT schools_provisional_district CHECK(district IS NULL OR length(btrim(district)) BETWEEN 1 AND 128),
  CONSTRAINT schools_provisional_system CHECK(system IS NULL OR length(btrim(system)) BETWEEN 1 AND 128),
  CONSTRAINT schools_provisional_stage CHECK(stage IS NULL OR length(btrim(stage)) BETWEEN 1 AND 128),
  CONSTRAINT schools_provisional_reason CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1024)
);
ALTER TABLE schools_provisional_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools_provisional_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON schools_provisional_records
  USING(organization_id::text=current_setting('app.organization_id',true))
  WITH CHECK(organization_id::text=current_setting('app.organization_id',true));
CREATE TRIGGER schools_provisional_immutable BEFORE UPDATE OR DELETE ON schools_provisional_records
  FOR EACH ROW EXECUTE FUNCTION schools_reject_immutable_delete('schools_provisional_immutable');
CREATE TRIGGER schools_provisional_no_truncate BEFORE TRUNCATE ON schools_provisional_records
  FOR EACH STATEMENT EXECUTE FUNCTION schools_reject_immutable_delete('schools_provisional_immutable');
REVOKE ALL ON schools_provisional_records FROM PUBLIC;
GRANT SELECT,INSERT ON schools_provisional_records TO tianxing_app;
DO $$ BEGIN
  IF current_user='tianxing_app' THEN
    REVOKE REFERENCES ON schools_schools,identity_users FROM tianxing_app;
  END IF;
END; $$;
