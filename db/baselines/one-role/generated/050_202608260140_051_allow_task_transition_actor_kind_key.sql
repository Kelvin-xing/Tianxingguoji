-- Forward corrective: Release 1 may define one state transition for more
-- than one actor kind. The historical key from migration 005 omitted it.

ALTER TABLE public.tasks_transition_rules
  DROP CONSTRAINT IF EXISTS tasks_transition_rules_pkey;

ALTER TABLE public.tasks_transition_rules
  ADD CONSTRAINT tasks_transition_rules_pkey PRIMARY KEY (
    organization_id,
    policy_id,
    from_state,
    to_state,
    actor_kind
  );
