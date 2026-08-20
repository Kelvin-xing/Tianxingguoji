CREATE TABLE cases_service_case_transition_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity_users (id),
  from_stage text NOT NULL,
  to_stage text NOT NULL,
  from_record_version bigint NOT NULL,
  to_record_version bigint NOT NULL,
  reason text,
  transitioned_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_service_case_transition_facts_case_fk
    FOREIGN KEY (service_case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT cases_service_case_transition_facts_case_version_key
    UNIQUE (service_case_id, organization_id, to_record_version),
  CONSTRAINT cases_service_case_transition_facts_direction_check CHECK (
    (from_stage = 'signed' AND to_stage = 'background_collection' AND reason IS NULL)
    OR
    (from_stage = 'background_collection' AND to_stage = 'signed'
      AND reason IS NOT NULL AND btrim(reason) <> '')
  ),
  CONSTRAINT cases_service_case_transition_facts_version_check CHECK (
    from_record_version >= 1 AND to_record_version = from_record_version + 1
  ),
  CONSTRAINT cases_service_case_transition_facts_timestamps_check CHECK (
    created_at >= transitioned_at
  )
);

CREATE FUNCTION cases_reject_service_case_transition_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'cases_service_case_transition_facts_append_only_check',
    MESSAGE = 'ServiceCase transition facts are append-only';
END;
$$;

CREATE TRIGGER cases_service_case_transition_facts_immutable_trg
BEFORE UPDATE OR DELETE ON cases_service_case_transition_facts
FOR EACH ROW EXECUTE FUNCTION cases_reject_service_case_transition_fact_mutation();

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
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT student.status
      INTO student_status
      FROM public.crm_students AS student
     WHERE student.id = NEW.student_id
       AND student.organization_id = NEW.organization_id;

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
     FOR UPDATE OF role_binding, membership, organization, identity_user;

    IF student_status IS DISTINCT FROM 'active'
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
      MESSAGE = 'ServiceCase stage can only change through the transition function';
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

