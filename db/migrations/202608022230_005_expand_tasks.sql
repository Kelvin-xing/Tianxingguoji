CREATE TABLE tasks_transition_policies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  version bigint NOT NULL,
  status text NOT NULL DEFAULT 'candidate',
  requested_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  initial_state text,
  approval_decision_id text,
  approval_decision_status text,
  approved_by_user_id uuid REFERENCES identity_users (id),
  approved_role text,
  approved_at timestamptz,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT tasks_transition_policies_composite_key UNIQUE (id, organization_id),
  CONSTRAINT tasks_transition_policies_version_key UNIQUE (organization_id, version),
  CONSTRAINT tasks_transition_policies_version_check CHECK (version >= 1),
  CONSTRAINT tasks_transition_policies_status_check CHECK (
    status IN ('candidate', 'approved', 'retired')
  ),
  CONSTRAINT tasks_transition_policies_initial_state_check CHECK (
    initial_state IS NULL OR initial_state IN (
      'created',
      'assigned',
      'accepted',
      'rejected',
      'reassigned',
      'completed',
      'approved',
      'overdue',
      'cancelled'
    )
  ),
  CONSTRAINT tasks_transition_policies_approval_role_check CHECK (
    approved_role IS NULL OR approved_role IN ('founder', 'advisor')
  ),
  CONSTRAINT tasks_transition_policies_receipt_check CHECK (
    (
      status = 'candidate'
      AND approval_decision_id IS NULL
      AND approval_decision_status IS NULL
      AND approved_by_user_id IS NULL
      AND approved_role IS NULL
      AND approved_at IS NULL
    )
    OR (
      status IN ('approved', 'retired')
      AND approval_decision_id = 'OD-06'
      AND approval_decision_status = 'resolved'
      AND approved_by_user_id IS NOT NULL
      AND approved_role IS NOT NULL
      AND approved_at IS NOT NULL
    )
  ),
  CONSTRAINT tasks_transition_policies_record_version_check CHECK (record_version >= 1),
  CONSTRAINT tasks_transition_policies_timestamps_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX tasks_one_approved_policy_idx
  ON tasks_transition_policies (organization_id)
  WHERE status = 'approved';

CREATE TABLE tasks_transition_rules (
  organization_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  actor_kind text NOT NULL,
  allowed_actor_roles text[] NOT NULL,
  requires_reason boolean NOT NULL,
  requires_different_actor boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id, policy_id, from_state, to_state),
  CONSTRAINT tasks_transition_rules_policy_fk FOREIGN KEY (policy_id, organization_id)
    REFERENCES tasks_transition_policies (id, organization_id),
  CONSTRAINT tasks_transition_rules_state_check CHECK (
    from_state IN (
      'created',
      'assigned',
      'accepted',
      'rejected',
      'reassigned',
      'completed',
      'approved',
      'overdue',
      'cancelled'
    )
    AND to_state IN (
      'created',
      'assigned',
      'accepted',
      'rejected',
      'reassigned',
      'completed',
      'approved',
      'overdue',
      'cancelled'
    )
    AND from_state <> to_state
  ),
  CONSTRAINT tasks_transition_rules_actor_kind_check CHECK (
    actor_kind IN ('assignee', 'approver', 'owner')
  ),
  CONSTRAINT tasks_transition_rules_roles_check CHECK (
    cardinality(allowed_actor_roles) > 0
    AND allowed_actor_roles <@ ARRAY[
      'founder',
      'admin',
      'advisor',
      'data_reviewer',
      'contractor'
    ]::text[]
  ),
  CONSTRAINT tasks_transition_rules_reason_check CHECK (
    to_state NOT IN ('rejected', 'reassigned', 'cancelled', 'approved')
    OR requires_reason
  ),
  CONSTRAINT tasks_transition_rules_approval_check CHECK (
    to_state <> 'approved'
    OR (from_state = 'completed' AND requires_different_actor)
  )
);

