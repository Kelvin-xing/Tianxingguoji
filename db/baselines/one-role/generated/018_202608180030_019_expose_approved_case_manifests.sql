CREATE FUNCTION cases_list_approved_manifests()
RETURNS TABLE (id uuid, composition_version text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT manifest.id, manifest.composition_version
    FROM public.cases_schema_manifests AS manifest
   WHERE manifest.application_type = 'k12'
     AND manifest.status = 'approved'
   ORDER BY manifest.composition_version, manifest.id
$$;

REVOKE ALL ON FUNCTION cases_list_approved_manifests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases_list_approved_manifests() TO tianxing_app;
