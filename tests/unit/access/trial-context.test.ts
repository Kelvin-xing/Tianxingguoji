import assert from "node:assert/strict";
import test from "node:test";
import { buildAccessContext, hasRequestCapability, compatibilityRoleForRepository } from "../../../modules/access/domain/authorization.ts";
import type { AccessResolutionFacts } from "../../../modules/access/domain/authorization.ts";
const facts: AccessResolutionFacts = {
  userId: "employee", organizationId: "tianxingjiaoyu", membershipId: "member",
  roles: ["l1"], membershipRecordVersion: 1, roleBindingRecordVersions: [1],
  trialPrincipal: { userId: "employee", organizationId: "tianxingjiaoyu", active: true, level: "l1", categories: [], recordVersion: 1 },
};
test("L1 receives business capabilities with its actual role, never personnel/system authority", () => {
  const context = buildAccessContext(facts);
  assert.equal(hasRequestCapability(context, "cases.assessments.manage"), true);
  assert.equal(hasRequestCapability(context, "students.deletion.review"), true);
  assert.equal(hasRequestCapability(context, "access.manage"), false);
  assert.equal(hasRequestCapability(context, "email.settings.manage"), false);
  assert.equal(compatibilityRoleForRepository(context, "cases.read"), "l1");
});
test("inconsistent, orphan or disabled new levels cannot fall back to old role capabilities", () => {
  for (const candidate of [
    { ...facts, roles: ["admin"] as const },
    { ...facts, roles: ["founder", "l1"] as const },
    { ...facts, trialPrincipal: undefined },
    { ...facts, trialPrincipal: { ...facts.trialPrincipal!, active: false } },
    { ...facts, trialPrincipal: { ...facts.trialPrincipal!, userId: "other" } },
  ]) {
    const context = buildAccessContext(candidate);
    assert.deepEqual(context.roles, []);
    assert.deepEqual(context.workspaceCapabilities, []);
    assert.equal(hasRequestCapability(context, "access.manage"), false);
    assert.equal(compatibilityRoleForRepository(context, "cases.read"), null);
  }
});
test("trial Founder has full business and security rights; legacy Founder is not silently upgraded", () => {
  const trial = buildAccessContext({ ...facts, roles: ["founder"], trialPrincipal: { ...facts.trialPrincipal!, level: "founder" } });
  assert.equal(hasRequestCapability(trial, "cases.assessments.manage"), true);
  assert.equal(hasRequestCapability(trial, "email.settings.manage"), true);
  const legacy = buildAccessContext({ ...facts, roles: ["founder"], trialPrincipal: undefined });
  assert.equal(hasRequestCapability(legacy, "cases.assessments.manage"), false);
});
