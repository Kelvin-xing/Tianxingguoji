import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAccessContext,
  compatibilityRoleForRepository,
} from "../../modules/access/public.ts";
import {
  APPROVED_REFERRAL_SOURCE_TYPES,
  STUDENT_GUARDIAN_RELATIONSHIP_TYPES,
  canManageReferralSources,
  canSelectReferralSource,
  evaluateSoftDelete,
  findDuplicateWarnings,
  validateRelationshipDescription,
} from "../../modules/crm/public.ts";
import {
  APPROVED_ASSESSMENT_FIELD_IDS,
  BACKGROUND_COMPLETION_FIELD_IDS,
  SCHOOL_SELECTION_READINESS_FIELD_IDS,
  evaluateApprovedAssessmentReadiness,
  evaluateCaseAssessmentAccess,
} from "../../modules/cases/public.ts";

test("P2-BE-03 freezes CRM vocabulary and warning-only duplicate matching", () => {
  assert.equal(STUDENT_GUARDIAN_RELATIONSHIP_TYPES.length, 27);
  assert.equal(APPROVED_REFERRAL_SOURCE_TYPES.length, 11);
  assert.equal(validateRelationshipDescription({
    relationshipType: "other", relationshipDescription: "family delegate",
  }), true);
  assert.equal(validateRelationshipDescription({
    relationshipType: "other", relationshipDescription: null,
  }), false);

  const warnings = findDuplicateWarnings({
    displayName: "  Ａda  ", email: "ADA@EXAMPLE.INVALID ", phone: "+852 (1234)-5678",
  }, [{
    id: "candidate", displayName: "Ada", email: "ada@example.invalid", phone: "+85212345678",
  }]);
  assert.deepEqual(warnings, [{
    id: "candidate", matchingFields: ["display_name", "email", "phone"],
  }]);
  assert.equal("automaticMerge" in warnings[0]!, false);
  assert.deepEqual(findDuplicateWarnings({ displayName: "", email: " ", phone: "(-)" }, [{
    id: "empty", displayName: "", email: "", phone: "",
  }]), []);
});

test("P2-BE-03 enforces Founder/Advisor referral and soft-delete boundaries", () => {
  assert.equal(canManageReferralSources(["founder", "admin"]), true);
  assert.equal(canManageReferralSources(["admin"]), false);
  assert.equal(canSelectReferralSource({
    actorRoles: ["advisor"], isCurrentPrimaryAdvisor: true, sourceStatus: "active",
  }), true);
  assert.equal(canSelectReferralSource({
    actorRoles: ["advisor"], isCurrentPrimaryAdvisor: false, sourceStatus: "active",
  }), false);
  assert.deepEqual(evaluateSoftDelete({
    entityType: "student", currentStatus: "active", targetStatus: "pending_delete",
    actorRoles: ["advisor"], reason: "duplicate profile", hasOpenCase: true,
    hasCurrentRelationship: false,
  }), { allowed: false, code: "SOFT_DELETE_OPEN_CASE" });
  assert.deepEqual(evaluateSoftDelete({
    entityType: "guardian", currentStatus: "pending_delete", targetStatus: "deleted",
    actorRoles: ["founder"], reason: "approved", hasOpenCase: false,
    hasCurrentRelationship: true,
  }), { allowed: false, code: "SOFT_DELETE_CURRENT_RELATIONSHIP" });
});

test("P2-BE-03 freezes 15 Assessment fields and calculates both blocker sets", () => {
  assert.equal(APPROVED_ASSESSMENT_FIELD_IDS.length, 15);
  assert.equal(BACKGROUND_COMPLETION_FIELD_IDS.length, 10);
  assert.equal(SCHOOL_SELECTION_READINESS_FIELD_IDS.length, 13);
  const answers = APPROVED_ASSESSMENT_FIELD_IDS.map((fieldId) => ({
    fieldId,
    semanticState: "provided" as const,
  }));
  assert.deepEqual(evaluateApprovedAssessmentReadiness(answers), {
    status: "background_complete",
    backgroundComplete: true,
    schoolSelectionReady: true,
    missingBackgroundFields: [],
    missingSchoolSelectionFields: [],
  });
  const incomplete = evaluateApprovedAssessmentReadiness([
    { fieldId: "student_profile.date_of_birth", semanticState: "unknown" },
  ]);
  assert.equal(incomplete.status, "draft");
  assert.equal(incomplete.missingBackgroundFields.includes("student_profile.date_of_birth"), true);
});

test("P2-BE-03 denies Admin-only customer data and bounds collaborator Assessment scope", () => {
  assert.deepEqual(evaluateCaseAssessmentAccess({
    actorRoles: ["admin"], requestedMode: "read", isCurrentPrimaryAdvisor: false,
    collaboratorScope: null,
  }), { allowed: false, code: "CASE_ASSESSMENT_ACCESS_DENIED" });
  assert.deepEqual(evaluateCaseAssessmentAccess({
    actorRoles: ["founder", "admin"], requestedMode: "read", isCurrentPrimaryAdvisor: false,
    collaboratorScope: null,
  }), { allowed: true, mode: "read", scope: "full" });
  assert.deepEqual(evaluateCaseAssessmentAccess({
    actorRoles: ["advisor"], requestedMode: "write", isCurrentPrimaryAdvisor: false,
    collaboratorScope: "education_profile",
  }), { allowed: true, mode: "write", scope: "education_profile" });
});

test("P2-BE-03 authorizes multi-role requests from the capability union", () => {
  const founderAdmin = buildAccessContext({
    userId: "10000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000002",
    membershipId: "10000000-0000-4000-8000-000000000003",
    roles: ["founder", "admin"],
    membershipRecordVersion: 2,
    roleBindingRecordVersions: [3, 4],
  });
  assert.equal(founderAdmin.workspaceCapabilities.includes("cases.create"), true);
  assert.equal(founderAdmin.workspaceCapabilities.includes("students.read"), true);
  assert.equal(compatibilityRoleForRepository(founderAdmin, "cases.create"), "founder");

  const founderAdvisor = buildAccessContext({
    userId: founderAdmin.userId,
    organizationId: founderAdmin.organizationId,
    membershipId: founderAdmin.membershipId,
    roles: ["founder", "advisor"],
    membershipRecordVersion: 2,
    roleBindingRecordVersions: [3, 5],
  });
  assert.equal(founderAdvisor.workspaceCapabilities.includes("cases.assessments.manage"), true);
  assert.equal(
    compatibilityRoleForRepository(founderAdvisor, "cases.assessments.manage"),
    "advisor",
  );

  const adminOnly = buildAccessContext({
    userId: founderAdmin.userId,
    organizationId: founderAdmin.organizationId,
    membershipId: founderAdmin.membershipId,
    roles: ["admin"],
    membershipRecordVersion: 2,
    roleBindingRecordVersions: [4],
  });
  assert.equal(adminOnly.workspaceCapabilities.includes("students.read"), false);
  assert.equal(compatibilityRoleForRepository(adminOnly, "cases.create"), null);
});
