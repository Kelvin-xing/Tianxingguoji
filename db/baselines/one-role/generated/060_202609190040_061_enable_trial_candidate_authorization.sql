-- BR-015: the legacy command roles below name operations, never substitute employee grades.
-- advisor means classified case maintenance; founder means approval/closure.
CREATE OR REPLACE FUNCTION cases_actor_has_active_case_role(
  target_case_id uuid, required_role text, require_primary_advisor boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  tenant_id uuid := nullif(current_setting('app.organization_id',true),'')::uuid;
  actor_id uuid := nullif(current_setting('app.actor_user_id',true),'')::uuid;
  category text;
  permission boolean;
  member_level text;
BEGIN
  IF required_role IS NULL OR required_role NOT IN ('advisor','founder')
    OR require_primary_advisor IS NULL THEN RETURN false; END IF;
  SELECT business_category INTO category FROM public.cases_service_cases
    WHERE id=target_case_id AND organization_id=tenant_id;
  IF NOT FOUND THEN RETURN false; END IF;
  permission := public.cases_trial_member_can_manage(tenant_id,actor_id,category,NULL);
  IF permission IS NOT NULL THEN
    IF permission IS NOT TRUE THEN RETURN false; END IF;
    -- The preceding function holds the member and active-role locks until commit.
    SELECT level INTO member_level FROM public.access_trial_members
      WHERE organization_id=tenant_id AND user_id=actor_id;
    RETURN required_role='advisor' OR member_level IN ('founder','l1');
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.cases_service_cases AS service_case
      JOIN public.access_role_bindings AS role_binding
        ON role_binding.organization_id = service_case.organization_id
       AND role_binding.user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid
       AND role_binding.role = required_role AND role_binding.status = 'active'
      JOIN public.access_organization_memberships AS membership
        ON membership.id = role_binding.membership_id
       AND membership.organization_id = role_binding.organization_id
       AND membership.user_id = role_binding.user_id AND membership.status = 'active'
      JOIN public.identity_users AS identity_user
        ON identity_user.id = role_binding.user_id AND identity_user.status = 'active'
      JOIN public.access_organizations AS organization
        ON organization.id = role_binding.organization_id AND organization.status = 'active'
     WHERE service_case.id = target_case_id
       AND service_case.organization_id::text = current_setting('app.organization_id', true)
       AND (NOT require_primary_advisor OR (
         required_role = 'advisor' AND service_case.primary_user_id = role_binding.user_id
         AND service_case.primary_role_binding_id = role_binding.id))
  );
END;
$$;
REVOKE ALL ON FUNCTION cases_actor_has_active_case_role(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases_actor_has_active_case_role(uuid,text,boolean) TO tianxing_app;
