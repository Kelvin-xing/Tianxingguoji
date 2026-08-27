-- Forward corrective: migration 041 introduced the Release 1
-- awaiting_reassignment state for tasks, but the historical transition-rule
-- constraint from migration 005 did not include it. Preserve legacy values
-- for historical rules while allowing the approved current policy.

ALTER TABLE public.tasks_transition_rules
  DROP CONSTRAINT IF EXISTS tasks_transition_rules_state_check;

ALTER TABLE public.tasks_transition_rules
  ADD CONSTRAINT tasks_transition_rules_state_check CHECK (
    from_state IN (
      'created',
      'assigned',
      'accepted',
      'rejected',
      'reassigned',
      'awaiting_reassignment',
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
      'awaiting_reassignment',
      'completed',
      'approved',
      'overdue',
      'cancelled'
    )
    AND from_state <> to_state
  );