CREATE TABLE tasks_tasks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  title text NOT NULL,
  state text NOT NULL,
  assignee_user_id uuid REFERENCES identity_users (id),
  assignee_role text,
  assignee_redaction_profile text,
  approver_user_id uuid REFERENCES identity_users (id),
  owner_user_id uuid REFERENCES identity_users (id),
  last_transition_actor_user_id uuid REFERENCES identity_users (id),
  last_transition_receipt_id uuid,
  last_transition_reason text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT tasks_tasks_case_fk FOREIGN KEY (service_case_id, organization_id)
    REFERENCES cases_service_cases (id, organization_id),
  CONSTRAINT tasks_tasks_composite_key UNIQUE (id, organization_id),
  CONSTRAINT tasks_tasks_state_check CHECK (
    state IN (
      'created',
      'assigned',
      'accepted',
      'rejected',
      'reassigned',
      'completed',
      'approved',
      'overdue',
      'cancelled'
    )
  ),
  CONSTRAINT tasks_tasks_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT tasks_tasks_assignee_role_check CHECK (
    assignee_role IS NULL OR assignee_role IN ('advisor', 'contractor')
  ),
  CONSTRAINT tasks_tasks_contractor_redaction_check CHECK (
    (
      assignee_role = 'contractor'
      AND assignee_redaction_profile = 'task_only'
    )
    OR (
      assignee_role IS DISTINCT FROM 'contractor'
      AND assignee_redaction_profile IS NULL
    )
  ),
  CONSTRAINT tasks_tasks_record_version_check CHECK (record_version >= 1),
  CONSTRAINT tasks_tasks_timestamps_check CHECK (updated_at >= created_at)
);

CREATE TABLE tasks_task_assignments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  task_id uuid NOT NULL,
  assignee_user_id uuid NOT NULL REFERENCES identity_users (id),
  assignee_role text NOT NULL,
  redaction_profile text,
  assigned_by_user_id uuid NOT NULL REFERENCES identity_users (id),
  status text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT tasks_task_assignments_task_fk FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks_tasks (id, organization_id),
  CONSTRAINT tasks_task_assignments_role_check CHECK (assignee_role IN ('advisor', 'contractor')),
  CONSTRAINT tasks_task_assignments_contractor_redaction_check CHECK (
    (
      assignee_role = 'contractor'
      AND redaction_profile = 'task_only'
    )
    OR (assignee_role = 'advisor' AND redaction_profile IS NULL)
  ),
  CONSTRAINT tasks_task_assignments_status_check CHECK (
    status IN ('assigned', 'reassigned', 'removed')
  ),
  CONSTRAINT tasks_task_assignments_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT tasks_task_assignments_composite_key UNIQUE (id, organization_id, task_id)
);

CREATE TABLE tasks_task_transition_receipts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  task_id uuid NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity_users (id),
  actor_role text NOT NULL,
  expected_record_version bigint NOT NULL,
  result_record_version bigint NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT tasks_task_transition_receipts_task_fk FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks_tasks (id, organization_id),
  CONSTRAINT tasks_task_transition_receipts_composite_key UNIQUE (id, organization_id, task_id),
  CONSTRAINT tasks_task_transition_receipts_state_check CHECK (
    from_state IN (
      'created',
      'assigned',
      'accepted',
      'rejected',
      'reassigned',
      'completed',
      'approved',
      'overdue',
      'cancelled'
    )
    AND to_state IN (
      'created',
      'assigned',
      'accepted',
      'rejected',
      'reassigned',
      'completed',
      'approved',
      'overdue',
      'cancelled'
    )
    AND from_state <> to_state
  ),
  CONSTRAINT tasks_task_transition_receipts_actor_role_check CHECK (
    actor_role IN ('founder', 'admin', 'advisor', 'data_reviewer', 'contractor')
  ),
  CONSTRAINT tasks_task_transition_receipts_version_check CHECK (
    expected_record_version >= 1
    AND result_record_version = expected_record_version + 1
  ),
  CONSTRAINT tasks_task_transition_receipts_reason_check CHECK (
    to_state NOT IN ('rejected', 'reassigned', 'cancelled', 'approved')
    OR (reason IS NOT NULL AND btrim(reason) <> '')
  )
);

