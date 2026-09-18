import type { TrialPrincipal } from "./trial-policy.ts";
import {
  BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE,
  ORGANIZATION_ROLES,
  WORKSPACE_CAPABILITIES,
  isOrganizationRole,
  isWorkspaceCapability,
  workspaceCapabilitiesForRole,
  type OrganizationRole,
  type Release1OrganizationRole,
  type WorkspaceCapability,
} from "./contract.ts";

export const AUTHORIZATION_DENIAL_CODES = Object.freeze([
  "ACCESS_ROLE_UNKNOWN",
  "ACCESS_CAPABILITY_UNKNOWN",
  "ACCESS_CAPABILITY_DENIED",
  "ACCESS_POLICY_UNAVAILABLE",
] as const);

export const ACCESS_POLICY_MANIFEST_VERSION = "access-policy-manifest/v1" as const;
export const BOOTSTRAP_ACCESS_POLICY_VERSION = "release1-bootstrap-v16" as const;

export type AuthorizationDenialCode = (typeof AUTHORIZATION_DENIAL_CODES)[number];

export interface AuthorizationResource {
  readonly type: string;
  readonly id: string;
}

export interface AccessContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly roles: readonly Release1OrganizationRole[];
  readonly workspaceCapabilities: readonly WorkspaceCapability[];
  readonly authorizationVersion: string;
  readonly trialPrincipal?: TrialPrincipal;
}

/** Minimal request actor accepted by business services during the legacy transition. */
export interface RequestAccessActor {
  readonly userId: string;
  readonly organizationId: string;
  readonly roles?: readonly OrganizationRole[];
  readonly workspaceCapabilities?: readonly WorkspaceCapability[];
  readonly trialPrincipal?: TrialPrincipal;
}

export function hasRequestCapability(
  actor: RequestAccessActor,
  capability: WorkspaceCapability,
): boolean {
  return actor.trialPrincipal
    ? trialWorkspaceCapabilities(actor.trialPrincipal).includes(capability)
    : actor.workspaceCapabilities?.includes(capability) === true;
}

/**
 * Chooses a compatibility label only after the capability union authorized the
 * request. Repositories use it to re-check a concrete active RoleBinding; it is
 * never the authorization decision.
 */
export function compatibilityRoleForRepository(
  actor: RequestAccessActor,
  capability: WorkspaceCapability,
): Release1OrganizationRole | null {
  if (!hasRequestCapability(actor, capability)) return null;
  if (actor.trialPrincipal) return actor.trialPrincipal.active ? actor.trialPrincipal.level : null;
  for (const role of ["founder", "advisor", "admin", "contractor"] as const) {
    if (actor.roles?.includes(role) && workspaceCapabilitiesForRole(role).includes(capability)) {
      return role;
    }
  }
  return null;
}

export function trialWorkspaceCapabilities(principal: TrialPrincipal): readonly WorkspaceCapability[] {
  if (!principal.active) return Object.freeze([]);
  return principal.level === "founder" ? WORKSPACE_CAPABILITIES : workspaceCapabilitiesForRole(principal.level);
}

export interface AccessResolutionFacts {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly roles: readonly Release1OrganizationRole[];
  readonly membershipRecordVersion: number;
  readonly roleBindingRecordVersions: readonly number[];
  readonly trialPrincipal?: TrialPrincipal;
}

export function mergeWorkspaceCapabilities(
  roles: readonly OrganizationRole[],
): readonly WorkspaceCapability[] {
  const capabilities = new Set<WorkspaceCapability>();
  for (const role of roles) {
    if (!isOrganizationRole(role)) continue;
    for (const capability of workspaceCapabilitiesForRole(role)) capabilities.add(capability);
  }
  return Object.freeze([...capabilities].sort());
}

export function buildAccessContext(facts: AccessResolutionFacts): AccessContext {
  const candidate = facts.trialPrincipal;
  const consistent = candidate && candidate.userId === facts.userId && candidate.organizationId === facts.organizationId
    && facts.roles.length === 1 && facts.roles[0] === candidate.level;
  const trial = candidate ? (consistent ? candidate : { ...candidate, active: false }) : undefined;
  const orphanTrialRole = !trial && facts.roles.some((role) => ["l1", "l2", "l3"].includes(role));
  const roles = Object.freeze(trial ? (trial.active ? [trial.level] : []) : orphanTrialRole ? [] : [...new Set(facts.roles)].sort());
  const versions = [facts.membershipRecordVersion, ...facts.roleBindingRecordVersions].join(",");
  return Object.freeze({
    userId: facts.userId,
    organizationId: facts.organizationId,
    membershipId: facts.membershipId,
    roles,
    workspaceCapabilities: trial ? trialWorkspaceCapabilities(trial) : mergeWorkspaceCapabilities(roles),
    authorizationVersion: `${facts.membershipId}:${versions}${trial ? `:trial:${trial.recordVersion}` : ""}`,
    ...(trial ? { trialPrincipal: trial } : {}),
  });
}

export interface AuthorizationRequest {
  readonly capability: WorkspaceCapability;
  readonly resource?: AuthorizationResource;
}

export type AuthorizationDecision =
  | { readonly allowed: true; readonly policyVersion: string }
  | { readonly allowed: false; readonly code: AuthorizationDenialCode };

export interface AccessPolicyRoleRule {
  readonly role: OrganizationRole;
  readonly allow: readonly WorkspaceCapability[];
}

export interface AccessPolicyManifest {
  readonly manifestVersion: typeof ACCESS_POLICY_MANIFEST_VERSION;
  readonly policyVersion: string;
  readonly defaultDecision: "deny";
  readonly rules: readonly AccessPolicyRoleRule[];
}

export const BOOTSTRAP_ACCESS_POLICY_MANIFEST: AccessPolicyManifest = Object.freeze({
  manifestVersion: ACCESS_POLICY_MANIFEST_VERSION,
  policyVersion: BOOTSTRAP_ACCESS_POLICY_VERSION,
  defaultDecision: "deny",
  rules: Object.freeze(ORGANIZATION_ROLES.map((role) => Object.freeze({
    role,
    allow: BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE[role],
  }))),
});

export const BOOTSTRAP_ACCESS_POLICY_MANIFEST_JSON = JSON.stringify(
  BOOTSTRAP_ACCESS_POLICY_MANIFEST,
);

export function evaluateBootstrapAuthorization(
  role: unknown,
  request: Readonly<{ readonly capability: unknown; readonly resource?: AuthorizationResource }>,
): AuthorizationDecision {
  if (!isOrganizationRole(role)) {
    return Object.freeze({ allowed: false, code: "ACCESS_ROLE_UNKNOWN" });
  }
  if (!isWorkspaceCapability(request.capability)) {
    return Object.freeze({ allowed: false, code: "ACCESS_CAPABILITY_UNKNOWN" });
  }
  const rule = BOOTSTRAP_ACCESS_POLICY_MANIFEST.rules.find((candidate) => candidate.role === role);
  if (!rule || !rule.allow.includes(request.capability)) {
    return Object.freeze({ allowed: false, code: "ACCESS_CAPABILITY_DENIED" });
  }
  return Object.freeze({
    allowed: true,
    policyVersion: BOOTSTRAP_ACCESS_POLICY_MANIFEST.policyVersion,
  });
}
