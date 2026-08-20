CREATE TABLE crm_referral_sources (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  display_name text NOT NULL,
  source_type text NOT NULL,
  status text NOT NULL,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT crm_referral_sources_display_name_check CHECK (btrim(display_name) <> ''),
  CONSTRAINT crm_referral_sources_type_check CHECK (btrim(source_type) <> ''),
  CONSTRAINT crm_referral_sources_status_check CHECK (status IN ('active', 'inactive')),
  CONSTRAINT crm_referral_sources_record_version_check CHECK (record_version >= 1),
  CONSTRAINT crm_referral_sources_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT crm_referral_sources_tenant_key UNIQUE (id, organization_id)
);

CREATE TABLE crm_students (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  display_name text,
  date_of_birth date,
  contact_email text,
  contact_phone text,
  status text NOT NULL,
  deletion_requested_at timestamptz,
  deletion_requested_by_user_id uuid REFERENCES identity_users (id),
  deletion_reason text,
  purge_approved_at timestamptz,
  purge_approved_by_user_id uuid REFERENCES identity_users (id),
  purged_at timestamptz,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT crm_students_status_check CHECK (
    status IN ('active', 'pending_delete', 'purged')
  ),
  CONSTRAINT crm_students_contact_email_check CHECK (
    contact_email IS NULL OR btrim(contact_email) <> ''
  ),
  CONSTRAINT crm_students_contact_phone_check CHECK (
    contact_phone IS NULL OR btrim(contact_phone) <> ''
  ),
  CONSTRAINT crm_students_purged_pii_check CHECK (
    (
      status = 'purged'
      AND display_name IS NULL
      AND date_of_birth IS NULL
      AND contact_email IS NULL
      AND contact_phone IS NULL
    )
    OR (
      status <> 'purged'
      AND display_name IS NOT NULL
      AND btrim(display_name) <> ''
    )
  ),
  CONSTRAINT crm_students_deletion_receipt_check CHECK (
    (
      status = 'active'
      AND deletion_requested_at IS NULL
      AND deletion_requested_by_user_id IS NULL
      AND deletion_reason IS NULL
      AND purge_approved_at IS NULL
      AND purge_approved_by_user_id IS NULL
      AND purged_at IS NULL
    )
    OR (
      status = 'pending_delete'
      AND deletion_requested_at IS NOT NULL
      AND deletion_requested_by_user_id IS NOT NULL
      AND deletion_reason IS NOT NULL
      AND btrim(deletion_reason) <> ''
      AND purge_approved_at IS NULL
      AND purge_approved_by_user_id IS NULL
      AND purged_at IS NULL
    )
    OR (
      status = 'purged'
      AND deletion_requested_at IS NOT NULL
      AND deletion_requested_by_user_id IS NOT NULL
      AND deletion_reason IS NULL
      AND purge_approved_at IS NOT NULL
      AND purge_approved_by_user_id IS NOT NULL
      AND purged_at IS NOT NULL
      AND purge_approved_at >= deletion_requested_at
      AND purged_at >= purge_approved_at
    )
  ),
  CONSTRAINT crm_students_lifecycle_timestamps_check CHECK (
    (deletion_requested_at IS NULL OR deletion_requested_at >= created_at)
    AND (purge_approved_at IS NULL OR purge_approved_at >= deletion_requested_at)
    AND (purged_at IS NULL OR purged_at >= purge_approved_at)
    AND updated_at >= COALESCE(
      purged_at,
      purge_approved_at,
      deletion_requested_at,
      created_at
    )
  ),
  CONSTRAINT crm_students_record_version_check CHECK (record_version >= 1),
  CONSTRAINT crm_students_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT crm_students_tenant_key UNIQUE (id, organization_id)
);

