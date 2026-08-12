import assert from "node:assert/strict";
import test from "node:test";

import {
  PortalBillingCompositionUnavailable,
  composePortalBillingProductionRuntime,
  loadPortalBillingProductionConfig,
} from "../../lib/runtime/portal-billing-production.ts";
import { createPortalRuntime } from "../../modules/external-portal/runtime.ts";
import { createPlatformBillingRuntime } from "../../modules/platform-billing/runtime.ts";

const HK_HOST = "tianxing.cluster-abc123.ap-east-1.rds.amazonaws.com";
const UUID = "11111111-1111-4111-8111-111111111111";

function validEnvironment(): Record<string, string> {
  return {
    AWS_REGION: "ap-east-1",
    PORTAL_AUTH_DATABASE_HOST: HK_HOST,
    PORTAL_AUTH_DATABASE_NAME: "tianxing",
    PORTAL_AUTH_DATABASE_PORT: "5432",
    PORTAL_AUTH_DATABASE_USER: "portal_auth",
    PORTAL_TENANT_DATABASE_HOST: HK_HOST,
    PORTAL_TENANT_DATABASE_NAME: "tianxing",
    PORTAL_TENANT_DATABASE_PORT: "5432",
    PORTAL_TENANT_DATABASE_USER: "tianxing_app",
    PLATFORM_BILLING_DATABASE_HOST: HK_HOST,
    PLATFORM_BILLING_DATABASE_NAME: "tianxing",
    PLATFORM_BILLING_DATABASE_PORT: "5432",
    PLATFORM_BILLING_DATABASE_USER: "platform_billing",
    PLATFORM_BILLING_READER_DATABASE_HOST: HK_HOST,
    PLATFORM_BILLING_READER_DATABASE_NAME: "tianxing",
    PLATFORM_BILLING_READER_DATABASE_PORT: "5432",
    PLATFORM_BILLING_READER_DATABASE_USER: "platform_billing_reader",
  };
}

test("loads four explicit HK RDS identities with TLS and no credential fallback", () => {
  const config = loadPortalBillingProductionConfig(validEnvironment());

  assert.equal(config.region, "ap-east-1");
  assert.deepEqual(
    [
      config.portalDiscovery.user,
      config.portalTenant.user,
      config.platformBilling.user,
      config.platformBillingReader.user,
    ],
    ["portal_auth", "tianxing_app", "platform_billing", "platform_billing_reader"],
  );
  assert.notEqual(config.portalDiscovery, config.portalTenant);
  assert.deepEqual(config.portalDiscovery.ssl, { rejectUnauthorized: true });
  assert.equal("password" in config.portalDiscovery, false);
  assert.equal("url" in config.portalDiscovery, false);
});

test("rejects non-HK, malformed, missing, and role-confused production configuration", () => {
  const cases: Array<[string, Partial<Record<string, string>>]> = [
    ["region", { AWS_REGION: "us-east-1" }],
    ["host", { PORTAL_AUTH_DATABASE_HOST: "localhost" }],
    ["port", { PLATFORM_BILLING_DATABASE_PORT: "5433" }],
    ["role", { PORTAL_AUTH_DATABASE_USER: "tianxing_app" }],
    ["reader role", { PLATFORM_BILLING_READER_DATABASE_USER: "platform_billing" }],
    ["missing", { PORTAL_TENANT_DATABASE_NAME: "" }],
  ];

  for (const [name, override] of cases) {
    assert.throws(
      () => loadPortalBillingProductionConfig({ ...validEnvironment(), ...override }),
      { name: "PortalBillingProductionConfigurationError" },
      name,
    );
  }
});

test("composition remains typed unavailable while production factories are absent", () => {
  assert.throws(
    () => composePortalBillingProductionRuntime(validEnvironment(), {}),
    (error: unknown) => {
      assert.ok(error instanceof PortalBillingCompositionUnavailable);
      assert.equal(error.code, "PORTAL_BILLING_COMPOSITION_UNAVAILABLE");
      assert.deepEqual(error.blockers, [
        "PORTAL_DISCOVERY_RDS_ADAPTER_FACTORY_REQUIRED",
        "PORTAL_TENANT_RDS_ADAPTER_FACTORY_REQUIRED",
        "PLATFORM_OPERATOR_AUTH_FACTORY_REQUIRED",
        "PLATFORM_BILLING_RDS_ADAPTER_FACTORY_REQUIRED",
        "PLATFORM_BILLING_AGGREGATE_READER_FACTORY_REQUIRED",
      ]);
      return true;
    },
  );
});

