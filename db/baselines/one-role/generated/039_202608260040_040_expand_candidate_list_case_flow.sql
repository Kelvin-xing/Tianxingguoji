-- P2-BE-04 forward-only expansion. Historical Target rows remain readable; every
-- new Target created by this slice is pinned to its originating confirmed item.

CREATE TABLE cases_candidate_school_list_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  version_number bigint NOT NULL,
  previous_version_id uuid,
  school_set_sha256 char(64) NOT NULL,
  status text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  change_summary text NOT NULL,
  submitted_at timestamptz,
  founder_decision text,
  founder_decided_by_user_id uuid REFERENCES identity_users (id),
  founder_decided_at timestamptz,
  founder_decision_reason text,
  founder_decision_sha256 char(64),
  guardian_id uuid,
  guardian_relationship_id uuid,
  guardian_decision text,
  guardian_decided_at timestamptz,
  guardian_confirmation_channel text,
  guardian_recorded_by_user_id uuid REFERENCES identity_users (id),
  guardian_recorded_at timestamptz,
  guardian_bound_founder_decision_sha256 char(64),
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_candidate_lists_case_fk FOREIGN KEY (service_case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT cases_candidate_lists_tenant_key UNIQUE (id, organization_id, service_case_id),
  CONSTRAINT cases_candidate_lists_case_version_key
    UNIQUE (organization_id, service_case_id, version_number),
  CONSTRAINT cases_candidate_lists_previous_fk FOREIGN KEY
    (previous_version_id, organization_id, service_case_id)
    REFERENCES cases_candidate_school_list_versions (id, organization_id, service_case_id),
  CONSTRAINT cases_candidate_lists_hash_check CHECK (
    school_set_sha256 ~ '^[0-9a-f]{64}$'
    AND (founder_decision_sha256 IS NULL OR founder_decision_sha256 ~ '^[0-9a-f]{64}$')
    AND (guardian_bound_founder_decision_sha256 IS NULL
      OR guardian_bound_founder_decision_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT cases_candidate_lists_status_check CHECK (
    status IN ('draft','submitted','awaiting_guardian','confirmed','returned')
  ),
  CONSTRAINT cases_candidate_lists_text_check CHECK (
    btrim(change_summary) <> '' AND char_length(change_summary) <= 1000
  ),
  CONSTRAINT cases_candidate_lists_founder_receipt_check CHECK (
    (status IN ('draft','submitted') AND founder_decision IS NULL
      AND founder_decided_by_user_id IS NULL AND founder_decided_at IS NULL
      AND founder_decision_reason IS NULL AND founder_decision_sha256 IS NULL)
    OR (status IN ('awaiting_guardian','confirmed','returned')
      AND founder_decision IN ('approved','rejected')
      AND founder_decided_by_user_id IS NOT NULL AND founder_decided_at IS NOT NULL
      AND founder_decision_reason IS NOT NULL AND btrim(founder_decision_reason) <> ''
      AND founder_decision_sha256 IS NOT NULL)
  ),
  CONSTRAINT cases_candidate_lists_guardian_receipt_check CHECK (
    (status IN ('draft','submitted','awaiting_guardian') AND guardian_decision IS NULL
      AND guardian_id IS NULL AND guardian_relationship_id IS NULL
      AND guardian_decided_at IS NULL AND guardian_confirmation_channel IS NULL
      AND guardian_recorded_by_user_id IS NULL AND guardian_recorded_at IS NULL
      AND guardian_bound_founder_decision_sha256 IS NULL)
    OR (status IN ('confirmed','returned') AND guardian_decision IN ('confirmed','not_confirmed')
      AND guardian_id IS NOT NULL AND guardian_relationship_id IS NOT NULL
      AND guardian_decided_at IS NOT NULL
      AND guardian_confirmation_channel IN ('phone','wechat','in_person')
      AND guardian_recorded_by_user_id IS NOT NULL AND guardian_recorded_at IS NOT NULL
      AND guardian_bound_founder_decision_sha256 = founder_decision_sha256)
    OR (status = 'returned' AND founder_decision = 'rejected' AND guardian_decision IS NULL
      AND guardian_id IS NULL AND guardian_relationship_id IS NULL
      AND guardian_decided_at IS NULL AND guardian_confirmation_channel IS NULL
      AND guardian_recorded_by_user_id IS NULL AND guardian_recorded_at IS NULL
      AND guardian_bound_founder_decision_sha256 IS NULL)
  ),
  CONSTRAINT cases_candidate_lists_decision_direction_check CHECK (
    (status = 'awaiting_guardian' AND founder_decision = 'approved')
    OR (status = 'confirmed' AND founder_decision = 'approved' AND guardian_decision = 'confirmed')
    OR (status = 'returned' AND (founder_decision = 'rejected'
      OR (founder_decision = 'approved' AND guardian_decision = 'not_confirmed')))
    OR status IN ('draft','submitted')
  ),
  CONSTRAINT cases_candidate_lists_version_check CHECK (version_number >= 1 AND record_version >= 1),
  CONSTRAINT cases_candidate_lists_timestamps_check CHECK (
    updated_at >= created_at
    AND ((status = 'draft' AND submitted_at IS NULL)
      OR (status <> 'draft' AND submitted_at IS NOT NULL AND submitted_at >= created_at))
    AND (founder_decided_at IS NULL OR founder_decided_at >= submitted_at)
    AND (guardian_decided_at IS NULL OR guardian_decided_at >= founder_decided_at)
    AND (guardian_recorded_at IS NULL OR guardian_recorded_at >= guardian_decided_at)
  )
);

CREATE TABLE cases_candidate_school_list_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  list_version_id uuid NOT NULL,
  school_id uuid NOT NULL,
  pinned_resolved_revision_id uuid NOT NULL,
  pinned_resolution_sha256 char(64) NOT NULL,
  ordinal integer NOT NULL,
  school_target_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT cases_candidate_list_items_version_fk FOREIGN KEY
    (list_version_id, organization_id, service_case_id)
    REFERENCES cases_candidate_school_list_versions (id, organization_id, service_case_id),
  CONSTRAINT cases_candidate_list_items_pin_fk FOREIGN KEY
    (pinned_resolved_revision_id, organization_id, school_id)
    REFERENCES schools_resolved_revisions (id, organization_id, school_id),
  CONSTRAINT cases_candidate_list_items_tenant_key
    UNIQUE (id, organization_id, service_case_id),
  CONSTRAINT cases_candidate_list_items_origin_key
    UNIQUE (id, organization_id, service_case_id, list_version_id),
  CONSTRAINT cases_candidate_list_items_school_key
    UNIQUE (organization_id, list_version_id, school_id),
  CONSTRAINT cases_candidate_list_items_ordinal_key
    UNIQUE (organization_id, list_version_id, ordinal),
  CONSTRAINT cases_candidate_list_items_pin_check CHECK (
    pinned_resolution_sha256 ~ '^[0-9a-f]{64}$' AND ordinal >= 1
  )
);

ALTER TABLE cases_school_targets
  ADD COLUMN application_round integer NOT NULL DEFAULT 1,
  ADD COLUMN origin_list_version_id uuid,
  ADD COLUMN origin_list_item_id uuid;

ALTER TABLE cases_school_targets
  DROP CONSTRAINT cases_targets_state_check,
  ADD CONSTRAINT cases_targets_state_check CHECK (state IN (
    'candidate','preparing','submitted','interview','waitlisted','accepted',
    'offer_confirmed','offer_declined','rejected','withdrawn'
  )),
  ADD CONSTRAINT cases_targets_application_round_check CHECK (application_round >= 1),
  ADD CONSTRAINT cases_targets_origin_pair_check CHECK (
    (origin_list_version_id IS NULL AND origin_list_item_id IS NULL)
    OR (origin_list_version_id IS NOT NULL AND origin_list_item_id IS NOT NULL)
  ),
  ADD CONSTRAINT cases_targets_origin_item_fk FOREIGN KEY
    (origin_list_item_id, organization_id, service_case_id)
    REFERENCES cases_candidate_school_list_items (id, organization_id, service_case_id);

ALTER TABLE cases_school_targets
  ADD CONSTRAINT cases_targets_origin_version_fk FOREIGN KEY
    (origin_list_version_id, organization_id, service_case_id)
    REFERENCES cases_candidate_school_list_versions (id, organization_id, service_case_id);

ALTER TABLE cases_school_targets
  ADD CONSTRAINT cases_targets_origin_same_version_fk FOREIGN KEY
    (origin_list_item_id, organization_id, service_case_id, origin_list_version_id)
    REFERENCES cases_candidate_school_list_items
      (id, organization_id, service_case_id, list_version_id);

ALTER TABLE cases_candidate_school_list_items
  ADD CONSTRAINT cases_candidate_list_items_target_fk FOREIGN KEY
    (school_target_id, organization_id, service_case_id)
    REFERENCES cases_school_targets (id, organization_id, service_case_id);

CREATE UNIQUE INDEX cases_school_targets_application_round_idx
  ON cases_school_targets (organization_id, service_case_id, school_id, application_round);

CREATE FUNCTION cases_validate_candidate_list_version_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_candidate_lists_history_permanent_check',
      MESSAGE = 'Candidate list history is permanent';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.service_case_id IS DISTINCT FROM OLD.service_case_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.previous_version_id IS DISTINCT FROM OLD.previous_version_id
     OR NEW.school_set_sha256 IS DISTINCT FROM OLD.school_set_sha256
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.change_summary IS DISTINCT FROM OLD.change_summary
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_candidate_lists_submitted_snapshot_immutable_check',
      MESSAGE = 'Submitted candidate list snapshot is immutable';
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status = 'submitted'
          AND OLD.submitted_at IS NULL AND NEW.submitted_at IS NOT NULL)
       OR (OLD.status = 'submitted' AND NEW.status IN ('awaiting_guardian','returned'))
       OR (OLD.status = 'awaiting_guardian' AND NEW.status IN ('confirmed','returned'))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_candidate_lists_transition_check',
      MESSAGE = 'Candidate list transition is not allowed';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_candidate_lists_record_version_check',
      MESSAGE = 'Candidate list optimistic version is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_candidate_list_versions_write_trg
