import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("auth/me uses the reusable request-time Access helper instead of actor.role", async () => {
  const [source, helper] = await Promise.all([
    readFile("app/api/v1/auth/me/route.ts", "utf8"),
    readFile("modules/access/infrastructure/request-access-context.ts", "utf8"),
  ]);

  assert.match(source, /resolveRequestAccessContext/);
  assert.match(source, /capabilities: accessContext\.workspaceCapabilities/);
  assert.match(source, /role: compatibilityRole/);
  assert.doesNotMatch(source, /actor\.role/);
  assert.doesNotMatch(source, /workspaceCapabilitiesForRole\(actor\.role\)/);
  assert.doesNotMatch(source, /capabilities: workspaceCapabilitiesForRole/);
  assert.match(helper, /AccessAuthorizationService/);
  assert.match(helper, /PostgresqlAccessAuthorizationRepository/);
  assert.match(helper, /resolveWorkspaceContext\(principal\)/);
  assert.match(helper, /capturedSessionVersion: actor\.capturedSessionVersion/);
});

test("auth/me treats the compatibility role as non-authoritative and denies missing Access bindings", async () => {
  const source = await readFile("app/api/v1/auth/me/route.ts", "utf8");

  assert.match(source, /REQUEST_ACCESS_FORBIDDEN/);
  assert.match(source, /organization_id: accessContext\.organizationId/);
});

test("root server page selects its default route from the current capability union", async () => {
  const source = await readFile("app/page.tsx", "utf8");

  assert.match(source, /resolveRequestAccessContext/);
  assert.match(source, /workspaceCapabilities\.includes\("today\.read"\)/);
  assert.match(source, /\? "\/today" : "\/tasks"/);
  assert.doesNotMatch(source, /workspaceCapabilitiesForRole|actor\.role|access\.roles/);
});
