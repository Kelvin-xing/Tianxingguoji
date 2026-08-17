export const SESSION_POLICY = Object.freeze({
  idleTimeoutMs: 15 * 60 * 1_000,
  absoluteTimeoutMs: 8 * 60 * 60 * 1_000,
  sensitiveReauthenticationMaxAgeMs: 5 * 60 * 1_000,
  maximumActiveSessions: 3,
} as const);

export const INVITE_POLICY = Object.freeze({
  activationCredentialVersion: "v1",
  activationSecretBytes: 32,
  expiresInMs: 24 * 60 * 60 * 1_000,
  deliveryChannelPolicyId: "hk_dpa_reviewed_transactional",
} as const);

export type SessionSlot = 1 | 2 | 3;

export type SessionSlotDecision =
  | { readonly allowed: true; readonly slot: SessionSlot }
  | { readonly allowed: false; readonly code: "SESSION_LIMIT_REACHED" };

export type UserStatus = "invited" | "active" | "disabled";
export type SessionStatus = "active" | "revoked" | "expired";
export type InviteStatus = "created" | "redeemed" | "expired" | "revoked";
export type OrganizationStatus = "active" | "disabled";
export type MembershipStatus = "invited" | "active" | "disabled";

export type SessionDenialCode =
  | "USER_DISABLED"
  | "SESSION_NOT_ACTIVE"
  | "SESSION_VERSION_STALE"
  | "ORGANIZATION_INACTIVE"
  | "MEMBERSHIP_INACTIVE"
  | "SESSION_ABSOLUTE_EXPIRED"
  | "SESSION_IDLE_EXPIRED"
  | "SENSITIVE_REAUTH_REQUIRED";

export type SessionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: SessionDenialCode };

export interface SessionEvaluationInput {
  readonly nowMs: number;
  readonly sensitiveAction: boolean;
  readonly userStatus: UserStatus;
  readonly currentSessionVersion: number;
  readonly sessionStatus: SessionStatus;
  readonly capturedSessionVersion: number;
  readonly organizationStatus: OrganizationStatus;
  readonly membershipStatus: MembershipStatus;
  readonly idleExpiresAtMs: number;
  readonly absoluteExpiresAtMs: number;
  readonly reauthenticatedAtMs: number | null;
}

export function selectAvailableSessionSlot(
  activeSlots: readonly SessionSlot[],
): SessionSlotDecision {
  const occupiedSlots = new Set(activeSlots);

  for (const slot of [1, 2, 3] as const) {
    if (!occupiedSlots.has(slot)) {
      return { allowed: true, slot };
    }
  }

  return { allowed: false, code: "SESSION_LIMIT_REACHED" };
}

export function evaluateSession(input: SessionEvaluationInput): SessionDecision {
  if (input.userStatus !== "active") {
    return { allowed: false, code: "USER_DISABLED" };
  }
  if (input.sessionStatus !== "active") {
    return { allowed: false, code: "SESSION_NOT_ACTIVE" };
  }
  if (input.capturedSessionVersion !== input.currentSessionVersion) {
    return { allowed: false, code: "SESSION_VERSION_STALE" };
  }
  if (input.organizationStatus !== "active") {
    return { allowed: false, code: "ORGANIZATION_INACTIVE" };
  }
  if (input.membershipStatus !== "active") {
    return { allowed: false, code: "MEMBERSHIP_INACTIVE" };
  }
  if (input.nowMs >= input.absoluteExpiresAtMs) {
    return { allowed: false, code: "SESSION_ABSOLUTE_EXPIRED" };
  }
  if (input.nowMs >= input.idleExpiresAtMs) {
    return { allowed: false, code: "SESSION_IDLE_EXPIRED" };
  }
  if (
    input.sensitiveAction &&
    (input.reauthenticatedAtMs === null ||
      input.reauthenticatedAtMs > input.nowMs ||
      input.nowMs - input.reauthenticatedAtMs >
        SESSION_POLICY.sensitiveReauthenticationMaxAgeMs)
  ) {
    return { allowed: false, code: "SENSITIVE_REAUTH_REQUIRED" };
  }

  return { allowed: true };
}

export type InviteActivationDenialCode =
  | "INVITE_NOT_CREATED"
  | "INVITE_EXPIRED";

export type InviteActivationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: InviteActivationDenialCode };

export interface InviteActivationInput {
  readonly nowMs: number;
  readonly status: InviteStatus;
  readonly expiresAtMs: number;
}

export function evaluateInviteActivation(input: InviteActivationInput): InviteActivationDecision {
  if (input.status !== "created") {
    return { allowed: false, code: "INVITE_NOT_CREATED" };
  }
  if (input.nowMs >= input.expiresAtMs) {
    return { allowed: false, code: "INVITE_EXPIRED" };
  }
  return { allowed: true };
}
