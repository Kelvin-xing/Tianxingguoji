-- Additive directory storage only. No old data, routes, application grants or plans.
-- Schools BR-051 v68; all commands remain unavailable to application roles.
-- migrate:up
CREATE FUNCTION schools_directory_valid_fields(value jsonb, allowed text[])
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_typeof(value) = 'object'
   AND NOT EXISTS (SELECT FROM jsonb_object_keys(value) k WHERE NOT (k = ANY(allowed)))
   AND NOT EXISTS (SELECT FROM jsonb_each(value) e WHERE jsonb_typeof(e.value) NOT IN ('string','boolean','null'))
$$;
CREATE TABLE schools_directory_schools (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES access_organizations(id),
 edb_number text CHECK (edb_number IS NULL OR edb_number ~ '^[0-9]{6}$'),
 origin text NOT NULL CHECK (origin IN ('edb','manual')),
 fields jsonb NOT NULL,
 is_closed boolean,
 record_version bigint NOT NULL DEFAULT 1 CHECK (record_version > 0),
 UNIQUE(id,organization_id),
 UNIQUE(organization_id,edb_number),
 CHECK (coalesce(length(btrim(fields->>'school_name_zh')),0)>0
     OR coalesce(length(btrim(fields->>'school_name_en')),0)>0),
 CHECK (schools_directory_valid_fields(fields,ARRAY['school_name_zh','school_name_en','school_level','student_gender','is_sen','tuition_info','tuition_year','tuition_source_url','has_boarding','boarding_info']::text[]))
);
ALTER TABLE schools_directory_schools ADD CONSTRAINT schools_directory_school_field_types CHECK (
 NOT jsonb_path_exists(fields - ARRAY['is_sen','has_boarding'], '$.* ? (@.type() == "boolean")')
 AND (NOT fields ? 'is_sen' OR jsonb_typeof(fields->'is_sen') IN ('boolean','null'))
 AND (NOT fields ? 'has_boarding' OR jsonb_typeof(fields->'has_boarding') IN ('boolean','null'))
);
CREATE TABLE schools_directory_campuses (
 id uuid PRIMARY KEY,
 school_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 origin text NOT NULL CHECK (origin IN ('edb','manual')),
 fields jsonb NOT NULL CHECK (schools_directory_valid_fields(fields,ARRAY['source_school_key','registration_number','location_marker','official_website','profile_url','district','address','phone','fax','school_session','finance_type']::text[])),
 CHECK (NOT jsonb_path_exists(fields, '$.* ? (@.type() == "boolean")')),
 deleted_at timestamptz,
 record_version bigint NOT NULL DEFAULT 1 CHECK (record_version > 0),
 UNIQUE(id,school_id,organization_id),
 FOREIGN KEY(school_id,organization_id) REFERENCES schools_directory_schools(id,organization_id)
);
-- Mode is explicit technical storage, never inferred as a business default.
CREATE TABLE schools_directory_field_modes (
 school_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 field_key text NOT NULL CHECK (field_key = ANY(ARRAY['source_school_key','registration_number','location_marker','official_website','profile_url','district','address','phone','fax','school_session','finance_type']::text[])),
 shared boolean NOT NULL,
 PRIMARY KEY(school_id,field_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES schools_directory_schools(id,organization_id)
);
CREATE TABLE schools_directory_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 school_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 campus_id uuid,
 field_key text NOT NULL,
 old_value jsonb,
 new_value jsonb,
 source jsonb NOT NULL CHECK (jsonb_typeof(source)='object'),
 actor_user_id uuid NOT NULL REFERENCES identity_users(id),
 occurred_at timestamptz NOT NULL,
 record_version bigint NOT NULL,
 FOREIGN KEY(school_id,organization_id) REFERENCES schools_directory_schools(id,organization_id),
 FOREIGN KEY(campus_id,school_id,organization_id) REFERENCES schools_directory_campuses(id,school_id,organization_id)
);
CREATE FUNCTION schools_directory_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'directory_history_is_append_only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER schools_directory_history_immutable BEFORE UPDATE OR DELETE ON schools_directory_history
 FOR EACH ROW EXECUTE FUNCTION schools_directory_history_guard();

