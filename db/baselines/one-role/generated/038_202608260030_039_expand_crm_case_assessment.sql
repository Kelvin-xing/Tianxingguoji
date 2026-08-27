-- P2-BE-03 corrective migration. Historical migrations remain immutable.
-- Legacy purge/source rows stay readable, while every new write uses the approved CRM/Case contract.

ALTER TABLE crm_students
  ADD COLUMN gender text,
  ADD COLUMN deletion_approved_at timestamptz,
  ADD COLUMN deletion_approved_by_user_id uuid REFERENCES identity_users (id),
  ADD COLUMN deleted_at timestamptz;

ALTER TABLE crm_guardians
  ADD COLUMN date_of_birth date,
  ADD COLUMN gender text,
  ADD COLUMN deletion_approved_at timestamptz,
  ADD COLUMN deletion_approved_by_user_id uuid REFERENCES identity_users (id),
  ADD COLUMN deleted_at timestamptz;

ALTER TABLE crm_students
  DROP CONSTRAINT crm_students_status_check,
  DROP CONSTRAINT crm_students_purged_pii_check,
  DROP CONSTRAINT crm_students_deletion_receipt_check,
  DROP CONSTRAINT crm_students_lifecycle_timestamps_check,
  ADD CONSTRAINT crm_students_status_check
    CHECK (status IN ('active', 'pending_delete', 'deleted', 'purged')),
  ADD CONSTRAINT crm_students_gender_check
    CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'not_disclosed')),
  ADD CONSTRAINT crm_students_profile_check CHECK (
    (status = 'purged' AND display_name IS NULL)
    OR (status <> 'purged' AND display_name IS NOT NULL AND btrim(display_name) <> '')
  ),
  ADD CONSTRAINT crm_students_soft_delete_receipt_check CHECK (
    (status = 'active' AND deletion_requested_at IS NULL AND deletion_requested_by_user_id IS NULL
      AND deletion_reason IS NULL AND deletion_approved_at IS NULL
      AND deletion_approved_by_user_id IS NULL AND deleted_at IS NULL)
    OR (status = 'pending_delete' AND deletion_requested_at IS NOT NULL
      AND deletion_requested_by_user_id IS NOT NULL AND deletion_reason IS NOT NULL
      AND btrim(deletion_reason) <> '' AND deletion_approved_at IS NULL
      AND deletion_approved_by_user_id IS NULL AND deleted_at IS NULL)
    OR (status = 'deleted' AND deletion_requested_at IS NOT NULL
      AND deletion_requested_by_user_id IS NOT NULL AND deletion_reason IS NOT NULL
      AND btrim(deletion_reason) <> '' AND deletion_approved_at IS NOT NULL
      AND deletion_approved_by_user_id IS NOT NULL AND deleted_at IS NOT NULL
      AND deletion_approved_at >= deletion_requested_at AND deleted_at >= deletion_approved_at)
    OR (status = 'purged' AND purge_approved_at IS NOT NULL
      AND purge_approved_by_user_id IS NOT NULL AND purged_at IS NOT NULL)
  ),
  ADD CONSTRAINT crm_students_soft_delete_timestamps_check CHECK (
    updated_at >= COALESCE(deleted_at, purged_at, deletion_approved_at,
      purge_approved_at, deletion_requested_at, created_at)
  );

