import { createHash, type Hash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const PLAN_EVIDENCE_SCHEMA_VERSION = 1 as const;

export interface P307AReceipt {
  readonly ticket: "P3-07A";
  readonly exactPayloadSha256: string;
  readonly toolingApprovalSha256: string;
}

export interface RedactedPlanManifestInput {
  readonly schemaVersion: typeof PLAN_EVIDENCE_SCHEMA_VERSION;
  readonly evidenceType: "release1.production-plan";
  readonly region: "ap-east-1";
  readonly generatedAt: string;
  readonly sourceTreeSha256: string;
  readonly providerLockSha256: string | null;
  readonly binaryPlanSha256: string | null;
  readonly planJsonSummarySha256: string | null;
  readonly p307aReceipt: P307AReceipt | null;
}

export interface RedactedPlanManifest extends RedactedPlanManifestInput {
  readonly planStatus: "not_generated" | "generated";
  readonly verification: "pass";
  readonly releaseState: "needs_human";
  readonly releaseEligible: false;
  readonly approvals: {
    readonly planPayload: "not_requested" | "approved";
    readonly planTooling: "not_requested" | "approved";
    readonly apply: "not_requested";
  };
}

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Hashes only Terraform source files using a length-delimited path/content
 * stream so file names and bytes cannot become ambiguous when concatenated.
 */
export function computeTerraformSourceTreeSha256(rootDir: string): string {
  const terraformRoot = join(rootDir, "infra", "terraform");
  const relativePaths = collectTerraformSourcePaths(terraformRoot, rootDir).sort();
  const digest = createHash("sha256");

  for (const relativePath of relativePaths) {
    const content = readFileSync(join(rootDir, relativePath));
    updateLengthDelimited(digest, Buffer.from(relativePath, "utf8"));
    updateLengthDelimited(digest, content);
  }

  return digest.digest("hex");
}

function collectTerraformSourcePaths(directory: string, rootDir: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".terraform") continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...collectTerraformSourcePaths(absolutePath, rootDir));
    } else if (entry.isFile() && entry.name.endsWith(".tf")) {
      paths.push(relative(rootDir, absolutePath).split(sep).join("/"));
    }
  }
  return paths;
}

function updateLengthDelimited(digest: Hash, bytes: Buffer): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  digest.update(length);
  digest.update(bytes);
}

export function createRedactedPlanManifest(
  input: RedactedPlanManifestInput,
): RedactedPlanManifest {
  if (input.schemaVersion !== PLAN_EVIDENCE_SCHEMA_VERSION) {
    throw new PlanManifestInputError("Unsupported plan evidence schema version.");
  }
  if (input.evidenceType !== "release1.production-plan") {
    throw new PlanManifestInputError("Unexpected plan evidence type.");
  }
  if (input.region !== "ap-east-1") {
    throw new PlanManifestInputError("Production plan evidence must be confined to ap-east-1.");
  }
  assertTimestamp(input.generatedAt);
  assertSha256(input.sourceTreeSha256, "sourceTreeSha256");

  if (
    input.providerLockSha256 !== null ||
    input.binaryPlanSha256 !== null ||
    input.planJsonSummarySha256 !== null ||
    input.p307aReceipt !== null
  ) {
    throw new PlanManifestInputError(
      "Source-only plan evidence cannot include plan hashes or a P3-07A receipt.",
    );
  }

  return deepFreeze({
    schemaVersion: input.schemaVersion,
    evidenceType: input.evidenceType,
    region: input.region,
    generatedAt: input.generatedAt,
    sourceTreeSha256: input.sourceTreeSha256,
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
  });
}

export class PlanManifestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanManifestInputError";
  }
}

function assertSha256(value: string, field: string): void {
  if (!SHA256.test(value)) throw new PlanManifestInputError(`${field} must be a SHA-256 digest.`);
}

function assertTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new PlanManifestInputError("generatedAt must be a canonical UTC timestamp.");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
