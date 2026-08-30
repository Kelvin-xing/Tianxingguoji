import assert from "node:assert/strict";
import test from "node:test";

import {
  PORTAL_CAPABILITY_SET_VERSION,
  PORTAL_FORBIDDEN_ACTIONS,
  PORTAL_GRANT_MAX_TTL_MS,
  PORTAL_MAX_ACTIVE_SESSIONS,
  PORTAL_SESSION_ABSOLUTE_TTL_MS,
  PORTAL_SESSION_IDLE_TTL_MS,
  PortalPolicyError,
  assertPortalGrantExpiry,
  assertPortalPolicyInput,
  type PortalEffectiveAccessInput,
  type PortalGrantActorFacts,
  type PortalGrantCommandAccessInput,
  type PortalWorkspaceSource,
} from "../../../modules/external-portal/domain/contract.ts";
import {
  buildPortalCaseReadV1,
  evaluatePortalEffectiveAccess,
  evaluatePortalGrantAuthorization,
  evaluatePortalGrantCommandAccess,
  evaluatePortalSessionCreation,
  mapPortalErrorToPublicResponse,
} from "../../../modules/external-portal/domain/policy.ts";

const ids = Object.freeze({
  organization: "11111111-1111-4111-8111-111111111111",
  otherOrganization: "22222222-2222-4222-8222-222222222222",
  case: "33333333-3333-4333-8333-333333333333",
  actor: "44444444-4444-4444-8444-444444444444",
  issuer: "55555555-5555-4555-8555-555555555555",
});
const nowMs = Date.UTC(2026, 7, 13, 10, 0, 0);

function actor(overrides: Partial<PortalGrantActorFacts> = {}): PortalGrantActorFacts {
  return {
    actorUserId: ids.actor,
    actorOrganizationId: ids.organization,
    caseOrganizationId: ids.organization,
    role: "founder",
    userActive: true,
    membershipActive: true,
    roleBindingActive: true,
    caseActive: true,
    currentPrimaryAdvisorUserId: ids.issuer,
    viewerRelationshipActive: true,
    ...overrides,
  };
}

function effective(overrides: Partial<PortalEffectiveAccessInput> = {}): PortalEffectiveAccessInput {
  return {
    nowMs,
    requestedOrganizationId: ids.organization,
    requestedCaseId: ids.case,
    capabilitySetVersion: PORTAL_CAPABILITY_SET_VERSION,
    grantOrganizationId: ids.organization,
    grantCaseId: ids.case,
    grantStatus: "active",
    grantExpiresAtMs: nowMs + 60_000,
    sessionStatus: "active",
    sessionIdleExpiresAtMs: nowMs + 30_000,
    sessionAbsoluteExpiresAtMs: nowMs + 60_000,
    viewerRelationshipActive: true,
    caseStatus: "active",
    issuerActive: true,
    issuerStillAuthorized: true,
    organizationActive: true,
    ...overrides,
  };
}

test("DP-01 permits only an active same-org Founder or current active Primary Advisor", () => {
  assert.deepEqual(evaluatePortalGrantAuthorization(actor()), { allowed: true });
  assert.deepEqual(evaluatePortalGrantAuthorization(actor({
    role: "advisor",
    actorUserId: ids.issuer,
  })), { allowed: true });

  const denials: readonly [Partial<PortalGrantActorFacts>, string][] = [
    [{ actorOrganizationId: ids.otherOrganization }, "PORTAL_SCOPE_DENIED"],
    [{ userActive: false }, "PORTAL_ACTOR_INACTIVE"],
    [{ membershipActive: false }, "PORTAL_ACTOR_INACTIVE"],
    [{ role: "advisor", actorUserId: ids.actor }, "PORTAL_SCOPE_DENIED"],
    [{ role: "contractor", actorUserId: ids.issuer }, "PORTAL_SCOPE_DENIED"],
    [{ caseActive: false }, "PORTAL_CASE_INACTIVE"],
    [{ viewerRelationshipActive: false }, "PORTAL_VIEWER_RELATIONSHIP_INACTIVE"],
  ];
  for (const [override, code] of denials) {
    assert.deepEqual(evaluatePortalGrantAuthorization(actor(override)), { allowed: false, code });
  }
});

