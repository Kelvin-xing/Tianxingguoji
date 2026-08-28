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
export const ORGANIZATION_ROLES = Object.freeze([
  "founder",
  "admin",
  "advisor",
  "contractor",
] as const);

export type Release1OrganizationRole = (typeof ORGANIZATION_ROLES)[number];
/** Historical rows remain readable for migration compatibility, never active. */
export type OrganizationRole = Release1OrganizationRole | "data_reviewer";
export type RoleBindingStatus = "active" | "revoked";

export const WORKSPACE_CAPABILITIES = Object.freeze([
  "today.read",
  "cases.read",
  "cases.create",
  "cases.workflow.manage",
  "cases.assessments.read",
  "cases.assessments.manage",
  "cases.referral_sources.assign",
  "students.read",
  "students.create",
  "students.guardians.manage",
  "students.profiles.manage",
  "students.deletion.request",
  "students.deletion.review",
  "referral_sources.read",
  "referral_sources.manage",
  "schools.read",
  "tasks.read",
  "tasks.create",
  "tasks.transition",
  "documents.read",
  "documents.create",
  "documents.upload",
  "documents.download",
  "access.manage",
  "schools.manage",
  "crawler.manage",
] as const);

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

export const BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE: Readonly<
  Record<Release1OrganizationRole, readonly WorkspaceCapability[]>
> = Object.freeze({
  founder: Object.freeze([
    "today.read",
    "cases.read",
    "cases.create",
    "cases.workflow.manage",
    "cases.assessments.read",
    "cases.referral_sources.assign",
    "students.read",
    "students.create",
    "students.guardians.manage",
    "students.profiles.manage",
    "students.deletion.request",
    "students.deletion.review",
    "referral_sources.read",
    "referral_sources.manage",
    "schools.read",
    "tasks.read",
    "tasks.create",
    "tasks.transition",
    "documents.read",
    "documents.create",
    "documents.upload",
    "documents.download",
    "access.manage",
    "schools.manage",
    "crawler.manage",
  ] as const),
  admin: Object.freeze([
    "today.read",
    "access.manage",
    "schools.manage",
    "crawler.manage",
  ] as const),
  advisor: Object.freeze([
    "today.read",
    "cases.read",
    "cases.create",
    "cases.workflow.manage",
    "cases.assessments.read",
    "cases.assessments.manage",
    "cases.referral_sources.assign",
    "students.read",
    "students.create",
    "students.guardians.manage",
    "students.profiles.manage",
    "students.deletion.request",
    "referral_sources.read",
    "schools.read",
    "tasks.read",
    "tasks.create",
    "tasks.transition",
    "documents.read",
    "documents.create",
    "documents.upload",
    "documents.download",
  ] as const),
  contractor: Object.freeze(["tasks.read", "tasks.transition"] as const),
});

export function workspaceCapabilitiesForRole(
  role: OrganizationRole,
): readonly WorkspaceCapability[] {
  return role === "data_reviewer" ? EMPTY_CAPABILITIES : BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE[role];
}

export function isOrganizationRole(value: unknown): value is Release1OrganizationRole {
  return typeof value === "string" && (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

const EMPTY_CAPABILITIES = Object.freeze([] as const);

export const ROLE_COMPATIBILITY = Object.freeze({
  founder: Object.freeze(["admin", "advisor"] as const),
  admin: Object.freeze(["founder", "advisor"] as const),
  advisor: Object.freeze(["founder", "admin"] as const),
  contractor: Object.freeze([] as const),
} as const);

export type EmploymentType = "FULL_TIME" | "PART_TIME";

export interface MemberAccessVersionRole {
  readonly bindingId: string;
  readonly recordVersion: number;
}

export function buildMemberAccessVersion(input: Readonly<{
  readonly membershipRecordVersion: number;
  readonly profileRecordVersion: number | null;
  readonly roles: readonly MemberAccessVersionRole[];
}>): string {
  const roles = [...input.roles]
    .sort((left, right) => left.bindingId.localeCompare(right.bindingId))
    .map((role) => `${role.bindingId}@${role.recordVersion}`)
    .join(",") || "none";
  return `v1:${input.membershipRecordVersion}:${input.profileRecordVersion ?? 0}:${roles}`;
}

export type RoleAssignmentDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code:
        | "ROLE_UNKNOWN"
        | "ROLE_CONFLICT"
        | "ROLE_NOT_COMPATIBLE_WITH_EMPLOYMENT_TYPE"
        | "LAST_FOUNDER_REQUIRED";
    };

export function evaluateRoleAssignment(input: Readonly<{
  readonly existingRoles: readonly OrganizationRole[];
  readonly candidateRole: unknown;
  readonly employmentType: EmploymentType;
  readonly removingRole?: OrganizationRole;
}>): RoleAssignmentDecision {
  if (!isOrganizationRole(input.candidateRole)) {
    return { allowed: false, code: "ROLE_UNKNOWN" };
  }
  const existing = new Set(input.existingRoles.filter(isOrganizationRole));
  const projected = new Set(existing);
  if (input.removingRole !== undefined && isOrganizationRole(input.removingRole)) {
    projected.delete(input.removingRole);
  }
  if (input.removingRole !== input.candidateRole) projected.add(input.candidateRole);
  if (projected.has("contractor") && projected.size > 1) {
    return { allowed: false, code: "ROLE_CONFLICT" };
  }
  if (
    (input.employmentType === "FULL_TIME" && input.candidateRole === "contractor") ||
    (input.employmentType === "PART_TIME" &&
      (input.candidateRole === "founder" || input.candidateRole === "advisor"))
  ) {
    return { allowed: false, code: "ROLE_NOT_COMPATIBLE_WITH_EMPLOYMENT_TYPE" };
  }
  if (
    input.removingRole === "founder" &&
    existing.has("founder") &&
    !projected.has("founder")
  ) {
    return { allowed: false, code: "LAST_FOUNDER_REQUIRED" };
  }
  return { allowed: true };
}

export function capabilityIncludes(
  granted: CollaboratorCapability,
  requested: CollaboratorCapability,
): boolean {
  const rank: Readonly<Record<CollaboratorCapability, number>> = {
    view: 1,
    comment: 2,
    edit: 3,
  };
  return rank[granted] >= rank[requested];
}

export function isWorkspaceCapability(value: unknown): value is WorkspaceCapability {
  return typeof value === "string" && (WORKSPACE_CAPABILITIES as readonly string[]).includes(value);
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
  if (!capabilityIncludes(input.grantCapability, input.requestedCapability)) {
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