CREATE TABLE crm_guardians (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  display_name text,
  email text,
  phone text,
  status text NOT NULL,
  deletion_requested_at timestamptz,
  deletion_requested_by_user_id uuid REFERENCES identity_users (id),
  deletion_reason text,
  purge_approved_at timestamptz,
  purge_approved_by_user_id uuid REFERENCES identity_users (id),
  purged_at timestamptz,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT crm_guardians_status_check CHECK (
    status IN ('active', 'pending_delete', 'purged')
  ),
  CONSTRAINT crm_guardians_email_check CHECK (email IS NULL OR btrim(email) <> ''),
  CONSTRAINT crm_guardians_phone_check CHECK (phone IS NULL OR btrim(phone) <> ''),
  CONSTRAINT crm_guardians_purged_pii_check CHECK (
    (
      status = 'purged'
      AND display_name IS NULL
      AND email IS NULL
      AND phone IS NULL
    )
    OR (
      status <> 'purged'
      AND display_name IS NOT NULL
      AND btrim(display_name) <> ''
    )
  ),
  CONSTRAINT crm_guardians_deletion_receipt_check CHECK (
    (
      status = 'active'
      AND deletion_requested_at IS NULL
      AND deletion_requested_by_user_id IS NULL
      AND deletion_reason IS NULL
      AND purge_approved_at IS NULL
      AND purge_approved_by_user_id IS NULL
      AND purged_at IS NULL
    )
    OR (
      status = 'pending_delete'
      AND deletion_requested_at IS NOT NULL
      AND deletion_requested_by_user_id IS NOT NULL
      AND deletion_reason IS NOT NULL
      AND btrim(deletion_reason) <> ''
      AND purge_approved_at IS NULL
      AND purge_approved_by_user_id IS NULL
      AND purged_at IS NULL
    )
    OR (
      status = 'purged'
      AND deletion_requested_at IS NOT NULL
      AND deletion_requested_by_user_id IS NOT NULL
      AND deletion_reason IS NULL
      AND purge_approved_at IS NOT NULL
      AND purge_approved_by_user_id IS NOT NULL
      AND purged_at IS NOT NULL
      AND purge_approved_at >= deletion_requested_at
      AND purged_at >= purge_approved_at
    )
  ),
  CONSTRAINT crm_guardians_lifecycle_timestamps_check CHECK (
    (deletion_requested_at IS NULL OR deletion_requested_at >= created_at)
    AND (purge_approved_at IS NULL OR purge_approved_at >= deletion_requested_at)
    AND (purged_at IS NULL OR purged_at >= purge_approved_at)
    AND updated_at >= COALESCE(
      purged_at,
      purge_approved_at,
      deletion_requested_at,
      created_at
    )
  ),
  CONSTRAINT crm_guardians_record_version_check CHECK (record_version >= 1),
  CONSTRAINT crm_guardians_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT crm_guardians_tenant_key UNIQUE (id, organization_id)
);

CREATE TABLE crm_student_guardian_relationships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  student_id uuid NOT NULL,
  guardian_id uuid NOT NULL,
  relationship_type text NOT NULL,
  is_legal_guardian boolean NOT NULL,
  is_primary_contact boolean NOT NULL,
  is_emergency_contact boolean NOT NULL,
  is_billing_contact boolean NOT NULL,
  notification_consent boolean NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  ended_by_user_id uuid REFERENCES identity_users (id),
  end_reason text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT crm_relationships_student_fk FOREIGN KEY (student_id, organization_id)
    REFERENCES crm_students (id, organization_id),
  CONSTRAINT crm_relationships_guardian_fk FOREIGN KEY (guardian_id, organization_id)
    REFERENCES crm_guardians (id, organization_id),
  CONSTRAINT crm_relationships_type_check CHECK (btrim(relationship_type) <> ''),
  CONSTRAINT crm_relationships_effective_interval_check CHECK (
    starts_at <= created_at
    AND (ends_at IS NULL OR (ends_at > starts_at AND ends_at <= updated_at))
  ),
  CONSTRAINT crm_relationships_end_receipt_check CHECK (
    (
      ends_at IS NULL
      AND ended_by_user_id IS NULL
      AND end_reason IS NULL
    )
    OR (
      ends_at IS NOT NULL
      AND ended_by_user_id IS NOT NULL
      AND end_reason IS NOT NULL
      AND btrim(end_reason) <> ''
    )
  ),
  CONSTRAINT crm_relationships_record_version_check CHECK (record_version >= 1),
  CONSTRAINT crm_relationships_timestamps_check CHECK (updated_at >= created_at),
  CONSTRAINT crm_relationships_tenant_key UNIQUE (id, organization_id)
);

CREATE UNIQUE INDEX crm_relationships_one_current_pair_idx
  ON crm_student_guardian_relationships (student_id, guardian_id)
  WHERE ends_at IS NULL;

