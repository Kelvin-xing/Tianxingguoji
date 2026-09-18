import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTrialAccess, evaluateTrialTaskAssignment,
  type TrialAction, type TrialLevel, type TrialPrincipal, type TrialResource,
} from "../../../modules/access/domain/trial-policy.ts";

const principal = (level: TrialLevel): TrialPrincipal => ({
  userId: "employee", organizationId: "tianxingjiaoyu", active: true,
  level, categories: level === "l2" ? ["international_school"] : [], recordVersion: 1,
});
const resource: TrialResource = {
  organizationId: "tianxingjiaoyu", category: "international_school", caseId: "case",
  task: { assigneeUserId: "employee", assignmentStatus: "active", status: "accepted" },
  projection: "task_only", profileUserId: "employee", auditActorUserId: "employee",
  document: { linkedToTask: true, allowedTaskActions: ["document.read", "document.upload", "document.download"], availableVersion: true },
};

// Independent business expectations; do not derive these from the implementation's role map.
const expectations: readonly [TrialAction, readonly TrialLevel[]][] = [
  ["case.read", ["founder", "l1", "l2"]],
  ["case.create", ["founder", "l1", "l2"]],
  ["case.manage", ["founder", "l1", "l2"]],
  ["assessment.manage", ["founder", "l1", "l2"]],
  ["case.approve", ["founder", "l1"]],
  ["case.close", ["founder", "l1"]],
  ["task.assign", ["founder", "l1", "l2"]],
  ["task.execute", ["founder", "l1", "l2", "l3"]],
  ["document.download", ["founder", "l1", "l2", "l3"]],
  ["member.manage", ["founder"]],
  ["member.invite", ["founder"]],
  ["member.disable", ["founder"]],
  ["settings.manage", ["founder"]],
  ["audit.security.read", ["founder"]],
  ["export", []],
];
for (const [action, allowed] of expectations) {
  test(`BR-015 ${action}: four-level matrix`, () => {
    for (const level of ["founder", "l1", "l2", "l3"] as const) {
      assert.equal(evaluateTrialAccess(principal(level), action, resource).allowed, allowed.includes(level), level);
    }
  });
}

test("L2 category grant required for reads and writes; multiple explicit grants supported", () => {
  const actor = principal("l2");
  const local = { ...resource, category: "local_school" as const };
  for (const action of ["case.read", "assessment.manage", "task.assign", "document.read"] as const) {
    assert.equal(evaluateTrialAccess(actor, action, local).allowed, false);
    assert.equal(evaluateTrialAccess({ ...actor, categories: ["local_school", "international_school"] }, action, local).allowed, true);
    assert.equal(evaluateTrialAccess({ ...actor, categories: [] }, action, resource).allowed, false);
  }
});

test("L3 can have assignments in both categories, without acquiring full-case context", () => {
  for (const category of ["local_school", "international_school"] as const) {
    const target = { ...resource, category };
    assert.equal(evaluateTrialAccess(principal("l3"), "task.read", target).allowed, true);
    for (const action of ["case.read", "assessment.read", "student.read", "task.assign"] as const) {
      assert.equal(evaluateTrialAccess(principal("l3"), action, target).allowed, false);
    }
    assert.equal(evaluateTrialAccess(principal("l3"), "task.read", { ...target, projection: "full" }).allowed, false);
  }
});

test("revocation, reassignment and cancellation remove L3 access; completion retains read only", () => {
  for (const task of [
    { ...resource.task!, assignmentStatus: "revoked" as const },
    { ...resource.task!, assignmentStatus: "reassigned" as const },
    { ...resource.task!, assigneeUserId: "someone-else" },
    { ...resource.task!, status: "cancelled" as const },
    { ...resource.task!, status: "awaiting_reassignment" as const },
  ]) {
    for (const action of ["task.read", "task.execute", "document.download"] as const) {
      assert.equal(evaluateTrialAccess(principal("l3"), action, { ...resource, task }).allowed, false);
    }
  }
  const completed = { ...resource, task: { ...resource.task!, status: "completed" as const } };
  assert.equal(evaluateTrialAccess(principal("l3"), "task.read", completed).allowed, true);
  assert.equal(evaluateTrialAccess(principal("l3"), "task.execute", completed).allowed, false);
  assert.equal(evaluateTrialAccess(principal("l3"), "document.upload", completed).allowed, false);
});

test("document scan restriction applies even to Founder and L1; L3 needs explicit action/link", () => {
  for (const level of ["founder", "l1", "l2", "l3"] as const) {
    assert.equal(evaluateTrialAccess(principal(level), "document.download", {
      ...resource, document: { ...resource.document!, availableVersion: false },
    }).allowed, false);
  }
  for (const document of [
    { ...resource.document!, linkedToTask: false },
    { ...resource.document!, allowedTaskActions: [] },
  ]) assert.equal(evaluateTrialAccess(principal("l3"), "document.download", { ...resource, document }).allowed, false);
});

test("L3 audit only exposes their own current task operations; self-profile does not edit another member", () => {
  assert.equal(evaluateTrialAccess(principal("l3"), "audit.business.read", { ...resource, auditActorUserId: "other" }).allowed, false);
  for (const level of ["founder", "l1", "l2", "l3"] as const) {
    assert.equal(evaluateTrialAccess(principal(level), "profile.self.edit", resource).allowed, true);
    assert.equal(evaluateTrialAccess(principal(level), "profile.self.edit", { ...resource, profileUserId: "other" }).allowed, false);
  }
});

test("unknown category, inactive account and invalid levels never inherit historical permissions", () => {
  for (const level of ["founder", "l1", "l2", "l3"] as const) {
    assert.equal(evaluateTrialAccess(principal(level), "case.read", { ...resource, category: null }).allowed, false);
    assert.equal(evaluateTrialAccess({ ...principal(level), active: false }, "task.read", resource).allowed, false);
  }
  assert.equal(evaluateTrialAccess({ ...principal("l1"), level: "admin" as TrialLevel }, "member.manage", resource).allowed, false);
  assert.equal(evaluateTrialAccess({ ...principal("l1"), recordVersion: 0 }, "case.read", resource).allowed, false);
  assert.equal(evaluateTrialAccess(principal("founder"), "arbitrary" as TrialAction, resource).allowed, false);
});

test("invalid organization context is rejected without introducing a second organization fixture", () => {
  assert.equal(evaluateTrialAccess(principal("founder"), "case.read", { ...resource, organizationId: "" }).allowed, false);
});

test("assignment is scoped by the manager and requires an active L3 recipient", () => {
  const actor = principal("l2");
  const recipient = principal("l3");
  assert.equal(evaluateTrialTaskAssignment({ actor, recipient, resource }).allowed, true);
  assert.equal(evaluateTrialTaskAssignment({ actor, recipient, resource: { ...resource, category: "local_school" } }).allowed, false);
  assert.equal(evaluateTrialTaskAssignment({ actor: recipient, recipient, resource }).allowed, false);
  assert.equal(evaluateTrialTaskAssignment({ actor, recipient: { ...recipient, active: false }, resource }).allowed, false);
  assert.equal(evaluateTrialTaskAssignment({ actor, recipient: principal("l1"), resource }).allowed, false);
});
