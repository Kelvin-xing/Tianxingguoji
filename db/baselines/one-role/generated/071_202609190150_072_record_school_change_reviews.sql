-- BR-015 full-business trial reviewers retain their actual grade.
-- Legacy approval records remain intact; the new command writes an immutable
-- decision receipt for both approval and rejection.
ALTER TABLE schools_overlay_revisions DROP CONSTRAINT schools_overlay_revisions_role_check;
ALTER TABLE schools_overlay_revisions ADD CONSTRAINT schools_overlay_revisions_role_check
  CHECK(approved_role IS NULL OR approved_role IN ('founder','l1','data_reviewer'));
CREATE OR REPLACE FUNCTION schools_validate_overlay_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  field_classes text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'candidate' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'schools_overlay_candidate_insert_check',
        MESSAGE = 'overlay revisions must enter as candidate';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.school_id IS DISTINCT FROM OLD.school_id
     OR NEW.base_snapshot_id IS DISTINCT FROM OLD.base_snapshot_id
     OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'schools_overlay_revision_content_immutable_check',
      MESSAGE = 'overlay revision content is immutable';
  END IF;

  IF OLD.status = 'candidate' AND NEW.status = 'approved' THEN
    IF NEW.approved_by_user_id IS NULL
       OR NEW.approved_role IS NULL
       OR NEW.approved_at IS NULL
       OR NEW.approved_by_user_id = NEW.requested_by_user_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'schools_overlay_reviewer_separation_check',
        MESSAGE = 'overlay approval requires a separate reviewer';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM identity_users AS reviewer
        JOIN access_role_bindings AS binding
          ON binding.user_id = reviewer.id
         AND binding.organization_id = NEW.organization_id
         AND binding.role = NEW.approved_role
         AND binding.status = 'active'
       WHERE reviewer.id = NEW.approved_by_user_id
         AND reviewer.status = 'active'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        CONSTRAINT = 'schools_overlay_reviewer_role_check',
        MESSAGE = 'overlay reviewer has no active role binding';
    END IF;

    IF NEW.approved_role='l1' AND NOT EXISTS (
      SELECT 1 FROM access_trial_members
      WHERE organization_id=NEW.organization_id AND user_id=NEW.approved_by_user_id
        AND level='l1' AND status='active'
    ) THEN
      RAISE EXCEPTION USING ERRCODE='42501', CONSTRAINT='schools_overlay_reviewer_role_check',
        MESSAGE='L1 approval requires current trial membership';
    END IF;

    SELECT array_agg(DISTINCT field_class)
      INTO field_classes
      FROM schools_overlay_fields
     WHERE organization_id = NEW.organization_id
       AND revision_id = NEW.id
       AND school_id = NEW.school_id;

    IF field_classes IS NULL OR cardinality(field_classes) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'schools_overlay_fields_required_check',
        MESSAGE = 'overlay approval requires fields';
    END IF;
    IF 'identity' = ANY(field_classes) AND NEW.approved_role NOT IN ('founder','l1') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        CONSTRAINT = 'schools_overlay_identity_founder_check',
        MESSAGE = 'identity overlay changes require Founder approval';
    END IF;
  ELSIF OLD.status = 'candidate' AND NEW.status = 'rejected' THEN
    IF NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'schools_overlay_rejection_receipt_check',
        MESSAGE = 'rejected overlay cannot carry approval receipt';
    END IF;
  ELSIF OLD.status = 'approved' AND NEW.status = 'disabled' THEN
    IF NEW.disabled_by_user_id IS NULL
       OR NEW.disabled_at IS NULL
       OR NEW.disable_reason IS NULL
       OR btrim(NEW.disable_reason) = ''
       OR NEW.disabled_by_user_id = NEW.requested_by_user_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'schools_overlay_disable_receipt_check',
        MESSAGE = 'overlay disable requires separate actor, time, and reason';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM identity_users AS disabler
        JOIN access_role_bindings AS binding
          ON binding.user_id = disabler.id
         AND binding.organization_id = NEW.organization_id
         AND binding.role IN ('founder', 'data_reviewer')
         AND binding.status = 'active'
       WHERE disabler.id = NEW.disabled_by_user_id
         AND disabler.status = 'active'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        CONSTRAINT = 'schools_overlay_disabler_role_check',
        MESSAGE = 'overlay rollback requires an active Founder or Data Reviewer';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'schools_overlay_status_transition_check',
      MESSAGE = 'overlay status transition is not allowed';
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF current_user='tianxing_app' THEN
    GRANT REFERENCES ON schools_overlay_revisions,schools_resolved_revisions,identity_users TO tianxing_app;
  END IF;
