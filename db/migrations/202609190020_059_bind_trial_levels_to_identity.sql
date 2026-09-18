-- BR-015: actual trial levels are roles; no impersonated Founder/Advisor grants.
ALTER TABLE access_role_bindings DROP CONSTRAINT access_role_bindings_role_check;
ALTER TABLE access_role_bindings ADD CONSTRAINT access_role_bindings_role_check
  CHECK (role IN ('founder','admin','advisor','contractor','data_reviewer','l1','l2','l3'));
ALTER TABLE access_role_bindings DROP CONSTRAINT access_role_bindings_active_role_vocabulary_check;
ALTER TABLE access_role_bindings ADD CONSTRAINT access_role_bindings_active_role_vocabulary_check
  CHECK (status <> 'active' OR role IN ('founder','admin','advisor','contractor','l1','l2','l3'));

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

  IF NOT EXISTS (SELECT 1 FROM access_trial_members t WHERE t.membership_id=NEW.membership_id)
     AND ((NEW.employment_type='FULL_TIME' AND COALESCE(has_contractor,false))
     OR (NEW.employment_type='PART_TIME' AND COALESCE(has_full_time_role,false))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'access_employee_profiles_employment_type_roles_check',
      MESSAGE = 'employee profile employment type conflicts with active roles';
  END IF;
  RETURN NEW;
END;
$$;


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
    IF NEW.role NOT IN ('founder','admin','advisor','contractor','l1','l2','l3') THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'access_role_bindings_active_role_vocabulary_check',
        MESSAGE = 'unknown active release role';
    END IF;
    SELECT count(*) FILTER (WHERE status='active'),
           bool_or(status='active' AND role IN ('contractor','l1','l2','l3'))
      INTO active_count,existing_contractor
      FROM access_role_bindings
     WHERE membership_id=NEW.membership_id
       AND organization_id=NEW.organization_id
       AND user_id=NEW.user_id
       AND id IS DISTINCT FROM NEW.id;
    IF (NEW.role IN ('contractor','l1','l2','l3') AND active_count>0)
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
       OR (employment='PART_TIME' AND NEW.role IN ('founder','advisor')
         AND NOT EXISTS (SELECT 1 FROM access_trial_members t WHERE t.membership_id=NEW.membership_id)) THEN
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


CREATE OR REPLACE FUNCTION access_resolve_workspace_context(p_user_id uuid, p_organization_id uuid, p_membership_id uuid)
RETURNS TABLE (user_id uuid, organization_id uuid, membership_id uuid, role_binding_id uuid, role text,
  membership_record_version bigint, role_binding_record_version bigint)
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT m.user_id, m.organization_id, m.id, rb.id, rb.role, m.record_version, rb.record_version
    FROM identity_users u
    JOIN access_organization_memberships m ON m.user_id=u.id AND m.organization_id=p_organization_id
      AND m.id=p_membership_id AND m.status='active'
    JOIN access_organizations o ON o.id=m.organization_id AND o.status='active'
    JOIN access_role_bindings rb ON rb.organization_id=m.organization_id AND rb.membership_id=m.id
      AND rb.user_id=m.user_id AND rb.status='active'
      AND rb.role IN ('founder','admin','advisor','contractor','l1','l2','l3')
   WHERE u.id=p_user_id AND u.status='active'
   ORDER BY rb.id;
$$;
REVOKE ALL ON FUNCTION access_resolve_workspace_context(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access_resolve_workspace_context(uuid, uuid, uuid) TO tianxing_app;

-- A membership may transition in either statement order, but never commit a mixed authority.
CREATE FUNCTION access_check_trial_role_consistency() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  target_membership uuid := NEW.membership_id;
  trial_level text;
  active_roles text[];
BEGIN
  SELECT level INTO trial_level FROM access_trial_members WHERE membership_id=target_membership;
  SELECT array_agg(role ORDER BY role) INTO active_roles FROM access_role_bindings
    WHERE membership_id=target_membership AND status='active';
  IF trial_level IS NOT NULL THEN
    IF active_roles IS DISTINCT FROM ARRAY[trial_level] THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='access_trial_role_consistency_check',
        MESSAGE='trial member must have exactly the matching active role';
    END IF;
  ELSIF active_roles && ARRAY['l1','l2','l3'] THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='access_trial_role_consistency_check',
      MESSAGE='trial role requires explicit enrollment';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER access_trial_role_consistency_member
  AFTER INSERT OR UPDATE ON access_trial_members DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION access_check_trial_role_consistency();
CREATE CONSTRAINT TRIGGER access_trial_role_consistency_binding
  AFTER INSERT OR UPDATE ON access_role_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION access_check_trial_role_consistency();

GRANT INSERT, UPDATE ON access_trial_members TO tianxing_app;
