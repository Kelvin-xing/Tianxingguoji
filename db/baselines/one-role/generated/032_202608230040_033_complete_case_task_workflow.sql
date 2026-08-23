DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tasks_tasks) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'tasks_tasks_legacy_content_migration_required',
      MESSAGE = 'existing tasks require an approved business-data migration';
  END IF;
END;
$$;

ALTER TABLE public.tasks_tasks
  ADD COLUMN task_brief text NOT NULL,
  ADD COLUMN due_at timestamptz NOT NULL,
  ADD CONSTRAINT tasks_tasks_task_brief_check
    CHECK (task_brief = btrim(task_brief) AND char_length(task_brief) BETWEEN 1 AND 4000);

CREATE FUNCTION public.tasks_validate_workflow_fields_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.task_brief IS DISTINCT FROM OLD.task_brief
     OR NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'tasks_tasks_workflow_fields_immutable_check',
      MESSAGE = 'task brief and due date are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_tasks_workflow_fields_immutable_trg
BEFORE UPDATE ON public.tasks_tasks
FOR EACH ROW EXECUTE FUNCTION public.tasks_validate_workflow_fields_immutable();

REVOKE ALL ON FUNCTION public.tasks_validate_workflow_fields_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tasks_validate_workflow_fields_immutable() TO tianxing_app;
