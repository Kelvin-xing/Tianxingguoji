import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FUTURE_FEATURE_CONTRACTS,
  FutureFeatureDisabledError,
  RELEASE_ONE_NAVIGATION_PLACEHOLDERS,
  assertFutureFeatureDisabled,
} from "../../modules/future/domain/feature-contracts.ts";

test("future AI, import, and multi-tenant capabilities remain disabled by contract in Release 1", () => {
  for (const contract of Object.values(FUTURE_FEATURE_CONTRACTS)) {
    assert.equal(contract.releaseOneState, "disabled_by_contract");
    assert.deepEqual(contract.permittedSurfaces, []);
    assert.deepEqual(contract.prohibitedSurfaces, ["navigation", "route", "job", "credential", "data_write"]);

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

test("Future exposes no Release 1 navigation placeholders", () => {
  assert.deepEqual(RELEASE_ONE_NAVIGATION_PLACEHOLDERS, []);
});

test("the future contract introduces no Release 1 execution dependency or secret-backed adapter", async () => {
  const source = await readFile(
    new URL("../../modules/future/domain/feature-contracts.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /DATABASE_URL|API[_-]?KEY|SECRET|TOKEN/);
  assert.doesNotMatch(source, /from\s+["'](?:node:|@\/modules\/)/);
});

test("sidebar has no Future module dependency or placeholder surface", async () => {
  const source = await readFile(
    new URL("../../components/layout/Sidebar.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /modules\/future/);
  assert.doesNotMatch(source, /RELEASE_ONE_NAVIGATION_PLACEHOLDERS/);
  assert.doesNotMatch(source, /FuturePlaceholder/);
});
