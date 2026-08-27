import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROUTES = Object.freeze([
  "app/api/v1/students/route.ts",
  "app/api/v1/students/[studentId]/route.ts",
  "app/api/v1/students/[studentId]/guardians/route.ts",
  "app/api/v1/students/[studentId]/guardians/search/route.ts",
  "app/api/v1/students/[studentId]/guardians/primary-handoffs/route.ts",
  "app/api/v1/students/[studentId]/deletion-requests/route.ts",
  "app/api/v1/guardians/[guardianId]/route.ts",
  "app/api/v1/guardians/[guardianId]/deletion-requests/route.ts",
  "app/api/v1/referral-sources/route.ts",
  "app/api/v1/referral-sources/[sourceId]/route.ts",
  "app/api/v1/crm/deletion-requests/route.ts",
  "app/api/v1/cases/route.ts",
  "app/api/v1/cases/options/route.ts",
  "app/api/v1/cases/[caseId]/route.ts",
  "app/api/v1/cases/[caseId]/assessment/route.ts",
  "app/api/v1/cases/[caseId]/assessment/background-completion/route.ts",
  "app/api/v1/cases/[caseId]/referral-source-assignments/route.ts",
] as const);

const SERVICES = Object.freeze([
  "modules/crm/application/student-create-service.ts",
  "modules/crm/application/read-service.ts",
  "modules/crm/application/guardian-relationship-service.ts",
  "modules/crm/application/profile-maintenance-service.ts",
  "modules/crm/application/referral-source-service.ts",
  "modules/crm/application/deletion-review-service.ts",
  "modules/cases/application/workspace-service.ts",
  "modules/cases/application/assessment-service.ts",
  "modules/cases/application/referral-source-assignment-service.ts",
  "app/api/v1/profile-maintenance-handler.ts",
] as const);

test("P2-BE-03 routes all resolve the current request-time Access context", async () => {
  for (const path of ROUTES) {
    const source = await readFile(path, "utf8");
    assert.match(source, /requireApiRequestAccessContext/, path);
    assert.doesNotMatch(source, /requireIdentityActor|requireSession\(|actor\.role/, path);
    assert.doesNotMatch(source, /evaluateBootstrapAuthorization/, path);
  }
});

test("the shared API Access boundary maps unauthenticated, forbidden, and unavailable", async () => {
  const source = await readFile("app/api/v1/request-access.ts", "utf8");
  assert.match(source, /resolveCurrentRequestAccessContext/);
  assert.match(source, /REQUEST_ACCESS_UNAUTHENTICATED[\s\S]*createApiError\("UNAUTHENTICATED"\)/);
  assert.match(source, /REQUEST_ACCESS_FORBIDDEN[\s\S]*createApiError\("FORBIDDEN"\)/);
  assert.match(source, /createApiError\("SERVICE_UNAVAILABLE"\)/);
  assert.doesNotMatch(source, /workspaceCapabilitiesForRole|actor\.role/);
});

test("P2-BE-03 services authorize from RequestAccessActor capability union", async () => {
  for (const path of SERVICES) {
    const source = await readFile(path, "utf8");
    assert.match(source, /RequestAccessActor/, path);
    assert.doesNotMatch(source, /IdentitySessionActor|actor\.role/, path);
    assert.doesNotMatch(source, /evaluateBootstrapAuthorization/, path);
  }
  const cases = await readFile("modules/cases/application/workspace-service.ts", "utf8");
  assert.match(cases, /compatibilityRoleForRepository\(actor, capability\)/);
  assert.doesNotMatch(cases, /workspaceCapabilitiesForRole/);
});