CREATE UNIQUE INDEX crm_relationships_one_current_primary_idx
  ON crm_student_guardian_relationships (student_id)
  WHERE is_primary_contact AND ends_at IS NULL;

CREATE FUNCTION crm_validate_referral_source_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_referral_sources_identity_immutable_check',
      MESSAGE = 'referral source identity is immutable';
  END IF;

  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_referral_sources_record_version_transition_check',
      MESSAGE = 'record_version must increase exactly once';
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_referral_sources_updated_at_transition_check',
      MESSAGE = 'updated_at cannot move backward';
  END IF;

  IF NEW.status <> OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status = 'inactive') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_referral_sources_status_transition_check',
      MESSAGE = 'invalid referral source status transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_referral_sources_validate_update
BEFORE UPDATE ON crm_referral_sources
FOR EACH ROW
EXECUTE FUNCTION crm_validate_referral_source_update();

CREATE FUNCTION crm_validate_student_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_students_identity_immutable_check',
      MESSAGE = 'student identity is immutable';
  END IF;

  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_students_record_version_transition_check',
      MESSAGE = 'record_version must increase exactly once';
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_students_updated_at_transition_check',
      MESSAGE = 'updated_at cannot move backward';
  END IF;

  IF NEW.status <> OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status = 'pending_delete')
     AND NOT (OLD.status = 'pending_delete' AND NEW.status = 'purged') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_students_status_transition_check',
      MESSAGE = 'invalid student status transition';
  END IF;

  IF OLD.status = 'purged' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_students_purged_immutable_check',
      MESSAGE = 'purged student tombstone is immutable';
  END IF;

  IF NEW.status = 'purged'
     AND EXISTS (
       SELECT 1
         FROM crm_student_guardian_relationships
        WHERE student_id = NEW.id
          AND ends_at IS NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_students_purge_current_relationship_check',
      MESSAGE = 'student purge requires all current relationships to be closed';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_students_validate_update
BEFORE UPDATE ON crm_students
FOR EACH ROW
EXECUTE FUNCTION crm_validate_student_update();

CREATE FUNCTION crm_validate_guardian_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_guardians_identity_immutable_check',
      MESSAGE = 'guardian identity is immutable';
  END IF;

  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_guardians_record_version_transition_check',
      MESSAGE = 'record_version must increase exactly once';
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_guardians_updated_at_transition_check',
      MESSAGE = 'updated_at cannot move backward';
  END IF;

  IF NEW.status <> OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status = 'pending_delete')
     AND NOT (OLD.status = 'pending_delete' AND NEW.status = 'purged') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_guardians_status_transition_check',
      MESSAGE = 'invalid guardian status transition';
  END IF;

  IF OLD.status = 'purged' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_guardians_purged_immutable_check',
      MESSAGE = 'purged guardian tombstone is immutable';
  END IF;

  IF NEW.status = 'purged'
     AND EXISTS (
       SELECT 1
         FROM crm_student_guardian_relationships
        WHERE guardian_id = NEW.id
          AND ends_at IS NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_guardians_purge_current_relationship_check',
      MESSAGE = 'guardian purge requires all current relationships to be closed';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_guardians_validate_update
BEFORE UPDATE ON crm_guardians
FOR EACH ROW
EXECUTE FUNCTION crm_validate_guardian_update();

CREATE FUNCTION crm_validate_relationship_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_student_status text;
  current_guardian_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_relationships_delete_history_check',
      MESSAGE = 'relationship history cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT student.status, guardian.status
      INTO current_student_status, current_guardian_status
      FROM crm_students AS student
      JOIN crm_guardians AS guardian
        ON guardian.id = NEW.guardian_id
       AND guardian.organization_id = NEW.organization_id
     WHERE student.id = NEW.student_id
       AND student.organization_id = NEW.organization_id
       FOR SHARE OF student, guardian;

    IF current_student_status IS DISTINCT FROM 'active'
       OR current_guardian_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'crm_relationships_active_parties_check',
        MESSAGE = 'current relationship requires active Student and Guardian';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.relationship_type IS DISTINCT FROM OLD.relationship_type
     OR NEW.is_legal_guardian IS DISTINCT FROM OLD.is_legal_guardian
     OR NEW.is_primary_contact IS DISTINCT FROM OLD.is_primary_contact
     OR NEW.is_emergency_contact IS DISTINCT FROM OLD.is_emergency_contact
     OR NEW.is_billing_contact IS DISTINCT FROM OLD.is_billing_contact
     OR NEW.notification_consent IS DISTINCT FROM OLD.notification_consent
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_relationships_immutable_history_check',
      MESSAGE = 'relationship decision fields are immutable';
  END IF;

  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_relationships_record_version_transition_check',
      MESSAGE = 'record_version must increase exactly once';
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_relationships_updated_at_transition_check',
      MESSAGE = 'updated_at cannot move backward';
  END IF;

  IF OLD.ends_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'crm_relationships_immutable_history_check',
      MESSAGE = 'closed relationship history is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_relationships_validate_insert
BEFORE INSERT ON crm_student_guardian_relationships
FOR EACH ROW
EXECUTE FUNCTION crm_validate_relationship_write();

CREATE TRIGGER crm_relationships_validate_update
BEFORE UPDATE ON crm_student_guardian_relationships
FOR EACH ROW
EXECUTE FUNCTION crm_validate_relationship_write();

CREATE TRIGGER crm_relationships_reject_delete
BEFORE DELETE ON crm_student_guardian_relationships
FOR EACH ROW
EXECUTE FUNCTION crm_validate_relationship_write();

CREATE FUNCTION crm_reject_authoritative_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = TG_TABLE_NAME || '_delete_lifecycle_check',
    MESSAGE = 'CRM identity rows must use the approved purge lifecycle';
END;
$$;

CREATE TRIGGER crm_referral_sources_reject_delete
BEFORE DELETE ON crm_referral_sources
FOR EACH ROW
EXECUTE FUNCTION crm_reject_authoritative_delete();

CREATE TRIGGER crm_students_reject_delete
BEFORE DELETE ON crm_students
FOR EACH ROW
EXECUTE FUNCTION crm_reject_authoritative_delete();

CREATE TRIGGER crm_guardians_reject_delete
BEFORE DELETE ON crm_guardians
FOR EACH ROW
EXECUTE FUNCTION crm_reject_authoritative_delete();

CREATE FUNCTION crm_assert_student_primary_contact(target_student_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  current_student_status text;
  current_primary_count integer;
BEGIN
  SELECT status
    INTO current_student_status
    FROM crm_students
   WHERE id = target_student_id;

  IF current_student_status = 'active' THEN
    SELECT count(*)::integer
      INTO current_primary_count
      FROM crm_student_guardian_relationships AS relationship
      JOIN crm_guardians AS guardian
        ON guardian.id = relationship.guardian_id
       AND guardian.organization_id = relationship.organization_id
     WHERE relationship.student_id = target_student_id
       AND relationship.is_primary_contact
       AND relationship.ends_at IS NULL
       AND guardian.status = 'active';

    IF current_primary_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'crm_students_current_primary_contact_check',
        MESSAGE = 'active Student requires exactly one current primary Guardian';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION crm_validate_deferred_primary_contact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_student record;
BEGIN
  IF TG_TABLE_NAME = 'crm_students' THEN
    PERFORM crm_assert_student_primary_contact(NEW.id);
  ELSIF TG_TABLE_NAME = 'crm_student_guardian_relationships' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM crm_assert_student_primary_contact(NEW.student_id);
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM crm_assert_student_primary_contact(OLD.student_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'crm_guardians' THEN
    FOR affected_student IN
      SELECT DISTINCT student_id
        FROM crm_student_guardian_relationships
       WHERE guardian_id = NEW.id
         AND is_primary_contact
         AND ends_at IS NULL
    LOOP
      PERFORM crm_assert_student_primary_contact(affected_student.student_id);
    END LOOP;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER crm_students_require_primary_contact
AFTER INSERT OR UPDATE ON crm_students
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION crm_validate_deferred_primary_contact();

CREATE CONSTRAINT TRIGGER crm_relationships_require_primary_contact
AFTER INSERT OR UPDATE OR DELETE ON crm_student_guardian_relationships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION crm_validate_deferred_primary_contact();

CREATE CONSTRAINT TRIGGER crm_guardians_preserve_primary_contact
AFTER UPDATE ON crm_guardians
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION crm_validate_deferred_primary_contact();
