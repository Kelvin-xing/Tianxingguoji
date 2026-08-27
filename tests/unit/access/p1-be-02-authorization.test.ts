import assert from "node:assert/strict";
import test from "node:test";

import {
  ORGANIZATION_ROLES,
  BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE,
  capabilityIncludes,
  evaluateRoleAssignment,
  evaluateScopeGrant,
} from "../../../modules/access/public.ts";
import { AccessAuthorizationService } from "../../../modules/access/server.ts";

const PRINCIPAL = Object.freeze({
  userId: "10000000-0000-4000-8000-000000000001",
  sessionId: "10000000-0000-4000-8000-000000000002",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: null,
  organizationId: "10000000-0000-4000-8000-000000000010",
  membershipId: "10000000-0000-4000-8000-000000000011",
});

test("P1-BE-02 freezes the four active roles and no Data Reviewer", () => {
  assert.deepEqual(ORGANIZATION_ROLES, ["founder", "admin", "advisor", "contractor"]);
  assert.deepEqual(BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE.contractor, ["tasks.read", "tasks.transition"]);
  for (const capability of ["tasks.create", "cases.read", "cases.assessments.read", "documents.read"] as const) {
    assert.equal(BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE.contractor.includes(capability as never), false);
  }
  assert.equal(BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE.admin.includes("students.read"), false);
  assert.equal(BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE.admin.includes("cases.assessments.read"), false);
});

test("P1-BE-02 accepts approved role combinations and denies Contractor conflicts", () => {
  for (const roles of [["founder", "admin"], ["founder", "advisor"], ["admin", "advisor"]] as const) {
    assert.deepEqual(evaluateRoleAssignment({
      existingRoles: roles.slice(0, 1),
      candidateRole: roles[1],
      employmentType: "FULL_TIME",
    }), { allowed: true });
  }
  assert.deepEqual(evaluateRoleAssignment({
    existingRoles: ["founder"],
    candidateRole: "contractor",
    employmentType: "FULL_TIME",
  }), { allowed: false, code: "ROLE_CONFLICT" });
  assert.deepEqual(evaluateRoleAssignment({
    existingRoles: ["admin"],
    candidateRole: "contractor",
    employmentType: "PART_TIME",
  }), { allowed: false, code: "ROLE_CONFLICT" });
  assert.deepEqual(evaluateRoleAssignment({
    existingRoles: [],
    candidateRole: "contractor",
    employmentType: "FULL_TIME",
  }), { allowed: false, code: "ROLE_NOT_COMPATIBLE_WITH_EMPLOYMENT_TYPE" });
  assert.deepEqual(evaluateRoleAssignment({
    existingRoles: ["founder"],
    candidateRole: "founder",
    removingRole: "founder",
    employmentType: "FULL_TIME",
  }), { allowed: false, code: "LAST_FOUNDER_REQUIRED" });
});

test("P1-BE-02 applies capability inclusion and request-time Access re-resolution", async () => {
  assert.equal(capabilityIncludes("edit", "view"), true);
  assert.equal(capabilityIncludes("edit", "comment"), true);
  assert.equal(capabilityIncludes("view", "comment"), false);
  const facts = {
    userId: PRINCIPAL.userId,
    organizationId: "10000000-0000-4000-8000-000000000010",
    membershipId: "10000000-0000-4000-8000-000000000011",
    roles: ["admin", "advisor"] as const,
    membershipRecordVersion: 2,
    roleBindingRecordVersions: [3, 4],
  };
  let calls = 0;
  const service = new AccessAuthorizationService({
    repository: {
      async resolveAccessFacts() {
        calls += 1;
        return calls === 1 ? facts : { ...facts, roles: ["admin"] as const };
      },
    },
  });
  assert.equal((await service.evaluateCapability(PRINCIPAL, { capability: "cases.read" })).allowed, true);
  assert.deepEqual(await service.evaluateCapability(PRINCIPAL, { capability: "cases.read" }), {
    allowed: false,
    code: "ACCESS_CAPABILITY_DENIED",
  });
  assert.equal(calls, 2);
});

test("P1-BE-02 keeps sensitive ScopeGrant approval and Contractor task denial fail closed", () => {
  const base = {
    nowMs: 10,
    organizationId: "org",
    caseId: "case",
    requestedScope: "case_summary" as const,
    requestedCapability: "view" as const,
    userStatus: "active" as const,
    organizationStatus: "active" as const,
    membershipStatus: "active" as const,
    advisorRoleBindingStatus: "active" as const,
    collaboratorStatus: "active" as const,
    grantStatus: "active" as const,
    grantOrganizationId: "org",
    grantCaseId: "case",
    grantScope: "case_summary" as const,
    grantCapability: "edit" as const,
    startsAtMs: 1,
    expiresAtMs: 20,
    requestedByUserId: "advisor",
    approvedByUserId: null,
    approverRole: null,
  };
  assert.deepEqual(evaluateScopeGrant(base), { allowed: true });
  assert.deepEqual(evaluateScopeGrant({ ...base, requestedCapability: "comment" }), { allowed: true });
  assert.deepEqual(evaluateScopeGrant({ ...base, requestedCapability: "export" }), {
    allowed: false,
    code: "COLLABORATOR_EXPORT_DENIED",
  });
});
