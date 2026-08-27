import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routes = [
  "app/api/v1/cases/[caseId]/candidate-lists/route.ts",
  "app/api/v1/cases/[caseId]/candidate-lists/[versionId]/review/route.ts",
  "app/api/v1/cases/[caseId]/candidate-lists/[versionId]/guardian-decision/route.ts",
  "app/api/v1/cases/[caseId]/lifecycle/route.ts",
] as const;

test("all P2-BE-04 commands resolve request-time Access union", async () => {
  for (const path of routes) {
    const source = await readFile(path,"utf8");
    assert.match(source,/requireApiRequestAccessContext\(\)/,path);
    assert.doesNotMatch(source,/requireIdentityActor|actor\.role|workspaceCapabilitiesForRole/,path);
  }
});

test("commands require Idempotency-Key and reject unknown body fields", async () => {
  const support = await readFile(
    "app/api/v1/cases/[caseId]/candidate-lists/route-support.ts","utf8");
  assert.match(support,/idempotency-key/);
  assert.match(support,/keys\.length !== expected\.length/);
});

test("repository stores immutable Audit receipt as idempotency result reference", async () => {
  const source = await readFile(
    "modules/cases/infrastructure/postgresql-candidate-list-repository.ts","utf8");
  assert.match(source,/resultReference: input\.effects\.audit\.id/);
  assert.match(source,/audit\.metadata->>'record_version'/);
  assert.doesNotMatch(source,/resultReference: command\.resultReference/);
});

test("routes expose only list creation, Founder review and recorded Guardian decision", async () => {
  const source = (await Promise.all(routes.map((path) => readFile(path,"utf8")))).join("\n");
  assert.match(source,/candidateListService\.createVersion/);
  assert.match(source,/candidateListService\.reviewVersion/);
  assert.match(source,/candidateListService\.recordGuardianDecision/);
  assert.match(source,/candidateListService\.closeCase/);
  assert.doesNotMatch(source,/Task|Application|Interview|Document|Portal|Email/);
});
