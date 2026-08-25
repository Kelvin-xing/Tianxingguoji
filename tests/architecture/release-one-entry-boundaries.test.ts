import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MODULE_REGISTRY,
  RELEASE_ONE_ACTIVE_MODULE_IDS,
  ModuleBoundaryError,
  assertModuleImportAllowed,
} from "../../modules/shared/architecture/module-registry.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("keeps excluded modules and resources outside the Release 1 active snapshot", () => {
  assert.equal(RELEASE_ONE_ACTIVE_MODULE_IDS.includes("platform_billing" as never), false);
  assert.equal(RELEASE_ONE_ACTIVE_MODULE_IDS.includes("future" as never), false);
  assert.deepEqual(MODULE_REGISTRY.platform_billing.owns, []);
  assert.deepEqual(MODULE_REGISTRY.future.owns, []);
  assert.deepEqual(MODULE_REGISTRY.access.historicalOwns, ["Subscription", "Entitlement", "SupportGrant"]);
  assert.deepEqual(MODULE_REGISTRY.crm.historicalOwns, ["DuplicateCandidate", "MergeRevision"]);
  assert.deepEqual(MODULE_REGISTRY.cases.historicalOwns, [
    "CaseReconstruction",
    "ReconstructionVersion",
    "ReconstructionEvent",
    "ReconstructionGap",
  ]);
});

test("rejects new consumers of historical module and CRM legacy entrypoints", () => {
  assertHistoricalImportRejected(
    "app/api/v1/new-platform-route.ts",
    "modules/platform-billing/public.ts",
    "platform_billing",
  );
  assertHistoricalImportRejected(
    "components/new-future-navigation.tsx",
    "modules/future/public.ts",
    "future",
  );
  assertHistoricalImportRejected(
    "app/api/v1/crm/new-duplicate-route.ts",
    "modules/crm/legacy-server.ts",
    "crm",
  );

  assert.doesNotThrow(() => assertModuleImportAllowed(
    "app/api/v1/platform/billing/overview/handler.ts",
    "modules/platform-billing/public.ts",
  ));
  assert.doesNotThrow(() => assertModuleImportAllowed(
    "app/api/v1/crm/duplicate-handler.ts",
    "modules/crm/legacy-server.ts",
  ));
});

test("active root entrypoints do not export DEC, Merge, or reconstruction contracts", () => {
  assert.doesNotMatch(source("modules/shared/public.ts"), /decision-guards|DECISION_STATUSES/);
  assert.doesNotMatch(source("modules/cases/public.ts"), /reconstruction/i);
  assert.doesNotMatch(source("modules/cases/server.ts"), /reconstruction/i);
  assert.doesNotMatch(source("modules/crm/server.ts"), /duplicate|merge|legacy/i);
  assert.doesNotMatch(source("modules/access/domain/contract.ts"), /students\.duplicates\.(?:review|merge)/);
  assert.doesNotMatch(source("modules/external-portal/domain/contract.ts"), /subscription/i);
});

test("excluded browser entries fail closed while their historical source remains retained", () => {
  const excludedPages = [
    "app/(erp)/platform/billing/page.tsx",
    "app/(erp)/cases/reconstructions/new/page.tsx",
    "app/(erp)/cases/reconstructions/[reconstructionId]/page.tsx",
    "app/(erp)/students/duplicates/page.tsx",
    "app/(erp)/students/duplicates/[candidateId]/page.tsx",
  ];
  for (const path of excludedPages) {
    const content = source(path);
    assert.match(content, /notFound\(\)/, `${path} must fail closed`);
    assert.doesNotMatch(content, /\bfetch\s*\(/, `${path} must not call an excluded API`);
  }

  const proxyBoundary = source("proxy.ts");
  for (const pathPattern of [
    "^\\/platform\\/billing$",
    "^\\/cases\\/reconstructions\\/new$",
    "^\\/cases\\/reconstructions\\/[^/]+$",
    "^\\/students\\/duplicates$",
    "^\\/students\\/duplicates\\/[^/]+$",
  ]) {
    assert.equal(
      proxyBoundary.includes(pathPattern),
      true,
      `${pathPattern} must be blocked before streaming`,
    );
  }
  assert.match(proxyBoundary, /status: 404/);
  assert.match(proxyBoundary, /"cache-control": "no-store"/);
  assert.match(proxyBoundary, /"x-request-id": requestId/);
  assert.match(proxyBoundary, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(
    proxyBoundary,
    /from\s+["'][^"']*(?:modules\/(?:platform-billing|future)|legacy-server|reconstruction)/,
  );

  assert.doesNotMatch(source("components/layout/Sidebar.tsx"), /modules\/future|FuturePlaceholder/);
  assert.doesNotMatch(source("components/crm/StudentsDirectory.tsx"), /students\/duplicates|students\.duplicates/);

  for (const path of [
    "modules/shared/domain/decision-guards.ts",
    "modules/platform-billing/domain/contract.ts",
    "modules/future/domain/feature-contracts.ts",
    "modules/crm/legacy-server.ts",
    "modules/cases/application/reconstruction/service.ts",
  ]) {
    assert.equal(existsSync(resolve(REPOSITORY_ROOT, path)), true, `${path} must remain as history`);
  }
});

test("excluded formal API routes cannot import or invoke retained runtimes", () => {
  const excludedRoutes = [
    "app/api/v1/platform/billing/overview/route.ts",
    "app/api/v1/cases/reconstructions/route.ts",
    "app/api/v1/crm/duplicate-candidates/route.ts",
    "app/api/v1/crm/duplicate-candidates/[candidateId]/route.ts",
    "app/api/v1/crm/duplicate-candidates/[candidateId]/merges/route.ts",
    "app/api/v1/crm/duplicate-records/search/route.ts",
    "app/api/v1/crm/duplicate-merges/[mergeId]/corrections/route.ts",
  ];
  for (const path of excludedRoutes) {
    const content = source(path);
    assert.match(content, /releaseOneExcludedEntryResponse/);
    assert.doesNotMatch(content, /modules\/(?:platform-billing|future)|legacy-server|duplicate-handler|reconstruction\/runtime/);
    assert.doesNotMatch(content, /get(?:PlatformBilling|DuplicateReview|CaseReconstruction)Runtime/);
  }

  assert.match(
    source("app/api/v1/crm/duplicate-records/search/route.ts"),
    /export async function GET\(request: Request\)/,
  );
});

function assertHistoricalImportRejected(importer: string, imported: string, importedModule: string): void {
  assert.throws(
    () => assertModuleImportAllowed(importer, imported),
    (error: unknown) => {
      assert.ok(error instanceof ModuleBoundaryError);
      assert.equal(error.code, "HISTORICAL_ENTRYPOINT_IMPORT");
      assert.deepEqual(error.details, { importer, imported, importedModule });
      return true;
    },
  );
}

function source(path: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
}
