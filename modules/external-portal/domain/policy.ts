import {
  PORTAL_CAPABILITY_SET_VERSION,
  PORTAL_MAX_ACTIVE_SESSIONS,
  PORTAL_SESSION_ABSOLUTE_TTL_MS,
  PORTAL_SESSION_IDLE_TTL_MS,
  PortalPolicyError,
  assertPortalGrantActorFacts,
  assertPortalPolicyInput,
  assertPortalSessionCreationInput,
  type PortalCaseReadV1,
  type PortalEffectiveAccessInput,
  type PortalErrorCode,
  type PortalGrantActorFacts,
  type PortalPolicyDecision,
  type PortalPublicErrorResponse,
  type PortalSessionCreationInput,
  type PortalSessionExpiry,
  type PortalWorkspaceSource,
} from "./contract.ts";

export function evaluatePortalGrantAuthorization(
  input: PortalGrantActorFacts,
): PortalPolicyDecision {
  assertPortalGrantActorFacts(input);
  if (input.actorOrganizationId !== input.caseOrganizationId) {
    return { allowed: false, code: "PORTAL_SCOPE_DENIED" };
  }
  if (!input.userActive || !input.membershipActive || !input.roleBindingActive) {
    return { allowed: false, code: "PORTAL_ACTOR_INACTIVE" };
  }
  if (!input.caseActive) {
    return { allowed: false, code: "PORTAL_CASE_INACTIVE" };
  }
  if (!input.viewerRelationshipActive) {
    return { allowed: false, code: "PORTAL_VIEWER_RELATIONSHIP_INACTIVE" };
  }
  if (input.role === "founder") {
    return { allowed: true };
  }
  if (
    input.role === "advisor" &&
    input.currentPrimaryAdvisorUserId !== null &&
    input.actorUserId === input.currentPrimaryAdvisorUserId
  ) {
    return { allowed: true };
  }
  return { allowed: false, code: "PORTAL_SCOPE_DENIED" };
}

export function evaluatePortalEffectiveAccess(
  input: PortalEffectiveAccessInput,
): PortalPolicyDecision {
  assertPortalPolicyInput(input);
  if (input.capabilitySetVersion !== PORTAL_CAPABILITY_SET_VERSION) {
    return { allowed: false, code: "PORTAL_CAPABILITY_UNSUPPORTED" };
  }
  if (
    input.requestedOrganizationId !== input.grantOrganizationId ||
    input.requestedCaseId !== input.grantCaseId
  ) {
    return { allowed: false, code: "PORTAL_SCOPE_DENIED" };
  }
  if (input.grantStatus === "revoked") {
    return { allowed: false, code: "PORTAL_GRANT_REVOKED" };
  }
  if (input.grantStatus === "expired" || input.nowMs >= input.grantExpiresAtMs) {
    return { allowed: false, code: "PORTAL_GRANT_EXPIRED" };
  }
  if (input.grantStatus !== "active") {
    return { allowed: false, code: "PORTAL_GRANT_NOT_ACTIVE" };
  }
  if (input.sessionStatus === "revoked") {
    return { allowed: false, code: "PORTAL_SESSION_INVALID" };
  }
  if (
    input.sessionStatus !== "active" ||
    input.nowMs >= input.sessionIdleExpiresAtMs ||
    input.nowMs >= input.sessionAbsoluteExpiresAtMs
  ) {
    return { allowed: false, code: "PORTAL_SESSION_EXPIRED" };
  }
  if (!input.viewerRelationshipActive) {
    return { allowed: false, code: "PORTAL_VIEWER_RELATIONSHIP_INACTIVE" };
  }
  if (input.caseStatus !== "active") {
    return { allowed: false, code: "PORTAL_CASE_INACTIVE" };
  }
  if (!input.issuerActive || !input.issuerStillAuthorized) {
    return { allowed: false, code: "PORTAL_ISSUER_UNAUTHORIZED" };
  }
  if (!input.organizationActive) {
    return { allowed: false, code: "PORTAL_ORGANIZATION_INACTIVE" };
  }
  // DP-09 makes past_due informational; it is intentionally not an access predicate.
  return { allowed: true };
}

export function evaluatePortalSessionCreation(
  input: PortalSessionCreationInput,
): PortalPolicyDecision<PortalSessionExpiry> {
  assertPortalSessionCreationInput(input);
  if (input.grantExpiresAtMs <= input.nowMs) {
    return { allowed: false, code: "PORTAL_GRANT_EXPIRED" };
  }
  if (input.activeSessionCount >= PORTAL_MAX_ACTIVE_SESSIONS) {
    return { allowed: false, code: "PORTAL_SESSION_LIMIT_REACHED" };
  }
  return {
    allowed: true,
    value: {
      idleExpiresAtMs: Math.min(input.nowMs + PORTAL_SESSION_IDLE_TTL_MS, input.grantExpiresAtMs),
      absoluteExpiresAtMs: Math.min(input.nowMs + PORTAL_SESSION_ABSOLUTE_TTL_MS, input.grantExpiresAtMs),
    },
  };
}

