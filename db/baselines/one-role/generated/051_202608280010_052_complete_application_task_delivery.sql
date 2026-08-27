-- Forward corrective for the Release 1 application task delivery loop.
-- Historical candidate versions remain readable; all new versions pin an
-- explicit application deadline supplied by the Advisor.

ALTER TABLE public.cases_candidate_school_list_items
  ADD COLUMN IF NOT EXISTS application_deadline timestamptz;

-- P0-07 made target state immutable before the application workflow existed.
-- Keep that boundary for ordinary writes, while allowing only a matching,
-- append-only transition fact to authorize a workflow state change.
CREATE OR REPLACE FUNCTION public.cases_validate_target_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matching_facts integer;
BEGIN
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  SELECT count(*) INTO matching_facts
    FROM public.cases_school_target_transition_facts AS fact
   WHERE fact.organization_id = NEW.organization_id
     AND fact.school_target_id = NEW.id
     AND fact.from_state = OLD.state
     AND fact.to_state = NEW.state
     AND fact.from_record_version = OLD.record_version
     AND fact.to_record_version = NEW.record_version;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.service_case_id IS DISTINCT FROM OLD.service_case_id
     OR NEW.school_id IS DISTINCT FROM OLD.school_id
     OR NEW.intake_year IS DISTINCT FROM OLD.intake_year
     OR NEW.admission_type IS DISTINCT FROM OLD.admission_type
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.state IS DISTINCT FROM OLD.state AND matching_facts = 0
         AND current_setting('app.target_workflow_transition', true)
             IS DISTINCT FROM 'authorized') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_school_targets_status_immutable_check',
      MESSAGE = 'target identity and state are immutable in P0-07';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_school_targets_record_version_transition_check',
      MESSAGE = 'record_version must increase exactly once';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_school_targets_timestamps_check',
      MESSAGE = 'updated_at cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;

-- Reassert the exact forward milestone used by the confirmed-list automation.
ALTER TABLE public.cases_service_case_transition_facts
  DROP CONSTRAINT IF EXISTS cases_service_case_transition_facts_direction_check;
ALTER TABLE public.cases_service_case_transition_facts
  ADD CONSTRAINT cases_service_case_transition_facts_direction_check CHECK (
    (from_stage = 'signed' AND to_stage = 'background_collection' AND reason IS NULL)
    OR (from_stage = 'background_collection' AND to_stage = 'school_selection_confirmed'
      AND reason = 'candidate_list_confirmed')
    OR (from_stage = 'school_selection_confirmed' AND to_stage = 'application_in_progress'
      AND reason = 'target_preparing')
    OR (from_stage IN ('background_collection','school_selection_confirmed','application_in_progress')
      AND to_stage = 'closed' AND reason = 'founder_manual_close')
  );

CREATE OR REPLACE FUNCTION public.cases_validate_service_case_stage_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM public.cases_service_case_transition_facts AS fact
     WHERE fact.organization_id=NEW.organization_id AND fact.service_case_id=NEW.id
       AND fact.actor_user_id IS NOT DISTINCT FROM
           nullif(current_setting('app.actor_user_id',true),'')::uuid
       AND fact.from_stage=OLD.stage AND fact.to_stage=NEW.stage
       AND fact.from_record_version=OLD.record_version
       AND fact.to_record_version=NEW.record_version
       AND ((OLD.stage='signed' AND NEW.stage='background_collection' AND fact.reason IS NULL)
         OR (OLD.stage='background_collection' AND NEW.stage='school_selection_confirmed'
           AND fact.reason='candidate_list_confirmed')
         OR (OLD.stage='school_selection_confirmed' AND NEW.stage='application_in_progress'
           AND fact.reason='target_preparing')
         OR (OLD.stage IN ('background_collection','school_selection_confirmed','application_in_progress')
           AND NEW.stage='closed' AND fact.reason='founder_manual_close'))
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='cases_service_cases_stage_direction_check',
    MESSAGE='ServiceCase stage direction is not enabled';
END;
$$;

