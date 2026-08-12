import assert from "node:assert/strict";
import test from "node:test";

import {
  MODULE_REGISTRY,
  ModuleBoundaryError,
  assertModuleImportAllowed,
  assertModuleWriteAllowed,
} from "../../modules/shared/module-registry.ts";

test("registers the exact Portal and Billing resources without taking tenant ownership", () => {
  assert.deepEqual(MODULE_REGISTRY.external_portal_access.owns, [
    "PortalViewer",
    "PortalAccessGrant",
    "PortalSession",
    "PortalSecurityEvent",
  ]);
  assert.deepEqual(MODULE_REGISTRY.platform_billing.owns, [
    "PlatformBillingActor",
    "CustomerContract",
    "MonthlyTenantMetric",
    "PlatformSubscriptionProjection",
    "PlatformAuditEvent",
  ]);

  for (const [writer, resource] of [
    ["external_portal_access", "ServiceCase"],
    ["external_portal_access", "Student"],
    ["external_portal_access", "AuditEvent"],
    ["platform_billing", "Subscription"],
    ["platform_billing", "ServiceCase"],
    ["platform_billing", "AuditEvent"],
  ] as const) {
    assert.throws(
      () => assertModuleWriteAllowed(writer, resource),
      (error: unknown) => error instanceof ModuleBoundaryError && error.code === "CROSS_MODULE_WRITE",
    );
  }
});

test("keeps repositories private while exposing only contract, policy, and runtime seams", () => {
  for (const moduleId of ["external_portal_access", "platform_billing"] as const) {
    assert.deepEqual(
      MODULE_REGISTRY[moduleId].publicEntrypoints.map((path) => path.split("/").at(-1)),
      ["contract.ts", "policy.ts", "runtime.ts"],
    );
  }

  assert.throws(
    () => assertModuleImportAllowed(
      "modules/platform-billing/runtime.ts",
      "modules/external-portal/repository.ts",
    ),
    (error: unknown) => error instanceof ModuleBoundaryError && error.code === "CROSS_MODULE_INTERNAL_IMPORT",
  );
  assert.throws(
    () => assertModuleImportAllowed(
      "modules/external-portal/runtime.ts",
      "modules/platform-billing/repository.ts",
    ),
    (error: unknown) => error instanceof ModuleBoundaryError && error.code === "CROSS_MODULE_INTERNAL_IMPORT",
  );
});