END; $$;
CREATE TABLE schools_change_review_receipts (
  revision_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  reviewed_by_user_id uuid NOT NULL REFERENCES identity_users(id),
  reviewer_role text NOT NULL CHECK(reviewer_role IN ('founder','l1')),
  decision text NOT NULL CHECK(decision IN ('approve','reject')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1024),
  record_version bigint NOT NULL CHECK(record_version>=2),
  resolved_revision_id uuid,
  reviewed_at timestamptz NOT NULL,
  FOREIGN KEY(revision_id,organization_id,school_id) REFERENCES schools_overlay_revisions(id,organization_id,school_id),
  FOREIGN KEY(resolved_revision_id,organization_id,school_id) REFERENCES schools_resolved_revisions(id,organization_id,school_id),
  CONSTRAINT schools_review_resolution_check CHECK((decision='approve')=(resolved_revision_id IS NOT NULL))
);
CREATE FUNCTION schools_validate_change_review_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision schools_overlay_revisions%ROWTYPE;
BEGIN
  SELECT * INTO revision FROM schools_overlay_revisions
    WHERE id=NEW.revision_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id;
  IF revision.id IS NULL OR revision.requested_by_user_id=NEW.reviewed_by_user_id
    OR NEW.reviewed_by_user_id::text IS DISTINCT FROM current_setting('app.actor_user_id',true)
    OR revision.record_version<>NEW.record_version
    OR revision.status<>(CASE WHEN NEW.decision='approve' THEN 'approved' ELSE 'rejected' END)
    OR (NEW.decision='approve' AND (revision.approved_by_user_id IS DISTINCT FROM NEW.reviewed_by_user_id
      OR revision.approved_role IS DISTINCT FROM NEW.reviewer_role OR revision.approved_at IS DISTINCT FROM NEW.reviewed_at))
    OR NOT EXISTS (
      SELECT 1 FROM identity_users actor
      JOIN access_organization_memberships membership ON membership.user_id=actor.id AND membership.organization_id=NEW.organization_id AND membership.status='active'
      JOIN access_organizations organization ON organization.id=NEW.organization_id AND organization.status='active'
      JOIN access_role_bindings binding ON binding.membership_id=membership.id AND binding.user_id=actor.id AND binding.organization_id=NEW.organization_id AND binding.status='active' AND binding.role=NEW.reviewer_role
      LEFT JOIN access_trial_members trial ON trial.organization_id=NEW.organization_id AND trial.user_id=actor.id
      WHERE actor.id=NEW.reviewed_by_user_id AND actor.status='active'
        AND ((trial.user_id IS NULL AND NEW.reviewer_role='founder') OR (trial.status='active' AND trial.level=NEW.reviewer_role))
    ) THEN
    RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='schools_change_review_receipt_check',MESSAGE='school review receipt does not match an authorized decision';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER schools_change_review_receipt_check BEFORE INSERT ON schools_change_review_receipts
  FOR EACH ROW EXECUTE FUNCTION schools_validate_change_review_receipt();
ALTER TABLE schools_change_review_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools_change_review_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON schools_change_review_receipts
  USING(organization_id::text=current_setting('app.organization_id',true))
  WITH CHECK(organization_id::text=current_setting('app.organization_id',true));
CREATE TRIGGER schools_change_review_immutable BEFORE UPDATE OR DELETE ON schools_change_review_receipts
  FOR EACH ROW EXECUTE FUNCTION schools_reject_immutable_delete('schools_change_review_immutable');
CREATE TRIGGER schools_change_review_no_truncate BEFORE TRUNCATE ON schools_change_review_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION schools_reject_immutable_delete('schools_change_review_immutable');
REVOKE ALL ON schools_change_review_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON schools_change_review_receipts TO tianxing_app;
DO $$ BEGIN
  IF current_user='tianxing_app' THEN
    REVOKE REFERENCES ON schools_overlay_revisions,schools_resolved_revisions,identity_users FROM tianxing_app;
  END IF;
END; $$;
