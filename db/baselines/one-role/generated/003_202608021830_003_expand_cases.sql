CREATE TABLE cases_service_cases (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  student_id uuid NOT NULL,
  case_number text NOT NULL,
  application_type text NOT NULL,
  intake_year integer NOT NULL,
  admission_type text NOT NULL,
  primary_role_binding_id uuid NOT NULL,
  primary_membership_id uuid NOT NULL,
  primary_user_id uuid NOT NULL,
  primary_role text NOT NULL,
  stage text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_service_cases_student_fk FOREIGN KEY (student_id, organization_id)
    REFERENCES crm_students (id, organization_id),
  CONSTRAINT cases_service_cases_primary_role_fk FOREIGN KEY (
    primary_role_binding_id,
    organization_id,
    primary_membership_id,
    primary_user_id,
    primary_role
  ) REFERENCES access_role_bindings (id, organization_id, membership_id, user_id, role),
  CONSTRAINT cases_service_cases_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT cases_service_cases_case_number_check CHECK (btrim(case_number) <> ''),
  CONSTRAINT cases_service_cases_application_type_check CHECK (application_type = 'k12'),
  CONSTRAINT cases_service_cases_intake_year_check CHECK (intake_year > 0),
  CONSTRAINT cases_service_cases_admission_type_check CHECK (btrim(admission_type) <> ''),
  CONSTRAINT cases_service_cases_primary_role_check CHECK (primary_role IN ('founder', 'advisor')),
  CONSTRAINT cases_service_cases_stage_check CHECK (
    stage IN (
      'signed',
      'background_collection',
      'school_selection_confirmed',
      'interview_preparation',
      'application_submitted',
      'awaiting_result',
      'offer_confirmed',
      'closed'
    )
  ),
  CONSTRAINT cases_service_cases_record_version_check CHECK (record_version >= 1),
  CONSTRAINT cases_service_cases_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT cases_service_cases_case_number_key UNIQUE (organization_id, case_number)
);

CREATE UNIQUE INDEX cases_service_cases_one_active_student_case_idx
  ON cases_service_cases (organization_id, student_id, intake_year, admission_type)
  WHERE stage <> 'closed';

CREATE TABLE cases_schema_manifests (
  id uuid PRIMARY KEY,
  application_type text NOT NULL,
  composition_version text NOT NULL,
  base_module_id text NOT NULL,
  base_module_version text NOT NULL,
  education_stage_module_id text NOT NULL,
  education_stage_module_version text NOT NULL,
  school_system_module_id text NOT NULL,
  school_system_module_version text NOT NULL,
  admission_route_module_id text NOT NULL,
  admission_route_module_version text NOT NULL,
  content_sha256 char(64) NOT NULL,
  status text NOT NULL,
  approved_by_user_id uuid REFERENCES identity_users (id),
  approved_at timestamptz,
  retired_by_user_id uuid REFERENCES identity_users (id),
  retired_at timestamptz,
  retirement_reason text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_schema_manifests_application_type_check CHECK (application_type = 'k12'),
  CONSTRAINT cases_schema_manifests_identity_check CHECK (
    btrim(composition_version) <> ''
    AND btrim(base_module_id) <> ''
    AND btrim(base_module_version) <> ''
    AND btrim(education_stage_module_id) <> ''
    AND btrim(education_stage_module_version) <> ''
    AND btrim(school_system_module_id) <> ''
    AND btrim(school_system_module_version) <> ''
    AND btrim(admission_route_module_id) <> ''
    AND btrim(admission_route_module_version) <> ''
  ),
  CONSTRAINT cases_schema_manifests_hash_check CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cases_schema_manifests_status_check CHECK (status IN ('candidate', 'approved', 'retired')),
  CONSTRAINT cases_schema_manifests_receipt_check CHECK (
    (
      status = 'candidate'
      AND approved_by_user_id IS NULL
      AND approved_at IS NULL
      AND retired_by_user_id IS NULL
      AND retired_at IS NULL
      AND retirement_reason IS NULL
    )
    OR (
      status = 'approved'
      AND approved_by_user_id IS NOT NULL
      AND approved_at IS NOT NULL
      AND retired_by_user_id IS NULL
      AND retired_at IS NULL
      AND retirement_reason IS NULL
    )
    OR (
      status = 'retired'
      AND approved_by_user_id IS NOT NULL
      AND approved_at IS NOT NULL
      AND retired_by_user_id IS NOT NULL
      AND retired_at IS NOT NULL
      AND retirement_reason IS NOT NULL
      AND btrim(retirement_reason) <> ''
    )
  ),
  CONSTRAINT cases_schema_manifests_receipt_timestamps_check CHECK (
    (approved_at IS NULL OR approved_at >= created_at)
    AND (retired_at IS NULL OR retired_at >= COALESCE(approved_at, created_at))
    AND updated_at >= COALESCE(retired_at, approved_at, created_at)
  ),
  CONSTRAINT cases_schema_manifests_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT cases_schema_manifests_composition_key UNIQUE (application_type, composition_version),
  CONSTRAINT cases_schema_manifests_hash_key UNIQUE (content_sha256)
);