test("DP-02 requires a safe expiry after now and no later than seven days or the case horizon", () => {
  assert.doesNotThrow(() => assertPortalGrantExpiry({
    nowMs,
    expiresAtMs: nowMs + PORTAL_GRANT_MAX_TTL_MS,
    caseAccessHorizonMs: nowMs + PORTAL_GRANT_MAX_TTL_MS,
  }));

  for (const expiresAtMs of [nowMs, nowMs - 1, nowMs + PORTAL_GRANT_MAX_TTL_MS + 1, NaN]) {
    assert.throws(
      () => assertPortalGrantExpiry({ nowMs, expiresAtMs, caseAccessHorizonMs: null }),
      (error: unknown) => error instanceof PortalPolicyError && error.code === "PORTAL_EXPIRY_INVALID",
    );
  }
  assert.throws(
    () => assertPortalGrantExpiry({ nowMs, expiresAtMs: nowMs + 2_000, caseAccessHorizonMs: nowMs + 1_999 }),
    (error: unknown) => error instanceof PortalPolicyError && error.code === "PORTAL_EXPIRY_INVALID",
  );
});

test("contract validation rejects unsafe timestamps, malformed IDs, and unknown enum values", () => {
  assert.throws(
    () => assertPortalPolicyInput({ ...effective(), requestedCaseId: "case-1" }),
    (error: unknown) => error instanceof PortalPolicyError && error.code === "PORTAL_INPUT_INVALID",
  );
  assert.throws(
    () => assertPortalPolicyInput({ ...effective(), sessionStatus: "unknown" as "active" }),
    (error: unknown) => error instanceof PortalPolicyError && error.code === "PORTAL_INPUT_INVALID",
  );
  assert.throws(
    () => assertPortalPolicyInput({ ...effective(), nowMs: Number.MAX_SAFE_INTEGER + 1 }),
    (error: unknown) => error instanceof PortalPolicyError && error.code === "PORTAL_INPUT_INVALID",
  );
});

test("DP-03 denies from current Release 1 facts without a Subscription input", () => {
  assert.deepEqual(evaluatePortalEffectiveAccess(effective()), { allowed: true });
  const denials: readonly [Partial<PortalEffectiveAccessInput>, string][] = [
    [{ grantStatus: "revoked" }, "PORTAL_GRANT_REVOKED"],
    [{ grantStatus: "expired" }, "PORTAL_GRANT_EXPIRED"],
    [{ grantExpiresAtMs: nowMs }, "PORTAL_GRANT_EXPIRED"],
    [{ sessionStatus: "revoked" }, "PORTAL_SESSION_INVALID"],
    [{ sessionIdleExpiresAtMs: nowMs }, "PORTAL_SESSION_EXPIRED"],
    [{ sessionAbsoluteExpiresAtMs: nowMs }, "PORTAL_SESSION_EXPIRED"],
    [{ viewerRelationshipActive: false }, "PORTAL_VIEWER_RELATIONSHIP_INACTIVE"],
    [{ caseStatus: "closed" }, "PORTAL_CASE_INACTIVE"],
    [{ caseStatus: "pending_delete" }, "PORTAL_CASE_INACTIVE"],
    [{ issuerActive: false }, "PORTAL_ISSUER_UNAUTHORIZED"],
    [{ issuerStillAuthorized: false }, "PORTAL_ISSUER_UNAUTHORIZED"],
    [{ organizationActive: false }, "PORTAL_ORGANIZATION_INACTIVE"],
    [{ requestedOrganizationId: ids.otherOrganization }, "PORTAL_SCOPE_DENIED"],
  ];
  for (const [override, code] of denials) {
    assert.deepEqual(evaluatePortalEffectiveAccess(effective(override)), { allowed: false, code });
  }
});

test("P5-BE-08 uses request-time capability union, permits paused and invalidates termination states", () => {
  const command: PortalGrantCommandAccessInput = {
    actor: { userId: ids.actor, organizationId: ids.organization, workspaceCapabilities: ["cases.workflow.manage"] },
    isCurrentPrimaryAdvisor: true,
    isFounder: false,
  };
  assert.deepEqual(evaluatePortalGrantCommandAccess(command), { allowed: true });
  assert.deepEqual(evaluatePortalGrantCommandAccess({ ...command, actor: { ...command.actor, workspaceCapabilities: [] } }), {
    allowed: false,
    code: "PORTAL_ISSUER_UNAUTHORIZED",
  });
  assert.deepEqual(evaluatePortalEffectiveAccess(effective({ caseStatus: "paused" })), { allowed: true });
  assert.deepEqual(evaluatePortalEffectiveAccess(effective({ caseStatus: "termination_pending" })), {
    allowed: false,
    code: "PORTAL_CASE_INACTIVE",
  });
});

