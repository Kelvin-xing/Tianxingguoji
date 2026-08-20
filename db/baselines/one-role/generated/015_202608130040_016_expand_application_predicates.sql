CREATE FUNCTION identity_user_is_active(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.identity_users
     WHERE id = target_user_id AND status = 'active'
  )
$$;

CREATE FUNCTION cases_manifest_is_approved(target_manifest_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.cases_schema_manifests
     WHERE id = target_manifest_id
       AND application_type = 'k12'
       AND status = 'approved'
  )
$$;

CREATE FUNCTION access_organization_is_active(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.access_organizations
     WHERE id = target_organization_id AND status = 'active'
  )
$$;

REVOKE ALL ON FUNCTION identity_user_is_active(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_manifest_is_approved(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION access_organization_is_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_user_is_active(uuid) TO tianxing_app;
GRANT EXECUTE ON FUNCTION cases_manifest_is_approved(uuid) TO tianxing_app;
GRANT EXECUTE ON FUNCTION access_organization_is_active(uuid) TO tianxing_app;

ALTER FUNCTION cases_validate_service_case_write() SECURITY DEFINER;
ALTER FUNCTION cases_validate_service_case_write() SET search_path = pg_catalog, public;
ALTER FUNCTION cases_validate_assessment_write() SECURITY DEFINER;
ALTER FUNCTION cases_validate_assessment_write() SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION cases_validate_service_case_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_validate_assessment_write() FROM PUBLIC;
