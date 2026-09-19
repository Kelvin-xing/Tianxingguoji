-- Restore command-only columns when the application is also the one-role owner.
-- A distinct migration owner retains the original application grants.
DO $$
BEGIN
  IF current_user='tianxing_app' AND EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='cases_candidate_school_list_versions'
      AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  ) THEN
    GRANT INSERT ON cases_candidate_school_list_versions,cases_candidate_school_list_items TO tianxing_app;
    GRANT INSERT ON cases_school_targets TO tianxing_app;
    GRANT UPDATE (status,submitted_at,founder_decision,founder_decided_by_user_id,founder_decided_at,
      founder_decision_reason,founder_decision_sha256,guardian_id,guardian_relationship_id,
      guardian_decision,guardian_decided_at,guardian_confirmation_channel,
      guardian_recorded_by_user_id,guardian_recorded_at,guardian_bound_founder_decision_sha256,
      record_version,updated_at) ON cases_candidate_school_list_versions TO tianxing_app;
    GRANT UPDATE (school_target_id) ON cases_candidate_school_list_items TO tianxing_app;
  END IF;
END;
$$;

-- Use PostgreSQL 17 sha256(bytea), without a pgcrypto extension dependency.

CREATE OR REPLACE FUNCTION public.cases_create_candidate_list_version_v2(
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
  SELECT encode(sha256(convert_to(string_agg(
      item.ordinal::text || ':' || item.school_id::text || ':'
      || item.pinned_resolved_revision_id::text || ':' || item.pinned_resolution_sha256 || ':'
      || to_char(item.application_deadline AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      '|' ORDER BY item.ordinal),'UTF8')),'hex') INTO actual_hash
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

CREATE OR REPLACE FUNCTION cases_review_candidate_list_version(
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
  decision_hash := encode(sha256(convert_to(jsonb_build_object(
    'decision',requested_decision,'reason',btrim(decision_reason),
    'school_set_sha256',list_version.school_set_sha256,
    'version_id',list_version.id,'version_number',list_version.version_number)::text,
    'UTF8')),'hex');
  UPDATE public.cases_candidate_school_list_versions SET status=next_status,
    founder_decision=requested_decision,founder_decided_by_user_id=actor_id,
    founder_decided_at=decision_time,founder_decision_reason=btrim(decision_reason),
    founder_decision_sha256=decision_hash,record_version=record_version+1,
    updated_at=decision_time WHERE id=list_version.id;
  RETURN QUERY SELECT 'allowed'::text,next_status,list_version.record_version+1,decision_hash;
END;
$$;