BEFORE UPDATE OR DELETE ON cases_candidate_school_list_versions
FOR EACH ROW EXECUTE FUNCTION cases_validate_candidate_list_version_write();

CREATE FUNCTION cases_validate_candidate_list_item_write()
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
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.school_target_id IS NOT NULL OR NEW.school_target_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'cases_candidate_list_items_immutable_check',
      MESSAGE = 'Candidate item is immutable except for its one-time Target binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_candidate_list_items_write_trg
BEFORE UPDATE OR DELETE ON cases_candidate_school_list_items
FOR EACH ROW EXECUTE FUNCTION cases_validate_candidate_list_item_write();

ALTER TABLE cases_candidate_school_list_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_candidate_school_list_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE cases_candidate_school_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases_candidate_school_list_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON cases_candidate_school_list_versions
  FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
CREATE POLICY tianxing_tenant_boundary ON cases_candidate_school_list_items
  FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));

REVOKE ALL ON TABLE cases_candidate_school_list_versions FROM PUBLIC;
REVOKE ALL ON TABLE cases_candidate_school_list_items FROM PUBLIC;
REVOKE ALL ON TABLE cases_candidate_school_list_versions FROM tianxing_app;
REVOKE ALL ON TABLE cases_candidate_school_list_items FROM tianxing_app;
GRANT SELECT, INSERT ON TABLE cases_candidate_school_list_versions TO tianxing_app;
GRANT UPDATE (status,founder_decision,founder_decided_by_user_id,founder_decided_at,
  founder_decision_reason,founder_decision_sha256,guardian_id,guardian_relationship_id,
  guardian_decision,guardian_decided_at,guardian_confirmation_channel,
  guardian_recorded_by_user_id,guardian_recorded_at,guardian_bound_founder_decision_sha256,
  record_version,updated_at) ON TABLE cases_candidate_school_list_versions TO tianxing_app;
