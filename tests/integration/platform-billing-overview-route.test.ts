import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlatformBillingOverviewGetHandler,
  PlatformBillingOverviewRuntimeUnavailable,
  type PlatformBillingOverview,
} from "../../app/api/v1/platform/billing/overview/handler.ts";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

const overview: PlatformBillingOverview = {
  generatedAt: "2026-08-13T08:00:00.000Z",
  organizations: [
    {
      organizationId: "22222222-2222-4222-8222-222222222222",
      organizationName: "North District Operations",
      lifecycleStatus: "active",
      subscription: { status: "past_due", aggregateException: "past_due" },
      advancingCaseSnapshot: {
        billingMonth: "2026-08",
        sourceCutoffAt: "2026-08-31T15:59:59.999Z",
        countPolicyVersion: "advancing_case_count_v1",
        advancingCaseCount: 12,
        revision: 2,
        generatedAt: "2026-09-01T00:05:00.000Z",
      },
      contract: { reference: "contract-ref-2026-a", status: "active" },
    },
  ],
};

function request() {
  return new Request("https://example.test/api/v1/platform/billing/overview");
}

test("returns only aggregate overview facts to every approved active platform view role", async () => {
  for (const role of ["platform_admin", "platform_finance", "platform_billing_approver"] as const) {
    const handler = createPlatformBillingOverviewGetHandler({
      authenticatePlatformOperator: async () => ({ actorId: ACTOR_ID, role, status: "active" }),
      getOverviewReader: () => ({ readOverview: async () => overview }),
    });
    const response = await handler(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.deepEqual(await response.json(), overview);
  }

  const serialized = JSON.stringify(overview).toLowerCase();
  for (const forbidden of ["student", "guardian", "caseid", "note", "document", "contact", "email", "phone", "amount", "value", "currency", "invoice", "export"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("fails closed for missing, disabled, tenant-only, and malformed actors", async () => {
  const cases = [
    { actor: null, status: 401, code: "PLATFORM_AUTHENTICATION_REQUIRED" },
    { actor: { actorId: ACTOR_ID, role: "platform_admin", status: "disabled" }, status: 403, code: "PLATFORM_BILLING_OVERVIEW_FORBIDDEN" },
    { actor: { actorId: ACTOR_ID, role: "tenant_founder", status: "active" }, status: 403, code: "PLATFORM_BILLING_OVERVIEW_FORBIDDEN" },
    { actor: { actorId: "not-a-platform-actor", role: "platform_finance", status: "active" }, status: 403, code: "PLATFORM_BILLING_OVERVIEW_FORBIDDEN" },
  ] as const;

  for (const item of cases) {
    const handler = createPlatformBillingOverviewGetHandler({
      authenticatePlatformOperator: async () => item.actor,
      getOverviewReader: () => ({ readOverview: async () => overview }),
    });
    const response = await handler(request());
    assert.equal(response.status, item.status);
    assert.deepEqual(await response.json(), { error: { code: item.code } });
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("maps absent read runtime to a typed 503 and supports an empty overview", async () => {
  const actor = { actorId: ACTOR_ID, role: "platform_admin", status: "active" } as const;
  const unavailable = createPlatformBillingOverviewGetHandler({
    authenticatePlatformOperator: async () => actor,
    getOverviewReader: () => { throw new PlatformBillingOverviewRuntimeUnavailable(); },
  });
  const unavailableResponse = await unavailable(request());
  assert.equal(unavailableResponse.status, 503);
  assert.deepEqual(await unavailableResponse.json(), { error: { code: "BILLING_RUNTIME_UNAVAILABLE" } });

  const emptyOverview = { generatedAt: overview.generatedAt, organizations: [] };
  const empty = createPlatformBillingOverviewGetHandler({
    authenticatePlatformOperator: async () => actor,
    getOverviewReader: () => ({ readOverview: async () => emptyOverview }),
  });
  const emptyResponse = await empty(request());
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual(await emptyResponse.json(), emptyOverview);
});

test("rebuilds an allowlisted DTO instead of forwarding reader extras", async () => {
  const actor = { actorId: ACTOR_ID, role: "platform_admin", status: "active" } as const;
  const unsafeReaderResult = {
    ...overview,
    internalAudit: "must-not-leak",
    organizations: overview.organizations.map((organization) => ({
      ...organization,
      studentName: "must-not-leak",
      contract: { ...organization.contract!, contractValueMinor: 999_999 },
    })),
  };
  const handler = createPlatformBillingOverviewGetHandler({
    authenticatePlatformOperator: async () => actor,
    getOverviewReader: () => ({ readOverview: async () => unsafeReaderResult }),
  });

  const response = await handler(request());
  const body = JSON.stringify(await response.json());
  assert.equal(body.includes("must-not-leak"), false);
  assert.equal(body.includes("contractValueMinor"), false);
  assert.equal(body.includes("internalAudit"), false);
});