CREATE OR REPLACE FUNCTION public.cases_validate_candidate_list_item_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_candidate_list_items_history_permanent_check',
      MESSAGE = 'Candidate list items are permanent';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.service_case_id IS DISTINCT FROM OLD.service_case_id
     OR NEW.list_version_id IS DISTINCT FROM OLD.list_version_id
     OR NEW.school_id IS DISTINCT FROM OLD.school_id
     OR NEW.pinned_resolved_revision_id IS DISTINCT FROM OLD.pinned_resolved_revision_id
     OR NEW.pinned_resolution_sha256 IS DISTINCT FROM OLD.pinned_resolution_sha256
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.application_deadline IS DISTINCT FROM OLD.application_deadline
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.school_target_id IS NOT NULL OR NEW.school_target_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_candidate_list_items_immutable_check',
      MESSAGE = 'Candidate item is immutable except for its one-time Target binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_task_source_event_idx
  ON public.tasks_tasks (organization_id, source_event_id, task_kind)
  WHERE creation_trigger = 'case_event' AND source_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cases_target_submission_receipt_idx
  ON public.cases_school_target_transition_facts
    (organization_id, task_completion_receipt_id)
  WHERE to_state = 'submitted' AND task_completion_receipt_id IS NOT NULL;

ALTER TABLE public.tasks_tasks
  ADD CONSTRAINT tasks_tasks_automatic_source_check CHECK (
    (task_kind = 'manual' AND creation_trigger = 'advisor_manual' AND source_event_id IS NULL)
    OR
    (task_kind IN ('application_prepare_submit','interview_support')
      AND creation_trigger = 'case_event' AND source_event_id IS NOT NULL)
  ) NOT VALID;

ALTER TABLE public.tasks_task_transition_receipts
  DROP CONSTRAINT IF EXISTS tasks_transition_receipts_state_check;
ALTER TABLE public.tasks_task_transition_receipts
  ADD CONSTRAINT tasks_transition_receipts_state_check CHECK (
    from_state IN ('assigned','accepted','awaiting_reassignment','completed','cancelled')
    AND to_state IN ('assigned','accepted','awaiting_reassignment','completed','cancelled')
    AND (from_state <> to_state OR (from_state='assigned' AND to_state='assigned' AND reason IS NOT NULL))
  );

