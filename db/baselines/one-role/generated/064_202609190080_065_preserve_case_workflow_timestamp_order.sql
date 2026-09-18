-- Preserve monotonic Case timestamps when workflow actions follow SQL transitions.
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

  -- JS clocks have millisecond precision; prior SQL transitions may have microseconds.
  action_time := GREATEST(action_time,service_case.updated_at);

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