GRANT SELECT, INSERT ON TABLE cases_candidate_school_list_items TO tianxing_app;
GRANT UPDATE (school_target_id) ON TABLE cases_candidate_school_list_items TO tianxing_app;
GRANT INSERT ON TABLE cases_school_targets TO tianxing_app;

REVOKE ALL ON FUNCTION cases_validate_candidate_list_version_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_validate_candidate_list_item_write() FROM PUBLIC;

COMMENT ON COLUMN cases_school_targets.origin_list_version_id IS
  'NULL only for legacy targets created before P2-BE-04; all new targets are confirmation-pinned.';

CREATE FUNCTION cases_actor_has_active_case_role(
  target_case_id uuid,
  required_role text,
  require_primary_advisor boolean
)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.cases_service_cases AS service_case
      JOIN public.access_role_bindings AS role_binding
        ON role_binding.organization_id = service_case.organization_id
       AND role_binding.user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid
       AND role_binding.role = required_role AND role_binding.status = 'active'
      JOIN public.access_organization_memberships AS membership
        ON membership.id = role_binding.membership_id
       AND membership.organization_id = role_binding.organization_id
       AND membership.user_id = role_binding.user_id AND membership.status = 'active'
      JOIN public.identity_users AS identity_user
        ON identity_user.id = role_binding.user_id AND identity_user.status = 'active'
      JOIN public.access_organizations AS organization
        ON organization.id = role_binding.organization_id AND organization.status = 'active'
     WHERE service_case.id = target_case_id
       AND service_case.organization_id::text = current_setting('app.organization_id', true)
       AND (NOT require_primary_advisor OR (
         required_role = 'advisor' AND service_case.primary_user_id = role_binding.user_id
         AND service_case.primary_role_binding_id = role_binding.id))
  );