CREATE FUNCTION schools_directory_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; tenant uuid; target_school uuid; old_data jsonb; new_data jsonb; k text; src jsonb; at_time timestamptz;
BEGIN
 actor := nullif(current_setting('app.actor_user_id',true),'')::uuid;
 tenant := nullif(current_setting('app.organization_id',true),'')::uuid;
 src := nullif(current_setting('app.schools_directory_source',true),'')::jsonb;
 at_time := nullif(current_setting('app.schools_directory_time',true),'')::timestamptz;
 IF actor IS NULL OR tenant IS NULL OR src IS NULL OR at_time IS NULL OR tenant<>NEW.organization_id THEN
   RAISE EXCEPTION 'directory_context_required' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT FROM access_organization_memberships m JOIN identity_users u ON u.id=m.user_id
                WHERE m.user_id=actor AND m.organization_id=tenant AND m.status='active' AND u.status='active') THEN
   RAISE EXCEPTION 'directory_active_actor_required' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
   IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.origin<>OLD.origin
      OR (TG_TABLE_NAME='schools_directory_campuses' AND to_jsonb(NEW)->>'school_id'<>to_jsonb(OLD)->>'school_id') THEN
     RAISE EXCEPTION 'directory_identity_is_immutable' USING ERRCODE='23514';
   END IF;
   IF NEW.record_version<>OLD.record_version+1 THEN
     RAISE EXCEPTION 'directory_version_conflict' USING ERRCODE='40001';
   END IF;
   IF TG_TABLE_NAME='schools_directory_campuses' AND to_jsonb(OLD)->>'deleted_at' IS NOT NULL THEN
     RAISE EXCEPTION 'directory_deleted_campus_is_immutable' USING ERRCODE='23514';
   END IF;
   IF TG_TABLE_NAME='schools_directory_campuses' AND to_jsonb(NEW)->'deleted_at' IS DISTINCT FROM to_jsonb(OLD)->'deleted_at' THEN
     IF OLD.origin='edb' THEN RAISE EXCEPTION 'directory_edb_campus_cannot_be_deleted' USING ERRCODE='23514'; END IF;
   END IF;
   old_data:=OLD.fields;
 ELSE
   IF NEW.record_version<>1 THEN RAISE EXCEPTION 'directory_initial_version' USING ERRCODE='23514'; END IF;
   IF TG_TABLE_NAME='schools_directory_campuses' AND to_jsonb(NEW)->>'deleted_at' IS NOT NULL THEN
     RAISE EXCEPTION 'directory_initial_campus_deleted' USING ERRCODE='23514';
   END IF;
   old_data:='{}';
 END IF;
 new_data:=NEW.fields;
 target_school:=CASE WHEN TG_TABLE_NAME='schools_directory_schools' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'school_id')::uuid END;
 -- Serialize all changes within a school, including concurrent campus deletions.
 PERFORM 1 FROM schools_directory_schools WHERE id=target_school FOR UPDATE;
 FOR k IN SELECT key FROM jsonb_object_keys(old_data || new_data) key LOOP
   IF TG_OP='INSERT' OR old_data->k IS DISTINCT FROM new_data->k THEN
     INSERT INTO schools_directory_history(school_id,organization_id,campus_id,field_key,old_value,new_value,source,actor_user_id,occurred_at,record_version)
     VALUES(target_school,tenant,CASE WHEN TG_TABLE_NAME='schools_directory_campuses' THEN NEW.id END,k,old_data->k,new_data->k,src,actor,at_time,NEW.record_version);
   END IF;
 END LOOP;
 FOR k IN SELECT unnest(CASE WHEN TG_TABLE_NAME='schools_directory_schools' THEN ARRAY['edb_number','is_closed','origin'] ELSE ARRAY['deleted_at','origin'] END) LOOP
   IF TG_OP='INSERT' OR to_jsonb(OLD)->k IS DISTINCT FROM to_jsonb(NEW)->k THEN
     INSERT INTO schools_directory_history(school_id,organization_id,campus_id,field_key,old_value,new_value,source,actor_user_id,occurred_at,record_version)
     VALUES(target_school,tenant,CASE WHEN TG_TABLE_NAME='schools_directory_campuses' THEN NEW.id END,k,CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->k END,to_jsonb(NEW)->k,src,actor,at_time,NEW.record_version);
   END IF;
 END LOOP;
 RETURN NEW;
END $$;
-- AFTER guards let initial history reference the newly inserted identity atomically.
CREATE TRIGGER schools_directory_school_history AFTER INSERT OR UPDATE ON schools_directory_schools
 FOR EACH ROW EXECUTE FUNCTION schools_directory_write_guard();
CREATE TRIGGER schools_directory_campus_history AFTER INSERT OR UPDATE ON schools_directory_campuses
 FOR EACH ROW EXECUTE FUNCTION schools_directory_write_guard();

