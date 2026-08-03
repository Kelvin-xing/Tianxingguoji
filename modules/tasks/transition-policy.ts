import {
  TASK_STATES,
  TaskContractError,
  type TaskActorRole,
  type TaskDecision,
  type TaskPolicyApprovalReceipt,
  type TaskState,
  type TaskTransitionInput,
  type TaskTransitionPolicy,
  type TaskTransitionRule,
} from "./contract.ts";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function nonBlank(value: string, code: "TASK_POLICY_RULE_INVALID"): string {
  if (typeof value !== "string" || value.trim() === "") throw new TaskContractError(code);
  return value.trim();
}

function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as readonly string[]).includes(value);
}

function validateRule(rule: TaskTransitionRule): TaskTransitionRule {
  if (!isTaskState(rule.from) || !isTaskState(rule.to)) {
    throw new TaskContractError("TASK_TRANSITION_RULE_INVALID");
  }
  if (rule.from === rule.to) throw new TaskContractError("TASK_TRANSITION_SELF_LOOP");
  if (!Object.values(["assignee", "approver", "owner"]).includes(rule.actorKind)) {
    throw new TaskContractError("TASK_TRANSITION_RULE_INVALID");
  }
  if (rule.allowedActorRoles.length === 0) {
    throw new TaskContractError("TASK_TRANSITION_RULE_INVALID");
  }
  if (
    ["rejected", "reassigned", "cancelled", "approved"].includes(rule.to) &&
    !rule.requiresReason
  ) {
    throw new TaskContractError("TASK_REASON_REQUIRED");
  }
  if (rule.to === "approved" && rule.from !== "completed") {
    throw new TaskContractError("TASK_APPROVAL_REQUIRES_COMPLETION");
  }
  if (rule.to === "approved" && !rule.requiresDifferentActor) {
    throw new TaskContractError("TASK_APPROVAL_SEPARATION_POLICY_REQUIRED");
  }
  return deepFreeze({
    from: rule.from,
    to: rule.to,
    actorKind: rule.actorKind,
    allowedActorRoles: Object.freeze([...rule.allowedActorRoles]),
    requiresReason: rule.requiresReason,
    requiresDifferentActor: rule.requiresDifferentActor,
  });
}

export function proposeTaskTransitionPolicy(input: {
  readonly policyId: string;
  readonly version: number;
  readonly organizationId: string;
  readonly requestedBy: string;
  readonly initialState: TaskState | null;
  readonly rules: readonly TaskTransitionRule[];
  readonly createdAt: string;
}): TaskTransitionPolicy {
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new TaskContractError("TASK_TRANSITION_RULE_INVALID");
  }
  if (input.initialState !== null && !isTaskState(input.initialState)) {
    throw new TaskContractError("TASK_TRANSITION_RULE_INVALID");
  }
  return deepFreeze({
    policyId: nonBlank(input.policyId, "TASK_TRANSITION_RULE_INVALID"),
    version: input.version,
    organizationId: nonBlank(input.organizationId, "TASK_TRANSITION_RULE_INVALID"),
    requestedBy: nonBlank(input.requestedBy, "TASK_TRANSITION_RULE_INVALID"),
    initialState: input.initialState,
    rules: Object.freeze(input.rules.map(validateRule)),
    status: "candidate",
    createdAt: nonBlank(input.createdAt, "TASK_TRANSITION_RULE_INVALID"),
  });
}

function assertNoDuplicateRules(rules: readonly TaskTransitionRule[]): void {
  const keys = new Set<string>();
  for (const rule of rules) {
    const key = `${rule.from}:${rule.to}`;
    if (keys.has(key)) throw new TaskContractError("TASK_TRANSITION_DUPLICATE");
    keys.add(key);
  }
}

