ALTER TABLE cases_service_cases NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cases_service_cases) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_cases_existing_data_unmapped_check',
      MESSAGE = 'existing ServiceCases require an explicit business migration';
  END IF;
END;
$$;

ALTER TABLE cases_service_cases FORCE ROW LEVEL SECURITY;

ALTER TABLE cases_service_cases
  DROP CONSTRAINT cases_service_cases_stage_check,
  DROP CONSTRAINT cases_service_cases_primary_role_check,
  ADD COLUMN workflow_status text NOT NULL DEFAULT 'active';

ALTER TABLE cases_service_cases
  ADD CONSTRAINT cases_service_cases_stage_check CHECK (
    stage IN (
      'signed',
      'background_collection',
      'school_selection_confirmed',
      'application_in_progress',
      'closed'
    )
  ),
  ADD CONSTRAINT cases_service_cases_primary_role_check CHECK (
    primary_role = 'advisor'
  ),
  ADD CONSTRAINT cases_service_cases_workflow_status_check CHECK (
    workflow_status IN ('active', 'paused', 'termination_pending', 'closed')
  ),
  ADD CONSTRAINT cases_service_cases_closed_state_check CHECK (
    (stage = 'closed') = (workflow_status = 'closed')
  );

ALTER TABLE cases_service_case_transition_facts
  DROP CONSTRAINT cases_service_case_transition_facts_direction_check,
  ADD CONSTRAINT cases_service_case_transition_facts_direction_check CHECK (
    from_stage = 'signed'
    AND to_stage = 'background_collection'
    AND reason IS NULL
  );

CREATE TABLE cases_service_case_lifecycle_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity_users (id),
  action text NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  from_record_version bigint NOT NULL,
  to_record_version bigint NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_service_case_lifecycle_facts_case_fk
    FOREIGN KEY (service_case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT cases_service_case_lifecycle_facts_case_version_key
    UNIQUE (service_case_id, organization_id, to_record_version),
  CONSTRAINT cases_service_case_lifecycle_facts_action_check CHECK (
    (action = 'pause' AND from_status = 'active' AND to_status = 'paused')
    OR
    (action = 'resume' AND from_status = 'paused' AND to_status = 'active')
  ),
  CONSTRAINT cases_service_case_lifecycle_facts_version_check CHECK (
    from_record_version >= 1 AND to_record_version = from_record_version + 1
  ),
  CONSTRAINT cases_service_case_lifecycle_facts_reason_check CHECK (
    (
      action = 'pause'
      AND reason IS NOT NULL
      AND btrim(reason) <> ''
      AND char_length(reason) <= 1000
    )
    OR (action = 'resume' AND reason IS NULL)
  ),
  CONSTRAINT cases_service_case_lifecycle_facts_timestamps_check CHECK (
    created_at >= occurred_at
  )
);

CREATE FUNCTION cases_reject_service_case_lifecycle_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'cases_service_case_lifecycle_facts_append_only_check',
    MESSAGE = 'ServiceCase lifecycle facts are append-only';
END;
$$;

CREATE TRIGGER cases_service_case_lifecycle_facts_immutable_trg
BEFORE UPDATE OR DELETE ON cases_service_case_lifecycle_facts
FOR EACH ROW EXECUTE FUNCTION cases_reject_service_case_lifecycle_fact_mutation();

CREATE FUNCTION cases_validate_service_case_lifecycle_fact_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.occurred_at < transaction_timestamp() - interval '5 minutes'
     OR NEW.occurred_at > transaction_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_case_lifecycle_facts_time_boundary_check',
      MESSAGE = 'ServiceCase lifecycle time is outside the accepted transaction window';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_service_case_lifecycle_facts_insert_guard_trg
BEFORE INSERT ON cases_service_case_lifecycle_facts
FOR EACH ROW EXECUTE FUNCTION cases_validate_service_case_lifecycle_fact_insert();