ALTER TABLE tasks_tasks
  ADD CONSTRAINT tasks_tasks_last_receipt_fk FOREIGN KEY (
    last_transition_receipt_id,
    organization_id,
    id
  ) REFERENCES tasks_task_transition_receipts (id, organization_id, task_id);

CREATE FUNCTION tasks_reject_immutable_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = TG_ARGV[0],
    MESSAGE = 'task policy, assignment, or transition history is immutable';
END;
$$;

CREATE FUNCTION tasks_reject_immutable_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = TG_ARGV[0],
    MESSAGE = 'task assignment history is immutable';
END;
$$;

CREATE FUNCTION tasks_validate_transition_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rule_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'candidate' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'tasks_policy_candidate_insert_check',
        MESSAGE = 'task policies must enter as candidate';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.initial_state IS DISTINCT FROM OLD.initial_state
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'tasks_policy_content_immutable_check',
      MESSAGE = 'task policy content is immutable';
  END IF;

  IF OLD.status = 'candidate' AND NEW.status = 'approved' THEN
    IF NEW.approval_decision_id <> 'OD-06'
       OR NEW.approval_decision_status <> 'resolved'
       OR NEW.approved_by_user_id IS NULL
       OR NEW.approved_role IS NULL
       OR NEW.approved_at IS NULL
       OR NEW.approved_by_user_id = NEW.requested_by_user_id
       OR NEW.initial_state IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'tasks_policy_approval_receipt_check',
        MESSAGE = 'task policy requires a resolved OD-06 receipt and explicit initial state';
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
        CONSTRAINT = 'tasks_policy_reviewer_role_check',
        MESSAGE = 'task policy reviewer has no active role binding';
    END IF;

    SELECT count(*)
      INTO rule_count
      FROM tasks_transition_rules
     WHERE organization_id = NEW.organization_id
       AND policy_id = NEW.id;
    IF rule_count = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'tasks_policy_rules_required_check',
        MESSAGE = 'approved task policy requires transition rules';
    END IF;
  ELSIF OLD.status = 'approved' AND NEW.status = 'retired' THEN
    IF NEW.approval_decision_id IS DISTINCT FROM OLD.approval_decision_id
       OR NEW.approval_decision_status IS DISTINCT FROM OLD.approval_decision_status
       OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.approved_role IS DISTINCT FROM OLD.approved_role
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'tasks_policy_approval_receipt_immutable_check',
        MESSAGE = 'task policy approval receipt is immutable';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'tasks_policy_status_transition_check',
      MESSAGE = 'task policy status transition is not allowed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION tasks_validate_transition_rule_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  policy_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status
      INTO policy_status
      FROM tasks_transition_policies
     WHERE id = NEW.policy_id
       AND organization_id = NEW.organization_id;
    IF policy_status IS DISTINCT FROM 'candidate' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'tasks_transition_rules_candidate_only_check',
        MESSAGE = 'transition rules may only be added to candidate policies';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'tasks_transition_rules_immutable_check',
    MESSAGE = 'transition rules are immutable';
END;
$$;

CREATE FUNCTION tasks_validate_task_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  policy_initial_state text;
  rule_actor_kind text;
  rule_allowed_roles text[];
  rule_requires_reason boolean;
  rule_requires_different_actor boolean;
  receipt_from_state text;
  receipt_to_state text;
  receipt_actor_id uuid;
  receipt_actor_role text;
  receipt_expected_version bigint;
  receipt_reason text;
