-- BR-015: explicit K12 case scope, without converting historical employees or cases.
ALTER TABLE cases_service_cases DROP CONSTRAINT cases_service_cases_primary_role_check;
ALTER TABLE cases_service_cases ADD CONSTRAINT cases_service_cases_primary_role_check
  CHECK (primary_role IN ('advisor','founder','l1','l2'));
ALTER TABLE cases_primary_advisor_assignments DROP CONSTRAINT cases_primary_advisor_assignments_role_check;
ALTER TABLE cases_primary_advisor_assignments ADD CONSTRAINT cases_primary_advisor_assignments_role_check
  CHECK (advisor_role IN ('advisor','founder','l1','l2'));

-- NULL means never enrolled; false means enrolled but unauthorized and forbids legacy fallback.
CREATE FUNCTION cases_trial_member_can_manage(
  target_organization_id uuid, target_user_id uuid, target_category text, claimed_role text
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE
  member_level text;
  member_categories text[];
  member_active boolean;
BEGIN
  IF target_organization_id::text IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'') THEN
    RETURN false;
  END IF;
  SELECT t.level,t.categories,
    (t.status='active' AND m.status='active' AND u.status='active' AND o.status='active')
    INTO member_level,member_categories,member_active
    FROM public.access_trial_members t
    JOIN public.access_organization_memberships m ON m.id=t.membership_id AND m.organization_id=t.organization_id
    JOIN public.identity_users u ON u.id=t.user_id
    JOIN public.access_organizations o ON o.id=t.organization_id
    WHERE t.organization_id=target_organization_id AND t.user_id=target_user_id
    FOR SHARE OF t,m,u,o;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT member_active OR member_level NOT IN ('founder','l1','l2')
    OR target_category IS NULL OR target_category NOT IN ('international_school','local_school')
    OR (claimed_role IS NOT NULL AND claimed_role <> member_level)
    OR (member_level='l2' AND NOT target_category=ANY(member_categories)) THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.access_role_bindings r
    WHERE r.organization_id=target_organization_id AND r.user_id=target_user_id
      AND r.status='active' AND r.role=member_level FOR SHARE;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION cases_trial_member_can_manage(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases_trial_member_can_manage(uuid,uuid,text,text) TO tianxing_app;


CREATE OR REPLACE FUNCTION cases_validate_service_case_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  student_status text;
  organization_status text;
  membership_status text;
  user_status text;
  role_binding_status text;
  trial_permission boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    trial_permission := public.cases_trial_member_can_manage(NEW.organization_id,
      nullif(current_setting('app.actor_user_id',true),'')::uuid,NEW.business_category,NULL);
    IF trial_permission IS FALSE THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='trial case creation is outside current scope';
    END IF;
    IF NEW.stage IS DISTINCT FROM 'signed' 
       OR NEW.workflow_status IS DISTINCT FROM 'active'
       OR NEW.record_version <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_service_cases_initial_state_check',
        MESSAGE = 'ServiceCase must start at signed/active version 1';
    END IF;

    SELECT student.status
      INTO student_status
      FROM public.crm_students AS student
     WHERE student.id = NEW.student_id
       AND student.organization_id = NEW.organization_id
     FOR SHARE;

    SELECT role_binding.status, membership.status, organization.status, identity_user.status
      INTO role_binding_status, membership_status, organization_status, user_status
      FROM public.access_role_bindings AS role_binding
      JOIN public.access_organization_memberships AS membership
        ON membership.id = role_binding.membership_id
       AND membership.organization_id = role_binding.organization_id
       AND membership.user_id = role_binding.user_id
      JOIN public.access_organizations AS organization
        ON organization.id = role_binding.organization_id
      JOIN public.identity_users AS identity_user
        ON identity_user.id = role_binding.user_id
     WHERE role_binding.id = NEW.primary_role_binding_id
       AND role_binding.organization_id = NEW.organization_id
       AND role_binding.membership_id = NEW.primary_membership_id
       AND role_binding.user_id = NEW.primary_user_id
       AND role_binding.role = NEW.primary_role
     FOR SHARE OF role_binding, membership, organization, identity_user;

    IF (NEW.primary_role IS DISTINCT FROM 'advisor' AND
        public.cases_trial_member_can_manage(NEW.organization_id,NEW.primary_user_id,
          NEW.business_category,NEW.primary_role) IS DISTINCT FROM true)
       OR student_status IS DISTINCT FROM 'active'
       OR organization_status IS DISTINCT FROM 'active'
       OR membership_status IS DISTINCT FROM 'active'
       OR user_status IS DISTINCT FROM 'active'
       OR role_binding_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_service_cases_active_principal_check',
        MESSAGE = 'ServiceCase requires active tenant principals';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.case_number IS DISTINCT FROM OLD.case_number
     OR NEW.business_category IS DISTINCT FROM OLD.business_category
     OR NEW.application_type IS DISTINCT FROM OLD.application_type
     OR NEW.intake_year IS DISTINCT FROM OLD.intake_year
     OR NEW.admission_type IS DISTINCT FROM OLD.admission_type
     OR NEW.primary_role_binding_id IS DISTINCT FROM OLD.primary_role_binding_id
     OR NEW.primary_membership_id IS DISTINCT FROM OLD.primary_membership_id
     OR NEW.primary_user_id IS DISTINCT FROM OLD.primary_user_id
     OR NEW.primary_role IS DISTINCT FROM OLD.primary_role
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_cases_identity_immutable_check',
      MESSAGE = 'ServiceCase identity is immutable';
  END IF;
  IF NEW.stage IS DISTINCT FROM OLD.stage
     AND current_setting('app.case_stage_transition', true) IS DISTINCT FROM 'authorized' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_cases_stage_transition_boundary_check',
      MESSAGE = 'ServiceCase stage can only change through an authorized command';
  END IF;
  IF NEW.workflow_status IS DISTINCT FROM OLD.workflow_status
     AND current_setting('app.case_workflow_action', true) IS DISTINCT FROM 'authorized' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_cases_workflow_action_boundary_check',
      MESSAGE = 'ServiceCase workflow status can only change through an authorized command';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_cases_record_version_transition_check',
      MESSAGE = 'record_version must increase exactly once';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_cases_timestamps_check',
      MESSAGE = 'updated_at cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION cases_advance_new_service_case(
  target_case_id uuid,
  actor_role text,
  transition_fact_id uuid,
  transition_time timestamptz
)
RETURNS TABLE (decision text, result_stage text, result_record_version bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tenant_setting text := nullif(current_setting('app.organization_id', true), '');
  actor_setting text := nullif(current_setting('app.actor_user_id', true), '');
  tenant_id uuid;
  actor_id uuid;
  service_case public.cases_service_cases%ROWTYPE;
  actor_is_active boolean := false;
BEGIN
  IF tenant_setting IS NULL OR actor_setting IS NULL THEN
    RETURN QUERY SELECT 'CASE_WORKSPACE_NOT_FOUND'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  tenant_id := tenant_setting::uuid;
  actor_id := actor_setting::uuid;

  SELECT candidate.*
    INTO service_case
    FROM public.cases_service_cases AS candidate
   WHERE candidate.id = target_case_id
     AND candidate.organization_id = tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'CASE_WORKSPACE_NOT_FOUND'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  actor_is_active := public.cases_trial_member_can_manage(
    tenant_id,actor_id,service_case.business_category,actor_role);
  IF actor_is_active IS NULL THEN
  PERFORM 1
    FROM public.access_role_bindings AS role_binding
      JOIN public.access_organization_memberships AS membership
        ON membership.id = role_binding.membership_id
       AND membership.organization_id = role_binding.organization_id
       AND membership.user_id = role_binding.user_id
      JOIN public.access_organizations AS organization
        ON organization.id = role_binding.organization_id
      JOIN public.identity_users AS identity_user
        ON identity_user.id = role_binding.user_id
     WHERE role_binding.organization_id = tenant_id
       AND role_binding.user_id = actor_id
       AND role_binding.role = actor_role
       AND role_binding.status = 'active'
       AND membership.status = 'active'
       AND organization.status = 'active'
       AND identity_user.status = 'active'
       AND actor_role IN ('founder', 'advisor')
       AND (
         actor_role = 'founder'
         OR (
           service_case.primary_user_id = actor_id
           AND service_case.primary_role = 'advisor'
           AND service_case.primary_role_binding_id = role_binding.id
         )
       )
   FOR SHARE OF role_binding, membership, organization, identity_user;
  actor_is_active := FOUND;
  END IF;
  IF NOT actor_is_active THEN
    RETURN QUERY SELECT 'CASE_WORKSPACE_NOT_FOUND'::text,
                        service_case.stage, service_case.record_version;
    RETURN;
  END IF;
  IF service_case.stage <> 'signed'
     OR service_case.workflow_status <> 'active'
     OR service_case.record_version <> 1 THEN
    RETURN QUERY SELECT 'CASE_WORKSPACE_CONFLICT'::text,
                        service_case.stage, service_case.record_version;
    RETURN;
  END IF;

  INSERT INTO public.cases_service_case_transition_facts
    (id, organization_id, service_case_id, actor_user_id, from_stage, to_stage,
     from_record_version, to_record_version, reason, transitioned_at, created_at)
  VALUES
    (transition_fact_id, tenant_id, service_case.id, actor_id, 'signed',
     'background_collection', 1, 2, NULL, transition_time, transition_time);

  PERFORM set_config('app.case_stage_transition', 'authorized', true);
  UPDATE public.cases_service_cases
     SET stage = 'background_collection', workflow_status = 'active',
         record_version = 2, updated_at = transition_time
   WHERE id = service_case.id
     AND organization_id = tenant_id;

  RETURN QUERY SELECT 'allowed'::text, 'background_collection'::text, 2::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION cases_apply_service_case_workflow_action(
  target_case_id uuid,
  expected_record_version bigint,
  requested_action text,
  actor_role text,
  action_reason text,
  lifecycle_fact_id uuid,
  action_time timestamptz
)
RETURNS TABLE (decision text, result_status text, result_record_version bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tenant_setting text := nullif(current_setting('app.organization_id', true), '');
  actor_setting text := nullif(current_setting('app.actor_user_id', true), '');
  tenant_id uuid;
  actor_id uuid;
  service_case public.cases_service_cases%ROWTYPE;
  actor_is_active boolean := false;
  next_status text;
BEGIN
  IF tenant_setting IS NULL OR actor_setting IS NULL THEN
    RETURN QUERY SELECT 'CASE_WORKFLOW_CASE_NOT_FOUND'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  tenant_id := tenant_setting::uuid;
  actor_id := actor_setting::uuid;

  SELECT candidate.*
    INTO service_case
    FROM public.cases_service_cases AS candidate
   WHERE candidate.id = target_case_id
     AND candidate.organization_id = tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'CASE_WORKFLOW_CASE_NOT_FOUND'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  PERFORM 1
    FROM public.crm_students AS student
   WHERE student.id = service_case.student_id
     AND student.organization_id = tenant_id
     AND student.status = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'CASE_WORKFLOW_CASE_NOT_FOUND'::text,
                        service_case.workflow_status, service_case.record_version;
    RETURN;
  END IF;

  PERFORM 1
    FROM public.cases_school_targets AS target
   WHERE target.service_case_id = service_case.id
     AND target.organization_id = tenant_id
   ORDER BY target.id
   FOR UPDATE;

  actor_is_active := public.cases_trial_member_can_manage(
    tenant_id,actor_id,service_case.business_category,actor_role);
  IF actor_is_active IS NULL THEN
  PERFORM 1
    FROM public.access_role_bindings AS role_binding
      JOIN public.access_organization_memberships AS membership
        ON membership.id = role_binding.membership_id
       AND membership.organization_id = role_binding.organization_id
       AND membership.user_id = role_binding.user_id
      JOIN public.access_organizations AS organization
        ON organization.id = role_binding.organization_id
      JOIN public.identity_users AS identity_user
        ON identity_user.id = role_binding.user_id
     WHERE role_binding.organization_id = tenant_id
       AND role_binding.user_id = actor_id
       AND role_binding.role = actor_role
       AND role_binding.status = 'active'
       AND membership.status = 'active'
       AND organization.status = 'active'
       AND identity_user.status = 'active'
       AND actor_role IN ('founder', 'advisor')
       AND (
         actor_role = 'founder'
         OR (
           service_case.primary_user_id = actor_id
           AND service_case.primary_role = 'advisor'
           AND service_case.primary_role_binding_id = role_binding.id
         )
       )
   FOR SHARE OF role_binding, membership, organization, identity_user;
  actor_is_active := FOUND;
  END IF;
  IF NOT actor_is_active THEN
    RETURN QUERY SELECT 'CASE_WORKFLOW_CASE_NOT_FOUND'::text,
                        service_case.workflow_status, service_case.record_version;
    RETURN;
  END IF;

  IF service_case.record_version <> expected_record_version THEN
    RETURN QUERY SELECT 'CASE_WORKFLOW_STALE_VERSION'::text,
                        service_case.workflow_status, service_case.record_version;
    RETURN;
  END IF;
  IF requested_action = 'pause' THEN
    IF action_reason IS NULL OR btrim(action_reason) = '' OR char_length(action_reason) > 1000 THEN
      RETURN QUERY SELECT 'CASE_WORKFLOW_INVALID'::text,
                          service_case.workflow_status, service_case.record_version;
      RETURN;
    END IF;
    IF service_case.workflow_status <> 'active'
       OR service_case.stage IN ('signed', 'closed') THEN
      RETURN QUERY SELECT 'CASE_WORKFLOW_CONFLICT'::text,
                          service_case.workflow_status, service_case.record_version;
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.cases_school_targets AS target
       WHERE target.service_case_id = service_case.id
         AND target.organization_id = tenant_id
         AND target.state IN (
           'submitted', 'interview', 'waitlisted', 'accepted',
           'offer_confirmed', 'offer_declined', 'rejected'
         )
    ) THEN
      RETURN QUERY SELECT 'CASE_WORKFLOW_SUBMITTED_TARGET_EXISTS'::text,
                          service_case.workflow_status, service_case.record_version;
      RETURN;
    END IF;
    next_status := 'paused';
  ELSIF requested_action = 'resume' THEN
    IF action_reason IS NOT NULL THEN
      RETURN QUERY SELECT 'CASE_WORKFLOW_INVALID'::text,
                          service_case.workflow_status, service_case.record_version;
      RETURN;
    END IF;
    IF service_case.workflow_status <> 'paused' OR service_case.stage = 'closed' THEN
      RETURN QUERY SELECT 'CASE_WORKFLOW_CONFLICT'::text,
                          service_case.workflow_status, service_case.record_version;
      RETURN;
    END IF;
    next_status := 'active';
  ELSE
    RETURN QUERY SELECT 'CASE_WORKFLOW_INVALID'::text,
                        service_case.workflow_status, service_case.record_version;
    RETURN;
  END IF;

  INSERT INTO public.cases_service_case_lifecycle_facts
    (id, organization_id, service_case_id, actor_user_id, action, from_status,
     to_status, from_record_version, to_record_version, reason, occurred_at, created_at)
  VALUES
    (lifecycle_fact_id, tenant_id, service_case.id, actor_id, requested_action,
     service_case.workflow_status, next_status, service_case.record_version,
     service_case.record_version + 1,
     CASE WHEN action_reason IS NULL THEN NULL ELSE btrim(action_reason) END,
     action_time, action_time);

  PERFORM set_config('app.case_workflow_action', 'authorized', true);
  UPDATE public.cases_service_cases
     SET workflow_status = next_status,
         record_version = record_version + 1,
         updated_at = action_time
   WHERE id = service_case.id
     AND organization_id = tenant_id;

  RETURN QUERY SELECT 'allowed'::text, next_status, service_case.record_version + 1;
END;
$$;
