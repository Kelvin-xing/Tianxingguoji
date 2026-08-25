import assert from "node:assert/strict";
import test from "node:test";

import {
  MODULE_REGISTRY,
  ModuleBoundaryError,
  assertModuleImportAllowed,
  assertModuleWriteAllowed,
} from "../../modules/shared/architecture/module-registry.ts";

test("keeps Portal active while Billing resources remain historical", () => {
  assert.deepEqual(MODULE_REGISTRY.external_portal.owns, [
    "PortalViewer",
    "PortalAccessGrant",
    "PortalSession",
    "PortalSecurityEvent",
  ]);
  assert.deepEqual(MODULE_REGISTRY.platform_billing.owns, []);
  assert.deepEqual(MODULE_REGISTRY.platform_billing.historicalOwns, [
    "PlatformBillingActor",
    "CustomerContract",
    "MonthlyTenantMetric",
    "PlatformSubscriptionProjection",
    "PlatformAuditEvent",
  ]);

  for (const [writer, resource] of [
    ["external_portal", "ServiceCase"],
    ["external_portal", "Student"],
    ["external_portal", "AuditEvent"],
  ] as const) {
    assert.throws(
      () => assertModuleWriteAllowed(writer, resource),
      (error: unknown) => error instanceof ModuleBoundaryError && error.code === "CROSS_MODULE_WRITE",
    );
  }

  for (const resource of ["MonthlyTenantMetric", "Subscription", "ServiceCase", "AuditEvent"] as const) {
    assert.throws(
      () => assertModuleWriteAllowed("platform_billing", resource),
      (error: unknown) => error instanceof ModuleBoundaryError &&
        error.code === "RELEASE_ONE_MODULE_INACTIVE",
    );
  }
});

test("keeps repositories private behind public and server facades", () => {
  for (const moduleId of ["external_portal", "platform_billing"] as const) {
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
    (error: unknown) => error instanceof ModuleBoundaryError && error.code === "HISTORICAL_ENTRYPOINT_IMPORT",
  );
});
