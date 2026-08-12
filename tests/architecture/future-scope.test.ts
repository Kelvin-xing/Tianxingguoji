import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FUTURE_FEATURE_CONTRACTS,
  FutureFeatureDisabledError,
  RELEASE_ONE_NAVIGATION_PLACEHOLDERS,
  assertFutureFeatureDisabled,
} from "../../modules/future/feature-contracts.ts";

test("future AI, import, and multi-tenant capabilities remain disabled by contract in Release 1", () => {
  for (const contract of Object.values(FUTURE_FEATURE_CONTRACTS)) {
    assert.equal(contract.releaseOneState, "disabled_by_contract");
    assert.deepEqual(contract.permittedSurfaces, ["navigation_placeholder"]);
    assert.deepEqual(contract.prohibitedSurfaces, ["route", "job", "credential", "data_write"]);

    assert.throws(
      () => assertFutureFeatureDisabled(contract.id),
      (error: unknown) => {
        assert.ok(error instanceof FutureFeatureDisabledError);
        assert.equal(error.code, "FUTURE_FEATURE_DISABLED");
        assert.deepEqual(error.details, {
          featureId: contract.id,
          release: "release_1",
          state: "disabled_by_contract",
        });
        return true;
      },
    );
  }
});

test("only the approved visible Release 1 placeholders are exposed to navigation", () => {
  assert.deepEqual(
    RELEASE_ONE_NAVIGATION_PLACEHOLDERS.map((placeholder) => placeholder.featureId),
    ["non_k12_services", "ai_reports", "data_import", "multi_tenant"],
  );

  for (const placeholder of RELEASE_ONE_NAVIGATION_PLACEHOLDERS) {
    assert.equal(placeholder.statusLabel, "正在開發中");
    assert.equal(FUTURE_FEATURE_CONTRACTS[placeholder.featureId].releaseOneState, "disabled_by_contract");
  }
});

test("the future contract introduces no Release 1 execution dependency or secret-backed adapter", async () => {
  const source = await readFile(
    new URL("../../modules/future/feature-contracts.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /DATABASE_URL|API[_-]?KEY|SECRET|TOKEN/);
  assert.doesNotMatch(source, /from\s+["'](?:node:|@\/modules\/)/);
});

test("sidebar renders future capability labels as disabled placeholders rather than links", async () => {
  const source = await readFile(
    new URL("../../components/layout/Sidebar.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /RELEASE_ONE_NAVIGATION_PLACEHOLDERS/);
  assert.match(source, /<FuturePlaceholder/);
  assert.match(source, /aria-disabled="true"/);
  assert.doesNotMatch(source, /href=\{placeholder\./);
});