test("composition enforces portal_auth discovery before tenant runtime resolution", async () => {
  const calls: string[] = [];
  const portalRepository = Object.freeze({ marker: "portal" });
  const billingRepository = Object.freeze({ marker: "billing" });
  const overviewReader = Object.freeze({ readOverview: async () => ({}) });

  const composition = composePortalBillingProductionRuntime(validEnvironment(), {
    portalDiscovery: {
      create(input) {
        calls.push(`discovery-config:${input.database.user}`);
        assert.deepEqual(Object.keys(input), ["database"]);
        return Object.freeze({
          async discoverByKeyedSecretHash(keyedSecretHash: string) {
            calls.push(`discover:${keyedSecretHash}`);
            return Object.freeze({
              organizationId: UUID,
              grantId: "22222222-2222-4222-8222-222222222222",
              serviceCaseId: "33333333-3333-4333-8333-333333333333",
            });
          },
        });
      },
    },
    portalTenant: {
      create(input) {
        calls.push(`tenant-config:${input.database.user}`);
        assert.deepEqual(Object.keys(input), ["database"]);
        return Object.freeze({
          async resolve(locator) {
            calls.push(`tenant:${locator.organizationId}:${locator.grantId}`);
            return createPortalRuntime(portalRepository as never);
          },
        });
      },
    },
    platformOperatorAuth: {
      create() {
        calls.push("auth:platform-identity");
        return Object.freeze({ authenticate: async () => ({ actorId: UUID, role: "platform_admin" as const, status: "active" as const }) });
      },
    },
    platformBilling: {
      create(input) {
        calls.push(`write:${input.database.user}`);
        return createPlatformBillingRuntime(billingRepository as never);
      },
    },
    platformBillingOverview: {
      create(input) {
        calls.push(`read:${input.database.user}`);
        return overviewReader;
      },
    },
  });

  assert.deepEqual(calls, [
    "discovery-config:portal_auth",
    "tenant-config:tianxing_app",
    "auth:platform-identity",
    "write:platform_billing",
    "read:platform_billing_reader",
  ]);
  const portal = await composition.resolvePortalRuntime("a".repeat(64));
  assert.equal(portal?.repository, portalRepository);
  assert.deepEqual(calls.slice(-2), [
    `discover:${"a".repeat(64)}`,
    `tenant:${UUID}:22222222-2222-4222-8222-222222222222`,
  ]);
  assert.equal(composition.platformBilling.repository, billingRepository);
  assert.equal(composition.platformBillingOverview, overviewReader);
});

test("portal discovery miss never opens the tenant adapter", async () => {
  let tenantCalls = 0;
  const composition = composePortalBillingProductionRuntime(validEnvironment(), {
    portalDiscovery: {
      create: () => Object.freeze({ discoverByKeyedSecretHash: async () => null }),
    },
    portalTenant: {
      create: () => Object.freeze({
        async resolve() {
          tenantCalls += 1;
          throw new Error("tenant adapter must not run");
        },
      }),
    },
    platformOperatorAuth: {
      create: () => Object.freeze({ authenticate: async () => null }),
    },
    platformBilling: {
      create: () => createPlatformBillingRuntime(Object.freeze({}) as never),
    },
    platformBillingOverview: {
      create: () => Object.freeze({ readOverview: async () => ({}) }),
    },
  });

  assert.equal(await composition.resolvePortalRuntime("b".repeat(64)), null);
  assert.equal(tenantCalls, 0);
});

test("malformed discovery locators fail before the tenant adapter opens", async () => {
  let tenantCalls = 0;
  const composition = composePortalBillingProductionRuntime(validEnvironment(), {
    portalDiscovery: {
      create: () => Object.freeze({
        discoverByKeyedSecretHash: async () => Object.freeze({
          organizationId: "wrong-tenant",
          grantId: "22222222-2222-4222-8222-222222222222",
          serviceCaseId: "33333333-3333-4333-8333-333333333333",
        }),
      }),
    },
    portalTenant: {
      create: () => Object.freeze({
        async resolve() {
          tenantCalls += 1;
          throw new Error("tenant adapter must not run");
        },
      }),
    },
    platformOperatorAuth: {
      create: () => Object.freeze({ authenticate: async () => null }),
    },
    platformBilling: {
      create: () => createPlatformBillingRuntime(Object.freeze({}) as never),
    },
    platformBillingOverview: {
      create: () => Object.freeze({ readOverview: async () => ({}) }),
    },
  });

  await assert.rejects(() => composition.resolvePortalRuntime("c".repeat(64)), {
    name: "PortalBillingProductionConfigurationError",
  });
  assert.equal(tenantCalls, 0);
});

test("portal composition rejects values that could be raw credentials", async () => {
  const composition = composePortalBillingProductionRuntime(validEnvironment(), {
    portalDiscovery: {
      create: () => Object.freeze({ discoverByKeyedSecretHash: async () => null }),
    },
    portalTenant: {
      create: () => Object.freeze({ resolve: async () => null as never }),
    },
    platformOperatorAuth: {
      create: () => Object.freeze({ authenticate: async () => null }),
    },
    platformBilling: {
      create: () => createPlatformBillingRuntime(Object.freeze({}) as never),
    },
    platformBillingOverview: {
      create: () => Object.freeze({ readOverview: async () => ({}) }),
    },
  });

  await assert.rejects(() => composition.resolvePortalRuntime("raw-secret"), {
    name: "PortalBillingProductionConfigurationError",
  });
});
