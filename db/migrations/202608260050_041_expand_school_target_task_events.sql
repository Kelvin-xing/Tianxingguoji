-- P3-BE-05 corrective schema. Historical policy rows remain readable, but
-- new Release 1 writes use the fixed state machine and append-only facts.
ALTER TABLE cases_school_targets
  ADD COLUMN IF NOT EXISTS current_assignment_id uuid,
  ADD COLUMN IF NOT EXISTS application_deadline timestamptz;
ALTER TABLE cases_school_targets DROP CONSTRAINT IF EXISTS cases_targets_state_check;
ALTER TABLE cases_school_targets ADD CONSTRAINT cases_targets_state_check CHECK (state IN (
  'candidate','preparing','submitted','interview','waitlisted','accepted',
  'offer_confirmed','offer_declined','rejected','withdrawn'));

CREATE TABLE IF NOT EXISTS cases_school_target_assignments (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, service_case_id uuid NOT NULL,
  school_target_id uuid NOT NULL, assignee_user_id uuid NOT NULL REFERENCES identity_users(id),
  assignee_role text NOT NULL DEFAULT 'advisor',
  assignee_membership_id uuid NOT NULL, advisor_role_binding_id uuid NOT NULL,
  case_collaborator_id uuid, assigned_by_user_id uuid NOT NULL REFERENCES identity_users(id),
  assignment_reason text NOT NULL, starts_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  ends_at timestamptz, ended_by_assignment_id uuid, record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_target_assignments_target_fk FOREIGN KEY
    (school_target_id, organization_id, service_case_id)
    REFERENCES cases_school_targets(id, organization_id, service_case_id),
  CONSTRAINT cases_target_assignments_membership_fk FOREIGN KEY
    (assignee_membership_id, organization_id, assignee_user_id)
    REFERENCES access_organization_memberships(id, organization_id, user_id),
  CONSTRAINT cases_target_assignments_binding_fk FOREIGN KEY
    (advisor_role_binding_id, organization_id, assignee_membership_id, assignee_user_id, assignee_role)
    REFERENCES access_role_bindings(id, organization_id, membership_id, user_id, role),
  CONSTRAINT cases_target_assignments_reason_check CHECK (btrim(assignment_reason) <> ''),
  CONSTRAINT cases_target_assignments_role_check CHECK (assignee_role IN ('advisor','contractor')),
  CONSTRAINT cases_target_assignments_time_check CHECK (ends_at IS NULL OR ends_at >= starts_at),
  CONSTRAINT cases_target_assignments_composite_key UNIQUE (id, organization_id, school_target_id)
);
ALTER TABLE cases_school_target_assignments DROP CONSTRAINT IF EXISTS cases_target_assignments_role_check;
ALTER TABLE cases_school_target_assignments ADD CONSTRAINT cases_target_assignments_role_check
  CHECK (assignee_role IN ('advisor','contractor'));
CREATE UNIQUE INDEX IF NOT EXISTS cases_target_assignments_one_current_idx
  ON cases_school_target_assignments(organization_id, school_target_id) WHERE ends_at IS NULL;
ALTER TABLE cases_school_targets ADD CONSTRAINT cases_targets_current_assignment_fk FOREIGN KEY
  (current_assignment_id, organization_id, id)
  REFERENCES cases_school_target_assignments(id, organization_id, school_target_id);

