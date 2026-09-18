-- BR-015: preserve the actual identity role in generated target assignments.
ALTER TABLE cases_school_target_assignments DROP CONSTRAINT cases_target_assignments_role_check;
ALTER TABLE cases_school_target_assignments ADD CONSTRAINT cases_target_assignments_role_check
  CHECK (assignee_role IN ('advisor','contractor','founder','l1','l2','l3'));

CREATE OR REPLACE FUNCTION public.cases_promote_confirmed_targets_to_preparing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  event_time timestamptz := GREATEST(clock_timestamp(),NEW.updated_at);
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
    IF EXISTS (
      SELECT 1 FROM public.cases_service_cases c WHERE c.id=target.service_case_id
        AND public.cases_trial_member_can_manage(c.organization_id,c.primary_user_id,
          c.business_category,c.primary_role) IS FALSE
    ) THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='target owner is outside current trial scope';
    END IF;
    assignment_id := gen_random_uuid(); fact_id := gen_random_uuid(); outbox_id := gen_random_uuid();
    INSERT INTO public.cases_school_target_assignments
      (id,organization_id,service_case_id,school_target_id,assignee_user_id,
       assignee_membership_id,advisor_role_binding_id,assignee_role,assigned_by_user_id,assignment_reason,
       starts_at,created_at,updated_at)
    SELECT assignment_id,target.organization_id,target.service_case_id,target.id,
      c.primary_user_id,c.primary_membership_id,c.primary_role_binding_id,c.primary_role,
      COALESCE(actor_id,c.primary_user_id),'confirmed_list',event_time,event_time,event_time
      FROM public.cases_service_cases c WHERE c.id=target.service_case_id;
    INSERT INTO public.cases_school_target_transition_facts
      (id,organization_id,service_case_id,school_target_id,transition_kind,from_state,to_state,
       actor_user_id,assignment_id,from_record_version,to_record_version,application_deadline,occurred_at)
    VALUES (fact_id,target.organization_id,target.service_case_id,target.id,'workflow','candidate',
      'preparing',actor_id,assignment_id,target.record_version,target.record_version+1,
      item.application_deadline,event_time);
    PERFORM set_config('app.target_workflow_transition','authorized',true);
    UPDATE public.cases_school_targets SET state='preparing',current_assignment_id=assignment_id,
      application_deadline=item.application_deadline,record_version=record_version+1,
      updated_at=event_time WHERE id=target.id;
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
        'target_preparing',event_time,event_time
        FROM public.cases_service_cases c
       WHERE c.id=target.service_case_id AND c.organization_id=target.organization_id
         AND c.stage='school_selection_confirmed';
      PERFORM set_config('app.case_stage_transition','authorized',true);
      UPDATE public.cases_service_cases SET stage='application_in_progress',record_version=record_version+1,
        updated_at=event_time
       WHERE id=target.service_case_id AND organization_id=target.organization_id
         AND stage='school_selection_confirmed';
      case_promoted := true;
    END IF;
    INSERT INTO public.audit_events
      (id,organization_id,actor_user_id,actor_kind,event_type,event_version,action,
       resource_type,resource_id,outcome,request_id,occurred_at,metadata)
    VALUES (fact_id,target.organization_id,actor_id,'user','cases.application_task_requested',2,
      'request','SchoolTarget',target.id,'succeeded',request_key,event_time,
      jsonb_build_object('effect_type','cases.application_task_requested',
        'record_version',target.record_version+1,'status','preparing'));
    INSERT INTO public.audit_outbox
      (id,audit_event_id,organization_id,aggregate_type,aggregate_id,event_type,event_version,
       idempotency_key,request_id,payload,status,available_at,created_at,updated_at)
    VALUES (outbox_id,fact_id,target.organization_id,'SchoolTarget',target.id,
      'cases.application_task_requested',2,
      'application-'||target.id||'-round-'||target.application_round::text,request_key,
      jsonb_build_object('aggregate_id',target.id,'record_version',target.record_version+1,
        'request_id',request_key,'effect_type','cases.application_task_requested','status','preparing'),
      'pending',event_time,event_time,event_time);
  END LOOP;
  RETURN NEW;
END;
$$;
