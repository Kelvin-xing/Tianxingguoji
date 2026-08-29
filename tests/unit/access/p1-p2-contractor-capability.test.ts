import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE } from "../../../modules/access/domain/contract.ts";

test("Release1 Contractor receives only coarse task read/transition capabilities", () => {
  assert.deepEqual(BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE.contractor, ["tasks.read", "tasks.transition"]);
  assert.equal(BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE.contractor.includes("tasks.create"), false);
  assert.equal(BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE.contractor.some((value) => value.startsWith("cases.") || value.startsWith("documents.")), false);
});

test("Contractor task repository revalidates latest task-only assignment and terminal resources each request", () => {
  const source = readFileSync("modules/tasks/infrastructure/postgresql-workspace-repository.ts", "utf8");
  assert.match(source, /task\.state NOT IN \('completed','cancelled','rejected'\)/);
  assert.match(source, /service_case\.stage <> 'closed'/);
  assert.match(source, /student\.status = 'active'/);
  assert.match(source, /tasks_task_assignments current_assignment/);
  assert.match(source, /current_assignment\.status IN \('assigned','accepted','reassigned'\)/);
  assert.match(source, /current_assignment\.redaction_profile='task_only'/);
  assert.match(source, /current_assignment\.id = \(SELECT latest_assignment\.id/);
  assert.match(source, /ORDER BY latest_assignment\.created_at DESC,latest_assignment\.id DESC/);
  assert.match(source, /LIMIT 1/);
  assert.doesNotMatch(source, /current_assignment\.status='assigned'/);
});