CREATE TABLE cases_schema_manifest_fields (
  manifest_id uuid NOT NULL REFERENCES cases_schema_manifests (id),
  module_layer text NOT NULL,
  module_id text NOT NULL,
  module_version text NOT NULL,
  field_id text NOT NULL,
  value_type text NOT NULL,
  visibility text NOT NULL,
  blocking_stages jsonb NOT NULL,
  CONSTRAINT cases_schema_manifest_fields_pk PRIMARY KEY (
    manifest_id,
    module_layer,
    module_id,
    module_version,
    field_id
  ),
  CONSTRAINT cases_schema_manifest_fields_identity_key UNIQUE (manifest_id, field_id),
  CONSTRAINT cases_schema_manifest_fields_layer_check CHECK (
    module_layer IN ('base', 'education_stage', 'school_system', 'admission_route')
  ),
  CONSTRAINT cases_schema_manifest_fields_text_check CHECK (
    btrim(module_id) <> ''
    AND btrim(module_version) <> ''
    AND btrim(field_id) <> ''
    AND btrim(value_type) <> ''
    AND btrim(visibility) <> ''
  ),
  CONSTRAINT cases_schema_manifest_fields_blocking_check CHECK (
    jsonb_typeof(blocking_stages) = 'array'
  )
);

CREATE TABLE cases_assessments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  manifest_id uuid NOT NULL REFERENCES cases_schema_manifests (id),
  status text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_assessments_case_fk FOREIGN KEY (service_case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT cases_assessments_tenant_key UNIQUE (id, organization_id, manifest_id),
  CONSTRAINT cases_assessments_status_check CHECK (
    status IN ('draft', 'background_complete', 'selection_ready')
  ),
  CONSTRAINT cases_assessments_record_version_check CHECK (record_version >= 1),
  CONSTRAINT cases_assessments_timestamps_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX cases_assessments_one_case_manifest_idx
  ON cases_assessments (organization_id, service_case_id, manifest_id);

CREATE TABLE cases_assessment_answers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  module_layer text NOT NULL,
  module_id text NOT NULL,
  module_version text NOT NULL,
  field_id text NOT NULL,
  semantic_state text NOT NULL,
  value_json jsonb,
  value_type text,
  source text NOT NULL,
  visibility text NOT NULL,
  is_derived boolean NOT NULL DEFAULT false,
  derived_rule_version text,
  updated_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_answers_assessment_fk FOREIGN KEY (
    assessment_id,
    organization_id,
    manifest_id
  ) REFERENCES cases_assessments (id, organization_id, manifest_id),
  CONSTRAINT cases_answers_manifest_field_fk FOREIGN KEY (
    manifest_id,
    module_layer,
    module_id,
    module_version,
    field_id
  ) REFERENCES cases_schema_manifest_fields (
    manifest_id,
    module_layer,
    module_id,
    module_version,
    field_id
  ),
  CONSTRAINT cases_answers_identity_key UNIQUE (organization_id, assessment_id, field_id),
  CONSTRAINT cases_answers_semantic_state_check CHECK (
    semantic_state IN ('provided', 'unknown', 'not_applicable', 'declined_to_provide')
  ),
  CONSTRAINT cases_answers_value_exclusivity_check CHECK (
    (
      semantic_state = 'provided'
      AND value_json IS NOT NULL
      AND value_json <> 'null'::jsonb
      AND value_type IS NOT NULL
      AND btrim(value_type) <> ''
    )
    OR (
      semantic_state <> 'provided'
      AND value_json IS NULL
      AND value_type IS NULL
    )
  ),
  CONSTRAINT cases_answers_text_check CHECK (
    btrim(source) <> ''
    AND btrim(visibility) <> ''
    AND (NOT is_derived OR (derived_rule_version IS NOT NULL AND btrim(derived_rule_version) <> ''))
  ),
  CONSTRAINT cases_answers_record_version_check CHECK (record_version >= 1),
  CONSTRAINT cases_answers_timestamps_check CHECK (updated_at >= created_at)
);