ALTER TABLE crm_guardians
  DROP CONSTRAINT crm_guardians_status_check,
  DROP CONSTRAINT crm_guardians_purged_pii_check,
  DROP CONSTRAINT crm_guardians_deletion_receipt_check,
  DROP CONSTRAINT crm_guardians_lifecycle_timestamps_check,
  ADD CONSTRAINT crm_guardians_status_check
    CHECK (status IN ('active', 'pending_delete', 'deleted', 'purged')),
  ADD CONSTRAINT crm_guardians_gender_check
    CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'not_disclosed')),
  ADD CONSTRAINT crm_guardians_contact_required_check
    CHECK (email IS NOT NULL OR phone IS NOT NULL) NOT VALID,
  ADD CONSTRAINT crm_guardians_profile_check CHECK (
    (status = 'purged' AND display_name IS NULL)
    OR (status <> 'purged' AND display_name IS NOT NULL AND btrim(display_name) <> '')
  ),
  ADD CONSTRAINT crm_guardians_soft_delete_receipt_check CHECK (
    (status = 'active' AND deletion_requested_at IS NULL AND deletion_requested_by_user_id IS NULL
      AND deletion_reason IS NULL AND deletion_approved_at IS NULL
      AND deletion_approved_by_user_id IS NULL AND deleted_at IS NULL)
    OR (status = 'pending_delete' AND deletion_requested_at IS NOT NULL
      AND deletion_requested_by_user_id IS NOT NULL AND deletion_reason IS NOT NULL
      AND btrim(deletion_reason) <> '' AND deletion_approved_at IS NULL
      AND deletion_approved_by_user_id IS NULL AND deleted_at IS NULL)
    OR (status = 'deleted' AND deletion_requested_at IS NOT NULL
      AND deletion_requested_by_user_id IS NOT NULL AND deletion_reason IS NOT NULL
      AND btrim(deletion_reason) <> '' AND deletion_approved_at IS NOT NULL
      AND deletion_approved_by_user_id IS NOT NULL AND deleted_at IS NOT NULL
      AND deletion_approved_at >= deletion_requested_at AND deleted_at >= deletion_approved_at)
    OR (status = 'purged' AND purge_approved_at IS NOT NULL
      AND purge_approved_by_user_id IS NOT NULL AND purged_at IS NOT NULL)
  ),
  ADD CONSTRAINT crm_guardians_soft_delete_timestamps_check CHECK (
    updated_at >= COALESCE(deleted_at, purged_at, deletion_approved_at,
      purge_approved_at, deletion_requested_at, created_at)
  );

