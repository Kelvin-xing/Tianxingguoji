import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = await readFile("modules/tasks/infrastructure/p3-postgresql-repository.ts", "utf8");
const transitionRoute = await readFile("app/api/v1/tasks/[taskId]/p3-transitions/route.ts", "utf8");
const [p3ReadRoute, assignedReadRoute, p3ReadService] = await Promise.all([
  readFile("app/api/v1/tasks/[taskId]/p3/route.ts", "utf8"),
  readFile("app/api/v1/tasks/assigned/route.ts", "utf8"),
  readFile("modules/tasks/application/p3-read-service.ts", "utf8"),
]);

test("Tasks repository consumes public facts and owns only task tables", () => {
  assert.match(repository, /runIdempotentTransaction/);
  assert.match(repository, /readTargetTaskFacts/);
  assert.match(repository, /readActorBindingFacts/);
  assert.match(repository, /readCleanCaseEvidence/);
  assert.doesNotMatch(repository, /(?:cases_|access_|documents_)[a-z_]+/);
  assert.doesNotMatch(repository, /actor\.roles\s*\?\.\s*\[0\]/);
});

test("public provision route is removed; only post-commit consumer may create automatic tasks", async () => {
  await assert.rejects(() => readFile("app/api/v1/tasks/provision/route.ts", "utf8"));
  const consumer = await readFile("modules/tasks/application/application-task-request-consumer.ts", "utf8");
  assert.match(consumer, /lockAuditOutboxSourceTransaction/);
  assert.match(consumer, /INSERT INTO tasks_tasks/);
});

test("transition DTO rejects extra fields and keeps Cases eventual", () => {
  assert.match(transitionRoute, /const expected = action === "accept"/);
  assert.match(transitionRoute, /keys\.join\(\",\"\) !== expected/);
  assert.match(transitionRoute, /checklist_snapshot,no_reference_declared,official_submission_reference,submission_channel,submitted_at,submitter_user_id/);
  assert.doesNotMatch(transitionRoute, /getSchoolTargetRuntime/);
});

test("authoritative P3 reads use request-time Access and expose owner-only rejected-task reassignment", () => {
  assert.match(p3ReadRoute, /requireApiRequestAccessContext/);
  assert.match(assignedReadRoute, /requireApiRequestAccessContext/);
  for (const field of ["task_kind", "school_target_id", "is_overdue", "record_version", "current_assignment", "allowed_actions"]) {
    assert.match(p3ReadService, new RegExp(field));
  }
  assert.match(p3ReadService, /tasks\.read/);
  assert.match(p3ReadService, /founder/);
  assert.match(p3ReadService, /advisor/);
  assert.match(p3ReadService, /reassign/);
  assert.match(p3ReadService, /current_assignment === null/);
  assert.match(p3ReadService, /task_kind === "application_prepare_submit"/);
  assert.match(repository, /applicationReassignmentAfterReject/);
  assert.match(repository, /RETURNING id/);
});