CREATE FUNCTION cases_apply_service_case_transition(
  target_case_id uuid,
  expected_record_version bigint,
  expected_from_stage text,
  requested_to_stage text,
  actor_role text,
  transition_reason text,
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
  forward_evidence_complete boolean := false;
BEGIN
  IF tenant_setting IS NULL OR actor_setting IS NULL THEN
    RETURN QUERY SELECT 'CASE_TRANSITION_CASE_FORBIDDEN'::text, NULL::text, NULL::bigint;
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
    RETURN QUERY SELECT 'CASE_TRANSITION_CASE_NOT_FOUND'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
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
  ) INTO actor_is_active;
  IF NOT actor_is_active THEN
    RETURN QUERY SELECT 'CASE_TRANSITION_CASE_FORBIDDEN'::text,
                        service_case.stage, service_case.record_version;
    RETURN;
  END IF;

  IF service_case.record_version <> expected_record_version THEN
    RETURN QUERY SELECT 'CASE_TRANSITION_STALE_VERSION'::text,
                        service_case.stage, service_case.record_version;
    RETURN;
  END IF;
  IF service_case.stage IS DISTINCT FROM expected_from_stage THEN
    RETURN QUERY SELECT 'CASE_TRANSITION_NOT_ALLOWED'::text,
                        service_case.stage, service_case.record_version;
    RETURN;
  END IF;

  IF expected_from_stage = 'signed' AND requested_to_stage = 'background_collection' THEN
    IF actor_role NOT IN ('advisor', 'founder')
       OR service_case.primary_user_id IS DISTINCT FROM actor_id
       OR service_case.primary_role IS DISTINCT FROM actor_role THEN
      RETURN QUERY SELECT 'CASE_TRANSITION_PRIMARY_ADVISOR_REQUIRED'::text,
                          service_case.stage, service_case.record_version;
      RETURN;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.access_role_bindings AS role_binding
       WHERE role_binding.id = service_case.primary_role_binding_id
         AND role_binding.organization_id = tenant_id
         AND role_binding.user_id = actor_id
         AND role_binding.role = actor_role
         AND role_binding.status = 'active'
    ) THEN
      RETURN QUERY SELECT 'CASE_TRANSITION_PRIMARY_ADVISOR_REQUIRED'::text,
                          service_case.stage, service_case.record_version;
      RETURN;
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM public.cases_assessments AS assessment
        JOIN public.cases_schema_manifests AS manifest
          ON manifest.id = assessment.manifest_id
       WHERE assessment.service_case_id = service_case.id
         AND assessment.organization_id = tenant_id
         AND assessment.status = 'background_complete'
         AND manifest.status = 'approved'
         AND NOT EXISTS (
           SELECT 1
             FROM public.cases_schema_manifest_fields AS field
             LEFT JOIN public.cases_assessment_answers AS answer
               ON answer.assessment_id = assessment.id
              AND answer.organization_id = assessment.organization_id
              AND answer.manifest_id = assessment.manifest_id
              AND answer.field_id = field.field_id
            WHERE field.manifest_id = assessment.manifest_id
              AND field.blocking_stages ? 'background_complete'
              AND answer.id IS NULL
         )
    ) INTO forward_evidence_complete;
    IF NOT forward_evidence_complete THEN
      RETURN QUERY SELECT 'CASE_TRANSITION_ASSESSMENT_INCOMPLETE'::text,
                          service_case.stage, service_case.record_version;
      RETURN;
    END IF;
    IF transition_reason IS NOT NULL THEN
      RETURN QUERY SELECT 'CASE_TRANSITION_INVALID'::text,
                          service_case.stage, service_case.record_version;
      RETURN;
    END IF;
  ELSIF expected_from_stage = 'background_collection' AND requested_to_stage = 'signed' THEN
    IF actor_role <> 'founder' THEN
      RETURN QUERY SELECT 'CASE_TRANSITION_FOUNDER_REQUIRED'::text,
                          service_case.stage, service_case.record_version;
      RETURN;
    END IF;
    IF transition_reason IS NULL OR btrim(transition_reason) = '' THEN
      RETURN QUERY SELECT 'CASE_TRANSITION_REASON_REQUIRED'::text,
                          service_case.stage, service_case.record_version;
      RETURN;
    END IF;
  ELSE
    RETURN QUERY SELECT 'CASE_TRANSITION_NOT_ALLOWED'::text,
                        service_case.stage, service_case.record_version;
    RETURN;
  END IF;

  INSERT INTO public.cases_service_case_transition_facts
    (id, organization_id, service_case_id, actor_user_id, from_stage, to_stage,
     from_record_version, to_record_version, reason, transitioned_at, created_at)
  VALUES
    (transition_fact_id, tenant_id, service_case.id, actor_id, expected_from_stage,
     requested_to_stage, service_case.record_version, service_case.record_version + 1,
     transition_reason, transition_time, transition_time);

  PERFORM set_config('app.case_stage_transition', 'authorized', true);
  UPDATE public.cases_service_cases
     SET stage = requested_to_stage,
         record_version = record_version + 1,
         updated_at = transition_time
   WHERE id = service_case.id
     AND organization_id = tenant_id;

  RETURN QUERY SELECT 'allowed'::text, requested_to_stage,
                      service_case.record_version + 1;
END;
$$;

REVOKE ALL ON TABLE cases_service_case_transition_facts FROM PUBLIC;
REVOKE ALL ON TABLE cases_service_case_transition_facts FROM tianxing_app;
GRANT SELECT ON TABLE cases_service_case_transition_facts TO tianxing_app;
ALTER TABLE cases_service_case_transition_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON cases_service_case_transition_facts
  FOR SELECT TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true));

REVOKE UPDATE ON TABLE cases_service_cases FROM tianxing_app;
REVOKE ALL ON FUNCTION cases_reject_service_case_transition_fact_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_validate_service_case_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_apply_service_case_transition(
  uuid, bigint, text, text, text, text, uuid, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases_apply_service_case_transition(
  uuid, bigint, text, text, text, text, uuid, timestamptz
) TO tianxing_app;
