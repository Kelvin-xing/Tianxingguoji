export const CRM_GENDERS = Object.freeze([
  "male",
  "female",
  "other",
  "not_disclosed",
] as const);

export const STUDENT_GUARDIAN_RELATIONSHIP_TYPES = Object.freeze([
  "parent",
  "father",
  "mother",
  "step_parent",
  "stepfather",
  "stepmother",
  "adoptive_parent",
  "adoptive_father",
  "adoptive_mother",
  "foster_parent",
  "foster_father",
  "foster_mother",
  "grandparent",
  "paternal_grandfather",
  "paternal_grandmother",
  "maternal_grandfather",
  "maternal_grandmother",
  "adult_sibling",
  "adult_brother",
  "adult_sister",
  "uncle",
  "aunt",
  "court_appointed_guardian",
  "institutional_guardian",
  "other_relative",
  "non_relative_guardian",
  "other",
] as const);

export const APPROVED_REFERRAL_SOURCE_TYPES = Object.freeze([
  "customer_referral",
  "employee_referral",
  "school_referral",
  "partner_referral",
  "website",
  "social_media",
  "paid_advertising",
  "event",
  "walk_in",
  "other",
  "unknown",
] as const);

export type CrmGender = (typeof CRM_GENDERS)[number];
export type StudentGuardianRelationshipType =
  (typeof STUDENT_GUARDIAN_RELATIONSHIP_TYPES)[number];
export type ApprovedReferralSourceType =
  (typeof APPROVED_REFERRAL_SOURCE_TYPES)[number];
export type ApprovedCrmStatus = "active" | "pending_delete" | "deleted";

export interface DuplicateWarningCandidate {
  readonly id: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

export interface DuplicateWarningMatch {
  readonly id: string;
  readonly matchingFields: readonly ("display_name" | "email" | "phone")[];
}

/** Duplicate detection is advisory only. It never returns a canonical record or merge instruction. */
export function findDuplicateWarnings(
  input: Omit<DuplicateWarningCandidate, "id">,
  candidates: readonly DuplicateWarningCandidate[],
): readonly DuplicateWarningMatch[] {
  const displayName = normalizeDisplayName(input.displayName);
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);

  return Object.freeze(candidates.flatMap((candidate) => {
    const matchingFields: Array<"display_name" | "email" | "phone"> = [];
    if (displayName !== null && displayName === normalizeDisplayName(candidate.displayName)) {
      matchingFields.push("display_name");
    }
    if (email !== null && email === normalizeEmail(candidate.email)) matchingFields.push("email");
    if (phone !== null && phone === normalizePhone(candidate.phone)) matchingFields.push("phone");
    return matchingFields.length === 0
      ? []
      : [Object.freeze({ id: candidate.id, matchingFields: Object.freeze(matchingFields) })];
  }));
}

export function normalizeDisplayName(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized.length === 0 ? null : normalized;
}

export function normalizeEmail(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 ? null : normalized;
}

export function normalizePhone(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/[\s()\-]/gu, "");
  return normalized.length === 0 ? null : normalized;
}

export function validateRelationshipDescription(input: Readonly<{
  relationshipType: StudentGuardianRelationshipType;
  relationshipDescription: string | null;
}>): boolean {
  return input.relationshipType === "other"
    ? (input.relationshipDescription?.trim().length ?? 0) > 0
    : input.relationshipDescription === null;
}

export function validateReferralSourceDescription(input: Readonly<{
  sourceType: ApprovedReferralSourceType;
  description: string | null;
}>): boolean {
  return input.sourceType === "other"
    ? (input.description?.trim().length ?? 0) > 0
    : input.description === null;
}

export type SoftDeleteDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      code:
        | "SOFT_DELETE_ROLE_DENIED"
        | "SOFT_DELETE_REASON_REQUIRED"
        | "SOFT_DELETE_OPEN_CASE"
        | "SOFT_DELETE_CURRENT_RELATIONSHIP"
        | "SOFT_DELETE_TRANSITION_INVALID";
    }>;

export function evaluateSoftDelete(input: Readonly<{
  entityType: "student" | "guardian";
  currentStatus: ApprovedCrmStatus;
  targetStatus: ApprovedCrmStatus;
  actorRoles: readonly string[];
  reason: string | null;
  hasOpenCase: boolean;
  hasCurrentRelationship: boolean;
}>): SoftDeleteDecision {
  const founder = input.actorRoles.includes("founder");
  const advisor = input.actorRoles.includes("advisor");
  if (input.currentStatus === "active" && input.targetStatus === "pending_delete") {
    if (!founder && !advisor) return { allowed: false, code: "SOFT_DELETE_ROLE_DENIED" };
    if (!input.reason?.trim()) return { allowed: false, code: "SOFT_DELETE_REASON_REQUIRED" };
  } else if (input.currentStatus === "pending_delete" && input.targetStatus === "active") {
    if (!founder) return { allowed: false, code: "SOFT_DELETE_ROLE_DENIED" };
  } else if (input.currentStatus === "pending_delete" && input.targetStatus === "deleted") {
    if (!founder) return { allowed: false, code: "SOFT_DELETE_ROLE_DENIED" };
  } else {
    return { allowed: false, code: "SOFT_DELETE_TRANSITION_INVALID" };
  }
  if (input.entityType === "student" && input.hasOpenCase) {
    return { allowed: false, code: "SOFT_DELETE_OPEN_CASE" };
  }
  if (input.entityType === "guardian" && input.hasCurrentRelationship) {
    return { allowed: false, code: "SOFT_DELETE_CURRENT_RELATIONSHIP" };
  }
  return { allowed: true };
}

export function canManageReferralSources(actorRoles: readonly string[]): boolean {
  return actorRoles.includes("founder");
}

export function canSelectReferralSource(input: Readonly<{
  actorRoles: readonly string[];
  isCurrentPrimaryAdvisor: boolean;
  sourceStatus: "active" | "inactive";
}>): boolean {
  return input.actorRoles.includes("advisor") &&
    input.isCurrentPrimaryAdvisor &&
    input.sourceStatus === "active";
}
