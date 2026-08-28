-- Harden Release 1 member/profile/role mutations without changing historical rows.

CREATE OR REPLACE FUNCTION access_validate_employee_profile_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_contractor boolean;
  has_full_time_role boolean;
BEGIN
  NEW.display_name := btrim(NEW.display_name);

  IF TG_OP = 'UPDATE' THEN
    IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'access_employee_profiles_identity_immutable_check',
        MESSAGE = 'employee profile identity is immutable';
    END IF;
    IF NEW.record_version <> OLD.record_version + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'access_employee_profiles_version_check',
        MESSAGE = 'employee profile updates must increment record_version exactly once';
    END IF;
    NEW.updated_at := transaction_timestamp();
  END IF;

  SELECT bool_or(status='active' AND role='contractor'),
         bool_or(status='active' AND role IN ('founder','advisor'))
    INTO has_contractor,has_full_time_role
    FROM access_role_bindings
   WHERE membership_id=NEW.membership_id
     AND organization_id=NEW.organization_id;

  IF (NEW.employment_type='FULL_TIME' AND COALESCE(has_contractor,false))
     OR (NEW.employment_type='PART_TIME' AND COALESCE(has_full_time_role,false)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'access_employee_profiles_employment_type_roles_check',
      MESSAGE = 'employee profile employment type conflicts with active roles';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS access_employee_profiles_validate_update ON access_employee_profiles;
DROP TRIGGER IF EXISTS access_employee_profiles_validate_write ON access_employee_profiles;
CREATE TRIGGER access_employee_profiles_validate_write
BEFORE INSERT OR UPDATE ON access_employee_profiles
FOR EACH ROW EXECUTE FUNCTION access_validate_employee_profile_write();

CREATE OR REPLACE FUNCTION access_validate_role_binding_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_count integer;
  existing_contractor boolean;
  employment text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.role IS DISTINCT FROM OLD.role
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'access_role_bindings_identity_immutable_check',
        MESSAGE = 'role binding identity is immutable';
    END IF;
    IF OLD.status <> 'active' OR NEW.status <> 'revoked' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'access_role_bindings_status_transition_check',
        MESSAGE = 'role binding only permits active to revoked';
    END IF;
    IF NEW.record_version <> OLD.record_version + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'access_role_bindings_version_check',
        MESSAGE = 'role binding updates must increment record_version exactly once';
    END IF;
    NEW.updated_at := transaction_timestamp();
  END IF;

  IF NEW.status = 'active' THEN
    IF NEW.role NOT IN ('founder','admin','advisor','contractor') THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'access_role_bindings_active_role_vocabulary_check',
        MESSAGE = 'unknown active release role';
    END IF;
    SELECT count(*) FILTER (WHERE status='active'),
           bool_or(status='active' AND role='contractor')
      INTO active_count,existing_contractor
      FROM access_role_bindings
     WHERE membership_id=NEW.membership_id
       AND organization_id=NEW.organization_id
       AND user_id=NEW.user_id
       AND id IS DISTINCT FROM NEW.id;
    IF (NEW.role='contractor' AND active_count>0)
       OR (NEW.role<>'contractor' AND COALESCE(existing_contractor,false)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'access_role_bindings_contractor_exclusive_check',
        MESSAGE = 'contractor must be the only active role';
    END IF;
    SELECT employment_type INTO employment
      FROM access_employee_profiles
     WHERE membership_id=NEW.membership_id
       AND organization_id=NEW.organization_id;
    IF employment IS NULL
       OR (employment='FULL_TIME' AND NEW.role='contractor')
       OR (employment='PART_TIME' AND NEW.role IN ('founder','advisor')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'access_role_bindings_employment_type_check',
        MESSAGE = 'active role requires a compatible employee profile';
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND OLD.role='founder' AND OLD.status='active'
     AND NEW.status='revoked' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'access:last-founder:' || OLD.organization_id::text,0));
    SELECT count(*) INTO active_count
      FROM access_role_bindings AS remaining_role
      JOIN access_organization_memberships AS remaining_membership
        ON remaining_membership.id=remaining_role.membership_id
       AND remaining_membership.organization_id=remaining_role.organization_id
       AND remaining_membership.status='active'
     WHERE remaining_role.organization_id=OLD.organization_id
       AND remaining_role.role='founder'
       AND remaining_role.status='active'
       AND remaining_role.id IS DISTINCT FROM OLD.id;
    IF active_count=0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'access_role_bindings_last_founder_check',
        MESSAGE = 'organization must retain an active founder';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS access_role_bindings_validate_write ON access_role_bindings;
CREATE TRIGGER access_role_bindings_validate_write
BEFORE INSERT OR UPDATE ON access_role_bindings
FOR EACH ROW EXECUTE FUNCTION access_validate_role_binding_write();