CREATE FUNCTION cases_assert_case_flow_v1_manifest(target_manifest_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
    FROM public.cases_schema_manifests AS manifest
   WHERE manifest.id = target_manifest_id
     AND manifest.application_type = 'k12'
     AND manifest.status = 'approved'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_manifest_blocker_contract_check',
      MESSAGE = 'assessment manifest is not the approved K12 contract';
  END IF;

  IF EXISTS (
    WITH expected(field_id, blocking_stages) AS (
      VALUES
        ('student_profile.date_of_birth', '["background_complete","selection_ready"]'::jsonb),
        ('student_profile.residency_status', '["background_complete","selection_ready"]'::jsonb),
        ('student_profile.primary_languages', '["background_complete"]'::jsonb),
        ('education_profile.current_stage', '["background_complete","selection_ready"]'::jsonb),
        ('education_profile.current_year_level', '["background_complete","selection_ready"]'::jsonb),
        ('education_profile.current_curriculum', '["background_complete"]'::jsonb),
        ('school_preferences.target_stage', '["background_complete","selection_ready"]'::jsonb),
        ('school_preferences.preferred_systems', '["selection_ready"]'::jsonb),
        ('school_preferences.preferred_districts', '["selection_ready"]'::jsonb),
        ('school_preferences.preferred_admission_route', '["background_complete","selection_ready"]'::jsonb),
        ('school_preferences.fee_band', '["selection_ready"]'::jsonb),
        ('family_context.primary_contact_language', '["background_complete","selection_ready"]'::jsonb),
        ('family_context.education_priority', '["background_complete","selection_ready"]'::jsonb),
        ('family_context.transport_arrangement', '["selection_ready"]'::jsonb),
        ('family_context.fee_preference', '["selection_ready"]'::jsonb)
    ), actual AS (
      SELECT field.field_id, field.blocking_stages
        FROM public.cases_schema_manifest_fields AS field
       WHERE field.manifest_id = target_manifest_id
    )
    SELECT 1
      FROM expected
      FULL OUTER JOIN actual USING (field_id)
     WHERE expected.field_id IS NULL
        OR actual.field_id IS NULL
        OR actual.blocking_stages IS DISTINCT FROM expected.blocking_stages
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_manifest_blocker_contract_check',
      MESSAGE = 'assessment manifest blocker contract does not match K12 v1';
  END IF;
END;
$$;

CREATE FUNCTION cases_lock_assessment_blockers(
  target_assessment_id uuid,
  target_manifest_id uuid,
  blocker_stage text
)
RETURNS TABLE (field_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tenant_setting text := nullif(current_setting('app.organization_id', true), '');
BEGIN
  IF blocker_stage NOT IN ('background_complete', 'selection_ready') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_manifest_blocker_contract_check',
      MESSAGE = 'assessment blocker stage is not canonical';
  END IF;
  IF tenant_setting IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessments_tenant_context_check',
      MESSAGE = 'assessment blocker validation requires tenant context';
  END IF;

  PERFORM 1
    FROM public.cases_assessments AS assessment
    JOIN public.cases_schema_manifests AS manifest
      ON manifest.id = assessment.manifest_id
   WHERE assessment.id = target_assessment_id
     AND assessment.manifest_id = target_manifest_id
     AND assessment.organization_id::text = tenant_setting
     AND manifest.status = 'approved'
   FOR UPDATE OF assessment
   FOR SHARE OF manifest;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessments_manifest_approved_check',
      MESSAGE = 'assessment blocker validation requires the bound approved manifest';
  END IF;

  PERFORM public.cases_assert_case_flow_v1_manifest(target_manifest_id);

  PERFORM 1
    FROM public.cases_schema_manifest_fields AS field
   WHERE field.manifest_id = target_manifest_id
     AND field.blocking_stages ? blocker_stage
   ORDER BY field.field_id
   FOR SHARE;

  PERFORM 1
    FROM public.cases_assessment_answers AS answer
   WHERE answer.assessment_id = target_assessment_id
     AND answer.organization_id::text = tenant_setting
     AND answer.manifest_id = target_manifest_id
     AND EXISTS (
       SELECT 1
         FROM public.cases_schema_manifest_fields AS field
        WHERE field.manifest_id = target_manifest_id
          AND field.field_id = answer.field_id
          AND field.blocking_stages ? blocker_stage
     )
   ORDER BY answer.field_id
   FOR UPDATE;

  RETURN QUERY
  SELECT field.field_id
    FROM public.cases_schema_manifest_fields AS field
    LEFT JOIN public.cases_assessment_answers AS answer
      ON answer.assessment_id = target_assessment_id
     AND answer.organization_id::text = tenant_setting
     AND answer.manifest_id = target_manifest_id
     AND answer.field_id = field.field_id
   WHERE field.manifest_id = target_manifest_id
     AND field.blocking_stages ? blocker_stage
     AND (answer.id IS NULL OR answer.semantic_state <> 'provided')
   ORDER BY field.field_id;
END;
$$;

CREATE FUNCTION cases_lock_assessment_background_blockers(
  target_assessment_id uuid,
  target_manifest_id uuid
)
RETURNS TABLE (field_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT blocker.field_id
    FROM public.cases_lock_assessment_blockers(
      target_assessment_id,
      target_manifest_id,
      'background_complete'
    ) AS blocker;
$$;

CREATE FUNCTION cases_assert_assessment_writeable(
  target_assessment_id uuid,
  target_organization_id uuid,
  completion_only boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  case_stage text;
  case_workflow_status text;
  student_status text;
BEGIN
  SELECT service_case.stage, service_case.workflow_status, student.status
    INTO case_stage, case_workflow_status, student_status
    FROM public.cases_assessments AS assessment
    JOIN public.cases_service_cases AS service_case
      ON service_case.id = assessment.service_case_id
     AND service_case.organization_id = assessment.organization_id
    JOIN public.crm_students AS student
      ON student.id = service_case.student_id
     AND student.organization_id = service_case.organization_id
   WHERE assessment.id = target_assessment_id
     AND assessment.organization_id = target_organization_id
   FOR SHARE OF service_case, student;
  IF NOT FOUND
     OR student_status <> 'active'
     OR case_workflow_status <> 'active'
     OR case_stage NOT IN (
       'background_collection',
       'school_selection_confirmed',
       'application_in_progress'
     )
     OR (completion_only AND case_stage <> 'background_collection') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessment_write_boundary_check',
      MESSAGE = 'assessment write requires an active eligible ServiceCase';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION cases_validate_assessment_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  manifest_status text;
BEGIN
  SELECT status INTO manifest_status
    FROM public.cases_schema_manifests
   WHERE id = NEW.manifest_id
   FOR SHARE;

  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM public.cases_service_cases AS service_case
      JOIN public.crm_students AS student
        ON student.id = service_case.student_id
       AND student.organization_id = service_case.organization_id
     WHERE service_case.id = NEW.service_case_id
       AND service_case.organization_id = NEW.organization_id
       AND service_case.stage = 'signed'
       AND service_case.workflow_status = 'active'
       AND student.status = 'active'
     FOR SHARE OF service_case, student;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_assessment_insert_boundary_check',
        MESSAGE = 'assessment insert requires the active signed Case creation boundary';
    END IF;
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

  PERFORM public.cases_assert_assessment_writeable(NEW.id, NEW.organization_id, true);

  IF OLD.status = 'draft' AND NEW.status = 'background_complete' THEN
    IF EXISTS (
      SELECT 1
        FROM public.cases_lock_assessment_background_blockers(NEW.id, NEW.manifest_id)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_assessments_blockers_incomplete_check',
        MESSAGE = 'assessment blocking fields are incomplete';
    END IF;
  ELSIF OLD.status = 'background_complete' AND NEW.status = 'selection_ready' THEN
    IF EXISTS (
      SELECT 1
        FROM public.cases_lock_assessment_blockers(
          NEW.id,
          NEW.manifest_id,
          'selection_ready'
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_assessments_blockers_incomplete_check',
        MESSAGE = 'assessment blocking fields are incomplete';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessments_status_transition_check',
      MESSAGE = 'assessment status transition is not approved';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION cases_require_service_case_advanced_before_commit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.cases_service_cases AS service_case
     WHERE service_case.id = NEW.id
       AND service_case.organization_id = NEW.organization_id
       AND service_case.stage = 'signed'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_cases_signed_commit_check',
      MESSAGE = 'ServiceCase must advance from signed before commit';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER cases_service_cases_signed_commit_trg
AFTER INSERT ON cases_service_cases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION cases_require_service_case_advanced_before_commit();

CREATE OR REPLACE FUNCTION cases_validate_answer_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  assessment_manifest_id uuid;
  manifest_value_type text;
BEGIN
  PERFORM public.cases_assert_assessment_writeable(
    NEW.assessment_id,
    NEW.organization_id,
    false
  );

  IF TG_OP = 'INSERT' THEN
    SELECT assessment.manifest_id, field.value_type
      INTO assessment_manifest_id, manifest_value_type
      FROM public.cases_assessments AS assessment
      JOIN public.cases_schema_manifest_fields AS field
        ON field.manifest_id = NEW.manifest_id
       AND field.module_layer = NEW.module_layer
       AND field.module_id = NEW.module_id
       AND field.module_version = NEW.module_version
       AND field.field_id = NEW.field_id
     WHERE assessment.id = NEW.assessment_id
       AND assessment.organization_id = NEW.organization_id;
    IF assessment_manifest_id IS DISTINCT FROM NEW.manifest_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_answers_manifest_field_check',
        MESSAGE = 'answer does not belong to the assessment manifest';
    END IF;
    IF NEW.semantic_state = 'provided'
       AND NEW.value_json->>'type' IS DISTINCT FROM manifest_value_type THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_answers_value_type_check',
        MESSAGE = 'answer value type does not match manifest field';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.assessment_id IS DISTINCT FROM OLD.assessment_id
     OR NEW.manifest_id IS DISTINCT FROM OLD.manifest_id
     OR NEW.module_layer IS DISTINCT FROM OLD.module_layer
     OR NEW.module_id IS DISTINCT FROM OLD.module_id
     OR NEW.module_version IS DISTINCT FROM OLD.module_version
     OR NEW.field_id IS DISTINCT FROM OLD.field_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessment_answers_identity_immutable_check',
      MESSAGE = 'answer identity is immutable';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessment_answers_record_version_transition_check',
      MESSAGE = 'record_version must increase exactly once';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessment_answers_timestamps_check',
      MESSAGE = 'updated_at cannot move backward';
  END IF;
  SELECT value_type INTO manifest_value_type
    FROM public.cases_schema_manifest_fields
   WHERE manifest_id = NEW.manifest_id
     AND module_layer = NEW.module_layer
     AND module_id = NEW.module_id
     AND module_version = NEW.module_version
     AND field_id = NEW.field_id;
  IF NEW.semantic_state = 'provided'
     AND NEW.value_type IS DISTINCT FROM manifest_value_type THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_answers_value_type_check',
      MESSAGE = 'answer value type does not match manifest field';
  END IF;
  IF NEW.semantic_state = 'provided'
     AND NEW.value_json->>'type' IS DISTINCT FROM NEW.value_type THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_answers_value_type_check',
      MESSAGE = 'answer value type does not match answer tag';
  END IF;
  RETURN NEW;
END;
$$;

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

    IF NEW.primary_role IS DISTINCT FROM 'advisor'
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

CREATE OR REPLACE FUNCTION cases_validate_service_case_stage_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    RETURN NEW;
  END IF;
  IF OLD.stage = 'signed' AND NEW.stage = 'background_collection'
     AND EXISTS (
       SELECT 1
         FROM public.cases_service_case_transition_facts AS fact
        WHERE fact.organization_id = NEW.organization_id
          AND fact.service_case_id = NEW.id
          AND fact.actor_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid
          AND fact.from_stage = OLD.stage
          AND fact.to_stage = NEW.stage
          AND fact.from_record_version = OLD.record_version
          AND fact.to_record_version = NEW.record_version
          AND fact.reason IS NULL
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'cases_service_cases_stage_direction_check',
    MESSAGE = 'ServiceCase stage direction is not enabled';
END;
$$;

CREATE OR REPLACE FUNCTION cases_apply_service_case_transition(
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
BEGIN
  RETURN QUERY SELECT 'CASE_TRANSITION_NOT_ALLOWED'::text, NULL::text, NULL::bigint;
END;
$$;

CREATE FUNCTION cases_advance_new_service_case(
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

CREATE FUNCTION cases_apply_service_case_workflow_action(
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

CREATE OR REPLACE FUNCTION cases_create_candidate_school_target(
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
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '42501',
    CONSTRAINT = 'cases_candidate_school_target_decommissioned_check',
    MESSAGE = 'Candidate SchoolTarget creation is decommissioned';
END;
$$;

GRANT UPDATE (stage, workflow_status, record_version, updated_at)
  ON TABLE cases_service_cases TO tianxing_app;
REVOKE ALL ON TABLE cases_service_case_lifecycle_facts FROM PUBLIC;
REVOKE ALL ON TABLE cases_service_case_lifecycle_facts FROM tianxing_app;
GRANT SELECT ON TABLE cases_service_case_lifecycle_facts TO tianxing_app;
GRANT INSERT ON TABLE cases_service_case_lifecycle_facts TO tianxing_app;
ALTER TABLE cases_service_case_lifecycle_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_service_case_lifecycle_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON cases_service_case_lifecycle_facts
  FOR SELECT TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY tianxing_tenant_insert_boundary ON cases_service_case_lifecycle_facts
  FOR INSERT TO tianxing_app
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));

GRANT INSERT ON TABLE cases_service_case_transition_facts TO tianxing_app;
ALTER TABLE cases_service_case_transition_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_insert_boundary ON cases_service_case_transition_facts
  FOR INSERT TO tianxing_app
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));

REVOKE ALL ON FUNCTION cases_reject_service_case_lifecycle_fact_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_validate_service_case_lifecycle_fact_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_assert_case_flow_v1_manifest(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_lock_assessment_blockers(
  uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_lock_assessment_background_blockers(
  uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases_lock_assessment_background_blockers(
  uuid, uuid
) TO tianxing_app;
REVOKE ALL ON FUNCTION cases_validate_assessment_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_assert_assessment_writeable(
  uuid, uuid, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_validate_answer_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_require_service_case_advanced_before_commit() FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_advance_new_service_case(
  uuid, text, uuid, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases_advance_new_service_case(
  uuid, text, uuid, timestamptz
) TO tianxing_app;
REVOKE ALL ON FUNCTION cases_apply_service_case_workflow_action(
  uuid, bigint, text, text, text, uuid, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases_apply_service_case_workflow_action(
  uuid, bigint, text, text, text, uuid, timestamptz
) TO tianxing_app;
REVOKE EXECUTE ON FUNCTION cases_apply_service_case_transition(
  uuid, bigint, text, text, text, text, uuid, timestamptz
) FROM tianxing_app;
REVOKE ALL ON FUNCTION cases_create_candidate_school_target(
  uuid, uuid, uuid, uuid, text, timestamptz
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cases_create_candidate_school_target(
  uuid, uuid, uuid, uuid, text, timestamptz
) FROM tianxing_app;