CREATE TABLE IF NOT EXISTS cases_school_target_transition_facts (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, service_case_id uuid NOT NULL,
  school_target_id uuid NOT NULL, transition_kind text NOT NULL, from_state text,
  to_state text NOT NULL, actor_user_id uuid REFERENCES identity_users(id), assignment_id uuid,
  from_record_version bigint, to_record_version bigint NOT NULL, application_deadline timestamptz,
  submission_task_id uuid, task_completion_receipt_id uuid, submission_channel text,
  submitted_at timestamptz, official_submission_reference text, no_reference_declared boolean,
  alternative_evidence_document_id uuid, interview_at timestamptz,
  invitation_evidence_document_id uuid, reason text, occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_target_facts_target_fk FOREIGN KEY
    (school_target_id, organization_id, service_case_id)
    REFERENCES cases_school_targets(id, organization_id, service_case_id),
  CONSTRAINT cases_target_facts_kind_check CHECK (transition_kind IN ('created','workflow','correction')),
  CONSTRAINT cases_target_facts_submission_check CHECK (
    to_state <> 'submitted' OR (submitted_at IS NOT NULL AND submission_channel IS NOT NULL AND
      ((official_submission_reference IS NOT NULL AND no_reference_declared = false) OR
       (official_submission_reference IS NULL AND no_reference_declared = true AND
        alternative_evidence_document_id IS NOT NULL)))
  ),
  CONSTRAINT cases_target_facts_version_check CHECK (to_record_version >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS cases_target_facts_version_idx
  ON cases_school_target_transition_facts(organization_id, school_target_id, to_record_version);

ALTER TABLE tasks_tasks
  ADD COLUMN IF NOT EXISTS task_key text,
  ADD COLUMN IF NOT EXISTS task_kind text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS school_target_id uuid,
  ADD COLUMN IF NOT EXISTS creation_trigger text NOT NULL DEFAULT 'advisor_manual',
  ADD COLUMN IF NOT EXISTS source_event_id uuid,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE tasks_tasks DROP CONSTRAINT IF EXISTS tasks_tasks_state_check;
ALTER TABLE tasks_tasks ADD CONSTRAINT tasks_tasks_state_check CHECK (state IN (
  'assigned','accepted','awaiting_reassignment','completed','cancelled'));
ALTER TABLE tasks_tasks DROP CONSTRAINT IF EXISTS tasks_tasks_kind_check;
ALTER TABLE tasks_tasks ADD CONSTRAINT tasks_tasks_kind_check CHECK (task_kind IN (
  'manual','application_prepare_submit','interview_support'));
ALTER TABLE tasks_tasks ADD CONSTRAINT tasks_tasks_creation_trigger_check
  CHECK (creation_trigger IN ('case_event','advisor_manual'));
CREATE UNIQUE INDEX IF NOT EXISTS tasks_task_business_key_idx
  ON tasks_tasks(organization_id, task_key) WHERE task_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_active_target_kind_idx
  ON tasks_tasks(organization_id, school_target_id, task_kind)
  WHERE task_kind <> 'manual' AND state NOT IN ('completed','cancelled');

ALTER TABLE tasks_task_assignments
  ADD COLUMN IF NOT EXISTS assignee_membership_id uuid,
  ADD COLUMN IF NOT EXISTS assignee_role_binding_id uuid,
  ADD COLUMN IF NOT EXISTS case_collaborator_id uuid,
  ADD COLUMN IF NOT EXISTS assigned_by_actor_kind text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS assigned_by_actor_id uuid,
  ADD COLUMN IF NOT EXISTS assignment_reason text,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS ended_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS end_reason text,
  ADD COLUMN IF NOT EXISTS record_version bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT transaction_timestamp();
ALTER TABLE tasks_task_assignments DROP CONSTRAINT IF EXISTS tasks_task_assignments_status_check;
ALTER TABLE tasks_task_assignments ADD CONSTRAINT tasks_task_assignments_status_check CHECK
  (status IN ('assigned','accepted','rejected','reassigned','cancelled','removed'));
CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_current_assignment_idx
  ON tasks_task_assignments(organization_id, task_id) WHERE ended_at IS NULL;

ALTER TABLE tasks_task_transition_receipts
  ADD COLUMN IF NOT EXISTS assignment_id uuid,
  ADD COLUMN IF NOT EXISTS actor_kind text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS completion_record_json jsonb,
  ADD COLUMN IF NOT EXISTS evidence_reference text,
  ADD COLUMN IF NOT EXISTS source_event_id uuid,
  ADD COLUMN IF NOT EXISTS occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp();
ALTER TABLE tasks_task_transition_receipts DROP CONSTRAINT IF EXISTS tasks_transition_receipts_state_check;
ALTER TABLE tasks_task_transition_receipts ADD CONSTRAINT tasks_transition_receipts_state_check CHECK (
  from_state IN ('assigned','accepted','awaiting_reassignment','completed','cancelled') AND
  to_state IN ('assigned','accepted','awaiting_reassignment','completed','cancelled') AND
  from_state <> to_state);
ALTER TABLE tasks_task_transition_receipts ADD CONSTRAINT tasks_completion_record_by_kind_check
  CHECK (to_state <> 'completed' OR completion_record_json IS NOT NULL);
DROP TRIGGER IF EXISTS tasks_tasks_write_trg ON tasks_tasks;
DROP TRIGGER IF EXISTS tasks_transition_receipts_write_trg ON tasks_task_transition_receipts;
DROP TRIGGER IF EXISTS tasks_assignments_update_trg ON tasks_task_assignments;

ALTER TABLE cases_service_case_transition_facts
  DROP CONSTRAINT IF EXISTS cases_service_case_transition_facts_direction_check;
ALTER TABLE cases_service_case_transition_facts ADD CONSTRAINT cases_service_case_transition_facts_direction_check CHECK (
  (from_stage = 'signed' AND to_stage = 'background_collection' AND reason IS NULL)
  OR (from_stage = 'background_collection' AND to_stage = 'school_selection_confirmed' AND reason = 'candidate_list_confirmed')
  OR (from_stage = 'school_selection_confirmed' AND to_stage = 'application_in_progress' AND reason = 'target_preparing')
  OR (from_stage IN ('background_collection','school_selection_confirmed','application_in_progress') AND to_stage = 'closed' AND reason = 'founder_manual_close')
);

CREATE OR REPLACE FUNCTION cases_validate_service_case_stage_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM public.cases_service_case_transition_facts AS fact
     WHERE fact.organization_id=NEW.organization_id AND fact.service_case_id=NEW.id
       AND fact.actor_user_id=nullif(current_setting('app.actor_user_id',true),'')::uuid
       AND fact.from_stage=OLD.stage AND fact.to_stage=NEW.stage
       AND fact.from_record_version=OLD.record_version
       AND fact.to_record_version=NEW.record_version
       AND ((OLD.stage='signed' AND NEW.stage='background_collection' AND fact.reason IS NULL)
         OR (OLD.stage='background_collection' AND NEW.stage='school_selection_confirmed' AND fact.reason='candidate_list_confirmed')
         OR (OLD.stage='school_selection_confirmed' AND NEW.stage='application_in_progress' AND fact.reason='target_preparing')
         OR (OLD.stage IN ('background_collection','school_selection_confirmed','application_in_progress')
           AND NEW.stage='closed' AND fact.reason='founder_manual_close'))
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='cases_service_cases_stage_direction_check',
    MESSAGE='ServiceCase stage direction is not enabled';
END;
$$;

ALTER TABLE tasks_tasks ADD CONSTRAINT tasks_tasks_school_target_fk
  FOREIGN KEY (school_target_id, organization_id, service_case_id)
  REFERENCES cases_school_targets(id, organization_id, service_case_id);
ALTER TABLE tasks_tasks ADD CONSTRAINT tasks_tasks_target_kind_check CHECK (
  (task_kind = 'manual' AND school_target_id IS NULL) OR
  (task_kind IN ('application_prepare_submit','interview_support') AND school_target_id IS NOT NULL)
);

-- Deferred so the CandidateList function has finished binding all target items.
CREATE OR REPLACE FUNCTION cases_promote_confirmed_targets_to_preparing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE item record; target record; assignment_id uuid; fact_id uuid; outbox_id uuid;
  actor_id uuid := nullif(current_setting('app.actor_user_id', true), '')::uuid;
BEGIN
  IF NEW.status <> 'confirmed' OR OLD.status = 'confirmed' THEN RETURN NEW; END IF;
  FOR item IN SELECT i.* FROM cases_candidate_school_list_items i
    WHERE i.list_version_id=NEW.id AND i.organization_id=NEW.organization_id ORDER BY i.ordinal LOOP
    SELECT t.* INTO target FROM cases_school_targets t
      WHERE t.id=item.school_target_id AND t.organization_id=NEW.organization_id FOR UPDATE;
    IF NOT FOUND OR target.state <> 'candidate' THEN CONTINUE; END IF;
    assignment_id := gen_random_uuid(); fact_id := gen_random_uuid(); outbox_id := gen_random_uuid();
    INSERT INTO cases_school_target_assignments
      (id,organization_id,service_case_id,school_target_id,assignee_user_id,
       assignee_membership_id,advisor_role_binding_id,assigned_by_user_id,assignment_reason)
    SELECT assignment_id,target.organization_id,target.service_case_id,target.id,
      c.primary_user_id,c.primary_membership_id,c.primary_role_binding_id,
      COALESCE(actor_id,c.primary_user_id),'confirmed_list'
      FROM cases_service_cases c WHERE c.id=target.service_case_id;
    UPDATE cases_school_targets SET state='preparing',current_assignment_id=assignment_id,
      record_version=record_version+1,updated_at=transaction_timestamp() WHERE id=target.id;
    INSERT INTO cases_school_target_transition_facts
      (id,organization_id,service_case_id,school_target_id,transition_kind,from_state,to_state,
       actor_user_id,assignment_id,from_record_version,to_record_version,occurred_at)
    VALUES (fact_id,target.organization_id,target.service_case_id,target.id,'workflow','candidate',
      'preparing',actor_id,assignment_id,target.record_version,target.record_version+1,transaction_timestamp());
    INSERT INTO cases_service_case_transition_facts
      (id,organization_id,service_case_id,actor_user_id,from_stage,to_stage,
       from_record_version,to_record_version,reason,transitioned_at,created_at)
    SELECT gen_random_uuid(),c.organization_id,c.id,COALESCE(actor_id,c.primary_user_id),
      c.stage,'application_in_progress',c.record_version,c.record_version+1,
      'target_preparing',transaction_timestamp(),transaction_timestamp()
      FROM cases_service_cases c
     WHERE c.id=target.service_case_id AND c.organization_id=target.organization_id
       AND c.stage='school_selection_confirmed';
    PERFORM set_config('app.case_stage_transition','authorized',true);
    UPDATE cases_service_cases SET stage='application_in_progress',record_version=record_version+1,
      updated_at=transaction_timestamp()
     WHERE id=target.service_case_id AND organization_id=target.organization_id
       AND stage='school_selection_confirmed';
    INSERT INTO audit_events
      (id,organization_id,actor_user_id,actor_kind,event_type,event_version,action,
       resource_type,resource_id,outcome,request_id,occurred_at,metadata)
    VALUES (fact_id,target.organization_id,actor_id,'user','cases.school_target_preparing',1,
      'transition','SchoolTarget',target.id,'succeeded',
      COALESCE(nullif(current_setting('app.request_id',true),''),'case-event'),
      transaction_timestamp(),jsonb_build_object('effect_type','school_target_preparing',
        'record_version',target.record_version+1,'status','preparing'));
    INSERT INTO audit_outbox
      (id,audit_event_id,organization_id,aggregate_type,aggregate_id,event_type,event_version,
       idempotency_key,request_id,payload,status,available_at,created_at)
    VALUES (outbox_id,fact_id,target.organization_id,'SchoolTarget',target.id,
      'cases.application_task_requested',1,'school-target-application-'||target.id,
      COALESCE(nullif(current_setting('app.request_id',true),''),'case-event'),
      jsonb_build_object('aggregate_id',target.id,'school_target_id',target.id,
        'service_case_id',target.service_case_id,'assignment_id',assignment_id,
        'source_event_id',fact_id,'task_kind','application_prepare_submit'),
      'pending',transaction_timestamp(),transaction_timestamp());
  END LOOP;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS cases_candidate_confirmed_preparing_trg ON cases_candidate_school_list_versions;
CREATE CONSTRAINT TRIGGER cases_candidate_confirmed_preparing_trg
AFTER UPDATE OF status ON cases_candidate_school_list_versions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION cases_promote_confirmed_targets_to_preparing();

ALTER TABLE cases_school_target_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_school_target_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY cases_target_assignments_tenant ON cases_school_target_assignments FOR ALL TO tianxing_app
  USING (organization_id::text=current_setting('app.organization_id',true))
  WITH CHECK (organization_id::text=current_setting('app.organization_id',true));
ALTER TABLE cases_school_target_transition_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_school_target_transition_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY cases_target_facts_tenant ON cases_school_target_transition_facts FOR ALL TO tianxing_app
  USING (organization_id::text=current_setting('app.organization_id',true))
  WITH CHECK (organization_id::text=current_setting('app.organization_id',true));
ALTER TABLE tasks_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_target_tenant ON tasks_tasks FOR ALL TO tianxing_app
  USING (organization_id::text=current_setting('app.organization_id',true))
  WITH CHECK (organization_id::text=current_setting('app.organization_id',true));
ALTER TABLE tasks_task_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks_task_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_assignments_tenant ON tasks_task_assignments FOR ALL TO tianxing_app
  USING (organization_id::text=current_setting('app.organization_id',true))
  WITH CHECK (organization_id::text=current_setting('app.organization_id',true));
ALTER TABLE tasks_task_transition_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks_task_transition_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_receipts_tenant ON tasks_task_transition_receipts FOR ALL TO tianxing_app
  USING (organization_id::text=current_setting('app.organization_id',true))
  WITH CHECK (organization_id::text=current_setting('app.organization_id',true));
COMMENT ON COLUMN tasks_tasks.due_at IS
  'Case pause never rewrites or extends this deadline; overdue is computed at read time.';
