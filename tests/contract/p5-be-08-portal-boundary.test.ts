import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const policy = readFileSync("modules/external-portal/domain/policy.ts", "utf8");
const contract = readFileSync("modules/external-portal/domain/contract.ts", "utf8");
const repository = readFileSync("modules/external-portal/infrastructure/postgresql-repository.ts", "utf8");
const workspaceRoute = readFileSync("app/api/v1/portal/workspace/handler.ts", "utf8");

test("P5-BE-08 portal policy is request-time capability based and read-only", () => {
  assert.doesNotMatch(policy, /actor\.role/);
  assert.match(policy, /cases\.workflow\.manage/);
  assert.match(contract, /termination_pending/);
  assert.match(contract, /paused/);
  assert.match(policy, /customerVisible/);
});

test("P5-BE-08 keeps private read SQL behind public adapters and never returns a case number", () => {
  assert.match(repository, /from \"\.\.\/\.\.\/access\/server\.ts\"/);
  assert.doesNotMatch(repository, /from \"\.\.\/\.\.\/access\/infrastructure/);
  assert.doesNotMatch(repository, /cases_service_cases|cases_candidate_school_list|crm_student_guardian|schools_schools/);
  assert.doesNotMatch(workspaceRoute, /case_number|caseNumber/);
  assert.match(workspaceRoute, /Promise<PortalCaseReadV1>/);
});

test("P5-BE-08 keeps Portal access available while a Case is paused", () => {
  assert.match(repository, /function isPortalCaseAvailable/);
  assert.match(repository, /status === "active" \|\| status === "paused"/);
  assert.doesNotMatch(repository, /workflowStatus !== "active"/);
});
