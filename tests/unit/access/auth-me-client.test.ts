import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import { getWorkspaceAccessSnapshot } from "../../../modules/access/client.ts";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";

test("reads only the v1 auth endpoint without caching or role-derived normalization", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let requestCount = 0;
  const controller = new AbortController();

  globalThis.fetch = async (input, init) => {
    requestCount += 1;
    assert.equal(input, "/api/v1/auth/me");
    assert.equal(init?.method, "GET");
    assert.equal(init?.signal instanceof AbortSignal, true);
    return apiResponse(snapshot({ role: "contractor", capabilities: ["cases.read"] }));
  };

  const first = await getWorkspaceAccessSnapshot(controller.signal);
  const second = await getWorkspaceAccessSnapshot(controller.signal);
  assert.equal(requestCount, 2);
  assert.equal(first.nickname, null);
  assert.equal(first.role, "contractor");
  assert.deepEqual(first.capabilities, ["cases.read"]);
  assert.deepEqual(second, first);
});

test("accepts an empty capability snapshot and treats policy version as opaque", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => apiResponse(snapshot({
    policy_version: "policy/2026.08:revision-2",
    capabilities: [],
  }));

  const result = await getWorkspaceAccessSnapshot();
  assert.equal(result.policy_version, "policy/2026.08:revision-2");
  assert.deepEqual(result.capabilities, []);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.capabilities), true);
});

test("fails closed for malformed identity, role, policy version, and DTO shape", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const malformed = [
    snapshot({ user_id: "not-a-uuid" }),
    snapshot({ organization_id: "not-a-uuid" }),
    snapshot({ role: "owner" }),
    snapshot({ policy_version: "" }),
    snapshot({ policy_version: "unsafe policy" }),
    { ...snapshot(), policy_version: undefined },
    { ...snapshot(), unexpected: true },
  ];

  for (const value of malformed) {
    globalThis.fetch = async () => apiResponse(value);
    await rejectsMalformed(getWorkspaceAccessSnapshot());
  }
});

test("fails closed for unknown and duplicate capabilities", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  for (const capabilities of [
    ["cases.write"],
    ["cases.read", "cases.read"],
    "cases.read",
  ]) {
    globalThis.fetch = async () => apiResponse(snapshot({ capabilities }));
    await rejectsMalformed(getWorkspaceAccessSnapshot());
  }
});

function snapshot(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    user_id: USER_ID,
    organization_id: ORGANIZATION_ID,
    nickname: null,
    role: "advisor",
    policy_version: "release1-bootstrap-v1",
    capabilities: ["today.read", "cases.read"],
    ...overrides,
  };
}

function apiResponse(data: unknown): Response {
  return Response.json(
    { api_version: "v1", request_id: "auth-me-test", data },
    { headers: { "x-request-id": "auth-me-test" } },
  );
}

async function rejectsMalformed(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof ApiClientError &&
      error.code === "MALFORMED_RESPONSE" &&
      error.retryable === false,
  );
}
