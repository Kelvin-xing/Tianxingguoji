import type {
  CaseOutcomeCode,
  SchoolTargetState,
  ServiceCaseStage,
} from "./contract.ts";

export type CaseLifecycleState = "active" | "paused" | "cancelled";
export type CaseLifecycleAction = "advance" | "pause" | "resume" | "cancel" | "close";

export type CaseTransitionPolicyDecision =
  | {
      readonly allowed: true;
      readonly stage: ServiceCaseStage;
      readonly lifecycleState: CaseLifecycleState;
      readonly pausedPreviousStage: ServiceCaseStage | null;
    }
  | { readonly allowed: false; readonly code: string };

export interface CaseTransitionPolicyInput {
  readonly action: CaseLifecycleAction;
  readonly actorRole: "founder" | "advisor" | "admin" | "data_reviewer" | "contractor";
  readonly actorIsCurrentPrimaryAdvisor: boolean;
  readonly stage: ServiceCaseStage;
  readonly lifecycleState: CaseLifecycleState;
  readonly pausedPreviousStage: ServiceCaseStage | null;
  readonly toStage: ServiceCaseStage | null;
  readonly hasReason: boolean;
  readonly approvedManifest: boolean;
  readonly backgroundBlockersComplete: boolean;
  readonly schoolSelectionBlockersComplete: boolean;
  readonly allTargetsTerminalWithOutcomes: boolean;
  readonly hasOpenTasks: boolean;
}

export type TargetEvidenceRequirement =
  | "due_date"
  | "checklist_complete_receipt"
  | "official_submission_reference"
  | "invitation_evidence"
  | "interview_time";

export interface SchoolTargetRouteTemplate {
  readonly templateId: "hk_k12_standard_v1";
  readonly version: 1;
  readonly approved: true;
  readonly transitions: readonly SchoolTargetTransitionTemplate[];
}

export interface SchoolTargetTransitionTemplate {
  readonly from: SchoolTargetState;
  readonly to: SchoolTargetState;
  readonly requirements: readonly TargetEvidenceRequirement[];
}

export interface SchoolTargetEvidence {
  readonly dueDate: string | null;
  readonly checklistCompleteReceipt: string | null;
  readonly officialSubmissionReference: string | null;
  readonly invitationEvidence: string | null;
  readonly interviewAt: string | null;
}

export type SchoolTargetTransitionDecision =
  | { readonly allowed: true; readonly requiresOutcome: boolean }
  | { readonly allowed: false; readonly code: string };

export const HK_K12_STANDARD_V1_TEMPLATE: SchoolTargetRouteTemplate = Object.freeze({
  templateId: "hk_k12_standard_v1",
  version: 1,
  approved: true,
  transitions: Object.freeze([
    Object.freeze({ from: "candidate", to: "preparing", requirements: Object.freeze([]) }),
    Object.freeze({
      from: "preparing",
      to: "submitted",
      requirements: Object.freeze([
        "due_date",
        "checklist_complete_receipt",
        "official_submission_reference",
      ]),
    }),
    Object.freeze({
      from: "submitted",
      to: "interview",
      requirements: Object.freeze(["invitation_evidence", "interview_time"]),
    }),
    Object.freeze({ from: "submitted", to: "waitlisted", requirements: Object.freeze([]) }),
    Object.freeze({ from: "submitted", to: "accepted", requirements: Object.freeze([]) }),
    Object.freeze({ from: "submitted", to: "rejected", requirements: Object.freeze([]) }),
    Object.freeze({ from: "submitted", to: "withdrawn", requirements: Object.freeze([]) }),
    Object.freeze({ from: "interview", to: "waitlisted", requirements: Object.freeze([]) }),
    Object.freeze({ from: "interview", to: "accepted", requirements: Object.freeze([]) }),
    Object.freeze({ from: "interview", to: "rejected", requirements: Object.freeze([]) }),
    Object.freeze({ from: "interview", to: "withdrawn", requirements: Object.freeze([]) }),
    Object.freeze({ from: "waitlisted", to: "accepted", requirements: Object.freeze([]) }),
    Object.freeze({ from: "waitlisted", to: "rejected", requirements: Object.freeze([]) }),
    Object.freeze({ from: "waitlisted", to: "withdrawn", requirements: Object.freeze([]) }),
  ]),
});

