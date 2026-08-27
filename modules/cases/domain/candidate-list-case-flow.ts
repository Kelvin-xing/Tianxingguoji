import {
  hasRequestCapability,
  type RequestAccessActor,
} from "../../access/public.ts";

export const CANDIDATE_LIST_STATUSES = Object.freeze([
  "draft",
  "submitted",
  "awaiting_guardian",
  "confirmed",
  "returned",
] as const);

export type CandidateListStatus = (typeof CANDIDATE_LIST_STATUSES)[number];
export type FounderListDecision = "approved" | "rejected";
export type GuardianListDecision = "confirmed" | "not_confirmed";
export type GuardianConfirmationChannel = "phone" | "wechat" | "in_person";
export type CaseWorkflowStatus = "active" | "paused" | "termination_pending" | "closed";
export type CandidateFlowSchoolTargetState =
  | "candidate"
  | "preparing"
  | "submitted"
  | "interview"
  | "waitlisted"
  | "accepted"
  | "offer_confirmed"
  | "offer_declined"
  | "rejected"
  | "withdrawn";

export const TERMINAL_SCHOOL_TARGET_STATES: ReadonlySet<CandidateFlowSchoolTargetState> = new Set([
  "offer_confirmed",
  "offer_declined",
  "rejected",
  "withdrawn",
]);

export type CandidateListPolicyCode =
  | "CANDIDATE_LIST_FORBIDDEN"
  | "CANDIDATE_LIST_CASE_NOT_ACTIVE"
  | "CANDIDATE_LIST_BACKGROUND_INCOMPLETE"
  | "CANDIDATE_LIST_SELECTION_BLOCKED"
  | "CANDIDATE_LIST_NOT_SUBMITTED"
  | "CANDIDATE_LIST_NOT_APPROVED"
  | "CANDIDATE_LIST_FOUNDER_RECEIPT_MISMATCH"
  | "CANDIDATE_LIST_GUARDIAN_RELATIONSHIP_INVALID"
  | "CASE_CLOSE_FORBIDDEN"
  | "CASE_CLOSE_TARGETS_INCOMPLETE"
  | "CASE_CLOSE_TASKS_INCOMPLETE";

export type CandidateListPolicyDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; code: CandidateListPolicyCode }>;

export function evaluateCandidateListCreation(input: Readonly<{
  actor: RequestAccessActor;
  isCurrentPrimaryAdvisor: boolean;
  workflowStatus: CaseWorkflowStatus;
  backgroundComplete: boolean;
}>): CandidateListPolicyDecision {
  if (!hasRequestCapability(input.actor, "cases.workflow.manage") ||
      input.actor.roles?.includes("advisor") !== true ||
      !input.isCurrentPrimaryAdvisor) {
    return denied("CANDIDATE_LIST_FORBIDDEN");
  }
  if (input.workflowStatus !== "active") return denied("CANDIDATE_LIST_CASE_NOT_ACTIVE");
  if (!input.backgroundComplete) return denied("CANDIDATE_LIST_BACKGROUND_INCOMPLETE");
  return ALLOWED;
}

export function evaluateFounderListReview(input: Readonly<{
  actor: RequestAccessActor;
  workflowStatus: CaseWorkflowStatus;
  listStatus: CandidateListStatus;
}>): CandidateListPolicyDecision {
  if (!hasRequestCapability(input.actor, "cases.workflow.manage") ||
      input.actor.roles?.includes("founder") !== true) {
    return denied("CANDIDATE_LIST_FORBIDDEN");
  }
  if (input.workflowStatus !== "active") return denied("CANDIDATE_LIST_CASE_NOT_ACTIVE");
  if (input.listStatus !== "submitted") return denied("CANDIDATE_LIST_NOT_SUBMITTED");
  return ALLOWED;
}

export function evaluateGuardianListDecision(input: Readonly<{
  actor: RequestAccessActor;
  isCurrentPrimaryAdvisor: boolean;
  workflowStatus: CaseWorkflowStatus;
  listStatus: CandidateListStatus;
  founderDecision: FounderListDecision | null;
  founderDecisionSha256: string | null;
  boundFounderDecisionSha256: string;
  selectionBlockersComplete: boolean;
  guardianRelationshipCurrent: boolean;
}>): CandidateListPolicyDecision {
  if (!hasRequestCapability(input.actor, "cases.workflow.manage") ||
      input.actor.roles?.includes("advisor") !== true ||
      !input.isCurrentPrimaryAdvisor) {
    return denied("CANDIDATE_LIST_FORBIDDEN");
  }
  if (input.workflowStatus !== "active") return denied("CANDIDATE_LIST_CASE_NOT_ACTIVE");
  if (input.listStatus !== "awaiting_guardian" || input.founderDecision !== "approved") {
    return denied("CANDIDATE_LIST_NOT_APPROVED");
  }
  if (!input.selectionBlockersComplete) return denied("CANDIDATE_LIST_SELECTION_BLOCKED");
  if (!input.guardianRelationshipCurrent) {
    return denied("CANDIDATE_LIST_GUARDIAN_RELATIONSHIP_INVALID");
  }
  if (input.founderDecisionSha256 === null ||
      input.founderDecisionSha256 !== input.boundFounderDecisionSha256) {
    return denied("CANDIDATE_LIST_FOUNDER_RECEIPT_MISMATCH");
  }
  return ALLOWED;
}

export type TerminalTargetBranches = Readonly<{
  allTargetsTerminal: boolean;
  allTargetsRejected: boolean;
  autoClose: false;
  branches: readonly ("add_new_school" | "founder_manual_close")[];
}>;

export function evaluateTerminalTargetBranches(
  states: readonly CandidateFlowSchoolTargetState[],
): TerminalTargetBranches {
  const allTargetsTerminal = states.length > 0 &&
    states.every((state) => TERMINAL_SCHOOL_TARGET_STATES.has(state));
  const allTargetsRejected = allTargetsTerminal && states.every((state) => state === "rejected");
  return Object.freeze({
    allTargetsTerminal,
    allTargetsRejected,
    autoClose: false,
    branches: allTargetsRejected
      ? Object.freeze(["add_new_school", "founder_manual_close"] as const)
      : Object.freeze(["founder_manual_close"] as const),
  });
}

export function evaluateFounderManualClose(input: Readonly<{
  actor: RequestAccessActor;
  workflowStatus: CaseWorkflowStatus;
  targetStates: readonly CandidateFlowSchoolTargetState[];
  hasIncompleteCaseTasks: boolean;
}>): CandidateListPolicyDecision {
  if (!hasRequestCapability(input.actor, "cases.workflow.manage") ||
      input.actor.roles?.includes("founder") !== true) {
    return denied("CASE_CLOSE_FORBIDDEN");
  }
  if (input.workflowStatus === "closed") return denied("CASE_CLOSE_FORBIDDEN");
  if (!evaluateTerminalTargetBranches(input.targetStates).allTargetsTerminal) {
    return denied("CASE_CLOSE_TARGETS_INCOMPLETE");
  }
  if (input.hasIncompleteCaseTasks) return denied("CASE_CLOSE_TASKS_INCOMPLETE");
  return ALLOWED;
}

const ALLOWED = Object.freeze({ allowed: true } as const);
function denied(code: CandidateListPolicyCode): CandidateListPolicyDecision {
  return Object.freeze({ allowed: false, code });
}
