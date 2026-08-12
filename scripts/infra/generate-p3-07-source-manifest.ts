import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeTerraformSourceTreeSha256,
  createRedactedPlanManifest,
  type RedactedPlanManifest,
} from "./create-redacted-plan-manifest.ts";

const MANIFEST_RELATIVE_PATH = "evidence/release1/p3-07/manifest.json";

export async function generateP307SourceManifest(input: {
  readonly rootDir: string;
}): Promise<RedactedPlanManifest> {
  const rootDir = resolve(input.rootDir);
  const manifestPath = join(rootDir, MANIFEST_RELATIVE_PATH);
  const existing = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;

  assertExistingManifestIsSourceOnly(existing);

  const manifest = createRedactedPlanManifest({
    schemaVersion: existing.schemaVersion as 1,
    evidenceType: existing.evidenceType as "release1.production-plan",
    region: existing.region as "ap-east-1",
    generatedAt: existing.generatedAt as string,
    sourceTreeSha256: computeTerraformSourceTreeSha256(rootDir),
    providerLockSha256: null,
    binaryPlanSha256: null,
    planJsonSummarySha256: null,
    p307aReceipt: null,
  });

  const temporaryPath = join(dirname(manifestPath), `.manifest.json.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await rename(temporaryPath, manifestPath);
  return manifest;
}

function assertExistingManifestIsSourceOnly(existing: Record<string, unknown>): void {
  const approvals = existing.approvals;
  const safeApprovals =
    typeof approvals === "object" && approvals !== null &&
    (approvals as Record<string, unknown>).planPayload === "not_requested" &&
    (approvals as Record<string, unknown>).planTooling === "not_requested" &&
    (approvals as Record<string, unknown>).apply === "not_requested";

  if (
    existing.planStatus !== "not_generated" ||
    existing.releaseState !== "needs_human" ||
    existing.releaseEligible !== false ||
    existing.providerLockSha256 !== null ||
    existing.binaryPlanSha256 !== null ||
    existing.planJsonSummarySha256 !== null ||
    existing.p307aReceipt !== null ||
    !safeApprovals
  ) {
    throw new Error("Source-only generator refuses plan, apply, approval, or release-eligible claims.");
  }
}

async function main(): Promise<void> {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const manifest = await generateP307SourceManifest({ rootDir });
  process.stdout.write(`${MANIFEST_RELATIVE_PATH}: ${manifest.sourceTreeSha256}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