const CASE_FORWARD_STAGES: Readonly<Record<ServiceCaseStage, ServiceCaseStage | null>> = Object.freeze({
  signed: "background_collection",
  background_collection: "school_selection_confirmed",
  school_selection_confirmed: "interview_preparation",
  interview_preparation: "application_submitted",
  application_submitted: "awaiting_result",
  awaiting_result: "offer_confirmed",
  offer_confirmed: "closed",
  closed: null,
});

const CASE_STAGES_BEFORE_SUBMISSION = new Set<ServiceCaseStage>([
  "signed",
  "background_collection",
  "school_selection_confirmed",
  "interview_preparation",
]);

const TARGET_TERMINAL_STATES = new Set<SchoolTargetState>([
  "waitlisted",
  "accepted",
  "rejected",
  "withdrawn",
]);

/**
 * CaseWorkflow's approved P2 lifecycle guard. Pause and cancellation are an
 * overlay rather than replacement case stages, preserving the eight-stage
 * history that is already pinned by the P0 contract.
 */
export function evaluateCaseTransitionPolicy(
  input: CaseTransitionPolicyInput,
): CaseTransitionPolicyDecision {
  if (input.action === "resume") {
    if (input.actorRole !== "founder") return deny("CASE_FOUNDER_REQUIRED");
    if (input.lifecycleState !== "paused" || input.pausedPreviousStage === null) {
      return deny("CASE_NOT_PAUSED");
    }
    if (!input.hasReason) return deny("CASE_REASON_REQUIRED");
    return allowCase(input.pausedPreviousStage, "active", null);
  }

  if (input.lifecycleState !== "active") return deny("CASE_NOT_ACTIVE");

  switch (input.action) {
    case "advance":
      if (!isCurrentPrimaryAdvisor(input)) return deny("CASE_PRIMARY_ADVISOR_REQUIRED");
      if (input.toStage === null || CASE_FORWARD_STAGES[input.stage] !== input.toStage) {
        return deny("CASE_TRANSITION_NOT_ALLOWED");
      }
      if (input.toStage === "closed") return deny("CASE_CLOSE_GUARD_REQUIRED");
      if (
        input.stage === "signed" &&
        (!input.approvedManifest || !input.backgroundBlockersComplete)
      ) {
        return deny("CASE_BACKGROUND_EVIDENCE_REQUIRED");
      }
      if (
        input.stage === "background_collection" &&
        (!input.approvedManifest || !input.schoolSelectionBlockersComplete)
      ) {
        return deny("CASE_SCHOOL_SELECTION_EVIDENCE_REQUIRED");
      }
      return allowCase(input.toStage, "active", null);
    case "pause":
      if (input.actorRole !== "advisor" || !input.actorIsCurrentPrimaryAdvisor) {
        return deny("CASE_PRIMARY_ADVISOR_REQUIRED");
      }
      if (!input.hasReason) return deny("CASE_REASON_REQUIRED");
      return allowCase(input.stage, "paused", input.stage);
    case "cancel":
      if (input.actorRole !== "founder") return deny("CASE_FOUNDER_REQUIRED");
      if (!CASE_STAGES_BEFORE_SUBMISSION.has(input.stage)) {
        return deny("CASE_CANCEL_AFTER_SUBMISSION_DENIED");
      }
      if (!input.hasReason) return deny("CASE_REASON_REQUIRED");
      return allowCase(input.stage, "cancelled", null);
    case "close":
      if (input.actorRole !== "founder") return deny("CASE_FOUNDER_REQUIRED");
      if (input.stage !== "offer_confirmed") return deny("CASE_TRANSITION_NOT_ALLOWED");
      if (!input.allTargetsTerminalWithOutcomes) return deny("CASE_TARGET_OUTCOMES_REQUIRED");
      if (input.hasOpenTasks) return deny("CASE_OPEN_TASKS_BLOCK_CLOSE");
      return allowCase("closed", "active", null);
    default:
      return deny("CASE_TRANSITION_NOT_ALLOWED");
  }
}

