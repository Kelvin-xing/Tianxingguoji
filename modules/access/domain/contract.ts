import type {
  MembershipStatus,
  OrganizationStatus,
  UserStatus,
} from "../../identity/public.ts";

export const COLLABORATOR_SCOPES = Object.freeze([
  "case_summary",
  "education_profile",
  "school_targets",
  "task_workspace",
  "communications",
  "identity_contact",
  "internal_notes",
] as const);

export const COLLABORATOR_CAPABILITIES = Object.freeze([
  "view",
  "comment",
  "edit",
] as const);

const SENSITIVE_SCOPES = Object.freeze(["identity_contact", "internal_notes"] as const);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

export const GRANT_POLICY = Object.freeze({
  defaultDurationMs: SEVEN_DAYS_MS,
  maximumDurationMs: SEVEN_DAYS_MS,
  sensitiveScopes: SENSITIVE_SCOPES,
} as const);

export type CollaboratorScope = (typeof COLLABORATOR_SCOPES)[number];
export type CollaboratorCapability = (typeof COLLABORATOR_CAPABILITIES)[number];
export type CollaboratorStatus = "active" | "removed" | "expired";
export type ScopeGrantStatus = "pending_approval" | "active" | "revoked" | "expired";
export type OrganizationRole =
  | "founder"
  | "admin"
  | "advisor"
  | "data_reviewer"
  | "contractor";
export type RoleBindingStatus = "active" | "revoked";

export const WORKSPACE_CAPABILITIES = Object.freeze([
  "today.read",
  "cases.read",
  "students.read",
  "schools.read",
  "tasks.read",
  "documents.read",
  "access.manage",
  "schools.manage",
  "crawler.manage",
] as const);

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

const ROLE_CAPABILITIES: Readonly<Record<OrganizationRole, readonly WorkspaceCapability[]>> = Object.freeze({
  founder: WORKSPACE_CAPABILITIES,
  admin: Object.freeze([
    "today.read",
    "students.read",
    "schools.read",
    "access.manage",
    "schools.manage",
    "crawler.manage",
  ] as const),
  advisor: Object.freeze([
    "today.read",
    "cases.read",
    "students.read",
    "schools.read",
    "tasks.read",
    "documents.read",
  ] as const),
  data_reviewer: Object.freeze([
    "today.read",
    "schools.read",
    "schools.manage",
    "crawler.manage",
  ] as const),
  contractor: Object.freeze(["tasks.read"] as const),
});

export function workspaceCapabilitiesForRole(role: OrganizationRole): readonly WorkspaceCapability[] {
  return ROLE_CAPABILITIES[role];
}

export type ScopeGrantDenialCode =
  | "COLLABORATOR_EXPORT_DENIED"
  | "USER_DISABLED"
  | "ORGANIZATION_INACTIVE"
  | "MEMBERSHIP_INACTIVE"
  | "ADVISOR_ROLE_INACTIVE"
  | "COLLABORATION_INACTIVE"
  | "GRANT_NOT_ACTIVE"
  | "GRANT_NOT_STARTED"
  | "GRANT_EXPIRED"
  | "GRANT_CONTEXT_MISMATCH"
  | "GRANT_SCOPE_MISMATCH"
  | "GRANT_CAPABILITY_MISMATCH"
  | "SENSITIVE_GRANT_NOT_APPROVED";

export type ScopeGrantDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: ScopeGrantDenialCode };

export interface ScopeGrantEvaluationInput {
  readonly nowMs: number;
  readonly organizationId: string;
  readonly caseId: string;
  readonly requestedScope: CollaboratorScope;
  readonly requestedCapability: CollaboratorCapability | "export";
  readonly userStatus: UserStatus;
  readonly organizationStatus: OrganizationStatus;
  readonly membershipStatus: MembershipStatus;
  readonly advisorRoleBindingStatus: RoleBindingStatus;
  readonly collaboratorStatus: CollaboratorStatus;
  readonly grantStatus: ScopeGrantStatus;
  readonly grantOrganizationId: string;
  readonly grantCaseId: string;
  readonly grantScope: CollaboratorScope;
  readonly grantCapability: CollaboratorCapability;
  readonly startsAtMs: number;
  readonly expiresAtMs: number;
  readonly requestedByUserId: string;
  readonly approvedByUserId: string | null;
  readonly approverRole: OrganizationRole | null;
}

export function calculateDefaultGrantExpiry(startsAtMs: number): number {
  return startsAtMs + GRANT_POLICY.defaultDurationMs;
}

export function evaluateScopeGrant(input: ScopeGrantEvaluationInput): ScopeGrantDecision {
  if (input.requestedCapability === "export") {
    return { allowed: false, code: "COLLABORATOR_EXPORT_DENIED" };
  }
  if (input.userStatus !== "active") {
    return { allowed: false, code: "USER_DISABLED" };
  }
  if (input.organizationStatus !== "active") {
    return { allowed: false, code: "ORGANIZATION_INACTIVE" };
  }
  if (input.membershipStatus !== "active") {
    return { allowed: false, code: "MEMBERSHIP_INACTIVE" };
  }
  if (input.advisorRoleBindingStatus !== "active") {
    return { allowed: false, code: "ADVISOR_ROLE_INACTIVE" };
  }
  if (input.collaboratorStatus !== "active") {
    return { allowed: false, code: "COLLABORATION_INACTIVE" };
  }
  if (input.grantStatus !== "active") {
    return { allowed: false, code: "GRANT_NOT_ACTIVE" };
  }
  if (
    input.organizationId !== input.grantOrganizationId ||
    input.caseId !== input.grantCaseId
  ) {
    return { allowed: false, code: "GRANT_CONTEXT_MISMATCH" };
  }
  if (input.requestedScope !== input.grantScope) {
    return { allowed: false, code: "GRANT_SCOPE_MISMATCH" };
  }
  if (input.requestedCapability !== input.grantCapability) {
    return { allowed: false, code: "GRANT_CAPABILITY_MISMATCH" };
  }
  if (input.nowMs < input.startsAtMs) {
    return { allowed: false, code: "GRANT_NOT_STARTED" };
  }
  if (input.nowMs >= input.expiresAtMs) {
    return { allowed: false, code: "GRANT_EXPIRED" };
  }
  if (
    isSensitiveScope(input.grantScope) &&
    (input.approvedByUserId === null ||
      input.approvedByUserId === input.requestedByUserId ||
      input.approverRole !== "founder")
  ) {
    return { allowed: false, code: "SENSITIVE_GRANT_NOT_APPROVED" };
  }

  return { allowed: true };
}

function isSensitiveScope(scope: CollaboratorScope): boolean {
  return (SENSITIVE_SCOPES as readonly CollaboratorScope[]).includes(scope);
}
