import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PlanManifestInputError,
  computeTerraformSourceTreeSha256,
  createRedactedPlanManifest,
} from "../../scripts/infra/create-redacted-plan-manifest.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const sourceOnlyInput = {
  schemaVersion: 1 as const,
  evidenceType: "release1.production-plan" as const,
  region: "ap-east-1" as const,
  generatedAt: "2026-08-12T00:00:00.000Z",
  sourceTreeSha256: "a".repeat(64),
  providerLockSha256: null,
  binaryPlanSha256: null,
  planJsonSummarySha256: null,
  p307aReceipt: null,
};

test("source-only evidence stays fail-closed until P3-07A", () => {
  assert.deepEqual(createRedactedPlanManifest(sourceOnlyInput), {
    ...sourceOnlyInput,
    planStatus: "not_generated",
    verification: "pass",
    releaseState: "needs_human",
    releaseEligible: false,
    approvals: {
      planPayload: "not_requested",
      planTooling: "not_requested",
      apply: "not_requested",
    },
  });
});

test("rejects a caller-supplied provider lock hash without trusted artifact bytes", () => {
  assert.throws(
    () => createRedactedPlanManifest({ ...sourceOnlyInput, providerLockSha256: "b".repeat(64) }),
    PlanManifestInputError,
  );
});

test("rejects a binary plan identity without trusted artifact provenance", () => {
  assert.throws(
    () => createRedactedPlanManifest({ ...sourceOnlyInput, binaryPlanSha256: "c".repeat(64) }),
    PlanManifestInputError,
  );
});

test("rejects partial, unsafe, or non-Hong-Kong source evidence", () => {
  assert.throws(() => createRedactedPlanManifest({ ...sourceOnlyInput, region: "ap-southeast-1" as "ap-east-1" }), PlanManifestInputError);
  assert.throws(() => createRedactedPlanManifest({ ...sourceOnlyInput, sourceTreeSha256: "pending" }), PlanManifestInputError);
  assert.throws(() => createRedactedPlanManifest({ ...sourceOnlyInput, planJsonSummarySha256: "d".repeat(64) }), PlanManifestInputError);
});

test("rejects shape-only receipts and partial plan self-assertions", () => {
  const receipt = {
    ticket: "P3-07A" as const,
    exactPayloadSha256: "e".repeat(64),
    toolingApprovalSha256: "f".repeat(64),
  };

  assert.throws(
    () => createRedactedPlanManifest({ ...sourceOnlyInput, p307aReceipt: receipt }),
    PlanManifestInputError,
  );
  assert.throws(
    () => createRedactedPlanManifest({ ...sourceOnlyInput, planJsonSummarySha256: "d".repeat(64) }),
    PlanManifestInputError,
  );
  assert.throws(
    () => createRedactedPlanManifest({ ...sourceOnlyInput, providerLockSha256: "b".repeat(64) }),
    PlanManifestInputError,
  );
  assert.throws(
    () =>
      createRedactedPlanManifest({
        ...sourceOnlyInput,
        binaryPlanSha256: "c".repeat(64),
        planJsonSummarySha256: "d".repeat(64),
        p307aReceipt: receipt,
      }),
    PlanManifestInputError,
  );
});

test("committed P3-07 evidence is reproducible and remains source-only", () => {
  const path = fileURLToPath(new URL("../../evidence/release1/p3-07/manifest.json", import.meta.url));
  const committed = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(committed.sourceTreeSha256, computeTerraformSourceTreeSha256(ROOT));
  const input = {
    schemaVersion: committed.schemaVersion,
    evidenceType: committed.evidenceType,
    region: committed.region,
    generatedAt: committed.generatedAt,
    sourceTreeSha256: committed.sourceTreeSha256,
    providerLockSha256: committed.providerLockSha256,
    binaryPlanSha256: committed.binaryPlanSha256,
    planJsonSummarySha256: committed.planJsonSummarySha256,
    p307aReceipt: committed.p307aReceipt,
  };
  assert.deepEqual(committed, createRedactedPlanManifest(input));
});
