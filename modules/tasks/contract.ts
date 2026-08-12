export const TASK_STATES = Object.freeze([
  "created",
  "assigned",
  "accepted",
  "rejected",
  "reassigned",
  "completed",
  "approved",
  "overdue",
  "cancelled",
] as const);

export type TaskState = (typeof TASK_STATES)[number];
export type TaskPolicyStatus = "candidate" | "approved" | "retired";
export type TaskActorKind = "assignee" | "approver" | "owner";
export type TaskActorRole =
  | "founder"
  | "admin"
  | "advisor"
  | "data_reviewer"
  | "contractor";

export type TaskDenialCode =
  | "TASK_POLICY_NOT_APPROVED"
  | "TASK_INITIAL_STATE_UNAPPROVED"
  | "TASK_POLICY_DECISION_NOT_RESOLVED"
  | "TASK_POLICY_SELF_REVIEW_DENIED"
  | "TASK_POLICY_REVIEWER_ROLE_NOT_ALLOWED"
  | "TASK_POLICY_RULES_REQUIRED"
  | "TASK_POLICY_MATRIX_MISMATCH"
  | "TASK_TRANSITION_SELF_LOOP"
  | "TASK_TRANSITION_DUPLICATE"
  | "TASK_TRANSITION_RULE_INVALID"
  | "TASK_APPROVAL_REQUIRES_COMPLETION"
  | "TASK_APPROVAL_SEPARATION_POLICY_REQUIRED"
  | "TASK_CONTEXT_MISMATCH"
  | "TASK_ACTOR_INACTIVE"
  | "TASK_STALE_VERSION"
  | "TASK_TRANSITION_NOT_ALLOWED"
  | "TASK_ACTOR_NOT_ALLOWED"
  | "TASK_CONTRACTOR_CONTEXT_REQUIRED"
  | "TASK_CONTRACTOR_ACTOR_NOT_ALLOWED"
  | "TASK_APPROVAL_SEPARATION_REQUIRED"
  | "TASK_REASON_REQUIRED";

export interface TaskTransitionRule {
  readonly from: TaskState;
  readonly to: TaskState;
  readonly actorKind: TaskActorKind;
  readonly allowedActorRoles: readonly TaskActorRole[];
  readonly requiresReason: boolean;
  readonly requiresDifferentActor: boolean;
}

export interface TaskPolicyApprovalReceipt {
  readonly decisionId: "OD-06";
  readonly decisionStatus: "resolved";
  readonly reviewerId: string;
  readonly reviewerRole: "founder" | "advisor";
  readonly approvedAt: string;
}

export interface TaskTransitionPolicy {
  readonly policyId: string;
  readonly version: number;
  readonly organizationId: string;
  readonly requestedBy: string;
  readonly initialState: TaskState | null;
  readonly rules: readonly TaskTransitionRule[];
  readonly status: TaskPolicyStatus;
  readonly createdAt: string;
  readonly approvalReceipt?: TaskPolicyApprovalReceipt;
}

export interface TaskTransitionInput {
  readonly policy: TaskTransitionPolicy;
  readonly organizationId: string;
  readonly taskOrganizationId: string;
  readonly caseId: string;
  readonly taskCaseId: string;
  readonly from: TaskState;
  readonly to: TaskState;
  readonly actorId: string;
  readonly actorRole: TaskActorRole;
  readonly actorIsActive: boolean;
  readonly assigneeId: string | null;
  readonly approverId: string | null;
  readonly ownerId: string | null;
  readonly redactedTaskContext: boolean;
  readonly recordVersion: number;
  readonly expectedRecordVersion: number;
  readonly reason: string;
}

export type TaskDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: TaskDenialCode };

export class TaskContractError extends Error {
  readonly code: TaskDenialCode;

  constructor(code: TaskDenialCode, message = code) {
    super(message);
    this.name = "TaskContractError";
    this.code = code;
  }
}
