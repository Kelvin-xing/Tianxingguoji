import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE = "db/migrations/202608230040_033_complete_case_task_workflow.sql";
const REPOSITORY = "modules/tasks/infrastructure/postgresql-workspace-repository.ts";

test("migration 033 fails closed for legacy tasks and freezes required workflow fields", async () => {
  const sql = await readFile(SOURCE, "utf8");
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM public\.tasks_tasks\)/);
  assert.match(sql, /tasks_tasks_legacy_content_migration_required/);
  assert.match(sql, /ADD COLUMN task_brief text NOT NULL/);
  assert.match(sql, /ADD COLUMN due_at timestamptz NOT NULL/);
  assert.match(sql, /char_length\(task_brief\) BETWEEN 1 AND 4000/);
  assert.match(sql, /tasks_tasks_workflow_fields_immutable_check/);
  assert.match(sql, /NEW\.task_brief IS DISTINCT FROM OLD\.task_brief/);
  assert.match(sql, /NEW\.due_at IS DISTINCT FROM OLD\.due_at/);
  assert.match(sql, /SET search_path = pg_catalog, public/);
  assert.doesNotMatch(sql, /ALTER ROLE|DISABLE ROW LEVEL SECURITY|DROP TABLE/i);
});

test("generated baseline contains migration 033 without changing its safety contract", async () => {
  const generated = await readFile(
    "db/baselines/one-role/generated/032_202608230040_033_complete_case_task_workflow.sql",
    "utf8",
  );
  assert.match(generated, /tasks_tasks_legacy_content_migration_required/);
  assert.match(generated, /tasks_tasks_workflow_fields_immutable_trg/);
});

test("task transitions lock current Case authority and synchronize the trigger owner projection", async () => {
  const source = await readFile(REPOSITORY, "utf8");
  assert.match(source, /FOR UPDATE OF task,service_case/);
  assert.match(source, /owner_user_id=\$9/);
  assert.match(source, /task\.primary_user_id\]\);/);
  assert.match(source, /if \(updated\.rowCount !== 1\) stale\(\);/);
  assert.doesNotMatch(source, /DISABLE TRIGGER|DISABLE ROW LEVEL SECURITY/i);
});
