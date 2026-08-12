import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateP307SourceManifest } from "../../scripts/infra/generate-p3-07-source-manifest.ts";

const GENERATED_AT = "2026-08-12T00:00:00.000Z";

test("P3-07 source generator atomically refreshes only fail-closed source evidence", async () => {
  const rootDir = await fixtureRoot();
  const manifestPath = join(rootDir, "evidence/release1/p3-07/manifest.json");

  const generated = await generateP307SourceManifest({ rootDir });
  const persisted = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.deepEqual(persisted, generated);
  assert.equal(generated.planStatus, "not_generated");
  assert.equal(generated.releaseState, "needs_human");
  assert.equal(generated.releaseEligible, false);
  assert.deepEqual(generated.approvals, {
    planPayload: "not_requested",
    planTooling: "not_requested",
    apply: "not_requested",
  });
  assert.equal(generated.binaryPlanSha256, null);
  assert.equal(generated.planJsonSummarySha256, null);
  assert.equal(generated.p307aReceipt, null);
});

test("P3-07 source generator refuses an existing plan or approval claim", async () => {
  const rootDir = await fixtureRoot();
  const manifestPath = join(rootDir, "evidence/release1/p3-07/manifest.json");
  const existing = JSON.parse(await readFile(manifestPath, "utf8"));
  existing.planStatus = "generated";
  existing.releaseEligible = true;
  await writeFile(manifestPath, `${JSON.stringify(existing, null, 2)}\n`);

  await assert.rejects(
    generateP307SourceManifest({ rootDir }),
    /refuses plan, apply, approval, or release-eligible claims/,
  );
});

async function fixtureRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "p307-source-manifest-"));
  await mkdir(join(rootDir, "infra/terraform"), { recursive: true });
  await mkdir(join(rootDir, "evidence/release1/p3-07"), { recursive: true });
  await writeFile(join(rootDir, "infra/terraform/main.tf"), "terraform {}\n");
  await writeFile(join(rootDir, "evidence/release1/p3-07/manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    evidenceType: "release1.production-plan",
    region: "ap-east-1",
    generatedAt: GENERATED_AT,
    sourceTreeSha256: "a".repeat(64),
    providerLockSha256: null,
    binaryPlanSha256: null,
    planJsonSummarySha256: null,
    p307aReceipt: null,
    planStatus: "not_generated",
    verification: "pass",
    releaseState: "needs_human",
    releaseEligible: false,
    approvals: {
      planPayload: "not_requested",
      planTooling: "not_requested",
      apply: "not_requested",
    },
  }, null, 2)}\n`);
  return rootDir;
}