test("DP-04 builds only the exact portal_case_read_v1 positive allowlist", () => {
  const source: PortalWorkspaceSource = {
    customerFacingStage: "Interview preparation",
    lastCustomerVisibleUpdateAt: "2026-08-13T09:00:00.000Z",
    schoolTargets: [{ name: "Example School", status: "shortlisted", customerVisible: true }, { name: "Hidden", status: "draft", customerVisible: false }],
    actionItems: [{ title: "Prepare photo", deadline: "2026-08-20", completed: false, customerVisible: true }, { title: "Internal check", deadline: null, completed: true, customerVisible: false }],
    messages: [{ body: "Interview confirmed", publishedAt: "2026-08-13T08:00:00.000Z", customerVisible: true }, { body: "Internal note", publishedAt: "2026-08-13T08:30:00.000Z", customerVisible: false }],
  };
  const projection = buildPortalCaseReadV1(source);
  assert.deepEqual(projection, {
    capabilitySetVersion: "portal_case_read_v1",
    customerFacingStage: "Interview preparation",
    lastCustomerVisibleUpdateAt: "2026-08-13T09:00:00.000Z",
    schoolTargets: [{ name: "Example School", status: "shortlisted" }],
    actionItems: [{ title: "Prepare photo", deadline: "2026-08-20", completed: false }],
    messages: [{ body: "Interview confirmed", publishedAt: "2026-08-13T08:00:00.000Z" }],
  });
  assert.deepEqual(PORTAL_FORBIDDEN_ACTIONS, ["document", "download", "export", "comment", "edit", "delete"]);
  assert.deepEqual(Object.keys(projection).sort(), [
    "actionItems", "capabilitySetVersion", "customerFacingStage",
    "lastCustomerVisibleUpdateAt", "messages", "schoolTargets",
  ]);
  assert.equal(Object.hasOwn(projection, "documents"), false);
});

test("DP-05 limits sessions and clips idle and absolute expiry to grant expiry", () => {
  assert.equal(PORTAL_MAX_ACTIVE_SESSIONS, 3);
  assert.deepEqual(evaluatePortalSessionCreation({
    nowMs,
    grantExpiresAtMs: nowMs + PORTAL_SESSION_ABSOLUTE_TTL_MS + 1,
    activeSessionCount: 2,
  }), {
    allowed: true,
    value: {
      idleExpiresAtMs: nowMs + PORTAL_SESSION_IDLE_TTL_MS,
      absoluteExpiresAtMs: nowMs + PORTAL_SESSION_ABSOLUTE_TTL_MS,
    },
  });
  assert.deepEqual(evaluatePortalSessionCreation({
    nowMs,
    grantExpiresAtMs: nowMs + 5 * 60_000,
    activeSessionCount: 0,
  }), {
    allowed: true,
    value: {
      idleExpiresAtMs: nowMs + 5 * 60_000,
      absoluteExpiresAtMs: nowMs + 5 * 60_000,
    },
  });
  assert.deepEqual(evaluatePortalSessionCreation({
    nowMs,
    grantExpiresAtMs: nowMs + 60_000,
    activeSessionCount: 3,
  }), { allowed: false, code: "PORTAL_SESSION_LIMIT_REACHED" });
});

test("public authentication maps every credential-state failure to one generic response", () => {
  const expected = { httpStatus: 401, code: "PORTAL_ACCESS_INVALID", message: "Portal access is invalid." } as const;
  for (const code of [
    "PORTAL_SECRET_INVALID",
    "PORTAL_GRANT_NOT_ACTIVE",
    "PORTAL_GRANT_EXPIRED",
    "PORTAL_GRANT_REVOKED",
    "PORTAL_SESSION_INVALID",
    "PORTAL_SESSION_EXPIRED",
    "PORTAL_VIEWER_RELATIONSHIP_INACTIVE",
  ] as const) {
    assert.deepEqual(mapPortalErrorToPublicResponse(code), expected, code);
  }
  for (const code of [
    "PORTAL_ISSUER_UNAUTHORIZED",
    "PORTAL_ORGANIZATION_INACTIVE",
  ] as const) {
    assert.deepEqual(mapPortalErrorToPublicResponse(code), {
      httpStatus: 403,
      code: "PORTAL_ACCESS_DENIED",
      message: "Portal access is denied.",
    }, code);
  }
  assert.deepEqual(mapPortalErrorToPublicResponse("PORTAL_RATE_LIMITED"), {
    httpStatus: 429,
    code: "PORTAL_RATE_LIMITED",
    message: "Portal access is temporarily unavailable.",
  });
});