CREATE TABLE cases_school_targets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  school_id uuid NOT NULL,
  intake_year integer NOT NULL,
  admission_type text NOT NULL,
  state text NOT NULL,
  pinned_resolved_revision_id uuid,
  pinned_resolution_sha256 char(64),
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_targets_case_fk FOREIGN KEY (service_case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT cases_targets_tenant_key UNIQUE (id, organization_id, service_case_id),
  CONSTRAINT cases_targets_identity_check CHECK (
    intake_year > 0
    AND btrim(admission_type) <> ''
  ),
  CONSTRAINT cases_targets_state_check CHECK (
    state IN (
      'candidate',
      'preparing',
      'submitted',
      'interview',
      'waitlisted',
      'accepted',
      'rejected',
      'withdrawn'
    )
  ),
  CONSTRAINT cases_targets_pin_check CHECK (
    (
      pinned_resolved_revision_id IS NULL
      AND pinned_resolution_sha256 IS NULL
    )
    OR (
      pinned_resolved_revision_id IS NOT NULL
      AND pinned_resolution_sha256 IS NOT NULL
      AND pinned_resolution_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT cases_targets_record_version_check CHECK (record_version >= 1),
  CONSTRAINT cases_targets_timestamps_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX cases_school_targets_identity_idx
  ON cases_school_targets (organization_id, service_case_id, school_id, intake_year, admission_type);

CREATE TABLE cases_case_outcomes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  school_target_id uuid NOT NULL,
  outcome_code text NOT NULL,
  outcome_date date NOT NULL,
  evidence_json jsonb NOT NULL,
  source text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity_users (id),
  revision_number integer NOT NULL,
  previous_outcome_id uuid,
  superseded_at timestamptz,
  superseded_by_outcome_id uuid,
  supersession_reason text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_outcomes_target_fk FOREIGN KEY (
    school_target_id,
    organization_id,
    service_case_id
  ) REFERENCES cases_school_targets (id, organization_id, service_case_id),
  CONSTRAINT cases_outcomes_tenant_key UNIQUE (id, organization_id, school_target_id),
  CONSTRAINT cases_outcomes_code_check CHECK (
    outcome_code IN ('waitlisted', 'accepted', 'rejected', 'withdrawn', 'not_submitted', 'aborted')
  ),
  CONSTRAINT cases_outcomes_evidence_check CHECK (jsonb_typeof(evidence_json) = 'object'),
  CONSTRAINT cases_outcomes_text_check CHECK (btrim(source) <> ''),
  CONSTRAINT cases_outcomes_revision_check CHECK (revision_number >= 1),
  CONSTRAINT cases_outcomes_supersession_check CHECK (
    (
      superseded_at IS NULL
      AND superseded_by_outcome_id IS NULL
      AND supersession_reason IS NULL
    )
    OR (
      superseded_at IS NOT NULL
      AND superseded_by_outcome_id IS NOT NULL
      AND supersession_reason IS NOT NULL
      AND btrim(supersession_reason) <> ''
    )
  ),
  CONSTRAINT cases_outcomes_receipt_timestamps_check CHECK (
    superseded_at IS NULL OR superseded_at >= created_at
  ),
  CONSTRAINT cases_outcomes_record_version_check CHECK (record_version >= 1),
  CONSTRAINT cases_outcomes_timestamps_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX cases_outcomes_revision_idx
  ON cases_case_outcomes (organization_id, school_target_id, revision_number);

CREATE UNIQUE INDEX cases_outcomes_one_current_per_target_idx
  ON cases_case_outcomes (organization_id, school_target_id)
  WHERE superseded_at IS NULL;

CREATE FUNCTION cases_assert_active_founder(p_user_id uuid, p_constraint text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  is_active_founder boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM access_role_bindings AS role_binding
      JOIN access_organization_memberships AS membership
        ON membership.id = role_binding.membership_id
       AND membership.organization_id = role_binding.organization_id
       AND membership.user_id = role_binding.user_id
      JOIN access_organizations AS organization
        ON organization.id = role_binding.organization_id
      JOIN identity_users AS identity_user
        ON identity_user.id = role_binding.user_id
     WHERE role_binding.user_id = p_user_id
       AND role_binding.role = 'founder'
       AND role_binding.status = 'active'
       AND membership.status = 'active'
       AND organization.status = 'active'
       AND identity_user.status = 'active'
  ) INTO is_active_founder;

  IF NOT is_active_founder THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = p_constraint,
      MESSAGE = 'an active Founder approval is required';
  END IF;
END;
$$;

CREATE FUNCTION cases_validate_service_case_write()
RETURNS trigger
LANGUAGE plpgsql
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
      FROM crm_students AS student
     WHERE student.id = NEW.student_id
       AND student.organization_id = NEW.organization_id;

    SELECT role_binding.status, membership.status, organization.status, identity_user.status
      INTO role_binding_status, membership_status, organization_status, user_status
      FROM access_role_bindings AS role_binding
      JOIN access_organization_memberships AS membership
        ON membership.id = role_binding.membership_id
       AND membership.organization_id = role_binding.organization_id
       AND membership.user_id = role_binding.user_id
      JOIN access_organizations AS organization
        ON organization.id = role_binding.organization_id
      JOIN identity_users AS identity_user
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
     OR NEW.stage IS DISTINCT FROM OLD.stage
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_service_cases_identity_immutable_check',
      MESSAGE = 'ServiceCase identity and stage are immutable';
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

CREATE FUNCTION cases_validate_manifest_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'candidate' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_schema_manifests_candidate_insert_check',
        MESSAGE = 'new manifests must start as candidate';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.application_type IS DISTINCT FROM OLD.application_type
     OR NEW.composition_version IS DISTINCT FROM OLD.composition_version
     OR NEW.base_module_id IS DISTINCT FROM OLD.base_module_id
     OR NEW.base_module_version IS DISTINCT FROM OLD.base_module_version
     OR NEW.education_stage_module_id IS DISTINCT FROM OLD.education_stage_module_id
     OR NEW.education_stage_module_version IS DISTINCT FROM OLD.education_stage_module_version
     OR NEW.school_system_module_id IS DISTINCT FROM OLD.school_system_module_id
     OR NEW.school_system_module_version IS DISTINCT FROM OLD.school_system_module_version
     OR NEW.admission_route_module_id IS DISTINCT FROM OLD.admission_route_module_id
     OR NEW.admission_route_module_version IS DISTINCT FROM OLD.admission_route_module_version
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_schema_manifests_immutable_check',
      MESSAGE = 'schema manifest content is immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_schema_manifests_timestamps_check',
      MESSAGE = 'updated_at cannot move backward';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.retired_by_user_id IS DISTINCT FROM OLD.retired_by_user_id
       OR NEW.retired_at IS DISTINCT FROM OLD.retired_at
       OR NEW.retirement_reason IS DISTINCT FROM OLD.retirement_reason
       OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_schema_manifests_immutable_check',
        MESSAGE = 'manifest receipt cannot be rewritten';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'candidate' AND NEW.status = 'approved' THEN
    IF NEW.approved_by_user_id IS NULL OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_schema_manifests_approval_receipt_check',
        MESSAGE = 'manifest approval receipt is required';
    END IF;
    PERFORM cases_assert_active_founder(
      NEW.approved_by_user_id,
      'cases_schema_manifests_approval_receipt_check'
    );
    RETURN NEW;
  END IF;

  IF OLD.status = 'approved' AND NEW.status = 'retired' THEN
    IF NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_schema_manifests_immutable_check',
        MESSAGE = 'manifest approval receipt is immutable';
    END IF;
    IF NEW.retired_by_user_id IS NULL
       OR NEW.retired_at IS NULL
       OR NEW.retirement_reason IS NULL
       OR btrim(NEW.retirement_reason) = '' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_schema_manifests_retirement_receipt_check',
        MESSAGE = 'manifest retirement receipt is required';
    END IF;
    PERFORM cases_assert_active_founder(
      NEW.retired_by_user_id,
      'cases_schema_manifests_retirement_receipt_check'
    );
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'cases_schema_manifests_status_transition_check',
    MESSAGE = 'manifest status transition is not approved';
END;
$$;

CREATE FUNCTION cases_validate_manifest_field_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  manifest_status text;
  expected_module_id text;
  expected_module_version text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_schema_manifest_fields_delete_rejected',
      MESSAGE = 'manifest fields are immutable';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_schema_manifest_fields_immutable_check',
      MESSAGE = 'manifest fields are immutable';
  END IF;

  SELECT status,
         CASE NEW.module_layer
           WHEN 'base' THEN base_module_id
           WHEN 'education_stage' THEN education_stage_module_id
           WHEN 'school_system' THEN school_system_module_id
           WHEN 'admission_route' THEN admission_route_module_id
         END,
         CASE NEW.module_layer
           WHEN 'base' THEN base_module_version
           WHEN 'education_stage' THEN education_stage_module_version
           WHEN 'school_system' THEN school_system_module_version
           WHEN 'admission_route' THEN admission_route_module_version
         END
    INTO manifest_status, expected_module_id, expected_module_version
    FROM cases_schema_manifests
   WHERE id = NEW.manifest_id
   FOR UPDATE;

  IF manifest_status IS DISTINCT FROM 'candidate' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_schema_manifest_fields_manifest_status_check',
      MESSAGE = 'fields can only be added to a candidate manifest';
  END IF;
  IF NEW.module_id IS DISTINCT FROM expected_module_id
     OR NEW.module_version IS DISTINCT FROM expected_module_version THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_schema_manifest_fields_module_reference_check',
      MESSAGE = 'field module reference does not match manifest';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(NEW.blocking_stages) AS stage(value)
     WHERE stage.value NOT IN ('background_complete', 'selection_ready')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_schema_manifest_fields_blocking_stage_check',
      MESSAGE = 'field blocker stage is not approved';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION cases_validate_assessment_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  manifest_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO manifest_status
      FROM cases_schema_manifests
     WHERE id = NEW.manifest_id
     FOR UPDATE;
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
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_assessments_identity_immutable_check',
      MESSAGE = 'assessment identity and status are immutable';
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
  RETURN NEW;
END;
$$;

CREATE FUNCTION cases_validate_answer_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  assessment_manifest_id uuid;
  manifest_value_type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT assessment.manifest_id, field.value_type
      INTO assessment_manifest_id, manifest_value_type
      FROM cases_assessments AS assessment
      JOIN cases_schema_manifest_fields AS field
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
  SELECT value_type
    INTO manifest_value_type
    FROM cases_schema_manifest_fields
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

CREATE FUNCTION cases_validate_target_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.service_case_id IS DISTINCT FROM OLD.service_case_id
     OR NEW.school_id IS DISTINCT FROM OLD.school_id
     OR NEW.intake_year IS DISTINCT FROM OLD.intake_year
     OR NEW.admission_type IS DISTINCT FROM OLD.admission_type
     OR NEW.state IS DISTINCT FROM OLD.state
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_school_targets_status_immutable_check',
      MESSAGE = 'target identity and state are immutable in P0-07';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_school_targets_record_version_transition_check',
      MESSAGE = 'record_version must increase exactly once';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_school_targets_timestamps_check',
      MESSAGE = 'updated_at cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION cases_validate_outcome_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_case_outcomes_immutable_check',
      MESSAGE = 'superseded outcome is immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.service_case_id IS DISTINCT FROM OLD.service_case_id
     OR NEW.school_target_id IS DISTINCT FROM OLD.school_target_id
     OR NEW.outcome_code IS DISTINCT FROM OLD.outcome_code
     OR NEW.outcome_date IS DISTINCT FROM OLD.outcome_date
     OR NEW.evidence_json IS DISTINCT FROM OLD.evidence_json
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
     OR NEW.previous_outcome_id IS DISTINCT FROM OLD.previous_outcome_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.superseded_at IS NULL
     OR NEW.superseded_by_outcome_id IS NULL
     OR NEW.supersession_reason IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_case_outcomes_immutable_check',
      MESSAGE = 'outcome core facts are immutable; use a correction revision';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_case_outcomes_record_version_transition_check',
      MESSAGE = 'record_version must increase exactly once';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_case_outcomes_timestamps_check',
      MESSAGE = 'updated_at cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION cases_validate_outcome_revisions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_id uuid;
  target_organization_id uuid;
  outcome_record record;
  previous_record record;
  maximum_revision integer;
  outcome_count integer;
BEGIN
  target_id := NEW.school_target_id;
  target_organization_id := NEW.organization_id;

  SELECT count(*), max(revision_number)
    INTO outcome_count, maximum_revision
    FROM cases_case_outcomes
   WHERE cases_case_outcomes.school_target_id = target_id
     AND cases_case_outcomes.organization_id = target_organization_id;

  IF outcome_count > 0 AND outcome_count <> maximum_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_case_outcomes_revision_check',
      MESSAGE = 'outcome revisions must be contiguous';
  END IF;

  FOR outcome_record IN
    SELECT *
      FROM cases_case_outcomes
     WHERE cases_case_outcomes.school_target_id = target_id
       AND cases_case_outcomes.organization_id = target_organization_id
  LOOP
    IF outcome_record.previous_outcome_id IS NULL THEN
      IF outcome_record.revision_number <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'cases_case_outcomes_revision_check',
          MESSAGE = 'first outcome revision must be one';
      END IF;
    ELSE
      SELECT revision_number, school_target_id, organization_id
        INTO previous_record
        FROM cases_case_outcomes
       WHERE id = outcome_record.previous_outcome_id;
      IF previous_record IS NULL
         OR previous_record.school_target_id IS DISTINCT FROM target_id
         OR previous_record.organization_id IS DISTINCT FROM target_organization_id
         OR previous_record.revision_number <> outcome_record.revision_number - 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'cases_case_outcomes_revision_check',
          MESSAGE = 'outcome previous revision is invalid';
      END IF;
    END IF;

    IF outcome_record.superseded_at IS NULL THEN
      IF outcome_record.superseded_by_outcome_id IS NOT NULL
         OR outcome_record.supersession_reason IS NOT NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'cases_case_outcomes_revision_check',
          MESSAGE = 'current outcome cannot have supersession receipt';
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1
          FROM cases_case_outcomes AS successor
         WHERE successor.id = outcome_record.superseded_by_outcome_id
           AND successor.school_target_id = target_id
           AND successor.organization_id = target_organization_id
           AND successor.revision_number = outcome_record.revision_number + 1
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'cases_case_outcomes_revision_check',
          MESSAGE = 'superseded outcome successor is invalid';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION cases_validate_target_outcome_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_id uuid;
  target_organization_id uuid;
  target_state text;
  current_outcome_count integer;
  current_outcome_code text;
BEGIN
  IF TG_TABLE_NAME = 'cases_school_targets' THEN
    target_id := NEW.id;
    target_organization_id := NEW.organization_id;
  ELSE
    target_id := NEW.school_target_id;
    target_organization_id := NEW.organization_id;
  END IF;

  SELECT state
    INTO target_state
    FROM cases_school_targets
   WHERE id = target_id
     AND organization_id = target_organization_id;

  SELECT count(*), max(outcome_code)
    INTO current_outcome_count, current_outcome_code
    FROM cases_case_outcomes
   WHERE school_target_id = target_id
     AND organization_id = target_organization_id
     AND superseded_at IS NULL;

  IF target_state IN ('waitlisted', 'accepted', 'rejected', 'withdrawn') THEN
    IF current_outcome_count <> 1 OR current_outcome_code IS DISTINCT FROM target_state THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'cases_targets_current_outcome_check',
        MESSAGE = 'terminal target requires one matching current outcome';
    END IF;
  ELSIF current_outcome_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'cases_targets_current_outcome_check',
      MESSAGE = 'non-terminal target cannot have a current outcome';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION cases_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = TG_ARGV[0],
    MESSAGE = 'authoritative CaseWorkflow history cannot be hard deleted';
END;
$$;

CREATE TRIGGER cases_service_cases_write_trg
BEFORE INSERT OR UPDATE ON cases_service_cases
FOR EACH ROW EXECUTE FUNCTION cases_validate_service_case_write();

CREATE TRIGGER cases_schema_manifests_write_trg
BEFORE INSERT OR UPDATE ON cases_schema_manifests
FOR EACH ROW EXECUTE FUNCTION cases_validate_manifest_write();

CREATE TRIGGER cases_schema_manifest_fields_write_trg
BEFORE INSERT OR UPDATE OR DELETE ON cases_schema_manifest_fields
FOR EACH ROW EXECUTE FUNCTION cases_validate_manifest_field_write();

CREATE TRIGGER cases_assessments_write_trg
BEFORE INSERT OR UPDATE ON cases_assessments
FOR EACH ROW EXECUTE FUNCTION cases_validate_assessment_write();

CREATE TRIGGER cases_assessment_answers_write_trg
BEFORE INSERT OR UPDATE ON cases_assessment_answers
FOR EACH ROW EXECUTE FUNCTION cases_validate_answer_write();

CREATE TRIGGER cases_school_targets_write_trg
BEFORE INSERT OR UPDATE ON cases_school_targets
FOR EACH ROW EXECUTE FUNCTION cases_validate_target_write();

CREATE TRIGGER cases_case_outcomes_write_trg
BEFORE INSERT OR UPDATE ON cases_case_outcomes
FOR EACH ROW EXECUTE FUNCTION cases_validate_outcome_write();

CREATE CONSTRAINT TRIGGER cases_targets_current_outcome_target_trg
AFTER INSERT OR UPDATE ON cases_school_targets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION cases_validate_target_outcome_state();

CREATE CONSTRAINT TRIGGER cases_targets_current_outcome_outcome_trg
AFTER INSERT OR UPDATE ON cases_case_outcomes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION cases_validate_target_outcome_state();

CREATE CONSTRAINT TRIGGER cases_case_outcomes_revision_trg
AFTER INSERT OR UPDATE ON cases_case_outcomes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION cases_validate_outcome_revisions();

CREATE TRIGGER cases_service_cases_delete_trg
BEFORE DELETE ON cases_service_cases
FOR EACH ROW EXECUTE FUNCTION cases_reject_delete('cases_service_cases_delete_rejected');

CREATE TRIGGER cases_schema_manifests_delete_trg
BEFORE DELETE ON cases_schema_manifests
FOR EACH ROW EXECUTE FUNCTION cases_reject_delete('cases_schema_manifests_delete_rejected');

CREATE TRIGGER cases_assessments_delete_trg
BEFORE DELETE ON cases_assessments
FOR EACH ROW EXECUTE FUNCTION cases_reject_delete('cases_assessments_delete_rejected');

CREATE TRIGGER cases_assessment_answers_delete_trg
BEFORE DELETE ON cases_assessment_answers
FOR EACH ROW EXECUTE FUNCTION cases_reject_delete('cases_assessment_answers_delete_rejected');

CREATE TRIGGER cases_school_targets_delete_trg
BEFORE DELETE ON cases_school_targets
FOR EACH ROW EXECUTE FUNCTION cases_reject_delete('cases_school_targets_delete_rejected');

CREATE TRIGGER cases_case_outcomes_delete_trg
BEFORE DELETE ON cases_case_outcomes
FOR EACH ROW EXECUTE FUNCTION cases_reject_delete('cases_case_outcomes_delete_rejected');
