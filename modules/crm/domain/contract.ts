export const CRM_FORBIDDEN_LEGAL_ID_FIELDS = Object.freeze([
  "hkid",
  "mainland_identity_card_number",
  "passport_number",
  "legal_id_image",
  "government_id",
] as const);

export const PRIMARY_GUARDIAN_RELATIONSHIP_TYPES = Object.freeze([
  "father",
  "mother",
  "other_guardian",
] as const);

export type PrimaryGuardianRelationshipType =
  (typeof PRIMARY_GUARDIAN_RELATIONSHIP_TYPES)[number];

export function isPrimaryGuardianRelationshipType(
  value: unknown,
): value is PrimaryGuardianRelationshipType {
  return typeof value === "string" &&
    (PRIMARY_GUARDIAN_RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

export type CrmLifecycleStatus = "active" | "pending_delete" | "purged";
export type GuardianStatus = CrmLifecycleStatus;
export type CrmActorRole = "founder" | "admin" | "advisor" | "data_reviewer";

export type PrimaryContactDenialCode =
  | "PRIMARY_CONTACT_MISSING"
  | "MULTIPLE_PRIMARY_CONTACTS"
  | "PRIMARY_GUARDIAN_INACTIVE";

export type PrimaryContactDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: PrimaryContactDenialCode };

export interface PrimaryContactRelationship {
  readonly isPrimaryContact: boolean;
  readonly startsAtMs: number;
  readonly endsAtMs: number | null;
  readonly guardianStatus: GuardianStatus;
}

export interface PrimaryContactEvaluationInput {
  readonly nowMs: number;
  readonly relationships: readonly PrimaryContactRelationship[];
}

export interface PotentialDuplicateSignals {
  readonly displayNameMatch: boolean;
  readonly dateOfBirthMatch: boolean;
  readonly emailMatch: boolean;
  readonly phoneMatch: boolean;
}

export type PotentialDuplicateClassification = Readonly<{
  classification: "distinct" | "review_required";
  automaticMerge: false;
}>;

export type CrmDeletionDenialCode =
  | "INVALID_LIFECYCLE_TRANSITION"
  | "DELETION_REASON_REQUIRED"
  | "FOUNDER_APPROVAL_REQUIRED"
  | "RETENTION_NOT_CLEARED"
  | "LEGAL_HOLD_ACTIVE"
  | "REFERENCES_REMAIN";

export type CrmDeletionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: CrmDeletionDenialCode };

export interface CrmDeletionTransitionInput {
  readonly currentStatus: CrmLifecycleStatus;
  readonly targetStatus: CrmLifecycleStatus;
  readonly reason: string;
  readonly actorRole: CrmActorRole;
  readonly founderApproved: boolean;
  readonly retentionCleared: boolean;
  readonly legalHoldActive: boolean;
  readonly referencesCleared: boolean;
}

export function classifyPotentialDuplicate(
  signals: PotentialDuplicateSignals,
): PotentialDuplicateClassification {
  const hasPotentialMatch = Object.values(signals).some(Boolean);

  return {
    classification: hasPotentialMatch ? "review_required" : "distinct",
    automaticMerge: false,
  };
}

export function evaluatePrimaryContacts(
  input: PrimaryContactEvaluationInput,
): PrimaryContactDecision {
  const currentPrimaryContacts = input.relationships.filter(
    ({ isPrimaryContact, startsAtMs, endsAtMs }) =>
      isPrimaryContact &&
      startsAtMs <= input.nowMs &&
      (endsAtMs === null || input.nowMs < endsAtMs),
  );

  if (currentPrimaryContacts.length === 0) {
    return { allowed: false, code: "PRIMARY_CONTACT_MISSING" };
  }
  if (currentPrimaryContacts.length > 1) {
    return { allowed: false, code: "MULTIPLE_PRIMARY_CONTACTS" };
  }
  if (!["active", "pending_delete"].includes(currentPrimaryContacts[0]?.guardianStatus ?? "purged")) {
    return { allowed: false, code: "PRIMARY_GUARDIAN_INACTIVE" };
  }

  return { allowed: true };
}

export function evaluateCrmDeletionTransition(
  input: CrmDeletionTransitionInput,
): CrmDeletionDecision {
  if (input.currentStatus === "active" && input.targetStatus === "pending_delete") {
    if (input.reason.trim().length === 0) {
      return { allowed: false, code: "DELETION_REASON_REQUIRED" };
    }
    return { allowed: true };
  }

  if (input.currentStatus === "pending_delete" && input.targetStatus === "purged") {
    if (input.actorRole !== "founder" || !input.founderApproved) {
      return { allowed: false, code: "FOUNDER_APPROVAL_REQUIRED" };
    }
    if (!input.retentionCleared) {
      return { allowed: false, code: "RETENTION_NOT_CLEARED" };
    }
    if (input.legalHoldActive) {
      return { allowed: false, code: "LEGAL_HOLD_ACTIVE" };
    }
    if (!input.referencesCleared) {
      return { allowed: false, code: "REFERENCES_REMAIN" };
    }
    return { allowed: true };
  }

  return { allowed: false, code: "INVALID_LIFECYCLE_TRANSITION" };
}
