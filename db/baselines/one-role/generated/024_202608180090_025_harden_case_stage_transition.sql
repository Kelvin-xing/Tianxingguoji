ALTER TABLE cases_service_case_transition_facts
  ADD CONSTRAINT cases_service_case_transition_facts_reason_length_check
  CHECK (reason IS NULL OR char_length(reason) <= 4000);

CREATE FUNCTION cases_validate_service_case_transition_fact_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.transitioned_at < transaction_timestamp() - interval '5 minutes'
     OR NEW.transitioned_at > transaction_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_case_transition_facts_time_boundary_check',
      MESSAGE = 'ServiceCase transition time is outside the accepted transaction window';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_service_case_transition_facts_insert_guard_trg
BEFORE INSERT ON cases_service_case_transition_facts
FOR EACH ROW EXECUTE FUNCTION cases_validate_service_case_transition_fact_insert();

CREATE FUNCTION cases_validate_service_case_stage_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_setting text := nullif(current_setting('app.actor_user_id', true), '');
  actor_id uuid;
  role_binding_status text;
  membership_status text;
  organization_status text;
  user_status text;
  assessment_status text;
  manifest_status text;
  assessment_id uuid;
  manifest_id uuid;
BEGIN
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    RETURN NEW;
  END IF;
  IF actor_setting IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_cases_stage_actor_check',
      MESSAGE = 'ServiceCase stage transition requires an actor';
  END IF;
  actor_id := actor_setting::uuid;

  IF OLD.stage = 'signed' AND NEW.stage = 'background_collection' THEN
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
       AND role_binding.user_id = actor_id
       AND role_binding.role = NEW.primary_role
       AND role_binding.role IN ('advisor', 'founder')
     FOR SHARE OF role_binding, membership, organization, identity_user;

    IF role_binding_status IS DISTINCT FROM 'active'
       OR membership_status IS DISTINCT FROM 'active'
       OR organization_status IS DISTINCT FROM 'active'
       OR user_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_service_cases_stage_primary_actor_check',
        MESSAGE = 'ServiceCase forward transition requires the active Primary actor';
    END IF;

    SELECT assessment.id, assessment.manifest_id, assessment.status, manifest.status
      INTO assessment_id, manifest_id, assessment_status, manifest_status
      FROM public.cases_assessments AS assessment
      JOIN public.cases_schema_manifests AS manifest
        ON manifest.id = assessment.manifest_id
     WHERE assessment.service_case_id = NEW.id
       AND assessment.organization_id = NEW.organization_id
     FOR SHARE OF assessment, manifest;

    IF assessment_status IS DISTINCT FROM 'background_complete'
       OR manifest_status IS DISTINCT FROM 'approved'
       OR EXISTS (
         SELECT 1
           FROM public.cases_schema_manifest_fields AS field
           LEFT JOIN public.cases_assessment_answers AS answer
             ON answer.assessment_id = assessment_id
            AND answer.organization_id = NEW.organization_id
            AND answer.manifest_id = manifest_id
            AND answer.field_id = field.field_id
          WHERE field.manifest_id = manifest_id
            AND field.blocking_stages ? 'background_complete'
            AND answer.id IS NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_service_cases_stage_assessment_check',
        MESSAGE = 'ServiceCase forward transition requires completed assessment evidence';
    END IF;
  ELSIF OLD.stage = 'background_collection' AND NEW.stage = 'signed' THEN
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
     WHERE role_binding.organization_id = NEW.organization_id
       AND role_binding.user_id = actor_id
       AND role_binding.role = 'founder'
     ORDER BY role_binding.id
     LIMIT 1
     FOR SHARE OF role_binding, membership, organization, identity_user;

    IF role_binding_status IS DISTINCT FROM 'active'
       OR membership_status IS DISTINCT FROM 'active'
       OR organization_status IS DISTINCT FROM 'active'
       OR user_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_service_cases_stage_founder_check',
        MESSAGE = 'ServiceCase rollback requires an active Founder';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_cases_stage_direction_check',
      MESSAGE = 'ServiceCase stage direction is not enabled';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_service_cases_stage_transition_guard_trg
BEFORE UPDATE ON cases_service_cases
FOR EACH ROW EXECUTE FUNCTION cases_validate_service_case_stage_transition();

REVOKE ALL ON FUNCTION cases_validate_service_case_transition_fact_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_validate_service_case_stage_transition() FROM PUBLIC;
