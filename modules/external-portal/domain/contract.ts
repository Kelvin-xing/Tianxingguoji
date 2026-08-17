export const PORTAL_CAPABILITY_SET_VERSION = "portal_case_read_v1" as const;
export const PORTAL_GRANT_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const PORTAL_MAX_ACTIVE_SESSIONS = 3;
export const PORTAL_SESSION_IDLE_TTL_MS = 15 * 60 * 1_000;
export const PORTAL_SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1_000;

export const PORTAL_FORBIDDEN_ACTIONS = Object.freeze([
  "document",
  "download",
  "export",
  "comment",
  "edit",
  "delete",
] as const);

export type PortalCapabilitySetVersion = typeof PORTAL_CAPABILITY_SET_VERSION;
export type PortalActorRole = "founder" | "admin" | "advisor" | "data_reviewer" | "contractor";
export type PortalGrantStatus = "active" | "pending_approval" | "revoked" | "expired";
export type PortalSessionStatus = "active" | "revoked" | "expired";
export type PortalCaseStatus = "active" | "closed" | "cancelled" | "pending_delete";
export type PortalSubscriptionStatus = "active" | "past_due";

export type PortalErrorCode =
  | "PORTAL_INPUT_INVALID"
  | "PORTAL_ACTOR_INACTIVE"
  | "PORTAL_EXPIRY_INVALID"
  | "PORTAL_CASE_INACTIVE"
  | "PORTAL_SECRET_INVALID"
  | "PORTAL_GRANT_EXPIRED"
  | "PORTAL_GRANT_REVOKED"
  | "PORTAL_GRANT_NOT_ACTIVE"
  | "PORTAL_SCOPE_DENIED"
  | "PORTAL_VIEWER_RELATIONSHIP_INACTIVE"
  | "PORTAL_ISSUER_UNAUTHORIZED"
  | "PORTAL_ORGANIZATION_INACTIVE"
  | "PORTAL_SESSION_INVALID"
  | "PORTAL_SESSION_EXPIRED"
  | "PORTAL_SESSION_LIMIT_REACHED"
  | "PORTAL_CAPABILITY_UNSUPPORTED"
  | "PORTAL_RATE_LIMITED"
  | "PORTAL_VERSION_CONFLICT"
  | "PORTAL_RUNTIME_UNAVAILABLE";

export type PortalPolicyDecision<T = undefined> =
  | (T extends undefined ? { readonly allowed: true } : { readonly allowed: true; readonly value: T })
  | { readonly allowed: false; readonly code: PortalErrorCode };

export class PortalPolicyError extends Error {
  readonly code: PortalErrorCode;

  constructor(code: PortalErrorCode) {
    super(`External portal policy rejected ${code}.`);
    this.name = "PortalPolicyError";
    this.code = code;
  }
}

export interface PortalGrantActorFacts {
  readonly actorUserId: string;
  readonly actorOrganizationId: string;
  readonly caseOrganizationId: string;
  readonly role: PortalActorRole;
  readonly userActive: boolean;
  readonly membershipActive: boolean;
  readonly roleBindingActive: boolean;
  readonly caseActive: boolean;
  readonly currentPrimaryAdvisorUserId: string | null;
  readonly viewerRelationshipActive: boolean;
}

export interface PortalGrantExpiryInput {
  readonly nowMs: number;
  readonly expiresAtMs: number;
  readonly caseAccessHorizonMs: number | null;
}

export interface PortalEffectiveAccessInput {
  readonly nowMs: number;
  readonly requestedOrganizationId: string;
  readonly requestedCaseId: string;
  readonly capabilitySetVersion: string;
  readonly grantOrganizationId: string;
  readonly grantCaseId: string;
  readonly grantStatus: PortalGrantStatus;
  readonly grantExpiresAtMs: number;
  readonly sessionStatus: PortalSessionStatus;
  readonly sessionIdleExpiresAtMs: number;
  readonly sessionAbsoluteExpiresAtMs: number;
  readonly viewerRelationshipActive: boolean;
  readonly caseStatus: PortalCaseStatus;
  readonly issuerActive: boolean;
  readonly issuerStillAuthorized: boolean;
  readonly organizationActive: boolean;
  readonly subscriptionStatus?: PortalSubscriptionStatus;
}

export interface PortalSessionCreationInput {
  readonly nowMs: number;
  readonly grantExpiresAtMs: number;
  readonly activeSessionCount: number;
}

export interface PortalSessionExpiry {
  readonly idleExpiresAtMs: number;
  readonly absoluteExpiresAtMs: number;
}

export interface PortalSchoolTargetSource {
  readonly name: string;
  readonly status: string;
  readonly customerVisible: boolean;
}

export interface PortalActionItemSource {
  readonly title: string;
  readonly deadline: string | null;
  readonly completed: boolean;
  readonly customerVisible: boolean;
}

export interface PortalMessageSource {
  readonly body: string;
  readonly publishedAt: string;
  readonly customerVisible: boolean;
}