CREATE OR REPLACE FUNCTION crm_validate_student_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'crm_students_immutable_or_version_check',
      MESSAGE = 'student identity and optimistic version are immutable';
  END IF;
  IF OLD.status IN ('deleted', 'purged') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_students_deleted_immutable_check',
      MESSAGE = 'deleted Student history is immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'active' AND NEW.status = 'pending_delete') OR
    (OLD.status = 'pending_delete' AND NEW.status IN ('active', 'deleted'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_students_status_transition_check',
      MESSAGE = 'invalid Student soft-delete transition';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'pending_delete' AND EXISTS (
    SELECT 1 FROM cases_service_cases AS service_case
     WHERE service_case.student_id = OLD.id AND service_case.organization_id = OLD.organization_id
       AND service_case.stage <> 'closed'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_students_open_case_check',
      MESSAGE = 'Student with a non-closed Case cannot enter pending delete';
  END IF;
  IF NEW.status = 'deleted' AND EXISTS (
    SELECT 1 FROM cases_service_cases AS service_case
     WHERE service_case.student_id = OLD.id AND service_case.organization_id = OLD.organization_id
       AND service_case.stage <> 'closed'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_students_open_case_check',
      MESSAGE = 'Student with a non-closed Case cannot be deleted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_validate_guardian_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'crm_guardians_immutable_or_version_check',
      MESSAGE = 'Guardian identity and optimistic version are immutable';
  END IF;
  IF OLD.status IN ('deleted', 'purged') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_guardians_deleted_immutable_check',
      MESSAGE = 'deleted Guardian history is immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'active' AND NEW.status = 'pending_delete') OR
    (OLD.status = 'pending_delete' AND NEW.status IN ('active', 'deleted'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_guardians_status_transition_check',
      MESSAGE = 'invalid Guardian soft-delete transition';
  END IF;
  IF NEW.status IN ('pending_delete', 'deleted') AND EXISTS (
    SELECT 1 FROM crm_student_guardian_relationships AS relationship
     WHERE relationship.guardian_id = OLD.id
       AND relationship.organization_id = OLD.organization_id AND relationship.ends_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_guardians_current_relationship_check',
      MESSAGE = 'Guardian with a current relationship cannot be deleted';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE crm_student_guardian_relationships
  ADD COLUMN relationship_description text;

UPDATE crm_student_guardian_relationships
   SET relationship_type = 'other', relationship_description = 'legacy other guardian'
 WHERE relationship_type = 'other_guardian';

ALTER TABLE crm_student_guardian_relationships
  DROP CONSTRAINT crm_relationships_type_check,
  ADD CONSTRAINT crm_relationships_type_check CHECK (relationship_type IN (
    'parent','father','mother','step_parent','stepfather','stepmother','adoptive_parent',
    'adoptive_father','adoptive_mother','foster_parent','foster_father','foster_mother',
    'grandparent','paternal_grandfather','paternal_grandmother','maternal_grandfather',
    'maternal_grandmother','adult_sibling','adult_brother','adult_sister','uncle','aunt',
    'court_appointed_guardian','institutional_guardian','other_relative',
    'non_relative_guardian','other'
  )),
  ADD CONSTRAINT crm_relationships_other_description_check CHECK (
    (relationship_type = 'other' AND relationship_description IS NOT NULL
      AND btrim(relationship_description) <> '')
    OR (relationship_type <> 'other' AND relationship_description IS NULL)
  );

CREATE OR REPLACE FUNCTION crm_validate_relationship_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE student_status text; guardian_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_relationships_append_only_check',
      MESSAGE = 'relationship history cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT student.status, guardian.status INTO student_status, guardian_status
      FROM crm_students AS student JOIN crm_guardians AS guardian
        ON guardian.id = NEW.guardian_id AND guardian.organization_id = NEW.organization_id
     WHERE student.id = NEW.student_id AND student.organization_id = NEW.organization_id
     FOR SHARE OF student, guardian;
    IF student_status IS DISTINCT FROM 'active' OR guardian_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_relationships_active_parties_check',
        MESSAGE = 'current relationship requires active Student and Guardian';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.student_id IS DISTINCT FROM OLD.student_id OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.relationship_type IS DISTINCT FROM OLD.relationship_type
     OR NEW.relationship_description IS DISTINCT FROM OLD.relationship_description
     OR NEW.is_legal_guardian IS DISTINCT FROM OLD.is_legal_guardian
     OR NEW.is_primary_contact IS DISTINCT FROM OLD.is_primary_contact
     OR NEW.is_emergency_contact IS DISTINCT FROM OLD.is_emergency_contact
     OR NEW.is_billing_contact IS DISTINCT FROM OLD.is_billing_contact
     OR NEW.notification_consent IS DISTINCT FROM OLD.notification_consent
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.ends_at IS NOT NULL OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_relationships_immutable_history_check',
      MESSAGE = 'relationship decisions are append-only';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE crm_referral_sources
  ADD COLUMN description text,
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN deactivated_by_user_id uuid REFERENCES identity_users (id),
  ADD COLUMN deactivation_reason text;

UPDATE crm_referral_sources
   SET status = 'inactive', deactivated_at = updated_at,
       deactivation_reason = 'legacy_source_type_retired'
 WHERE source_type IN ('bank', 'insurance', 'other_partner') AND status = 'active';

ALTER TABLE crm_referral_sources
  DROP CONSTRAINT crm_referral_sources_type_check,
  ADD CONSTRAINT crm_referral_sources_type_check CHECK (
    source_type IN ('customer_referral','employee_referral','school_referral','partner_referral',
      'website','social_media','paid_advertising','event','walk_in','other','unknown')
    OR (status = 'inactive' AND source_type IN ('bank','insurance','other_partner'))
  ),
  ADD CONSTRAINT crm_referral_sources_other_description_check CHECK (
    (source_type = 'other' AND description IS NOT NULL AND btrim(description) <> '')
    OR (source_type <> 'other' AND description IS NULL)
  ),
  ADD CONSTRAINT crm_referral_sources_deactivation_receipt_check CHECK (
    (status = 'active' AND deactivated_at IS NULL AND deactivated_by_user_id IS NULL
      AND deactivation_reason IS NULL)
    OR (status = 'inactive' AND deactivated_at IS NOT NULL
      AND deactivation_reason IS NOT NULL AND btrim(deactivation_reason) <> '')
  ) NOT VALID;

CREATE OR REPLACE FUNCTION crm_validate_referral_source_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_referral_sources_immutable_or_version_check',
      MESSAGE = 'ReferralSource identity and optimistic version are immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status = 'inactive') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'crm_referral_sources_status_transition_check',
      MESSAGE = 'ReferralSource can only be deactivated';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE INSERT, UPDATE, DELETE ON TABLE crm_duplicate_candidates FROM tianxing_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE crm_duplicate_merges FROM tianxing_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE crm_duplicate_alias_revisions FROM tianxing_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE crm_duplicate_field_provenance_revisions FROM tianxing_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE crm_duplicate_merge_corrections FROM tianxing_app;

ALTER TABLE cases_case_referral_source_assignments
  ADD COLUMN source_description text;
ALTER TABLE cases_case_referral_source_assignments
  DROP CONSTRAINT cases_case_referral_source_assignments_type_check,
  ADD CONSTRAINT cases_case_referral_source_assignments_type_check CHECK (
    source_type IN ('customer_referral','employee_referral','school_referral','partner_referral',
      'website','social_media','paid_advertising','event','walk_in','other','unknown',
      'bank','insurance','other_partner')
  );

CREATE TABLE cases_primary_advisor_assignments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  advisor_role_binding_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  advisor_user_id uuid NOT NULL,
  advisor_role text NOT NULL DEFAULT 'advisor',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  ended_by_assignment_id uuid,
  assignment_reason text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_primary_advisor_assignments_case_fk
    FOREIGN KEY (service_case_id, organization_id) REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT cases_primary_advisor_assignments_role_fk
    FOREIGN KEY (advisor_role_binding_id, organization_id, membership_id, advisor_user_id, advisor_role)
    REFERENCES access_role_bindings (id, organization_id, membership_id, user_id, role),
  CONSTRAINT cases_primary_advisor_assignments_tenant_key UNIQUE (id, organization_id),
  CONSTRAINT cases_primary_advisor_assignments_reason_check CHECK (btrim(assignment_reason) <> ''),
  CONSTRAINT cases_primary_advisor_assignments_role_check CHECK (advisor_role = 'advisor'),
  CONSTRAINT cases_primary_advisor_assignments_interval_check CHECK (
    (ends_at IS NULL AND ended_by_assignment_id IS NULL)
    OR (ends_at IS NOT NULL AND ended_by_assignment_id IS NOT NULL AND ends_at >= starts_at)
  ),
  CONSTRAINT cases_primary_advisor_assignments_version_check CHECK (record_version >= 1)
);

CREATE UNIQUE INDEX cases_primary_advisor_assignments_one_current_idx
  ON cases_primary_advisor_assignments (organization_id, service_case_id) WHERE ends_at IS NULL;

INSERT INTO cases_primary_advisor_assignments
  (id, organization_id, service_case_id, advisor_role_binding_id, membership_id,
   advisor_user_id, advisor_role, starts_at, assignment_reason, created_at, updated_at)
SELECT gen_random_uuid(), organization_id, id, primary_role_binding_id, primary_membership_id,
       primary_user_id, 'advisor', created_at, 'legacy_primary_advisor_backfill', created_at, updated_at
  FROM cases_service_cases;

ALTER TABLE cases_service_cases ADD COLUMN current_primary_advisor_assignment_id uuid;
-- one-role baseline: this legacy backfill runs before tenant context exists.
ALTER TABLE cases_service_cases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE cases_service_cases DISABLE ROW LEVEL SECURITY;
GRANT UPDATE (current_primary_advisor_assignment_id)
  ON TABLE cases_service_cases TO tianxing_app;
UPDATE cases_service_cases AS service_case
   SET current_primary_advisor_assignment_id = assignment.id
  FROM cases_primary_advisor_assignments AS assignment
 WHERE assignment.service_case_id = service_case.id
   AND assignment.organization_id = service_case.organization_id AND assignment.ends_at IS NULL;
REVOKE UPDATE (current_primary_advisor_assignment_id)
  ON TABLE cases_service_cases FROM tianxing_app;
ALTER TABLE cases_service_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_service_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE cases_service_cases
  ALTER COLUMN current_primary_advisor_assignment_id SET NOT NULL,
  ADD CONSTRAINT cases_service_cases_primary_assignment_fk
    FOREIGN KEY (current_primary_advisor_assignment_id, organization_id)
    REFERENCES cases_primary_advisor_assignments (id, organization_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION cases_reject_primary_advisor_assignment_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ends_at IS NOT NULL OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.service_case_id IS DISTINCT FROM OLD.service_case_id
     OR NEW.advisor_role_binding_id IS DISTINCT FROM OLD.advisor_role_binding_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.advisor_user_id IS DISTINCT FROM OLD.advisor_user_id
     OR NEW.advisor_role IS DISTINCT FROM OLD.advisor_role
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.assignment_reason IS DISTINCT FROM OLD.assignment_reason
     OR NEW.ends_at IS NULL OR NEW.ended_by_assignment_id IS NULL
     OR NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'cases_primary_advisor_assignments_append_only_check',
      MESSAGE = 'PrimaryAdvisorAssignment history is append-only';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cases_primary_advisor_assignments_immutable_trg
BEFORE UPDATE OR DELETE ON cases_primary_advisor_assignments
FOR EACH ROW EXECUTE FUNCTION cases_reject_primary_advisor_assignment_mutation();

ALTER TABLE cases_primary_advisor_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_primary_advisor_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON cases_primary_advisor_assignments
  FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
REVOKE ALL ON TABLE cases_primary_advisor_assignments FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE cases_primary_advisor_assignments TO tianxing_app;
GRANT UPDATE (ends_at, ended_by_assignment_id, record_version, updated_at)
  ON TABLE cases_primary_advisor_assignments TO tianxing_app;

UPDATE cases_assessments SET status = 'background_complete' WHERE status = 'selection_ready';
ALTER TABLE cases_assessments
  DROP CONSTRAINT cases_assessments_status_check,
  ADD CONSTRAINT cases_assessments_status_check CHECK (status IN ('draft', 'background_complete'));

ALTER TABLE cases_assessment_answers ADD COLUMN revision_number bigint;
UPDATE cases_assessment_answers SET revision_number = record_version;
ALTER TABLE cases_assessment_answers ALTER COLUMN revision_number SET NOT NULL;
ALTER TABLE cases_assessment_answers
  DROP CONSTRAINT cases_answers_identity_key,
  ADD CONSTRAINT cases_answers_revision_check CHECK (revision_number >= 1),
  ADD CONSTRAINT cases_answers_revision_key
    UNIQUE (organization_id, assessment_id, field_id, revision_number);

CREATE FUNCTION cases_reject_assessment_answer_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'cases_assessment_answers_append_only_check',
    MESSAGE = 'Assessment answer revisions are append-only';
END;
$$;
CREATE TRIGGER cases_assessment_answers_append_only_trg
BEFORE UPDATE OR DELETE ON cases_assessment_answers
FOR EACH ROW EXECUTE FUNCTION cases_reject_assessment_answer_mutation();

REVOKE UPDATE, DELETE ON TABLE cases_assessment_answers FROM tianxing_app;
GRANT SELECT, INSERT ON TABLE cases_assessment_answers TO tianxing_app;

ALTER TABLE crm_students FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_guardians FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_student_guardian_relationships FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_referral_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE cases_service_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE cases_assessments FORCE ROW LEVEL SECURITY;
ALTER TABLE cases_assessment_answers FORCE ROW LEVEL SECURITY;