BEGIN
  IF NEW.assignee_role = 'contractor' AND NEW.assignee_redaction_profile <> 'task_only' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      CONSTRAINT = 'tasks_contractor_redaction_check',
      MESSAGE = 'contractor task context must be task_only redacted';
  END IF;

  SELECT initial_state
    INTO policy_initial_state
    FROM tasks_transition_policies
   WHERE organization_id = NEW.organization_id
     AND status = 'approved';
  IF policy_initial_state IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      CONSTRAINT = 'tasks_policy_not_approved_check',
      MESSAGE = 'task writes require an approved transition policy';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM policy_initial_state THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'tasks_initial_state_check',
        MESSAGE = 'task initial state does not match the approved policy';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.service_case_id IS DISTINCT FROM OLD.service_case_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.record_version <> OLD.record_version + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'tasks_task_content_immutable_check',
      MESSAGE = 'task identity and version transition are invalid';
  END IF;

  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    IF NEW.assignee_user_id IS DISTINCT FROM OLD.assignee_user_id
       OR NEW.assignee_role IS DISTINCT FROM OLD.assignee_role
       OR NEW.assignee_redaction_profile IS DISTINCT FROM OLD.assignee_redaction_profile
       OR NEW.approver_user_id IS DISTINCT FROM OLD.approver_user_id
       OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
       OR NEW.last_transition_actor_user_id IS DISTINCT FROM OLD.last_transition_actor_user_id
       OR NEW.last_transition_receipt_id IS DISTINCT FROM OLD.last_transition_receipt_id
       OR NEW.last_transition_reason IS DISTINCT FROM OLD.last_transition_reason THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'tasks_assignment_transition_required_check',
        MESSAGE = 'task assignment changes require an approved state transition';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.last_transition_receipt_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'tasks_transition_receipt_required_check',
      MESSAGE = 'task state changes require a transition receipt';
  END IF;

  SELECT from_state, to_state, actor_user_id, actor_role, expected_record_version, reason
    INTO receipt_from_state, receipt_to_state, receipt_actor_id, receipt_actor_role,
         receipt_expected_version, receipt_reason
    FROM tasks_task_transition_receipts
   WHERE id = NEW.last_transition_receipt_id
     AND organization_id = NEW.organization_id
     AND task_id = NEW.id;
  IF receipt_from_state IS DISTINCT FROM OLD.state
     OR receipt_to_state IS DISTINCT FROM NEW.state
     OR receipt_actor_id IS NULL
     OR receipt_actor_role IS NULL
     OR receipt_actor_id IS DISTINCT FROM NEW.last_transition_actor_user_id
     OR receipt_expected_version IS DISTINCT FROM OLD.record_version
     OR receipt_reason IS DISTINCT FROM NEW.last_transition_reason THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'tasks_transition_receipt_match_check',
      MESSAGE = 'transition receipt does not match task update';
  END IF;

  SELECT rule.actor_kind, rule.allowed_actor_roles, rule.requires_reason, rule.requires_different_actor
    INTO rule_actor_kind, rule_allowed_roles, rule_requires_reason, rule_requires_different_actor
    FROM tasks_transition_policies AS policy
    JOIN tasks_transition_rules AS rule
      ON rule.policy_id = policy.id
     AND rule.organization_id = policy.organization_id
     AND rule.from_state = OLD.state
     AND rule.to_state = NEW.state
   WHERE policy.organization_id = NEW.organization_id
     AND policy.status = 'approved';
  IF rule_actor_kind IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'tasks_transition_not_allowed_check',
      MESSAGE = 'task transition is not in the approved policy';
  END IF;
  IF rule_requires_reason AND (NEW.last_transition_reason IS NULL OR btrim(NEW.last_transition_reason) = '') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'tasks_transition_reason_required_check',
      MESSAGE = 'task transition requires a reason';
  END IF;
  IF rule_requires_different_actor AND receipt_actor_id = NEW.assignee_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      CONSTRAINT = 'tasks_approval_separation_check',
      MESSAGE = 'task completion and approval require separate actors';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM identity_users AS actor
      JOIN access_role_bindings AS binding
        ON binding.user_id = actor.id
       AND binding.organization_id = NEW.organization_id
        AND binding.role = receipt_actor_role
        AND binding.role = ANY(rule_allowed_roles)
       AND binding.status = 'active'
     WHERE actor.id = receipt_actor_id
       AND actor.status = 'active'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      CONSTRAINT = 'tasks_transition_actor_role_check',
      MESSAGE = 'task transition actor has no active permitted role';
  END IF;
  IF rule_actor_kind = 'assignee' AND receipt_actor_id IS DISTINCT FROM NEW.assignee_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      CONSTRAINT = 'tasks_transition_assignee_check',
      MESSAGE = 'task transition actor is not the assignee';
  ELSIF rule_actor_kind = 'approver' AND receipt_actor_id IS DISTINCT FROM NEW.approver_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      CONSTRAINT = 'tasks_transition_approver_check',
      MESSAGE = 'task transition actor is not the approver';
  ELSIF rule_actor_kind = 'owner' AND receipt_actor_id IS DISTINCT FROM NEW.owner_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      CONSTRAINT = 'tasks_transition_owner_check',
      MESSAGE = 'task transition actor is not the task owner';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION tasks_validate_transition_receipt_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_state text;
  current_record_version bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'tasks_transition_receipts_immutable_check',
      MESSAGE = 'task transition receipts are immutable';
  END IF;

  SELECT state, record_version
    INTO current_state, current_record_version
    FROM tasks_tasks
   WHERE id = NEW.task_id
     AND organization_id = NEW.organization_id;
  IF current_state IS NULL
     OR NEW.from_state IS DISTINCT FROM current_state
     OR NEW.expected_record_version IS DISTINCT FROM current_record_version THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'tasks_transition_receipt_version_check',
      MESSAGE = 'transition receipt is stale or does not match the task';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_transition_policies_write_trg
