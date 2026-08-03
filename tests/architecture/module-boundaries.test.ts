import assert from "node:assert/strict";
import test from "node:test";

import {
  MODULE_REGISTRY,
  ModuleBoundaryError,
  assertModuleImportAllowed,
  assertModuleWriteAllowed,
  getModuleForPath,
} from "../../modules/shared/module-registry.ts";

test("registers one owner for every authoritative resource", () => {
  const owners = new Map<string, string>();

  for (const definition of Object.values(MODULE_REGISTRY)) {
    for (const resource of definition.owns) {
      assert.equal(owners.has(resource), false, `${resource} has more than one owner`);
      owners.set(resource, definition.id);
    }
  }

  assert.equal(owners.get("User"), "identity");
  assert.equal(owners.get("Student"), "crm");
  assert.equal(owners.get("ServiceCase"), "cases");
  assert.equal(owners.get("Task"), "tasks");
  assert.equal(owners.get("DocumentVersion"), "documents");
  assert.equal(owners.get("AuditEvent"), "audit_operations");
});

test("resolves files to the module owning their longest source root", () => {
  assert.equal(getModuleForPath("modules/cases/service.ts")?.id, "cases");
  assert.equal(getModuleForPath("@/modules/audit/query.ts")?.id, "audit_operations");
  assert.equal(getModuleForPath("app/api/v1/cases/route.ts")?.id, "adapters");
  assert.equal(getModuleForPath("workers/deliver-in-app.ts")?.id, "adapters");
  assert.equal(getModuleForPath("components/layout/Sidebar.tsx"), undefined);
});

test("allows internal imports and cross-module public contracts", () => {
  assert.doesNotThrow(() =>
    assertModuleImportAllowed("modules/cases/service.ts", "modules/cases/repository.ts"),
  );
  assert.doesNotThrow(() =>
    assertModuleImportAllowed("modules/cases/service.ts", "@/modules/crm/contract"),
  );
  assert.doesNotThrow(() =>
    assertModuleImportAllowed(
      "modules/cases/service.ts",
      "modules/shared/decision-guards.ts",
    ),
  );
  assert.doesNotThrow(() =>
    assertModuleImportAllowed("app/api/v1/cases/route.ts", "modules/cases/contract.ts"),
  );
  assert.doesNotThrow(() =>
    assertModuleImportAllowed(
      "app/api/v1/health/route.ts",
      "modules/shared/api-contract.ts",
    ),
  );
  assert.doesNotThrow(() =>
    assertModuleImportAllowed(
      "app/api/v1/health/route.ts",
      "modules/shared/request-context.ts",
    ),
  );
});

test("rejects imports of another module's internals", () => {
  assertBoundaryError(
    () => assertModuleImportAllowed("modules/cases/service.ts", "modules/crm/repository.ts"),
    "CROSS_MODULE_INTERNAL_IMPORT",
    {
      importer: "modules/cases/service.ts",
      importerModule: "cases",
      imported: "modules/crm/repository.ts",
      importedModule: "crm",
    },
  );
  assertBoundaryError(
    () =>
      assertModuleImportAllowed(
        "modules/cases/service.ts",
        "modules/cases/../crm/repository.ts",
      ),
    "CROSS_MODULE_INTERNAL_IMPORT",
    {
      importer: "modules/cases/service.ts",
      importerModule: "cases",
      imported: "modules/crm/repository.ts",
      importedModule: "crm",
    },
  );
});

test("rejects unregistered paths under the governed module roots", () => {
  assertBoundaryError(
    () => assertModuleImportAllowed("modules/cases/service.ts", "modules/future/internal.ts"),
    "UNREGISTERED_MODULE_PATH",
    { path: "modules/future/internal.ts" },
  );
});

test("allows only the owning module to write an authoritative resource", () => {
  assert.doesNotThrow(() => assertModuleWriteAllowed("crm", "Student"));
  assert.doesNotThrow(() => assertModuleWriteAllowed("cases", "ServiceCase"));

  assertBoundaryError(
    () => assertModuleWriteAllowed("cases", "Student"),
    "CROSS_MODULE_WRITE",
    { writerModule: "cases", resource: "Student", ownerModule: "crm" },
  );
  assertBoundaryError(
    () => assertModuleWriteAllowed("unknown", "Student"),
    "UNKNOWN_MODULE",
    { moduleId: "unknown" },
  );
  assertBoundaryError(
    () => assertModuleWriteAllowed("crm", "UnregisteredRecord"),
    "UNKNOWN_RESOURCE",
    { resource: "UnregisteredRecord" },
  );
});

function assertBoundaryError(
  action: () => void,
  code: ModuleBoundaryError["code"],
  details: Record<string, string>,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ModuleBoundaryError);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, details);
    return true;
  });
}