-- V2 keeps the historical function immutable and extends only the new command
-- path. The timestamp is canonicalized to UTC milliseconds in the school-set
-- hash so Founder and Guardian decisions bind the exact deadline.
CREATE FUNCTION public.cases_create_candidate_list_version_v2(
  target_case_id uuid,
  target_version_id uuid,
  previous_version_id uuid,
  expected_case_record_version bigint,
  expected_school_set_sha256 text,
  change_summary text,
  items_json jsonb,
  submitted_time timestamptz
)
RETURNS TABLE (decision text, result_version_number bigint, result_record_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tenant_id uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  actor_id uuid := nullif(current_setting('app.actor_user_id', true), '')::uuid;
  service_case public.cases_service_cases%ROWTYPE;
  next_version bigint;
  actual_previous uuid;
  actual_hash text;
  inserted_count integer;
BEGIN
  SELECT candidate.* INTO service_case FROM public.cases_service_cases AS candidate
   WHERE candidate.id = target_case_id AND candidate.organization_id = tenant_id FOR UPDATE;
  IF NOT FOUND OR NOT public.cases_actor_has_active_case_role(target_case_id, 'advisor', true) THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_NOT_FOUND'::text, NULL::bigint, NULL::bigint; RETURN;
  END IF;
  IF service_case.record_version <> expected_case_record_version THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_STALE_VERSION'::text, NULL::bigint,
      service_case.record_version; RETURN;
  END IF;
  IF service_case.workflow_status <> 'active' OR service_case.stage <> 'background_collection' THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_CASE_NOT_ACTIVE'::text, NULL::bigint,
      service_case.record_version; RETURN;
  END IF;
  PERFORM 1 FROM public.cases_assessments AS assessment
   WHERE assessment.service_case_id = service_case.id AND assessment.organization_id = tenant_id
     AND assessment.status = 'background_complete' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_BACKGROUND_INCOMPLETE'::text, NULL::bigint,
      service_case.record_version; RETURN;
  END IF;
  SELECT version.id, version.version_number INTO actual_previous, next_version
    FROM public.cases_candidate_school_list_versions AS version
   WHERE version.service_case_id = service_case.id AND version.organization_id = tenant_id
   ORDER BY version.version_number DESC LIMIT 1 FOR UPDATE;
  next_version := COALESCE(next_version, 0) + 1;
  IF previous_version_id IS DISTINCT FROM actual_previous OR jsonb_typeof(items_json) <> 'array'
     OR jsonb_array_length(items_json) = 0 OR jsonb_array_length(items_json) > 50
     OR change_summary IS NULL OR btrim(change_summary) = '' THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_INVALID'::text, NULL::bigint,
      service_case.record_version; RETURN;
  END IF;

  INSERT INTO public.cases_candidate_school_list_versions
    (id,organization_id,service_case_id,version_number,previous_version_id,school_set_sha256,
     status,created_by_user_id,change_summary,submitted_at,record_version,created_at,updated_at)
  VALUES (target_version_id,tenant_id,service_case.id,next_version,previous_version_id,
    expected_school_set_sha256,'draft',actor_id,btrim(change_summary),NULL,1,
    submitted_time,submitted_time);

  INSERT INTO public.cases_candidate_school_list_items
    (id,organization_id,service_case_id,list_version_id,school_id,
     pinned_resolved_revision_id,pinned_resolution_sha256,ordinal,application_deadline,created_at)
  SELECT item.id,tenant_id,service_case.id,target_version_id,item.school_id,
    item.pinned_resolved_revision_id,item.pinned_resolution_sha256,item.ordinal,
    item.application_deadline,submitted_time
    FROM jsonb_to_recordset(items_json) AS item(
      id uuid, school_id uuid, pinned_resolved_revision_id uuid,
      pinned_resolution_sha256 text, ordinal integer, application_deadline timestamptz)
   WHERE item.application_deadline IS NOT NULL;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> jsonb_array_length(items_json) OR EXISTS (
    SELECT 1 FROM public.cases_candidate_school_list_items AS item
    JOIN public.schools_resolved_revisions AS revision
      ON revision.id = item.pinned_resolved_revision_id
     AND revision.organization_id = item.organization_id AND revision.school_id = item.school_id
   WHERE item.list_version_id = target_version_id
     AND revision.resolution_sha256 IS DISTINCT FROM item.pinned_resolution_sha256
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_candidate_list_items_pin_check',
      MESSAGE = 'Candidate list pins or application deadlines are invalid';
  END IF;
  SELECT encode(digest(convert_to(string_agg(
      item.ordinal::text || ':' || item.school_id::text || ':'
      || item.pinned_resolved_revision_id::text || ':' || item.pinned_resolution_sha256 || ':'
      || to_char(item.application_deadline AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      '|' ORDER BY item.ordinal),'UTF8'),'sha256'),'hex') INTO actual_hash
    FROM public.cases_candidate_school_list_items AS item
   WHERE item.list_version_id = target_version_id AND item.organization_id = tenant_id;
  IF actual_hash IS DISTINCT FROM expected_school_set_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_candidate_lists_hash_check',
      MESSAGE = 'Candidate list canonical hash mismatch';
  END IF;
  UPDATE public.cases_candidate_school_list_versions
     SET status='submitted',submitted_at=submitted_time,record_version=2,updated_at=submitted_time
   WHERE id=target_version_id AND organization_id=tenant_id;
  RETURN QUERY SELECT 'allowed'::text, next_version, 2::bigint;
END;
$$;

REVOKE ALL ON FUNCTION public.cases_create_candidate_list_version_v2(
  uuid,uuid,uuid,bigint,text,text,jsonb,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cases_create_candidate_list_version_v2(
  uuid,uuid,uuid,bigint,text,text,jsonb,timestamptz) TO tianxing_app;

-- Replace migration 041's event producer without rewriting history. The
-- outbox envelope now matches its Audit event and uses only migration 007's
-- payload allowlist. Consumers derive every business fact from PostgreSQL.
CREATE OR REPLACE FUNCTION public.cases_promote_confirmed_targets_to_preparing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  item record;
  target record;
  assignment_id uuid;
  fact_id uuid;
  outbox_id uuid;
  case_promoted boolean := false;
  actor_id uuid := nullif(current_setting('app.actor_user_id', true), '')::uuid;
  request_key text := COALESCE(nullif(current_setting('app.request_id',true),''),'case-event');
BEGIN
  IF NEW.status <> 'confirmed' OR OLD.status = 'confirmed' THEN RETURN NEW; END IF;
  FOR item IN SELECT i.* FROM public.cases_candidate_school_list_items i
    WHERE i.list_version_id=NEW.id AND i.organization_id=NEW.organization_id ORDER BY i.ordinal LOOP
    SELECT t.* INTO target FROM public.cases_school_targets t
      WHERE t.id=item.school_target_id AND t.organization_id=NEW.organization_id FOR UPDATE;
    IF NOT FOUND OR target.state <> 'candidate' THEN CONTINUE; END IF;
    assignment_id := gen_random_uuid(); fact_id := gen_random_uuid(); outbox_id := gen_random_uuid();
    INSERT INTO public.cases_school_target_assignments
      (id,organization_id,service_case_id,school_target_id,assignee_user_id,
       assignee_membership_id,advisor_role_binding_id,assigned_by_user_id,assignment_reason)
    SELECT assignment_id,target.organization_id,target.service_case_id,target.id,
      c.primary_user_id,c.primary_membership_id,c.primary_role_binding_id,
      COALESCE(actor_id,c.primary_user_id),'confirmed_list'
      FROM public.cases_service_cases c WHERE c.id=target.service_case_id;
    INSERT INTO public.cases_school_target_transition_facts
      (id,organization_id,service_case_id,school_target_id,transition_kind,from_state,to_state,
       actor_user_id,assignment_id,from_record_version,to_record_version,application_deadline,occurred_at)
    VALUES (fact_id,target.organization_id,target.service_case_id,target.id,'workflow','candidate',
      'preparing',actor_id,assignment_id,target.record_version,target.record_version+1,
      item.application_deadline,transaction_timestamp());
    PERFORM set_config('app.target_workflow_transition','authorized',true);
    UPDATE public.cases_school_targets SET state='preparing',current_assignment_id=assignment_id,
      application_deadline=item.application_deadline,record_version=record_version+1,
      updated_at=transaction_timestamp() WHERE id=target.id;
    PERFORM set_config('app.target_workflow_transition','',true);
    IF NOT case_promoted AND EXISTS (
      SELECT 1 FROM public.cases_service_cases c
       WHERE c.id=target.service_case_id AND c.organization_id=target.organization_id
         AND c.stage='school_selection_confirmed'
    ) THEN
      INSERT INTO public.cases_service_case_transition_facts
        (id,organization_id,service_case_id,actor_user_id,from_stage,to_stage,
         from_record_version,to_record_version,reason,transitioned_at,created_at)
      SELECT gen_random_uuid(),c.organization_id,c.id,COALESCE(actor_id,c.primary_user_id),
        c.stage,'application_in_progress',c.record_version,c.record_version+1,
        'target_preparing',transaction_timestamp(),transaction_timestamp()
        FROM public.cases_service_cases c
       WHERE c.id=target.service_case_id AND c.organization_id=target.organization_id
         AND c.stage='school_selection_confirmed';
      PERFORM set_config('app.case_stage_transition','authorized',true);
      UPDATE public.cases_service_cases SET stage='application_in_progress',record_version=record_version+1,
        updated_at=transaction_timestamp()
       WHERE id=target.service_case_id AND organization_id=target.organization_id
         AND stage='school_selection_confirmed';
      case_promoted := true;
    END IF;
    INSERT INTO public.audit_events
      (id,organization_id,actor_user_id,actor_kind,event_type,event_version,action,
       resource_type,resource_id,outcome,request_id,occurred_at,metadata)
    VALUES (fact_id,target.organization_id,actor_id,'user','cases.application_task_requested',2,
      'request','SchoolTarget',target.id,'succeeded',request_key,transaction_timestamp(),
      jsonb_build_object('effect_type','cases.application_task_requested',
        'record_version',target.record_version+1,'status','preparing'));
    INSERT INTO public.audit_outbox
      (id,audit_event_id,organization_id,aggregate_type,aggregate_id,event_type,event_version,
       idempotency_key,request_id,payload,status,available_at,created_at)
    VALUES (outbox_id,fact_id,target.organization_id,'SchoolTarget',target.id,
      'cases.application_task_requested',2,
      'application-'||target.id||'-round-'||target.application_round::text,request_key,
      jsonb_build_object('aggregate_id',target.id,'record_version',target.record_version+1,
        'request_id',request_key,'effect_type','cases.application_task_requested','status','preparing'),
      'pending',transaction_timestamp(),transaction_timestamp());
  END LOOP;
  RETURN NEW;
END;
$$;

-- Rebind the deferred confirmation hook to the v2 producer above. The
-- forward migration owns this replacement so a fresh baseline cannot retain
-- the historical function body without its automation trigger.
GRANT TRIGGER ON TABLE public.cases_candidate_school_list_versions TO tianxing_app;
DROP TRIGGER IF EXISTS cases_candidate_confirmed_preparing_trg
  ON public.cases_candidate_school_list_versions;
CREATE CONSTRAINT TRIGGER cases_candidate_confirmed_preparing_trg
  AFTER UPDATE OF status ON public.cases_candidate_school_list_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.cases_promote_confirmed_targets_to_preparing();
REVOKE TRIGGER ON TABLE public.cases_candidate_school_list_versions FROM tianxing_app;

COMMENT ON COLUMN public.cases_candidate_school_list_items.application_deadline IS
  'Advisor-supplied ISO instant pinned into the approved list; historical rows may be null.';
