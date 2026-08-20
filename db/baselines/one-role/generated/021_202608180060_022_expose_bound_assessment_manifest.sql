CREATE FUNCTION cases_read_bound_assessment_manifest(target_manifest_id uuid)
RETURNS TABLE (
  id uuid,
  status text,
  application_type text,
  composition_version text,
  base_module_id text,
  base_module_version text,
  education_stage_module_id text,
  education_stage_module_version text,
  school_system_module_id text,
  school_system_module_version text,
  admission_route_module_id text,
  admission_route_module_version text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT manifest.id, manifest.status, manifest.application_type,
         manifest.composition_version,
         manifest.base_module_id, manifest.base_module_version,
         manifest.education_stage_module_id, manifest.education_stage_module_version,
         manifest.school_system_module_id, manifest.school_system_module_version,
         manifest.admission_route_module_id, manifest.admission_route_module_version
    FROM public.cases_schema_manifests AS manifest
   WHERE manifest.id = target_manifest_id
     AND EXISTS (
       SELECT 1
         FROM public.cases_assessments AS assessment
        WHERE assessment.manifest_id = manifest.id
          AND assessment.organization_id::text =
              pg_catalog.current_setting('app.organization_id', true)
     )
$$;

CREATE FUNCTION cases_read_bound_assessment_manifest_fields(target_manifest_id uuid)
RETURNS TABLE (
  module_layer text,
  module_id text,
  module_version text,
  field_id text,
  value_type text,
  visibility text,
  blocking_stages jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT field.module_layer, field.module_id, field.module_version,
         field.field_id, field.value_type, field.visibility, field.blocking_stages
    FROM public.cases_schema_manifest_fields AS field
   WHERE field.manifest_id = target_manifest_id
     AND EXISTS (
       SELECT 1
         FROM public.cases_assessments AS assessment
        WHERE assessment.manifest_id = field.manifest_id
          AND assessment.organization_id::text =
              pg_catalog.current_setting('app.organization_id', true)
     )
   ORDER BY field.module_layer, field.field_id
$$;

REVOKE ALL ON FUNCTION cases_read_bound_assessment_manifest(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_read_bound_assessment_manifest_fields(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases_read_bound_assessment_manifest(uuid) TO tianxing_app;
GRANT EXECUTE ON FUNCTION cases_read_bound_assessment_manifest_fields(uuid) TO tianxing_app;

CREATE FUNCTION cases_validate_assessment_runtime_blockers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  blocker_stage text;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'background_complete' THEN
    blocker_stage := 'background_complete';
  ELSIF OLD.status = 'background_complete' AND NEW.status = 'selection_ready' THEN
    blocker_stage := 'selection_ready';
  ELSE
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.cases_schema_manifest_fields AS field
      LEFT JOIN public.cases_assessment_answers AS answer
        ON answer.assessment_id = NEW.id
       AND answer.organization_id = NEW.organization_id
       AND answer.manifest_id = NEW.manifest_id
       AND answer.field_id = field.field_id
     WHERE field.manifest_id = NEW.manifest_id
       AND field.blocking_stages ? blocker_stage
       AND answer.id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessments_runtime_blockers_incomplete_check',
      MESSAGE = 'assessment runtime blocking fields are incomplete';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_assessments_runtime_blockers_trg
BEFORE UPDATE ON cases_assessments
FOR EACH ROW EXECUTE FUNCTION cases_validate_assessment_runtime_blockers();

REVOKE ALL ON FUNCTION cases_validate_assessment_runtime_blockers() FROM PUBLIC;
ALTER FUNCTION cases_validate_assessment_write() SECURITY DEFINER;
ALTER FUNCTION cases_validate_assessment_write() SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION cases_validate_assessment_write() FROM PUBLIC;
