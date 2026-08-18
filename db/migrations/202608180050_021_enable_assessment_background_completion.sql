CREATE OR REPLACE FUNCTION cases_validate_assessment_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  manifest_status text;
  blocker_stage text;
BEGIN
  SELECT status INTO manifest_status
    FROM cases_schema_manifests
   WHERE id = NEW.manifest_id
   FOR SHARE;

  IF TG_OP = 'INSERT' THEN
    IF manifest_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_assessments_manifest_approved_check',
        MESSAGE = 'assessment requires an approved manifest';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.service_case_id IS DISTINCT FROM OLD.service_case_id
     OR NEW.manifest_id IS DISTINCT FROM OLD.manifest_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessments_identity_immutable_check',
      MESSAGE = 'assessment identity is immutable';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessments_record_version_transition_check',
      MESSAGE = 'record_version must increase exactly once';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessments_timestamps_check',
      MESSAGE = 'updated_at cannot move backward';
  END IF;
  IF manifest_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessments_manifest_approved_check',
      MESSAGE = 'assessment transition requires an approved manifest';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'background_complete' THEN
    blocker_stage := 'background_collection';
  ELSIF OLD.status = 'background_complete' AND NEW.status = 'selection_ready' THEN
    blocker_stage := 'school_selection_confirmed';
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessments_status_transition_check',
      MESSAGE = 'assessment status transition is not approved';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM cases_schema_manifest_fields AS field
      LEFT JOIN cases_assessment_answers AS answer
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
      CONSTRAINT = 'cases_assessments_blockers_incomplete_check',
      MESSAGE = 'assessment blocking fields are incomplete';
  END IF;

  RETURN NEW;
END;
$$;
