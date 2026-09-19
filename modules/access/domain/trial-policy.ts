/** BR-015 / ACCESS-TRIAL-01. Facts must be loaded from the current transaction. */
export const TRIAL_LEVELS = ["founder", "l1", "l2", "l3"] as const;
export const K12_BUSINESS_CATEGORIES = ["international_school", "local_school"] as const;
export type TrialLevel = (typeof TRIAL_LEVELS)[number];
export type K12BusinessCategory = (typeof K12_BUSINESS_CATEGORIES)[number];

export const TRIAL_ACTIONS = [
  "case.read", "case.create", "case.manage", "assessment.read", "assessment.manage",
  "case.approve", "case.close", "student.read", "student.create", "student.manage",
  "task.read", "task.create", "task.assign", "task.execute",
  "document.read", "document.create", "document.upload", "document.download",
  "school.read", "school.manage", "school.approve", "referral.read", "referral.manage",
  "member.manage", "member.invite", "member.disable", "profile.self.edit",
  "settings.manage", "audit.business.read", "audit.security.read", "export",
] as const;
export type TrialAction = (typeof TRIAL_ACTIONS)[number];

export interface TrialPrincipal {
  readonly userId: string;
  readonly organizationId: string;
  readonly active: boolean;
  readonly level: TrialLevel;
  readonly categories: readonly K12BusinessCategory[];
  /** Changes whenever level or category assignments change. Never session-cached. */
  readonly recordVersion: number;
}

export interface TrialTaskFacts {
  readonly assigneeUserId: string | null;
  readonly assignmentStatus: "active" | "revoked" | "reassigned";
  readonly status: "assigned" | "accepted" | "awaiting_reassignment" | "completed" | "cancelled";
}

export interface TrialResource {
  readonly organizationId: string;
  readonly category?: K12BusinessCategory | null;
  readonly caseId?: string;
  readonly task?: TrialTaskFacts;
  /** A task-only response excludes Assessment, contacts, notes and other tasks. */
  readonly projection?: "task_only" | "full";
  readonly document?: Readonly<{
    linkedToTask: boolean;
    allowedTaskActions: readonly TrialAction[];
    availableVersion: boolean;
  }>;
  readonly auditActorUserId?: string;
  readonly profileUserId?: string;
}

export type TrialDenial = "INACTIVE" | "INVALID_FACTS" | "ORGANIZATION_MISMATCH"
  | "ACTION_DENIED" | "CATEGORY_DENIED" | "ASSIGNMENT_DENIED" | "DOCUMENT_DENIED";
export type TrialDecision = Readonly<{ allowed: true }> | Readonly<{ allowed: false; code: TrialDenial }>;
const ALLOW = Object.freeze({ allowed: true } as const);
const deny = (code: TrialDenial): TrialDecision => Object.freeze({ allowed: false, code });
const PERSONNEL_AND_SECURITY = new Set<TrialAction>([
  "member.manage", "member.invite", "member.disable", "settings.manage", "audit.security.read",
]);
const APPROVALS = new Set<TrialAction>(["case.approve", "case.close", "school.approve"]);
const GLOBAL_BUSINESS = new Set<TrialAction>(["referral.read", "referral.manage"]);
const L3_ACTIONS = new Set<TrialAction>([
  "task.read", "task.execute", "document.read", "document.upload", "document.download", "audit.business.read",
]);

export function isTrialLevel(value: unknown): value is TrialLevel {
  return typeof value === "string" && (TRIAL_LEVELS as readonly string[]).includes(value);
}
export function isK12BusinessCategory(value: unknown): value is K12BusinessCategory {
  return typeof value === "string" && (K12_BUSINESS_CATEGORIES as readonly string[]).includes(value);
}

/** Never combines a trial level with legacy role capabilities. Unknown inputs fail closed. */
export function evaluateTrialAccess(
  actor: TrialPrincipal,
  action: TrialAction,
  resource: TrialResource,
): TrialDecision {
  if (!actor.active) return deny("INACTIVE");
  if (!isTrialLevel(actor.level) || !actor.userId || !actor.organizationId
    || !Number.isSafeInteger(actor.recordVersion) || actor.recordVersion < 1
    || !Array.isArray(actor.categories) || actor.categories.some((category) => !isK12BusinessCategory(category))
    || !(TRIAL_ACTIONS as readonly string[]).includes(action)) return deny("INVALID_FACTS");
  if (actor.organizationId !== resource.organizationId) return deny("ORGANIZATION_MISMATCH");
  if (action === "export") return deny("ACTION_DENIED");
  if (action === "profile.self.edit") {
    return resource.profileUserId === actor.userId ? ALLOW : deny("ACTION_DENIED");
  }
  if (PERSONNEL_AND_SECURITY.has(action)) return actor.level === "founder" ? ALLOW : deny("ACTION_DENIED");
  if (GLOBAL_BUSINESS.has(action)) {
    return actor.level === "founder" || actor.level === "l1" ? ALLOW : deny("ACTION_DENIED");
  }
  // Every case-linked resource has an explicit category, even for Founder/L1.
  if (!isK12BusinessCategory(resource.category)) return deny("CATEGORY_DENIED");
  if (actor.level === "l2" && !actor.categories.includes(resource.category)) return deny("CATEGORY_DENIED");
  if (APPROVALS.has(action) && actor.level !== "founder" && actor.level !== "l1") return deny("ACTION_DENIED");
  if (action.startsWith("document.")) {
    if (!resource.document) return deny("DOCUMENT_DENIED");
    if (action === "document.download" && !resource.document.availableVersion) return deny("DOCUMENT_DENIED");
  }
  if (actor.level !== "l3") return ALLOW;
  if (!L3_ACTIONS.has(action)) return deny("ACTION_DENIED");
  const task = resource.task;
  if (!task || task.assigneeUserId !== actor.userId || task.assignmentStatus !== "active"
    || !["assigned", "accepted", "completed"].includes(task.status)) return deny("ASSIGNMENT_DENIED");
  if (resource.projection !== "task_only") return deny("ACTION_DENIED");
  if (task.status === "completed" && (action === "task.execute" || action === "document.upload")) return deny("ACTION_DENIED");
  if (action === "audit.business.read" && resource.auditActorUserId !== actor.userId) return deny("ACTION_DENIED");
  if (action.startsWith("document.") && (!resource.document?.linkedToTask
    || !resource.document.allowedTaskActions.includes(action))) return deny("DOCUMENT_DENIED");
  return ALLOW;
}

/** The assigner and recipient must be re-read while holding mutation locks. */
export function evaluateTrialTaskAssignment(input: Readonly<{
  actor: TrialPrincipal;
  recipient: TrialPrincipal;
  resource: TrialResource;
}>): TrialDecision {
  const decision = evaluateTrialAccess(input.actor, "task.assign", input.resource);
  if (!decision.allowed) return decision;
  const recipient = input.recipient;
  if (!recipient.active || recipient.level !== "l3" || !recipient.userId
    || !Number.isSafeInteger(recipient.recordVersion) || recipient.recordVersion < 1
    || recipient.organizationId !== input.actor.organizationId) return deny("ASSIGNMENT_DENIED");
  return ALLOW;
}
