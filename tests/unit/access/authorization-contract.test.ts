import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_POLICY_MANIFEST_VERSION,
  AUTHORIZATION_DENIAL_CODES,
  BOOTSTRAP_ACCESS_POLICY_MANIFEST,
  BOOTSTRAP_ACCESS_POLICY_MANIFEST_JSON,
  BOOTSTRAP_ACCESS_POLICY_VERSION,
  BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE,
  ORGANIZATION_ROLES,
  WORKSPACE_CAPABILITIES,
  evaluateBootstrapAuthorization,
  isOrganizationRole,
  isWorkspaceCapability,
  workspaceCapabilitiesForRole,
  type OrganizationRole,
  type WorkspaceCapability,
} from "../../../modules/access/public.ts";

const EXPECTED_MATRIX = Object.freeze({
  founder: Object.freeze([
    "today.read",
    "cases.read",
    "cases.create",
    "cases.workflow.manage",
    "cases.assessments.read",
    "cases.referral_sources.assign",
    "students.read",
    "students.create",
    "students.profiles.manage",
    "students.duplicates.review",
    "students.duplicates.merge",
    "students.deletion.request",
    "students.deletion.review",
    "referral_sources.read",
    "referral_sources.manage",
    "schools.read",
    "tasks.read",
    "tasks.create",
    "tasks.transition",
    "documents.read",
    "documents.create",
    "documents.upload",
    "documents.download",
    "access.manage",
    "schools.manage",
    "crawler.manage",
  ]),
  admin: Object.freeze([
    "today.read",
    "cases.assessments.read",
    "students.read",
    "referral_sources.read",
    "referral_sources.manage",
    "schools.read",
    "access.manage",
    "schools.manage",
    "crawler.manage",
  ]),
  advisor: Object.freeze([
    "today.read",
    "cases.read",
    "cases.create",
    "cases.workflow.manage",
    "cases.assessments.read",
    "cases.assessments.manage",
    "cases.referral_sources.assign",
    "students.read",
    "students.create",
    "students.guardians.manage",
    "students.profiles.manage",
    "students.duplicates.review",
    "students.deletion.request",
    "referral_sources.read",
    "schools.read",
    "tasks.read",
    "tasks.create",
    "tasks.transition",
    "documents.read",
    "documents.create",
    "documents.upload",
    "documents.download",
  ]),
  data_reviewer: Object.freeze([
    "today.read",
    "students.duplicates.review",
    "schools.read",
    "schools.manage",
    "crawler.manage",
  ]),
  contractor: Object.freeze(["tasks.read", "tasks.transition"]),
} as const satisfies Readonly<Record<OrganizationRole, readonly WorkspaceCapability[]>>);

test("freezes the DOC-02 five-role workspace capability matrix", () => {
  assert.deepEqual(ORGANIZATION_ROLES, [
    "founder",
    "admin",
    "advisor",
    "data_reviewer",
    "contractor",
  ]);
  assert.deepEqual(BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE, EXPECTED_MATRIX);
  for (const role of ORGANIZATION_ROLES) {
    assert.deepEqual(workspaceCapabilitiesForRole(role), EXPECTED_MATRIX[role]);
    assert.equal(Object.isFrozen(workspaceCapabilitiesForRole(role)), true);
  }
});

test("allows only explicit bootstrap role-capability rules and denies every missing rule", () => {
  for (const role of ORGANIZATION_ROLES) {
    for (const capability of WORKSPACE_CAPABILITIES) {
      const decision = evaluateBootstrapAuthorization(role, { capability });
      if (EXPECTED_MATRIX[role].includes(capability as never)) {
        assert.deepEqual(decision, {
          allowed: true,
          policyVersion: BOOTSTRAP_ACCESS_POLICY_VERSION,
        });
      } else {
        assert.deepEqual(decision, {
          allowed: false,
          code: "ACCESS_CAPABILITY_DENIED",
        });
      }
    }
  }
});

test("runtime validators and bootstrap evaluation fail closed for unknown vocabulary", () => {
  assert.deepEqual(AUTHORIZATION_DENIAL_CODES, [
    "ACCESS_ROLE_UNKNOWN",
    "ACCESS_CAPABILITY_UNKNOWN",
    "ACCESS_CAPABILITY_DENIED",
    "ACCESS_POLICY_UNAVAILABLE",
  ]);
  for (const role of ORGANIZATION_ROLES) assert.equal(isOrganizationRole(role), true);
  for (const capability of WORKSPACE_CAPABILITIES) {
    assert.equal(isWorkspaceCapability(capability), true);
  }
  for (const unknownRole of ["owner", "Founder", "", null, 7]) {
    assert.equal(isOrganizationRole(unknownRole), false);
    assert.deepEqual(evaluateBootstrapAuthorization(unknownRole, { capability: "today.read" }), {
      allowed: false,
      code: "ACCESS_ROLE_UNKNOWN",
    });
  }
  for (const unknownCapability of ["cases.write", "Cases.read", "", null, 7]) {
    assert.equal(isWorkspaceCapability(unknownCapability), false);
    assert.deepEqual(evaluateBootstrapAuthorization("founder", {
      capability: unknownCapability,
    }), {
      allowed: false,
      code: "ACCESS_CAPABILITY_UNKNOWN",
    });
  }
});

test("publishes one deterministic serializable bootstrap policy manifest", () => {
  assert.equal(ACCESS_POLICY_MANIFEST_VERSION, "access-policy-manifest/v1");
  assert.equal(BOOTSTRAP_ACCESS_POLICY_VERSION, "release1-bootstrap-v12");
  assert.equal(BOOTSTRAP_ACCESS_POLICY_MANIFEST.manifestVersion, ACCESS_POLICY_MANIFEST_VERSION);
  assert.equal(BOOTSTRAP_ACCESS_POLICY_MANIFEST.policyVersion, BOOTSTRAP_ACCESS_POLICY_VERSION);
  assert.equal(BOOTSTRAP_ACCESS_POLICY_MANIFEST.defaultDecision, "deny");
  assert.deepEqual(
    BOOTSTRAP_ACCESS_POLICY_MANIFEST.rules.map(({ role, allow }) => ({ role, allow })),
    ORGANIZATION_ROLES.map((role) => ({ role, allow: EXPECTED_MATRIX[role] })),
  );
  assert.equal(JSON.stringify(BOOTSTRAP_ACCESS_POLICY_MANIFEST), BOOTSTRAP_ACCESS_POLICY_MANIFEST_JSON);
  assert.deepEqual(JSON.parse(BOOTSTRAP_ACCESS_POLICY_MANIFEST_JSON), BOOTSTRAP_ACCESS_POLICY_MANIFEST);
  assert.equal(Object.isFrozen(BOOTSTRAP_ACCESS_POLICY_MANIFEST), true);
  assert.equal(Object.isFrozen(BOOTSTRAP_ACCESS_POLICY_MANIFEST.rules), true);
  assert.equal(BOOTSTRAP_ACCESS_POLICY_MANIFEST.rules.every(Object.isFrozen), true);
});