$$;

CREATE FUNCTION cases_create_candidate_list_version(
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
     pinned_resolved_revision_id,pinned_resolution_sha256,ordinal,created_at)
  SELECT item.id,tenant_id,service_case.id,target_version_id,item.school_id,
    item.pinned_resolved_revision_id,item.pinned_resolution_sha256,item.ordinal,submitted_time
    FROM jsonb_to_recordset(items_json) AS item(
      id uuid, school_id uuid, pinned_resolved_revision_id uuid,
      pinned_resolution_sha256 text, ordinal integer);
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
      MESSAGE = 'Candidate list pins do not match immutable School revisions';
  END IF;
  SELECT encode(digest(convert_to(string_agg(
      item.ordinal::text || ':' || item.school_id::text || ':'
      || item.pinned_resolved_revision_id::text || ':' || item.pinned_resolution_sha256,
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

CREATE FUNCTION cases_review_candidate_list_version(
  target_case_id uuid,
  target_version_id uuid,
  expected_record_version bigint,
  requested_decision text,
  decision_reason text,
  decision_time timestamptz
)
RETURNS TABLE (decision text, result_status text, result_record_version bigint,
  founder_decision_sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tenant_id uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  actor_id uuid := nullif(current_setting('app.actor_user_id', true), '')::uuid;
  service_case public.cases_service_cases%ROWTYPE;
  list_version public.cases_candidate_school_list_versions%ROWTYPE;
  next_status text;
  decision_hash text;
BEGIN
  SELECT candidate.* INTO service_case FROM public.cases_service_cases AS candidate
   WHERE candidate.id = target_case_id AND candidate.organization_id = tenant_id FOR UPDATE;
  SELECT candidate.* INTO list_version FROM public.cases_candidate_school_list_versions AS candidate
   WHERE candidate.id = target_version_id AND candidate.service_case_id = target_case_id
     AND candidate.organization_id = tenant_id FOR UPDATE;
  IF NOT FOUND OR NOT public.cases_actor_has_active_case_role(target_case_id, 'founder', false) THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_NOT_FOUND'::text,NULL::text,NULL::bigint,NULL::text; RETURN;
  END IF;
  IF service_case.workflow_status <> 'active' THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_CASE_NOT_ACTIVE'::text,list_version.status,
      list_version.record_version,NULL::text; RETURN;
  END IF;
  IF list_version.record_version <> expected_record_version THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_STALE_VERSION'::text,list_version.status,
      list_version.record_version,NULL::text; RETURN;
  END IF;
  IF list_version.status <> 'submitted' OR requested_decision NOT IN ('approved','rejected')
     OR decision_reason IS NULL OR btrim(decision_reason) = '' THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_INVALID'::text,list_version.status,
      list_version.record_version,NULL::text; RETURN;
  END IF;
  next_status := CASE requested_decision WHEN 'approved' THEN 'awaiting_guardian' ELSE 'returned' END;
  decision_hash := encode(digest(convert_to(jsonb_build_object(
    'decision',requested_decision,'reason',btrim(decision_reason),
    'school_set_sha256',list_version.school_set_sha256,
    'version_id',list_version.id,'version_number',list_version.version_number)::text,
    'UTF8'),'sha256'),'hex');
  UPDATE public.cases_candidate_school_list_versions SET status=next_status,
    founder_decision=requested_decision,founder_decided_by_user_id=actor_id,
    founder_decided_at=decision_time,founder_decision_reason=btrim(decision_reason),
    founder_decision_sha256=decision_hash,record_version=record_version+1,
    updated_at=decision_time WHERE id=list_version.id;
  RETURN QUERY SELECT 'allowed'::text,next_status,list_version.record_version+1,decision_hash;
END;
$$;

ALTER TABLE cases_service_case_transition_facts
  DROP CONSTRAINT cases_service_case_transition_facts_direction_check,
  ADD CONSTRAINT cases_service_case_transition_facts_direction_check CHECK (
    (from_stage = 'signed' AND to_stage = 'background_collection' AND reason IS NULL)
    OR (from_stage = 'background_collection' AND to_stage = 'school_selection_confirmed'
      AND reason = 'candidate_list_confirmed')
    OR (from_stage IN ('background_collection','school_selection_confirmed','application_in_progress')
      AND to_stage = 'closed' AND reason = 'founder_manual_close')
  );

ALTER TABLE cases_service_case_lifecycle_facts
  DROP CONSTRAINT cases_service_case_lifecycle_facts_action_check,
  DROP CONSTRAINT cases_service_case_lifecycle_facts_reason_check,
  ADD CONSTRAINT cases_service_case_lifecycle_facts_action_check CHECK (
    (action='pause' AND from_status='active' AND to_status='paused')
    OR (action='resume' AND from_status='paused' AND to_status='active')
    OR (action='manual_close' AND from_status IN ('active','termination_pending')
      AND to_status='closed')
  ),
  ADD CONSTRAINT cases_service_case_lifecycle_facts_reason_check CHECK (
    (action='pause' AND reason IS NOT NULL AND btrim(reason)<>'' AND char_length(reason)<=1000)
    OR (action='resume' AND reason IS NULL)
    OR (action='manual_close' AND reason IS NOT NULL AND btrim(reason)<>''
      AND char_length(reason)<=1000)
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
         OR (OLD.stage='background_collection' AND NEW.stage='school_selection_confirmed'
           AND fact.reason='candidate_list_confirmed')
         OR (OLD.stage IN ('background_collection','school_selection_confirmed','application_in_progress')
           AND NEW.stage='closed' AND fact.reason='founder_manual_close'))
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE='23514',
    CONSTRAINT='cases_service_cases_stage_direction_check',
    MESSAGE='ServiceCase stage direction is not enabled';
END;
$$;

CREATE FUNCTION cases_close_service_case(
  target_case_id uuid,
  expected_case_record_version bigint,
  closure_outcome text,
  closure_reason text,
  transition_fact_id uuid,
  lifecycle_fact_id uuid,
  closed_time timestamptz
)
RETURNS TABLE (decision text, result_status text, result_record_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tenant_id uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  actor_id uuid := nullif(current_setting('app.actor_user_id', true), '')::uuid;
  service_case public.cases_service_cases%ROWTYPE;
  receipt_reason text;
BEGIN
  SELECT candidate.* INTO service_case FROM public.cases_service_cases AS candidate
   WHERE candidate.id=target_case_id AND candidate.organization_id=tenant_id FOR UPDATE;
  IF NOT FOUND OR NOT public.cases_actor_has_active_case_role(target_case_id,'founder',false) THEN
    RETURN QUERY SELECT 'CASE_CLOSE_NOT_FOUND'::text,NULL::text,NULL::bigint; RETURN;
  END IF;
  PERFORM 1 FROM public.cases_school_targets AS target
   WHERE target.service_case_id=service_case.id AND target.organization_id=tenant_id
   ORDER BY target.id FOR UPDATE;
  PERFORM 1 FROM public.tasks_tasks AS task
   WHERE task.service_case_id=service_case.id AND task.organization_id=tenant_id
   ORDER BY task.id FOR UPDATE;
  IF service_case.record_version<>expected_case_record_version THEN
    RETURN QUERY SELECT 'CASE_CLOSE_STALE_VERSION'::text,service_case.workflow_status,
      service_case.record_version; RETURN;
  END IF;
  IF service_case.workflow_status NOT IN ('active','termination_pending')
     OR service_case.stage NOT IN ('background_collection','school_selection_confirmed','application_in_progress')
     OR closure_outcome NOT IN ('success','no_offer','service_terminated')
     OR closure_reason IS NULL OR btrim(closure_reason)='' THEN
    RETURN QUERY SELECT 'CASE_CLOSE_INVALID'::text,service_case.workflow_status,
      service_case.record_version; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cases_school_targets AS target
       WHERE target.service_case_id=service_case.id AND target.organization_id=tenant_id)
     OR EXISTS (SELECT 1 FROM public.cases_school_targets AS target
       WHERE target.service_case_id=service_case.id AND target.organization_id=tenant_id
         AND target.state NOT IN ('offer_confirmed','offer_declined','rejected','withdrawn')) THEN
    RETURN QUERY SELECT 'CASE_CLOSE_TARGETS_INCOMPLETE'::text,service_case.workflow_status,
      service_case.record_version; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tasks_tasks AS task
       WHERE task.service_case_id=service_case.id AND task.organization_id=tenant_id
         AND task.state NOT IN ('completed','approved','cancelled')) THEN
    RETURN QUERY SELECT 'CASE_CLOSE_TASKS_INCOMPLETE'::text,service_case.workflow_status,
      service_case.record_version; RETURN;
  END IF;
  receipt_reason := closure_outcome || ':' || btrim(closure_reason);
  INSERT INTO public.cases_service_case_transition_facts
    (id,organization_id,service_case_id,actor_user_id,from_stage,to_stage,
     from_record_version,to_record_version,reason,transitioned_at,created_at)
  VALUES (transition_fact_id,tenant_id,service_case.id,actor_id,service_case.stage,'closed',
    service_case.record_version,service_case.record_version+1,'founder_manual_close',closed_time,closed_time);
  INSERT INTO public.cases_service_case_lifecycle_facts
    (id,organization_id,service_case_id,actor_user_id,action,from_status,to_status,
     from_record_version,to_record_version,reason,occurred_at,created_at)
  VALUES (lifecycle_fact_id,tenant_id,service_case.id,actor_id,'manual_close',
    service_case.workflow_status,'closed',service_case.record_version,
    service_case.record_version+1,receipt_reason,closed_time,closed_time);
  PERFORM set_config('app.case_stage_transition','authorized',true);
  PERFORM set_config('app.case_workflow_action','authorized',true);
  UPDATE public.cases_service_cases SET stage='closed',workflow_status='closed',
    record_version=record_version+1,updated_at=closed_time WHERE id=service_case.id;
  RETURN QUERY SELECT 'allowed'::text,'closed'::text,service_case.record_version+1;
END;
$$;

CREATE FUNCTION cases_record_guardian_list_decision(
  target_case_id uuid,
  target_version_id uuid,
  expected_list_record_version bigint,
  expected_case_record_version bigint,
  target_guardian_id uuid,
  target_relationship_id uuid,
  requested_decision text,
  confirmation_channel text,
  guardian_decided_time timestamptz,
  bound_founder_decision_sha256 text,
  transition_fact_id uuid,
  recorded_time timestamptz
)
RETURNS TABLE (decision text, result_status text, result_record_version bigint,
  result_case_stage text, result_case_record_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tenant_id uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  actor_id uuid := nullif(current_setting('app.actor_user_id', true), '')::uuid;
  service_case public.cases_service_cases%ROWTYPE;
  list_version public.cases_candidate_school_list_versions%ROWTYPE;
  assessment_id uuid;
  manifest_id uuid;
  next_status text;
  existing_target_id uuid;
  item_row public.cases_candidate_school_list_items%ROWTYPE;
BEGIN
  SELECT candidate.* INTO service_case FROM public.cases_service_cases AS candidate
   WHERE candidate.id=target_case_id AND candidate.organization_id=tenant_id FOR UPDATE;
  SELECT candidate.* INTO list_version FROM public.cases_candidate_school_list_versions AS candidate
   WHERE candidate.id=target_version_id AND candidate.service_case_id=target_case_id
     AND candidate.organization_id=tenant_id FOR UPDATE;
  IF NOT FOUND OR NOT public.cases_actor_has_active_case_role(target_case_id,'advisor',true) THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_NOT_FOUND'::text,NULL::text,NULL::bigint,NULL::text,NULL::bigint; RETURN;
  END IF;
  PERFORM 1 FROM public.cases_candidate_school_list_items AS item
   WHERE item.list_version_id=list_version.id AND item.organization_id=tenant_id
   ORDER BY item.ordinal FOR UPDATE;
  IF service_case.record_version<>expected_case_record_version
     OR list_version.record_version<>expected_list_record_version THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_STALE_VERSION'::text,list_version.status,
      list_version.record_version,service_case.stage,service_case.record_version; RETURN;
  END IF;
  IF service_case.workflow_status<>'active' THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_CASE_NOT_ACTIVE'::text,list_version.status,
      list_version.record_version,service_case.stage,service_case.record_version; RETURN;
  END IF;
  IF list_version.status<>'awaiting_guardian' OR list_version.founder_decision<>'approved'
     OR list_version.founder_decision_sha256 IS DISTINCT FROM bound_founder_decision_sha256
     OR requested_decision NOT IN ('confirmed','not_confirmed')
     OR confirmation_channel NOT IN ('phone','wechat','in_person')
     OR guardian_decided_time > recorded_time THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_INVALID'::text,list_version.status,
      list_version.record_version,service_case.stage,service_case.record_version; RETURN;
  END IF;
  PERFORM 1 FROM public.crm_student_guardian_relationships AS relationship
   JOIN public.crm_guardians AS guardian ON guardian.id=relationship.guardian_id
    AND guardian.organization_id=relationship.organization_id AND guardian.status='active'
   WHERE relationship.id=target_relationship_id AND relationship.guardian_id=target_guardian_id
     AND relationship.student_id=service_case.student_id
     AND relationship.organization_id=tenant_id AND relationship.ends_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_GUARDIAN_INVALID'::text,list_version.status,
      list_version.record_version,service_case.stage,service_case.record_version; RETURN;
  END IF;
  SELECT assessment.id,assessment.manifest_id INTO assessment_id,manifest_id
    FROM public.cases_assessments AS assessment
   WHERE assessment.service_case_id=service_case.id AND assessment.organization_id=tenant_id
     AND assessment.status='background_complete' FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.cases_lock_assessment_blockers(
      assessment_id,manifest_id,'selection_ready')) THEN
    RETURN QUERY SELECT 'CANDIDATE_LIST_SELECTION_BLOCKED'::text,list_version.status,
      list_version.record_version,service_case.stage,service_case.record_version; RETURN;
  END IF;
  next_status := CASE requested_decision WHEN 'confirmed' THEN 'confirmed' ELSE 'returned' END;
  UPDATE public.cases_candidate_school_list_versions SET status=next_status,
    guardian_id=target_guardian_id,guardian_relationship_id=target_relationship_id,
    guardian_decision=requested_decision,guardian_decided_at=guardian_decided_time,
    guardian_confirmation_channel=confirmation_channel,guardian_recorded_by_user_id=actor_id,
    guardian_recorded_at=recorded_time,
    guardian_bound_founder_decision_sha256=bound_founder_decision_sha256,
    record_version=record_version+1,updated_at=recorded_time WHERE id=list_version.id;
  IF requested_decision='confirmed' THEN
    FOR item_row IN SELECT item.* FROM public.cases_candidate_school_list_items AS item
      WHERE item.list_version_id=list_version.id AND item.organization_id=tenant_id
      ORDER BY item.ordinal LOOP
      SELECT target.id INTO existing_target_id FROM public.cases_school_targets AS target
       WHERE target.organization_id=tenant_id AND target.service_case_id=service_case.id
         AND target.school_id=item_row.school_id AND target.intake_year=service_case.intake_year
         AND target.admission_type=service_case.admission_type FOR UPDATE;
      IF existing_target_id IS NULL THEN
        existing_target_id := gen_random_uuid();
        INSERT INTO public.cases_school_targets
          (id,organization_id,service_case_id,school_id,intake_year,admission_type,state,
           pinned_resolved_revision_id,pinned_resolution_sha256,application_round,
           origin_list_version_id,origin_list_item_id,record_version,created_at,updated_at)
        VALUES (existing_target_id,tenant_id,service_case.id,item_row.school_id,
          service_case.intake_year,service_case.admission_type,'candidate',
          item_row.pinned_resolved_revision_id,item_row.pinned_resolution_sha256,1,
          list_version.id,item_row.id,1,recorded_time,recorded_time);
      END IF;
      UPDATE public.cases_candidate_school_list_items SET school_target_id=existing_target_id
       WHERE id=item_row.id;
    END LOOP;
    IF service_case.stage='background_collection' THEN
      INSERT INTO public.cases_service_case_transition_facts
        (id,organization_id,service_case_id,actor_user_id,from_stage,to_stage,
         from_record_version,to_record_version,reason,transitioned_at,created_at)
      VALUES (transition_fact_id,tenant_id,service_case.id,actor_id,'background_collection',
        'school_selection_confirmed',service_case.record_version,service_case.record_version+1,
        'candidate_list_confirmed',recorded_time,recorded_time);
      PERFORM set_config('app.case_stage_transition','authorized',true);
      UPDATE public.cases_service_cases SET stage='school_selection_confirmed',
        record_version=record_version+1,updated_at=recorded_time WHERE id=service_case.id;
      service_case.stage := 'school_selection_confirmed';
      service_case.record_version := service_case.record_version+1;
    END IF;
  END IF;
  RETURN QUERY SELECT 'allowed'::text,next_status,list_version.record_version+1,
    service_case.stage,service_case.record_version;
END;
$$;

REVOKE INSERT, UPDATE, DELETE ON TABLE cases_candidate_school_list_versions FROM tianxing_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE cases_candidate_school_list_items FROM tianxing_app;
REVOKE INSERT ON TABLE cases_school_targets FROM tianxing_app;
REVOKE ALL ON FUNCTION cases_actor_has_active_case_role(uuid,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_create_candidate_list_version(
  uuid,uuid,uuid,bigint,text,text,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_review_candidate_list_version(
  uuid,uuid,bigint,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_record_guardian_list_decision(
  uuid,uuid,bigint,bigint,uuid,uuid,text,text,timestamptz,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_close_service_case(
  uuid,bigint,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases_create_candidate_list_version(
  uuid,uuid,uuid,bigint,text,text,jsonb,timestamptz) TO tianxing_app;
GRANT EXECUTE ON FUNCTION cases_actor_has_active_case_role(uuid,text,boolean) TO tianxing_app;
GRANT EXECUTE ON FUNCTION cases_review_candidate_list_version(
  uuid,uuid,bigint,text,text,timestamptz) TO tianxing_app;
GRANT EXECUTE ON FUNCTION cases_record_guardian_list_decision(
  uuid,uuid,bigint,bigint,uuid,uuid,text,text,timestamptz,text,uuid,timestamptz) TO tianxing_app;
GRANT EXECUTE ON FUNCTION cases_close_service_case(
  uuid,bigint,text,text,uuid,uuid,timestamptz) TO tianxing_app;
