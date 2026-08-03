import assert from "node:assert/strict";
import test from "node:test";

import {
  DECISION_STATUSES,
  DecisionGuardError,
  assertDecisionPremise,
  assertReleaseOneFeatureAllowed,
  assertReleaseOneTransitionAllowed,
} from "../../../modules/shared/decision-guards.ts";

test("publishes all decision statuses as an immutable 60-decision registry", () => {
  const decisionIds = Object.keys(DECISION_STATUSES).sort();
  const statusCounts = Object.values(DECISION_STATUSES).reduce(
    (counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }),
    {} as Record<string, number>,
  );

  assert.equal(decisionIds.length, 60);
  assert.deepEqual(
    decisionIds,
    Array.from({ length: 60 }, (_, index) => `DEC-${String(index + 1).padStart(3, "0")}`),
  );
  assert.deepEqual(statusCounts, {
    accepted: 56,
    accepted_with_constraint: 1,
    amended: 2,
    open: 1,
  });
  assert.equal(DECISION_STATUSES["DEC-007"], "accepted_with_constraint");
  assert.equal(DECISION_STATUSES["DEC-011"], "amended");
  assert.equal(DECISION_STATUSES["DEC-016"], "amended");
  assert.equal(DECISION_STATUSES["DEC-060"], "open");
  assert.equal(Object.isFrozen(DECISION_STATUSES), true);
  assert.throws(
    () => {
      (DECISION_STATUSES as Record<string, string>)["DEC-001"] = "open";
    },
    TypeError,
  );
});

test("allows only non-open decision premises", () => {
  assert.equal(assertDecisionPremise("DEC-001"), "accepted");
  assert.equal(assertDecisionPremise("DEC-007"), "accepted_with_constraint");
  assert.equal(assertDecisionPremise("DEC-011"), "amended");
});

test("rejects open and unknown decision premises with stable error data", () => {
  assertGuardError(
    () => assertDecisionPremise("DEC-060"),
    "OPEN_DECISION",
    { decisionId: "DEC-060", status: "open" },
  );
  assertGuardError(
    () => assertDecisionPremise("DEC-999"),
    "UNKNOWN_DECISION",
    { decisionId: "DEC-999" },
  );
});

test("rejects Release 1 out-of-scope and unknown feature subjects", () => {
  for (const subject of [
    "ai_reports",
    "csv_import",
    "excel_import",
    "multi_tenant",
    "second_organization",
  ]) {
    assertGuardError(
      () => assertReleaseOneFeatureAllowed(subject),
      "OUT_OF_SCOPE_FEATURE",
      { subject },
    );
  }

  assertGuardError(
    () => assertReleaseOneFeatureAllowed("future_feature"),
    "UNKNOWN_FEATURE_SUBJECT",
    { subject: "future_feature" },
  );
});

test("allows the approved Release 1 workflow transitions", () => {
  const allowedTransitions = [
    ["ServiceCase", "signed", "background_collection"],
    ["ServiceCase", "background_collection", "school_selection_confirmed"],
    ["ServiceCase", "school_selection_confirmed", "interview_preparation"],
    ["ServiceCase", "interview_preparation", "application_submitted"],
    ["ServiceCase", "application_submitted", "awaiting_result"],
    ["ServiceCase", "awaiting_result", "offer_confirmed"],
    ["ServiceCase", "offer_confirmed", "closed"],
    ["ServiceCase", "closed", "offer_confirmed"],
    ["ServiceCase", "offer_confirmed", "awaiting_result"],
    ["ServiceCase", "awaiting_result", "application_submitted"],
    ["ServiceCase", "application_submitted", "interview_preparation"],
    ["ServiceCase", "interview_preparation", "school_selection_confirmed"],
    ["ServiceCase", "school_selection_confirmed", "background_collection"],
    ["ServiceCase", "background_collection", "signed"],
    ["SchoolTarget", "candidate", "preparing"],
    ["SchoolTarget", "preparing", "submitted"],
    ["SchoolTarget", "submitted", "interview"],
    ["SchoolTarget", "interview", "waitlisted"],
    ["SchoolTarget", "interview", "accepted"],
    ["SchoolTarget", "interview", "rejected"],
    ["SchoolTarget", "interview", "withdrawn"],
    ["ScopeGrant", "pending_approval", "active"],
    ["ScopeGrant", "active", "revoked"],
    ["ScopeGrant", "active", "expired"],
    ["DocumentVersion", "pending_upload", "quarantined"],
    ["DocumentVersion", "quarantined", "scanning"],
    ["DocumentVersion", "scanning", "available"],
    ["DocumentVersion", "scanning", "rejected"],
    ["DocumentVersion", "scanning", "scan_failed"],
    ["DocumentVersion", "scan_failed", "scanning"],
    ["DocumentVersion", "available", "superseded"],
    ["DocumentVersion", "available", "pending_delete"],
    ["DocumentVersion", "available", "deleted"],
    ["School", "provisional", "under_review"],
    ["School", "under_review", "verified"],
    ["School", "verified", "retired"],
    ["SchoolChangeRequest", "submitted", "approved"],
    ["SchoolChangeRequest", "submitted", "rejected"],
    ["SchoolChangeRequest", "submitted", "withdrawn"],
    ["Invite", "created", "redeemed"],
    ["Invite", "created", "expired"],
    ["Invite", "created", "revoked"],
    ["Session", "active", "revoked"],
    ["Session", "active", "expired"],
    ["User", "invited", "active"],
    ["User", "active", "disabled"],
    ["PublishedSnapshot", "candidate", "validated"],
    ["PublishedSnapshot", "validated", "active"],
    ["PublishedSnapshot", "validated", "rejected"],
    ["PublishedSnapshot", "active", "superseded"],
  ] as const;

  for (const [subject, from, to] of allowedTransitions) {
    assert.doesNotThrow(() => assertReleaseOneTransitionAllowed(subject, from, to));
  }
});

test("rejects unresolved and unknown Release 1 workflow transitions", () => {
  assertGuardError(
    () => assertReleaseOneTransitionAllowed("ServiceCase", "signed", "cancelled"),
    "UNAPPROVED_TRANSITION",
    { subject: "ServiceCase", from: "signed", to: "cancelled" },
  );
  assertGuardError(
    () => assertReleaseOneTransitionAllowed("Task", "required", "completed"),
    "UNAPPROVED_TRANSITION",
    { subject: "Task", from: "required", to: "completed" },
  );
  assertGuardError(
    () => assertReleaseOneTransitionAllowed("UnknownEntity", "a", "b"),
    "UNKNOWN_TRANSITION_SUBJECT",
    { subject: "UnknownEntity", from: "a", to: "b" },
  );
});

function assertGuardError(
  action: () => void,
  code: DecisionGuardError["code"],
  details: Record<string, string>,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof DecisionGuardError);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, details);
    return true;
  });
}
