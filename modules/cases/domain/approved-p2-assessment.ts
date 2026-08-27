import type { AnswerSemanticState } from "./contract.ts";

export const APPROVED_ASSESSMENT_FIELD_IDS = Object.freeze([
  "student_profile.date_of_birth",
  "student_profile.residency_status",
  "student_profile.primary_languages",
  "education_profile.current_stage",
  "education_profile.current_year_level",
  "education_profile.current_curriculum",
  "school_preferences.target_stage",
  "school_preferences.preferred_systems",
  "school_preferences.preferred_districts",
  "school_preferences.preferred_admission_route",
  "school_preferences.fee_band",
  "family_context.primary_contact_language",
  "family_context.education_priority",
  "family_context.transport_arrangement",
  "family_context.fee_preference",
] as const);

export const BACKGROUND_COMPLETION_FIELD_IDS = Object.freeze([
  "student_profile.date_of_birth",
  "student_profile.residency_status",
  "student_profile.primary_languages",
  "education_profile.current_stage",
  "education_profile.current_year_level",
  "education_profile.current_curriculum",
  "school_preferences.target_stage",
  "school_preferences.preferred_admission_route",
  "family_context.primary_contact_language",
  "family_context.education_priority",
] as const);

export const SCHOOL_SELECTION_READINESS_FIELD_IDS = Object.freeze([
  "student_profile.date_of_birth",
  "student_profile.residency_status",
  "education_profile.current_stage",
  "education_profile.current_year_level",
  "school_preferences.target_stage",
  "school_preferences.preferred_systems",
  "school_preferences.preferred_districts",
  "school_preferences.preferred_admission_route",
  "school_preferences.fee_band",
  "family_context.primary_contact_language",
  "family_context.education_priority",
  "family_context.transport_arrangement",
  "family_context.fee_preference",
] as const);

export type ApprovedAssessmentFieldId = (typeof APPROVED_ASSESSMENT_FIELD_IDS)[number];
export type ApprovedAssessmentStatus = "draft" | "background_complete";

export interface AssessmentAnswerFact {
  readonly fieldId: ApprovedAssessmentFieldId;
  readonly semanticState: AnswerSemanticState;
}

export interface AssessmentReadiness {
  readonly status: ApprovedAssessmentStatus;
  readonly backgroundComplete: boolean;
  readonly schoolSelectionReady: boolean;
  readonly missingBackgroundFields: readonly ApprovedAssessmentFieldId[];
  readonly missingSchoolSelectionFields: readonly ApprovedAssessmentFieldId[];
}

/** Readiness is calculated from the latest append-only revision per field. */
export function evaluateApprovedAssessmentReadiness(
  latestAnswers: readonly AssessmentAnswerFact[],
): AssessmentReadiness {
  const provided = new Set(
    latestAnswers
      .filter(({ semanticState }) => semanticState === "provided")
      .map(({ fieldId }) => fieldId),
  );
  const missingBackgroundFields = BACKGROUND_COMPLETION_FIELD_IDS.filter(
    (fieldId) => !provided.has(fieldId),
  );
  const missingSchoolSelectionFields = SCHOOL_SELECTION_READINESS_FIELD_IDS.filter(
    (fieldId) => !provided.has(fieldId),
  );
  return Object.freeze({
    status: missingBackgroundFields.length === 0 ? "background_complete" : "draft",
    backgroundComplete: missingBackgroundFields.length === 0,
    schoolSelectionReady: missingSchoolSelectionFields.length === 0,
    missingBackgroundFields: Object.freeze(missingBackgroundFields),
    missingSchoolSelectionFields: Object.freeze(missingSchoolSelectionFields),
  });
}

export type CaseAssessmentAccessDecision =
  | Readonly<{ allowed: true; mode: "read" | "write"; scope: "full" | "education_profile" }>
  | Readonly<{ allowed: false; code: "CASE_ASSESSMENT_ACCESS_DENIED" }>;

export function evaluateCaseAssessmentAccess(input: Readonly<{
  actorRoles: readonly string[];
  requestedMode: "read" | "write";
  isCurrentPrimaryAdvisor: boolean;
  collaboratorScope: "education_profile" | null;
}>): CaseAssessmentAccessDecision {
  if (input.actorRoles.includes("founder") && input.requestedMode === "read") {
    return { allowed: true, mode: "read", scope: "full" };
  }
  if (input.actorRoles.includes("advisor") && input.isCurrentPrimaryAdvisor) {
    return { allowed: true, mode: input.requestedMode, scope: "full" };
  }
  if (input.actorRoles.includes("advisor") && input.collaboratorScope === "education_profile") {
    return { allowed: true, mode: input.requestedMode, scope: "education_profile" };
  }
  return { allowed: false, code: "CASE_ASSESSMENT_ACCESS_DENIED" };
}

export function evaluateApprovedCaseCreation(input: Readonly<{
  actorRoles: readonly string[];
  studentStatus: string;
  primaryAdvisorRole: string;
  primaryAdvisorActive: boolean;
  manifestApproved: boolean;
}>): boolean {
  return (input.actorRoles.includes("founder") || input.actorRoles.includes("advisor")) &&
    input.studentStatus === "active" &&
    input.primaryAdvisorRole === "advisor" &&
    input.primaryAdvisorActive &&
    input.manifestApproved;
}