BEFORE INSERT OR UPDATE ON tasks_transition_policies
FOR EACH ROW EXECUTE FUNCTION tasks_validate_transition_policy();

CREATE TRIGGER tasks_transition_rules_write_trg
BEFORE INSERT OR UPDATE ON tasks_transition_rules
FOR EACH ROW EXECUTE FUNCTION tasks_validate_transition_rule_write();

CREATE TRIGGER tasks_tasks_write_trg
BEFORE INSERT OR UPDATE ON tasks_tasks
FOR EACH ROW EXECUTE FUNCTION tasks_validate_task_write();

CREATE TRIGGER tasks_transition_receipts_write_trg
BEFORE INSERT OR UPDATE ON tasks_task_transition_receipts
FOR EACH ROW EXECUTE FUNCTION tasks_validate_transition_receipt_write();

CREATE TRIGGER tasks_assignments_delete_trg
BEFORE DELETE ON tasks_task_assignments
FOR EACH ROW EXECUTE FUNCTION tasks_reject_immutable_delete('tasks_task_assignments_delete_rejected');

CREATE TRIGGER tasks_assignments_update_trg
BEFORE UPDATE ON tasks_task_assignments
FOR EACH ROW EXECUTE FUNCTION tasks_reject_immutable_update('tasks_task_assignments_update_rejected');

CREATE TRIGGER tasks_tasks_delete_trg
BEFORE DELETE ON tasks_tasks
FOR EACH ROW EXECUTE FUNCTION tasks_reject_immutable_delete('tasks_tasks_delete_rejected');

CREATE TRIGGER tasks_transition_policies_delete_trg
BEFORE DELETE ON tasks_transition_policies
FOR EACH ROW EXECUTE FUNCTION tasks_reject_immutable_delete('tasks_transition_policies_delete_rejected');

CREATE TRIGGER tasks_transition_rules_delete_trg
BEFORE DELETE ON tasks_transition_rules
FOR EACH ROW EXECUTE FUNCTION tasks_reject_immutable_delete('tasks_transition_rules_delete_rejected');

CREATE TRIGGER tasks_transition_receipts_delete_trg
BEFORE DELETE ON tasks_task_transition_receipts
FOR EACH ROW EXECUTE FUNCTION tasks_reject_immutable_delete('tasks_transition_receipts_delete_rejected');
