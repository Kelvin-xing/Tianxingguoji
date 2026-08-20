import assert from "node:assert/strict";
import test from "node:test";

import {
  createPortalGrantCollectionHandlers,
  type PortalGrantRouteDependencies,
} from "../../app/api/v1/cases/[caseId]/portal-grants/handler.ts";
import { createPortalGrantItemHandlers } from "../../app/api/v1/cases/[caseId]/portal-grants/[grantId]/handler.ts";
import { createPortalGrantRotateHandler } from "../../app/api/v1/cases/[caseId]/portal-grants/[grantId]/rotate/handler.ts";
import {
  PORTAL_SESSION_COOKIE_NAME,
  createPortalSessionHandlers,
} from "../../app/api/v1/portal/sessions/handler.ts";
import { createPortalWorkspaceGetHandler } from "../../app/api/v1/portal/workspace/handler.ts";
import { PortalPolicyError } from "../../modules/external-portal/domain/contract.ts";
import { PortalRuntimeUnavailable } from "../../modules/external-portal/infrastructure/runtime.ts";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const GRANT_ID = "22222222-2222-4222-8222-222222222222";
const VIEWER_ID = "33333333-3333-4333-8333-333333333333";
const context = { params: Promise.resolve({ caseId: CASE_ID }) };
const itemContext = { params: Promise.resolve({ caseId: CASE_ID, grantId: GRANT_ID }) };

function internalDependencies(overrides: Partial<PortalGrantRouteDependencies> = {}): PortalGrantRouteDependencies {
  return {
    authenticateInternal: async () => ({ actorUserId: "44444444-4444-4444-8444-444444444444" }),
    listGrants: async () => [],
    issueGrant: async (input) => ({
      grantId: GRANT_ID,
      rawSecretOnce: "portal-secret-once",
      fingerprint: "ABC123",
      expiresAt: input.expiresAt,
      status: "active",
      recordVersion: 1,
    }),
    revokeGrant: async () => ({ grantId: GRANT_ID, status: "revoked", recordVersion: 2 }),
    rotateGrant: async (input) => ({
      grantId: "55555555-5555-4555-8555-555555555555",
      rawSecretOnce: "rotated-secret-once",
      fingerprint: "DEF456",
      expiresAt: input.expiresAt,
      status: "active",
      recordVersion: 1,
    }),
    ...overrides,
  };
}

test("internal grant routes require idempotency and expected versions and expose raw secrets once", async () => {
  let issueInput: unknown;
  const collection = createPortalGrantCollectionHandlers(internalDependencies({
    issueGrant: async (input) => {
      issueInput = input;
      return internalDependencies().issueGrant(input);
    },
  }));
  const issue = await collection.POST(new Request(`https://app.test/api/v1/cases/${CASE_ID}/portal-grants`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "issue-1", origin: "https://app.test" },
    body: JSON.stringify({ portal_viewer_id: VIEWER_ID, expires_at: "2026-08-16T10:00:00.000Z" }),
  }), context);
  assert.equal(issue.status, 201);
  assert.equal((await issue.json() as { raw_secret_once: string }).raw_secret_once, "portal-secret-once");
  assert.deepEqual(issueInput, {
    actorUserId: "44444444-4444-4444-8444-444444444444",
    caseId: CASE_ID,
    portalViewerId: VIEWER_ID,
    expiresAt: "2026-08-16T10:00:00.000Z",
    idempotencyKey: "issue-1",
  });

  const missingKey = await collection.POST(new Request(`https://app.test/api/v1/cases/${CASE_ID}/portal-grants`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://app.test" }, body: "{}",
  }), context);
  assert.equal(missingKey.status, 400);

  let revokedVersion = 0;
  const item = createPortalGrantItemHandlers(internalDependencies({
    revokeGrant: async (input) => {
      revokedVersion = input.expectedVersion;
      return { grantId: GRANT_ID, status: "revoked", recordVersion: 8 };
    },
  }));
  const revoke = await item.DELETE(new Request(`https://app.test/api/v1/cases/${CASE_ID}/portal-grants/${GRANT_ID}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", "idempotency-key": "revoke-1", origin: "https://app.test" },
    body: JSON.stringify({ expected_version: 7, reason_code: "manual_revoke" }),
  }), itemContext);
  assert.equal(revoke.status, 200);
  assert.equal(revokedVersion, 7);

  const rotate = createPortalGrantRotateHandler(internalDependencies());
  const rotated = await rotate(new Request(`https://app.test/api/v1/cases/${CASE_ID}/portal-grants/${GRANT_ID}/rotate`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "rotate-1", origin: "https://app.test" },
    body: JSON.stringify({ expected_version: 7, expires_at: "2026-08-17T10:00:00.000Z" }),
  }), itemContext);
  assert.equal(rotated.status, 201);
  assert.equal((await rotated.json() as { raw_secret_once: string }).raw_secret_once, "rotated-secret-once");
});

