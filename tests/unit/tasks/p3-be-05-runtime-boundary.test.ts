import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = await readFile("modules/tasks/infrastructure/p3-postgresql-repository.ts", "utf8");
const provisionRoute = await readFile("app/api/v1/tasks/provision/route.ts", "utf8");
const transitionRoute = await readFile("app/api/v1/tasks/[taskId]/p3-transitions/route.ts", "utf8");

test("Tasks repository consumes public facts and owns only task tables", () => {
  assert.match(repository, /runIdempotentTransaction/);
  assert.match(repository, /readTargetTaskFacts/);
  assert.match(repository, /readActorBindingFacts/);
  assert.match(repository, /readCleanCaseEvidence/);
  assert.doesNotMatch(repository, /(?:cases_|access_|documents_)[a-z_]+/);
  assert.doesNotMatch(repository, /actor\.roles\s*\?\.\s*\[0\]/);
});

test("provision DTO does not accept a client assignee", () => {
  assert.doesNotMatch(provisionRoute, /assignee_user_id/);
  assert.match(provisionRoute, /Object\.keys\(body\)\.sort\(\)/);
});

test("transition DTO rejects extra fields and keeps Cases eventual", () => {
  assert.match(transitionRoute, /const expected = action === "accept"/);
  assert.match(transitionRoute, /keys\.join\(\",\"\) !== expected/);
  assert.doesNotMatch(transitionRoute, /getSchoolTargetRuntime/);
});
