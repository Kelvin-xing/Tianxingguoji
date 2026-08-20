CREATE FUNCTION cases_create_candidate_school_target(
  p_case_id uuid,
  p_target_id uuid,
  p_school_id uuid,
  p_resolved_revision_id uuid,
  p_expected_resolution_sha256 text,
  p_created_at timestamptz
)
RETURNS TABLE (
  decision text,
  target_id uuid,
  school_id uuid,
  intake_year integer,
  admission_type text,
  state text,
  record_version bigint,
  resolved_revision_id uuid,
  resolution_sha256 text,
  created_at timestamptz
)
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
  role_binding_status text;
  membership_status text;
  organization_status text;
  user_status text;
  stored_resolution_sha256 text;
BEGIN
  IF tenant_setting IS NULL OR actor_setting IS NULL
     OR tenant_setting !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
     OR actor_setting !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
    RETURN QUERY SELECT 'SCHOOL_TARGET_CASE_NOT_FOUND'::text,
      NULL::uuid, NULL::uuid, NULL::integer, NULL::text, NULL::text,
      NULL::bigint, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  tenant_id := tenant_setting::uuid;
  actor_id := actor_setting::uuid;

  SELECT candidate.*
    INTO service_case
    FROM public.cases_service_cases AS candidate
   WHERE candidate.id = p_case_id
     AND candidate.organization_id = tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'SCHOOL_TARGET_CASE_NOT_FOUND'::text,
      NULL::uuid, NULL::uuid, NULL::integer, NULL::text, NULL::text,
      NULL::bigint, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

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
   WHERE role_binding.id = service_case.primary_role_binding_id
     AND role_binding.organization_id = tenant_id
     AND role_binding.membership_id = service_case.primary_membership_id
     AND role_binding.user_id = actor_id
     AND role_binding.role = 'advisor'
     AND service_case.primary_user_id = actor_id
     AND service_case.primary_role = 'advisor'
   FOR SHARE OF role_binding, membership, organization, identity_user;
  IF role_binding_status IS DISTINCT FROM 'active'
     OR membership_status IS DISTINCT FROM 'active'
     OR organization_status IS DISTINCT FROM 'active'
     OR user_status IS DISTINCT FROM 'active' THEN
    RETURN QUERY SELECT 'SCHOOL_TARGET_CASE_NOT_FOUND'::text,
      NULL::uuid, NULL::uuid, NULL::integer, NULL::text, NULL::text,
      NULL::bigint, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF service_case.stage <> 'background_collection' THEN
    RETURN QUERY SELECT 'SCHOOL_TARGET_STAGE_NOT_ALLOWED'::text,
      NULL::uuid, NULL::uuid, service_case.intake_year, service_case.admission_type,
      NULL::text, NULL::bigint, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_created_at < transaction_timestamp() - interval '5 minutes'
     OR p_created_at > transaction_timestamp() + interval '5 minutes' THEN
    RETURN QUERY SELECT 'SCHOOL_TARGET_RESOLUTION_INVALID'::text,
      NULL::uuid, NULL::uuid, service_case.intake_year, service_case.admission_type,
      NULL::text, NULL::bigint, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT revision.resolution_sha256::text
    INTO stored_resolution_sha256
    FROM public.schools_resolved_revisions AS revision
   WHERE revision.id = p_resolved_revision_id
     AND revision.organization_id = tenant_id
     AND revision.school_id = p_school_id
   FOR SHARE;
  IF stored_resolution_sha256 IS NULL
     OR stored_resolution_sha256 IS DISTINCT FROM p_expected_resolution_sha256 THEN
    RETURN QUERY SELECT 'SCHOOL_TARGET_RESOLUTION_NOT_FOUND'::text,
      NULL::uuid, NULL::uuid, service_case.intake_year, service_case.admission_type,
      NULL::text, NULL::bigint, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.cases_school_targets AS existing
     WHERE existing.organization_id = tenant_id
       AND existing.service_case_id = service_case.id
       AND existing.school_id = p_school_id
       AND existing.intake_year = service_case.intake_year
       AND existing.admission_type = service_case.admission_type
  ) THEN
    RETURN QUERY SELECT 'SCHOOL_TARGET_DUPLICATE'::text,
      NULL::uuid, p_school_id, service_case.intake_year, service_case.admission_type,
      NULL::text, NULL::bigint, p_resolved_revision_id,
      stored_resolution_sha256, NULL::timestamptz;
    RETURN;
  END IF;

  INSERT INTO public.cases_school_targets
    (id, organization_id, service_case_id, school_id, intake_year, admission_type,
     state, pinned_resolved_revision_id, pinned_resolution_sha256,
     record_version, created_at, updated_at)
  VALUES
    (p_target_id, tenant_id, service_case.id, p_school_id, service_case.intake_year,
     service_case.admission_type, 'candidate', p_resolved_revision_id,
     stored_resolution_sha256, 1, p_created_at, p_created_at);

  RETURN QUERY
  SELECT 'allowed'::text, target.id, target.school_id, target.intake_year,
         target.admission_type, target.state, target.record_version,
         target.pinned_resolved_revision_id, target.pinned_resolution_sha256::text,
         target.created_at
    FROM public.cases_school_targets AS target
   WHERE target.id = p_target_id
     AND target.organization_id = tenant_id;
END;
$$;

REVOKE INSERT ON TABLE cases_school_targets FROM tianxing_app;
REVOKE ALL ON FUNCTION cases_create_candidate_school_target(
  uuid, uuid, uuid, uuid, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases_create_candidate_school_target(
  uuid, uuid, uuid, uuid, text, timestamptz
) TO tianxing_app;