test("internal routes fail closed with stable authentication, authorization, conflict and runtime responses", async () => {
  const unauthenticated = createPortalGrantCollectionHandlers(internalDependencies({ authenticateInternal: async () => null }));
  assert.equal((await unauthenticated.GET(new Request("https://app.test"), context)).status, 401);

  const forbidden = createPortalGrantCollectionHandlers(internalDependencies({
    listGrants: async () => { throw new PortalPolicyError("PORTAL_SCOPE_DENIED"); },
  }));
  assert.equal((await forbidden.GET(new Request("https://app.test"), context)).status, 403);

  const unavailable = createPortalGrantCollectionHandlers(internalDependencies({
    listGrants: async () => { throw new PortalRuntimeUnavailable(); },
  }));
  const response = await unavailable.GET(new Request("https://app.test"), context);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: "PORTAL_RUNTIME_UNAVAILABLE" } });
});

test("portal redemption uses one generic 401 and sets a separate secure session cookie", async () => {
  for (const code of ["PORTAL_SECRET_INVALID", "PORTAL_GRANT_EXPIRED", "PORTAL_GRANT_REVOKED", "PORTAL_SESSION_LIMIT_REACHED"] as const) {
    const handlers = createPortalSessionHandlers({
      redeem: async () => { throw new PortalPolicyError(code); },
      revokeSession: async () => undefined,
    });
    const response = await handlers.POST(new Request("https://app.test/api/v1/portal/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ access_key: "credential-shape-test-key" }),
    }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: "PORTAL_ACCESS_INVALID" } });
  }

  const handlers = createPortalSessionHandlers({
    redeem: async () => ({ sessionSecret: "opaque-session", absoluteExpiresAt: "2026-08-13T18:00:00.000Z" }),
    revokeSession: async () => undefined,
  });
  const response = await handlers.POST(new Request("https://app.test/api/v1/portal/sessions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ access_key: "valid-credential-shape-key" }),
  }));
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`^${PORTAL_SESSION_COOKIE_NAME}=opaque-session`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\//i);
  assert.equal(cookie.includes("tx_session="), false);
});

test("internal grant mutations reject missing and cross-origin requests before authentication", async () => {
  let authenticationAttempts = 0;
  const dependencies = internalDependencies({
    authenticateInternal: async () => {
      authenticationAttempts += 1;
      return { actorUserId: "44444444-4444-4444-8444-444444444444" };
    },
  });
  const collection = createPortalGrantCollectionHandlers(dependencies);
  const item = createPortalGrantItemHandlers(dependencies);
  const rotate = createPortalGrantRotateHandler(dependencies);

  const requests = [
    collection.POST(new Request(`https://app.test/api/v1/cases/${CASE_ID}/portal-grants`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "missing-origin" },
      body: JSON.stringify({ portal_viewer_id: VIEWER_ID, expires_at: "2026-08-16T10:00:00.000Z" }),
    }), context),
    item.DELETE(new Request(`https://app.test/api/v1/cases/${CASE_ID}/portal-grants/${GRANT_ID}`, {
      method: "DELETE", headers: { "content-type": "application/json", "idempotency-key": "wrong-origin", origin: "https://evil.test" },
      body: JSON.stringify({ expected_version: 1, reason_code: "manual_revoke" }),
    }), itemContext),
    rotate(new Request(`https://app.test/api/v1/cases/${CASE_ID}/portal-grants/${GRANT_ID}/rotate`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "wrong-origin", origin: "https://evil.test" },
      body: JSON.stringify({ expected_version: 1, expires_at: "2026-08-16T10:00:00.000Z" }),
    }), itemContext),
  ];

  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: { code: "PORTAL_ACCESS_DENIED" } });
  }
  assert.equal(authenticationAttempts, 0);
});

test("logout clears the portal cookie when server-side revocation is unavailable", async () => {
  const handlers = createPortalSessionHandlers({
    redeem: async () => { throw new Error("not used"); },
    revokeSession: async () => { throw new PortalRuntimeUnavailable(); },
  });
  const response = await handlers.DELETE(new Request("https://app.test/api/v1/portal/sessions", {
    method: "DELETE",
    headers: { cookie: `${PORTAL_SESSION_COOKIE_NAME}=opaque-session` },
  }));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: "PORTAL_RUNTIME_UNAVAILABLE" } });
  assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`^${PORTAL_SESSION_COOKIE_NAME}=;`));
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/i);
});

test("workspace is no-store, reconstructs the allowlist, and rejects missing sessions generically", async () => {
  const handler = createPortalWorkspaceGetHandler({
    getSessionSecret: async () => "opaque-session",
    readWorkspace: async () => ({
      capabilitySetVersion: "portal_case_read_v1",
      caseNumber: "CASE-001",
      customerFacingStage: "Documents in review",
      lastCustomerVisibleUpdateAt: "2026-08-13T10:00:00.000Z",
      schoolTargets: [{ name: "School A", status: "submitted" }],
      actionItems: [{ title: "Upload consent", deadline: null, completed: false }],
      messages: [{ body: "Review started", publishedAt: "2026-08-13T09:00:00.000Z" }],
      internalNotes: "must-not-leak",
      documents: ["must-not-leak"],
    }),
  });
  const response = await handler(new Request("https://app.test/api/v1/portal/workspace"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  const serialized = JSON.stringify(await response.json());
  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal(serialized.includes("documents"), false);

  const missing = createPortalWorkspaceGetHandler({ getSessionSecret: async () => null, readWorkspace: async () => { throw new Error(); } });
  const denied = await missing(new Request("https://app.test/api/v1/portal/workspace"));
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: { code: "PORTAL_ACCESS_INVALID" } });
});