export interface PortalWorkspaceSource {
  readonly caseNumber: string;
  readonly customerFacingStage: string;
  readonly lastCustomerVisibleUpdateAt: string;
  readonly schoolTargets: readonly PortalSchoolTargetSource[];
  readonly actionItems: readonly PortalActionItemSource[];
  readonly messages: readonly PortalMessageSource[];
}

export interface PortalCaseReadV1 {
  readonly capabilitySetVersion: PortalCapabilitySetVersion;
  readonly caseNumber: string;
  readonly customerFacingStage: string;
  readonly lastCustomerVisibleUpdateAt: string;
  readonly schoolTargets: readonly { readonly name: string; readonly status: string }[];
  readonly actionItems: readonly {
    readonly title: string;
    readonly deadline: string | null;
    readonly completed: boolean;
  }[];
  readonly messages: readonly { readonly body: string; readonly publishedAt: string }[];
}

export type PortalPublicErrorCode =
  | "PORTAL_ACCESS_INVALID"
  | "PORTAL_ACCESS_DENIED"
  | "PORTAL_RATE_LIMITED"
  | "PORTAL_REQUEST_INVALID"
  | "PORTAL_CONFLICT"
  | "PORTAL_UNAVAILABLE";

export interface PortalPublicErrorResponse {
  readonly httpStatus: 400 | 401 | 403 | 409 | 429 | 503;
  readonly code: PortalPublicErrorCode;
  readonly message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR_ROLES: readonly PortalActorRole[] = ["founder", "admin", "advisor", "data_reviewer", "contractor"];
const GRANT_STATUSES: readonly PortalGrantStatus[] = ["active", "pending_approval", "revoked", "expired"];
const SESSION_STATUSES: readonly PortalSessionStatus[] = ["active", "revoked", "expired"];
const CASE_STATUSES: readonly PortalCaseStatus[] = ["active", "closed", "cancelled", "pending_delete"];
const SUBSCRIPTION_STATUSES: readonly PortalSubscriptionStatus[] = ["active", "past_due"];

export function isPortalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isPortalTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function assertPortalGrantActorFacts(input: PortalGrantActorFacts): void {
  if (
    !isPortalUuid(input.actorUserId) ||
    !isPortalUuid(input.actorOrganizationId) ||
    !isPortalUuid(input.caseOrganizationId) ||
    !ACTOR_ROLES.includes(input.role) ||
    (input.currentPrimaryAdvisorUserId !== null && !isPortalUuid(input.currentPrimaryAdvisorUserId)) ||
    ![
      input.userActive,
      input.membershipActive,
      input.roleBindingActive,
      input.caseActive,
      input.viewerRelationshipActive,
    ].every((value) => typeof value === "boolean")
  ) {
    throw new PortalPolicyError("PORTAL_INPUT_INVALID");
  }
}

export function assertPortalGrantExpiry(input: PortalGrantExpiryInput): void {
  if (
    !isPortalTimestamp(input.nowMs) ||
    !isPortalTimestamp(input.expiresAtMs) ||
    (input.caseAccessHorizonMs !== null && !isPortalTimestamp(input.caseAccessHorizonMs)) ||
    input.expiresAtMs <= input.nowMs ||
    input.expiresAtMs - input.nowMs > PORTAL_GRANT_MAX_TTL_MS ||
    (input.caseAccessHorizonMs !== null && input.expiresAtMs > input.caseAccessHorizonMs)
  ) {
    throw new PortalPolicyError("PORTAL_EXPIRY_INVALID");
  }
}

export function assertPortalPolicyInput(input: PortalEffectiveAccessInput): void {
  if (
    !isPortalTimestamp(input.nowMs) ||
    !isPortalTimestamp(input.grantExpiresAtMs) ||
    !isPortalTimestamp(input.sessionIdleExpiresAtMs) ||
    !isPortalTimestamp(input.sessionAbsoluteExpiresAtMs) ||
    !isPortalUuid(input.requestedOrganizationId) ||
    !isPortalUuid(input.requestedCaseId) ||
    !isPortalUuid(input.grantOrganizationId) ||
    !isPortalUuid(input.grantCaseId) ||
    !GRANT_STATUSES.includes(input.grantStatus) ||
    !SESSION_STATUSES.includes(input.sessionStatus) ||
    !CASE_STATUSES.includes(input.caseStatus) ||
    (input.subscriptionStatus !== undefined && !SUBSCRIPTION_STATUSES.includes(input.subscriptionStatus)) ||
    ![
      input.viewerRelationshipActive,
      input.issuerActive,
      input.issuerStillAuthorized,
      input.organizationActive,
    ].every((value) => typeof value === "boolean") ||
    typeof input.capabilitySetVersion !== "string"
  ) {
    throw new PortalPolicyError("PORTAL_INPUT_INVALID");
  }
}

export function assertPortalSessionCreationInput(input: PortalSessionCreationInput): void {
  if (
    !isPortalTimestamp(input.nowMs) ||
    !isPortalTimestamp(input.grantExpiresAtMs) ||
    !Number.isSafeInteger(input.activeSessionCount) ||
    input.activeSessionCount < 0
  ) {
    throw new PortalPolicyError("PORTAL_INPUT_INVALID");
  }
}
