-- Release 1 preserves historical purged tombstones but never creates new ones.
ALTER TABLE crm_students
  ADD CONSTRAINT crm_students_no_new_purged_check
  CHECK (status <> 'purged') NOT VALID;

ALTER TABLE crm_guardians
  ADD CONSTRAINT crm_guardians_no_new_purged_check
  CHECK (status <> 'purged') NOT VALID;

-- Cross-module deletion guards are owned by the application coordinator and Cases public port.
CREATE OR REPLACE FUNCTION crm_validate_student_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'crm_students_immutable_or_version_check',
      MESSAGE = 'student identity and optimistic version are immutable';
  END IF;
  IF OLD.status IN ('deleted', 'purged') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_students_deleted_immutable_check',
      MESSAGE = 'deleted Student history is immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'active' AND NEW.status = 'pending_delete') OR
    (OLD.status = 'pending_delete' AND NEW.status IN ('active', 'deleted'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_students_status_transition_check',
      MESSAGE = 'invalid Student soft-delete transition';
  END IF;
  RETURN NEW;
END;
$$;
