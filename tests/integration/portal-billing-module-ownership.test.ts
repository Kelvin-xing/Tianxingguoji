import assert from "node:assert/strict";
import test from "node:test";

import {
  MODULE_REGISTRY,
  ModuleBoundaryError,
  assertModuleImportAllowed,
  assertModuleWriteAllowed,
} from "../../modules/shared/architecture/module-registry.ts";

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

test("keeps repositories private behind public and server facades", () => {
  for (const moduleId of ["external_portal_access", "platform_billing"] as const) {
    assert.deepEqual(
      MODULE_REGISTRY[moduleId].publicEntrypoints.map((path) => path.split("/").at(-1)),
      ["public.ts", "server.ts"],
    );
  }

  assert.throws(
    () => assertModuleImportAllowed(
      "modules/platform-billing/infrastructure/runtime.ts",
      "modules/external-portal/application/repository-port.ts",
    ),
    (error: unknown) => error instanceof ModuleBoundaryError && error.code === "CROSS_MODULE_INTERNAL_IMPORT",
  );
  assert.throws(
    () => assertModuleImportAllowed(
      "modules/external-portal/infrastructure/runtime.ts",
      "modules/platform-billing/application/repository-port.ts",
    ),
    (error: unknown) => error instanceof ModuleBoundaryError && error.code === "CROSS_MODULE_INTERNAL_IMPORT",
  );
});