/**
 * Target route templates are explicit versioned data. The command never uses
 * a client-provided boolean as proof that a policy is approved.
 */
export function evaluateSchoolTargetTransitionPolicy(input: {
  readonly template: SchoolTargetRouteTemplate | null;
  readonly from: SchoolTargetState;
  readonly to: SchoolTargetState;
  readonly evidence: SchoolTargetEvidence;
}): SchoolTargetTransitionDecision {
  const template = input.template;
  if (!isApprovedHkK12StandardV1(template)) return denyTarget("TARGET_ROUTE_POLICY_REQUIRED");
  const transition = template.transitions.find(
    (candidate) => candidate.from === input.from && candidate.to === input.to,
  );
  if (!transition) return denyTarget("TARGET_TRANSITION_NOT_ALLOWED");
  for (const requirement of transition.requirements) {
    if (!hasTargetEvidence(requirement, input.evidence)) {
      return denyTarget("TARGET_EVIDENCE_REQUIRED");
    }
  }
  return { allowed: true, requiresOutcome: TARGET_TERMINAL_STATES.has(input.to) };
}

export function isTerminalSchoolTargetState(state: SchoolTargetState): boolean {
  return TARGET_TERMINAL_STATES.has(state);
}

export function outcomeCodesForTargetState(state: SchoolTargetState): readonly CaseOutcomeCode[] {
  switch (state) {
    case "waitlisted":
      return ["waitlisted"];
    case "accepted":
      return ["accepted"];
    case "rejected":
      return ["rejected"];
    case "withdrawn":
      return ["withdrawn", "not_submitted", "aborted"];
    default:
      return [];
  }
}

function isCurrentPrimaryAdvisor(input: CaseTransitionPolicyInput): boolean {
  return (
    input.actorIsCurrentPrimaryAdvisor &&
    (input.actorRole === "advisor" || input.actorRole === "founder")
  );
}

function isApprovedHkK12StandardV1(
  template: SchoolTargetRouteTemplate | null,
): template is SchoolTargetRouteTemplate {
  return (
    template !== null &&
    template.templateId === "hk_k12_standard_v1" &&
    template.version === 1 &&
    template.approved === true
  );
}

function hasTargetEvidence(
  requirement: TargetEvidenceRequirement,
  evidence: SchoolTargetEvidence,
): boolean {
  switch (requirement) {
    case "due_date":
      return isIsoCalendarDate(evidence.dueDate);
    case "checklist_complete_receipt":
      return isNonEmpty(evidence.checklistCompleteReceipt);
    case "official_submission_reference":
      return isNonEmpty(evidence.officialSubmissionReference);
    case "invitation_evidence":
      return isNonEmpty(evidence.invitationEvidence);
    case "interview_time":
      return isIsoDateTime(evidence.interviewAt);
  }
}

function isIsoCalendarDate(value: string | null): boolean {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function isIsoDateTime(value: string | null): boolean {
  return value !== null && !Number.isNaN(Date.parse(value)) && /T/.test(value);
}

function isNonEmpty(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

function allowCase(
  stage: ServiceCaseStage,
  lifecycleState: CaseLifecycleState,
  pausedPreviousStage: ServiceCaseStage | null,
): CaseTransitionPolicyDecision {
  return { allowed: true, stage, lifecycleState, pausedPreviousStage };
}

function deny(code: string): CaseTransitionPolicyDecision {
  return { allowed: false, code };
}

function denyTarget(code: string): SchoolTargetTransitionDecision {
  return { allowed: false, code };
}