function assertText(value: unknown, maximumLength: number): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
    throw new PortalPolicyError("PORTAL_INPUT_INVALID");
  }
}

function assertIsoTimestamp(value: unknown): asserts value is string {
  assertText(value, 64);
  if (!Number.isFinite(Date.parse(value))) {
    throw new PortalPolicyError("PORTAL_INPUT_INVALID");
  }
}

export function buildPortalCaseReadV1(source: PortalWorkspaceSource): PortalCaseReadV1 {
  assertText(source.caseNumber, 128);
  assertText(source.customerFacingStage, 256);
  assertIsoTimestamp(source.lastCustomerVisibleUpdateAt);
  if (!Array.isArray(source.schoolTargets) || !Array.isArray(source.actionItems) || !Array.isArray(source.messages)) {
    throw new PortalPolicyError("PORTAL_INPUT_INVALID");
  }

  for (const item of source.schoolTargets) {
    assertText(item.name, 512);
    assertText(item.status, 128);
    if (typeof item.customerVisible !== "boolean") throw new PortalPolicyError("PORTAL_INPUT_INVALID");
  }
  for (const item of source.actionItems) {
    assertText(item.title, 512);
    if (item.deadline !== null) assertText(item.deadline, 64);
    if (typeof item.completed !== "boolean" || typeof item.customerVisible !== "boolean") {
      throw new PortalPolicyError("PORTAL_INPUT_INVALID");
    }
  }
  for (const item of source.messages) {
    assertText(item.body, 10_000);
    assertIsoTimestamp(item.publishedAt);
    if (typeof item.customerVisible !== "boolean") throw new PortalPolicyError("PORTAL_INPUT_INVALID");
  }

  const schoolTargets = source.schoolTargets.filter((item) => item.customerVisible).map((item) => {
    return Object.freeze({ name: item.name, status: item.status });
  });
  const actionItems = source.actionItems.filter((item) => item.customerVisible).map((item) => {
    return Object.freeze({ title: item.title, deadline: item.deadline, completed: item.completed });
  });
  const messages = source.messages.filter((item) => item.customerVisible).map((item) => {
    return Object.freeze({ body: item.body, publishedAt: item.publishedAt });
  });

  return Object.freeze({
    capabilitySetVersion: PORTAL_CAPABILITY_SET_VERSION,
    caseNumber: source.caseNumber,
    customerFacingStage: source.customerFacingStage,
    lastCustomerVisibleUpdateAt: source.lastCustomerVisibleUpdateAt,
    schoolTargets: Object.freeze(schoolTargets),
    actionItems: Object.freeze(actionItems),
    messages: Object.freeze(messages),
  });
}

export function mapPortalErrorToPublicResponse(code: PortalErrorCode): PortalPublicErrorResponse {
  if ([
    "PORTAL_SECRET_INVALID",
    "PORTAL_GRANT_NOT_ACTIVE",
    "PORTAL_GRANT_EXPIRED",
    "PORTAL_GRANT_REVOKED",
    "PORTAL_SESSION_INVALID",
    "PORTAL_SESSION_EXPIRED",
  ].includes(code)) {
    return { httpStatus: 401, code: "PORTAL_ACCESS_INVALID", message: "Portal access is invalid." };
  }
  if (code === "PORTAL_RATE_LIMITED") {
    return { httpStatus: 429, code: "PORTAL_RATE_LIMITED", message: "Portal access is temporarily unavailable." };
  }
  if (code === "PORTAL_INPUT_INVALID" || code === "PORTAL_EXPIRY_INVALID") {
    return { httpStatus: 400, code: "PORTAL_REQUEST_INVALID", message: "Portal request is invalid." };
  }
  if (code === "PORTAL_VERSION_CONFLICT") {
    return { httpStatus: 409, code: "PORTAL_CONFLICT", message: "Portal access changed. Retry the request." };
  }
  if (code === "PORTAL_RUNTIME_UNAVAILABLE") {
    return { httpStatus: 503, code: "PORTAL_UNAVAILABLE", message: "Portal access is temporarily unavailable." };
  }
  return { httpStatus: 403, code: "PORTAL_ACCESS_DENIED", message: "Portal access is denied." };
}
