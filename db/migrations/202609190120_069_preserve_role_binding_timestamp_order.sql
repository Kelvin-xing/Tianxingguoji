-- Preserve role-binding chronology when a transaction predates a visible row.
-- Retain all identity, status, employee profile and last-Founder checks.
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
    NEW.updated_at := GREATEST(transaction_timestamp(), OLD.updated_at, OLD.created_at);
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