export function approveTaskTransitionPolicy(
  policy: TaskTransitionPolicy,
  receipt: TaskPolicyApprovalReceipt,
): TaskTransitionPolicy {
  if (policy.status !== "candidate") {
    throw new TaskContractError("TASK_TRANSITION_RULE_INVALID");
  }
  if (receipt.decisionId !== "OD-06" || receipt.decisionStatus !== "resolved") {
    throw new TaskContractError("TASK_POLICY_DECISION_NOT_RESOLVED");
  }
  if (policy.requestedBy === receipt.reviewerId) {
    throw new TaskContractError("TASK_POLICY_SELF_REVIEW_DENIED");
  }
  if (receipt.reviewerRole !== "founder" && receipt.reviewerRole !== "advisor") {
    throw new TaskContractError("TASK_POLICY_REVIEWER_ROLE_NOT_ALLOWED");
  }
  if (policy.initialState === null) {
    throw new TaskContractError("TASK_INITIAL_STATE_UNAPPROVED");
  }
  if (policy.rules.length === 0) throw new TaskContractError("TASK_POLICY_RULES_REQUIRED");
  assertNoDuplicateRules(policy.rules);
  return deepFreeze({
    ...policy,
    status: "approved",
    approvalReceipt: deepFreeze({ ...receipt }),
  });
}

export function evaluateTaskCreation(policy: TaskTransitionPolicy):
  | { readonly allowed: true; readonly initialState: TaskState }
  | { readonly allowed: false; readonly code: "TASK_POLICY_NOT_APPROVED" | "TASK_INITIAL_STATE_UNAPPROVED" } {
  if (policy.status !== "approved" || !policy.approvalReceipt) {
    return { allowed: false, code: "TASK_POLICY_NOT_APPROVED" };
  }
  if (policy.initialState === null) return { allowed: false, code: "TASK_INITIAL_STATE_UNAPPROVED" };
  return { allowed: true, initialState: policy.initialState };
}

function actorMatchesRule(input: TaskTransitionInput, rule: TaskTransitionRule): boolean {
  if (rule.actorKind === "assignee") return input.assigneeId === input.actorId;
  if (rule.actorKind === "approver") return input.approverId === input.actorId;
  if (rule.actorKind === "owner") return input.ownerId === input.actorId;
  return false;
}

export function evaluateTaskTransition(input: TaskTransitionInput): TaskDecision {
  if (input.policy.status !== "approved" || !input.policy.approvalReceipt) {
    return { allowed: false, code: "TASK_POLICY_NOT_APPROVED" };
  }
  if (
    input.organizationId !== input.taskOrganizationId ||
    input.caseId !== input.taskCaseId
  ) {
    return { allowed: false, code: "TASK_CONTEXT_MISMATCH" };
  }
  if (!input.actorIsActive) return { allowed: false, code: "TASK_ACTOR_INACTIVE" };
  if (input.recordVersion !== input.expectedRecordVersion) {
    return { allowed: false, code: "TASK_STALE_VERSION" };
  }

  const rule = input.policy.rules.find(
    (candidate) => candidate.from === input.from && candidate.to === input.to,
  );
  if (!rule) return { allowed: false, code: "TASK_TRANSITION_NOT_ALLOWED" };
  if (!rule.allowedActorRoles.includes(input.actorRole)) {
    return { allowed: false, code: "TASK_ACTOR_NOT_ALLOWED" };
  }
  if (input.actorRole === "contractor" && !input.redactedTaskContext) {
    return { allowed: false, code: "TASK_CONTRACTOR_CONTEXT_REQUIRED" };
  }
  if (input.actorRole === "contractor" && rule.actorKind !== "assignee") {
    return { allowed: false, code: "TASK_CONTRACTOR_ACTOR_NOT_ALLOWED" };
  }
  if (rule.requiresDifferentActor && input.actorId === input.assigneeId) {
    return { allowed: false, code: "TASK_APPROVAL_SEPARATION_REQUIRED" };
  }
  if (!actorMatchesRule(input, rule)) {
    return { allowed: false, code: "TASK_ACTOR_NOT_ALLOWED" };
  }
  if (rule.requiresReason && input.reason.trim() === "") {
    return { allowed: false, code: "TASK_REASON_REQUIRED" };
  }
  return { allowed: true };
}