CREATE FUNCTION schools_directory_mode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; tenant uuid; src jsonb; stamp timestamptz; v bigint;
BEGIN
 actor:=nullif(current_setting('app.actor_user_id',true),'')::uuid;
 tenant:=nullif(current_setting('app.organization_id',true),'')::uuid;
 src:=nullif(current_setting('app.schools_directory_source',true),'')::jsonb;
 stamp:=nullif(current_setting('app.schools_directory_time',true),'')::timestamptz;
 IF actor IS NULL OR tenant IS DISTINCT FROM NEW.organization_id OR src IS NULL OR stamp IS NULL THEN
   RAISE EXCEPTION 'directory_context_required' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.school_id<>OLD.school_id OR NEW.organization_id<>OLD.organization_id OR NEW.field_key<>OLD.field_key) THEN
   RAISE EXCEPTION 'directory_mode_identity_is_immutable' USING ERRCODE='23514';
 END IF;
 -- The school update revalidates actor membership and serializes version/history.
 UPDATE schools_directory_schools SET record_version=record_version+1 WHERE id=NEW.school_id RETURNING record_version INTO v;
 INSERT INTO schools_directory_history(school_id,organization_id,field_key,old_value,new_value,source,actor_user_id,occurred_at,record_version)
 VALUES(NEW.school_id,tenant,'mode:'||NEW.field_key,CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD.shared) END,to_jsonb(NEW.shared),src,actor,stamp,v);
 RETURN NEW;
END $$;
CREATE TRIGGER schools_directory_mode_history AFTER INSERT OR UPDATE ON schools_directory_field_modes
 FOR EACH ROW EXECUTE FUNCTION schools_directory_mode_guard();

CREATE FUNCTION schools_directory_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'directory_physical_delete_forbidden' USING ERRCODE='23514'; END $$;
CREATE TRIGGER schools_directory_school_no_delete BEFORE DELETE ON schools_directory_schools FOR EACH ROW EXECUTE FUNCTION schools_directory_no_delete();
CREATE TRIGGER schools_directory_campus_no_delete BEFORE DELETE ON schools_directory_campuses FOR EACH ROW EXECUTE FUNCTION schools_directory_no_delete();

CREATE FUNCTION schools_directory_check_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid; f record; value_count integer;
BEGIN
 sid:=CASE WHEN TG_TABLE_NAME='schools_directory_schools' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'school_id')::uuid END;
 PERFORM 1 FROM schools_directory_schools WHERE id=sid FOR UPDATE;
 IF NOT EXISTS(SELECT FROM schools_directory_campuses WHERE school_id=sid AND deleted_at IS NULL) THEN
   RAISE EXCEPTION 'directory_last_campus_required' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM schools_directory_field_modes WHERE school_id=sid)<>11 THEN
   RAISE EXCEPTION 'directory_explicit_field_modes_required' USING ERRCODE='23514';
 END IF;
 FOR f IN SELECT field_key FROM schools_directory_field_modes WHERE school_id=sid AND shared LOOP
   SELECT count(DISTINCT coalesce(fields->f.field_key,'null'::jsonb)) INTO value_count
     FROM schools_directory_campuses WHERE school_id=sid AND deleted_at IS NULL;
   IF value_count>1 THEN RAISE EXCEPTION 'directory_shared_values_must_agree' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER schools_directory_school_shape AFTER INSERT OR UPDATE ON schools_directory_schools
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION schools_directory_check_shape();
CREATE CONSTRAINT TRIGGER schools_directory_campus_shape AFTER INSERT OR UPDATE ON schools_directory_campuses
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION schools_directory_check_shape();
CREATE CONSTRAINT TRIGGER schools_directory_mode_shape AFTER INSERT OR UPDATE ON schools_directory_field_modes
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION schools_directory_check_shape();
CREATE TRIGGER schools_directory_mode_no_delete BEFORE DELETE ON schools_directory_field_modes FOR EACH ROW EXECUTE FUNCTION schools_directory_no_delete();
-- No security-definer entry points and no application grants. Later permission ticket owns activation.
ALTER TABLE schools_directory_schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools_directory_schools FORCE ROW LEVEL SECURITY;
ALTER TABLE schools_directory_campuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools_directory_campuses FORCE ROW LEVEL SECURITY;
ALTER TABLE schools_directory_field_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools_directory_field_modes FORCE ROW LEVEL SECURITY;
ALTER TABLE schools_directory_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools_directory_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON schools_directory_schools,schools_directory_campuses,schools_directory_field_modes,schools_directory_history FROM PUBLIC;
REVOKE ALL ON FUNCTION schools_directory_valid_fields(jsonb,text[]),schools_directory_history_guard(),schools_directory_write_guard(),schools_directory_no_delete(),schools_directory_check_shape(),schools_directory_mode_guard() FROM PUBLIC;
-- migrate:down
DROP TABLE schools_directory_history;
DROP TABLE schools_directory_field_modes;
DROP TABLE schools_directory_campuses;
DROP TABLE schools_directory_schools;
DROP FUNCTION schools_directory_check_shape();
DROP FUNCTION schools_directory_mode_guard();
DROP FUNCTION schools_directory_write_guard();
DROP FUNCTION schools_directory_no_delete();
DROP FUNCTION schools_directory_history_guard();
DROP FUNCTION schools_directory_valid_fields(jsonb,text[]);
