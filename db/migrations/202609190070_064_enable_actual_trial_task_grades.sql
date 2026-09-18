-- BR-015: assignments and receipts retain actual employee grades; L3 is always task-only.
ALTER TABLE tasks_tasks DROP CONSTRAINT tasks_tasks_assignee_role_check;
ALTER TABLE tasks_tasks ADD CONSTRAINT tasks_tasks_assignee_role_check CHECK (
  assignee_role IS NULL OR assignee_role IN ('advisor','contractor','founder','l1','l2','l3'));
ALTER TABLE tasks_tasks DROP CONSTRAINT tasks_tasks_contractor_redaction_check;
ALTER TABLE tasks_tasks ADD CONSTRAINT tasks_tasks_contractor_redaction_check CHECK (
  (assignee_role IN ('contractor','l3') AND assignee_redaction_profile IS NOT DISTINCT FROM 'task_only')
  OR (assignee_role IS NULL AND assignee_redaction_profile IS NULL)
  OR (assignee_role IN ('advisor','founder','l1','l2') AND assignee_redaction_profile IS NULL));
ALTER TABLE tasks_task_assignments DROP CONSTRAINT tasks_task_assignments_role_check;
ALTER TABLE tasks_task_assignments ADD CONSTRAINT tasks_task_assignments_role_check CHECK (
  assignee_role IN ('advisor','contractor','founder','l1','l2','l3'));
ALTER TABLE tasks_task_assignments DROP CONSTRAINT tasks_task_assignments_contractor_redaction_check;
ALTER TABLE tasks_task_assignments ADD CONSTRAINT tasks_task_assignments_contractor_redaction_check CHECK (
  (assignee_role IN ('contractor','l3') AND redaction_profile IS NOT DISTINCT FROM 'task_only')
  OR (assignee_role IN ('advisor','founder','l1','l2') AND redaction_profile IS NULL));
ALTER TABLE tasks_task_transition_receipts DROP CONSTRAINT tasks_task_transition_receipts_actor_role_check;
ALTER TABLE tasks_task_transition_receipts ADD CONSTRAINT tasks_task_transition_receipts_actor_role_check CHECK (
  actor_role IN ('founder','admin','advisor','data_reviewer','contractor','l1','l2','l3'));

-- 041/052 replace the receipt state contract under a shorter constraint name.
-- Retaining 005's separate constraint wrongly rejects awaiting_reassignment and rejection receipts.
ALTER TABLE tasks_task_transition_receipts DROP CONSTRAINT tasks_task_transition_receipts_state_check;
