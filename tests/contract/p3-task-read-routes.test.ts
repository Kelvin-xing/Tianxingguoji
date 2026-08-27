import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("P3 authoritative read routes expose the exact projection and request-time Access", async () => {
  const [detail, assigned, service, repository] = await Promise.all([
    readFile("app/api/v1/tasks/[taskId]/p3/route.ts", "utf8"),
    readFile("app/api/v1/tasks/assigned/route.ts", "utf8"),
    readFile("modules/tasks/application/p3-read-service.ts", "utf8"),
    readFile("modules/tasks/infrastructure/postgresql-p3-read-repository.ts", "utf8"),
  ]);
  for (const source of [detail, assigned]) {
    assert.match(source, /requireApiRequestAccessContext/);
    assert.match(source, /getP3TaskReadRuntime/);
  }
  for (const field of ["task_kind", "school_target_id", "is_overdue", "record_version", "current_assignment", "allowed_actions"]) {
    assert.match(service, new RegExp(field));
  }
  assert.match(service, /tasks\.read/);
  assert.match(service, /founder/);
  assert.match(service, /advisor/);
  assert.match(service, /task_kind === "manual"/);
  assert.match(service, /reassign/);
  assert.match(service, /current_assignment === null/);
  assert.match(service, /task_kind === "application_prepare_submit"/);
  assert.match(repository, /task\.assignee_user_id=\$2::uuid/);
  assert.match(repository, /service_case\.primary_user_id=\$2::uuid/);
  assert.match(repository, /binding\.role = CASE WHEN \$3::boolean THEN 'founder' ELSE 'advisor' END/);
});
