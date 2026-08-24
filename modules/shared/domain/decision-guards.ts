export type DecisionStatus =
  | "accepted"
  | "accepted_with_constraint"
  | "amended"
  | "open";

export const DECISION_STATUSES = Object.freeze({
  "DEC-001": "accepted",
  "DEC-002": "accepted",
  "DEC-003": "accepted",
  "DEC-004": "accepted",
  "DEC-005": "accepted",
  "DEC-006": "accepted",
  "DEC-007": "accepted_with_constraint",
  "DEC-008": "accepted",
  "DEC-009": "accepted",
  "DEC-010": "accepted",
  "DEC-011": "amended",
  "DEC-012": "accepted",
  "DEC-013": "accepted",
  "DEC-014": "accepted",
  "DEC-015": "accepted",
  "DEC-016": "amended",
  "DEC-017": "accepted",
  "DEC-018": "accepted",
  "DEC-019": "accepted",
  "DEC-020": "accepted",
  "DEC-021": "accepted",
  "DEC-022": "accepted",
  "DEC-023": "accepted",
  "DEC-024": "accepted",
  "DEC-025": "accepted",
  "DEC-026": "accepted",
  "DEC-027": "accepted",
  "DEC-028": "accepted",
  "DEC-029": "accepted",
  "DEC-030": "accepted",
  "DEC-031": "accepted",
  "DEC-032": "accepted",
  "DEC-033": "accepted",
  "DEC-034": "accepted",
  "DEC-035": "accepted",
  "DEC-036": "accepted",
  "DEC-037": "accepted",
  "DEC-038": "accepted",
  "DEC-039": "accepted",
  "DEC-040": "accepted",
  "DEC-041": "accepted",
  "DEC-042": "accepted",
  "DEC-043": "accepted",
  "DEC-044": "accepted",
  "DEC-045": "accepted",
  "DEC-046": "accepted",
  "DEC-047": "accepted",
  "DEC-048": "accepted",
  "DEC-049": "accepted",
  "DEC-050": "accepted",
  "DEC-051": "accepted",
  "DEC-052": "accepted",
  "DEC-053": "accepted",
  "DEC-054": "accepted",
  "DEC-055": "accepted",
  "DEC-056": "accepted",
  "DEC-057": "accepted",
  "DEC-058": "accepted",
  "DEC-059": "accepted",
  "DEC-060": "open",
} as const satisfies Readonly<Record<string, DecisionStatus>>);

export type DecisionGuardErrorCode =
  | "UNKNOWN_DECISION"
  | "OPEN_DECISION"
  | "OUT_OF_SCOPE_FEATURE"
  | "UNKNOWN_FEATURE_SUBJECT"
  | "UNKNOWN_TRANSITION_SUBJECT"
  | "UNAPPROVED_TRANSITION";

export class DecisionGuardError extends Error {
  readonly code: DecisionGuardErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: DecisionGuardErrorCode, details: Record<string, string>) {
    super(`Decision guard rejected ${code}`);
    this.name = "DecisionGuardError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

const OUT_OF_SCOPE_FEATURE_SUBJECTS = new Set([
  "ai_reports",
  "csv_import",
  "excel_import",
  "multi_tenant",
  "second_organization",
]);

const RELEASE_ONE_TRANSITION_SUBJECTS = new Set([
  "ServiceCase",
  "SchoolTarget",
  "Task",
  "ScopeGrant",
  "DocumentVersion",
  "School",
  "SchoolChangeRequest",
  "Invite",
  "Session",
  "User",
  "PublishedSnapshot",
]);

const RELEASE_ONE_TRANSITIONS = new Set([
  "ServiceCase:signed:background_collection",
  "SchoolTarget:candidate:preparing",
  "SchoolTarget:preparing:submitted",
  "SchoolTarget:submitted:interview",
  "SchoolTarget:interview:waitlisted",
  "SchoolTarget:interview:accepted",
  "SchoolTarget:interview:rejected",
  "SchoolTarget:interview:withdrawn",
  "ScopeGrant:pending_approval:active",
  "ScopeGrant:active:revoked",
  "ScopeGrant:active:expired",
  "DocumentVersion:pending_upload:quarantined",
  "DocumentVersion:pending_upload:rejected",
  "DocumentVersion:pending_upload:abandoned",
  "DocumentVersion:quarantined:scanning",
  "DocumentVersion:scanning:available",
  "DocumentVersion:scanning:rejected",
  "DocumentVersion:scanning:scan_failed",
  "DocumentVersion:scan_failed:scanning",
  "DocumentVersion:available:superseded",
  "DocumentVersion:available:pending_delete",
  "DocumentVersion:available:deleted",
  "School:provisional:under_review",
  "School:under_review:verified",
  "School:verified:retired",
  "SchoolChangeRequest:submitted:approved",
  "SchoolChangeRequest:submitted:rejected",
  "SchoolChangeRequest:submitted:withdrawn",
  "Invite:created:redeemed",
  "Invite:created:expired",
  "Invite:created:revoked",
  "Session:active:revoked",
  "Session:active:expired",
  "User:invited:active",
  "User:active:disabled",
  "PublishedSnapshot:candidate:validated",
  "PublishedSnapshot:validated:active",
  "PublishedSnapshot:validated:rejected",
  "PublishedSnapshot:active:superseded",
]);

export function assertDecisionPremise(decisionId: string): Exclude<DecisionStatus, "open"> {
  if (!Object.hasOwn(DECISION_STATUSES, decisionId)) {
    throw new DecisionGuardError("UNKNOWN_DECISION", { decisionId });
  }

  const status = DECISION_STATUSES[decisionId as keyof typeof DECISION_STATUSES];
  if (status === "open") {
    throw new DecisionGuardError("OPEN_DECISION", { decisionId, status });
  }

  return status;
}

export function assertReleaseOneFeatureAllowed(subject: string): never {
  if (OUT_OF_SCOPE_FEATURE_SUBJECTS.has(subject)) {
    throw new DecisionGuardError("OUT_OF_SCOPE_FEATURE", { subject });
  }

  throw new DecisionGuardError("UNKNOWN_FEATURE_SUBJECT", { subject });
}

export function assertReleaseOneTransitionAllowed(subject: string, from: string, to: string): void {
  if (!RELEASE_ONE_TRANSITION_SUBJECTS.has(subject)) {
    throw new DecisionGuardError("UNKNOWN_TRANSITION_SUBJECT", { subject, from, to });
  }

  if (!RELEASE_ONE_TRANSITIONS.has(`${subject}:${from}:${to}`)) {
    throw new DecisionGuardError("UNAPPROVED_TRANSITION", { subject, from, to });
  }
}
