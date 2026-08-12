import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEvidenceManifest,
  EvidenceInputError,
  type EvidenceManifest,
  type EvidenceManifestInput,
} from "../evidence/create-manifest.ts";

export const VERTICAL_SLICE_EVIDENCE_RELATIVE_PATH = "evidence/release1/p1-18";
const EXPECTED_MANIFEST_SHA256 =
  "1f33b55821a803e346718baf2bc4f173ef14def4583ec35df6dc89466c1456e9";

export const VERTICAL_SLICE_EXIT_CODE = {
  verifiedLocalEvidence: 0,
  invalidEvidence: 2,
  noGo: 4,
} as const;

const REQUIRED_SCENARIOS = [
  { id: "application.compatible-prior-image", expectedState: "needs_human" },
  { id: "local.evidence-integrity", expectedState: "passed" },
  { id: "migration.corrective-path", expectedState: "needs_human" },
  { id: "restore.database-isolated", expectedState: "needs_human" },
  { id: "restore.document-linkage", expectedState: "needs_human" },
] as const;

const EXTERNAL_GATE_IDS = [
  "application.compatible-prior-image",
  "migration.corrective-path",
  "restore.database-isolated",
  "restore.document-linkage",
] as const;

type ExternalGateId = (typeof EXTERNAL_GATE_IDS)[number];

export interface VerticalSliceEvidenceOptions {
  readonly evidenceDirectory?: string;
}

export interface RequiredExternalEvidence {
  readonly id: ExternalGateId;
  readonly status: "unperformed";
}

export interface VerticalSliceVerification {
  readonly schemaVersion: 1;
  readonly evidenceSource: "synthetic";
  readonly integrity: "pass";
  readonly verification: "pass";
  readonly releaseState: "needs_human";
  readonly decision: "no_go";
  readonly reasonCodes: readonly [
    "SYNTHETIC_EVIDENCE_ONLY",
    "EXTERNAL_STAGING_EVIDENCE_REQUIRED",
    "HUMAN_GO_NO_GO_REQUIRED",
  ];
  readonly requiredExternalEvidence: readonly RequiredExternalEvidence[];
  readonly manifestSha256: string;
}

export class VerticalSliceEvidenceError extends Error {
  readonly code:
    | "EVIDENCE_MISSING"
    | "EVIDENCE_TAMPERED"
    | "EVIDENCE_LAYOUT_INVALID"
    | "EVIDENCE_INPUT_INVALID";

  constructor(code: VerticalSliceEvidenceError["code"]) {
    super(code);
    this.name = "VerticalSliceEvidenceError";
    this.code = code;
  }
}

export async function verifyVerticalSliceEvidence(
  options: VerticalSliceEvidenceOptions = {},
): Promise<VerticalSliceVerification> {
  const evidenceDirectory = resolve(
    options.evidenceDirectory ?? resolve(process.cwd(), VERTICAL_SLICE_EVIDENCE_RELATIVE_PATH),
  );
  const input = await readEvidenceInput(evidenceDirectory);
  const compiledManifest = compileEvidence(input);
  const manifest = await readCompiledManifest(evidenceDirectory);

  if (canonicalize(manifest) !== canonicalize(compiledManifest)) {
    throw new VerticalSliceEvidenceError("EVIDENCE_TAMPERED");
  }
  if (compiledManifest.manifestSha256 !== EXPECTED_MANIFEST_SHA256) {
    throw new VerticalSliceEvidenceError("EVIDENCE_TAMPERED");
  }

  assertRequiredScenarioContract(compiledManifest);
  await assertClosedBundleLayout(evidenceDirectory, compiledManifest);
  await assertArtifactChecksums(evidenceDirectory, compiledManifest);

  return Object.freeze({
    schemaVersion: 1,
    evidenceSource: "synthetic",
    integrity: "pass",
    verification: "pass",
    releaseState: "needs_human",
    decision: "no_go",
    reasonCodes: [
      "SYNTHETIC_EVIDENCE_ONLY",
      "EXTERNAL_STAGING_EVIDENCE_REQUIRED",
      "HUMAN_GO_NO_GO_REQUIRED",
    ],
    requiredExternalEvidence: EXTERNAL_GATE_IDS.map((id) => ({ id, status: "unperformed" })),
    manifestSha256: compiledManifest.manifestSha256,
  });
}

export function verificationExitCode(
  result: VerticalSliceVerification,
  requireGo: boolean,
): number {
  if (result.integrity !== "pass" || result.verification !== "pass") {
    return VERTICAL_SLICE_EXIT_CODE.invalidEvidence;
  }
  return requireGo ? VERTICAL_SLICE_EXIT_CODE.noGo : VERTICAL_SLICE_EXIT_CODE.verifiedLocalEvidence;
}

async function readEvidenceInput(evidenceDirectory: string): Promise<EvidenceManifestInput> {
  return readJson(joinEvidencePath(evidenceDirectory, "manifest-input.json")) as Promise<EvidenceManifestInput>;
}

async function readCompiledManifest(evidenceDirectory: string): Promise<EvidenceManifest> {
  return readJson(joinEvidencePath(evidenceDirectory, "manifest.json")) as Promise<EvidenceManifest>;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) throw new VerticalSliceEvidenceError("EVIDENCE_MISSING");
    throw new VerticalSliceEvidenceError("EVIDENCE_INPUT_INVALID");
  }
}

function compileEvidence(input: EvidenceManifestInput): EvidenceManifest {
  try {
    return createEvidenceManifest(input);
  } catch (error: unknown) {
    if (error instanceof EvidenceInputError) {
      throw new VerticalSliceEvidenceError("EVIDENCE_INPUT_INVALID");
    }
    throw error;
  }
}

function assertRequiredScenarioContract(manifest: EvidenceManifest): void {
  if (
    manifest.source !== "synthetic" ||
    manifest.evidenceType !== "release1.synthetic" ||
    manifest.verification !== "pass" ||
    manifest.releaseState !== "needs_human" ||
    manifest.releaseEligible !== false
  ) {
    throw new VerticalSliceEvidenceError("EVIDENCE_TAMPERED");
  }

  const scenarios = new Map(manifest.scenarios.map((scenario) => [scenario.id, scenario]));
  if (scenarios.size !== REQUIRED_SCENARIOS.length) {
    throw new VerticalSliceEvidenceError("EVIDENCE_TAMPERED");
  }
  for (const required of REQUIRED_SCENARIOS) {
    const scenario = scenarios.get(required.id);
    if (
      scenario === undefined ||
      scenario.expectedState !== required.expectedState ||
      scenario.actualState !== required.expectedState ||
      scenario.verification !== "pass"
    ) {
      throw new VerticalSliceEvidenceError("EVIDENCE_TAMPERED");
    }
  }
}

async function assertClosedBundleLayout(
  evidenceDirectory: string,
  manifest: EvidenceManifest,
): Promise<void> {
  const expectedFiles = new Set([
    "manifest-input.json",
    "manifest.json",
    ...manifest.artifacts.map(({ path }) => path),
  ]);
  const actualFiles = await listRegularFiles(evidenceDirectory);
  if (actualFiles.length !== expectedFiles.size || actualFiles.some((path) => !expectedFiles.has(path))) {
    throw new VerticalSliceEvidenceError("EVIDENCE_LAYOUT_INVALID");
  }
}

async function listRegularFiles(directory: string, prefix = ""): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new VerticalSliceEvidenceError("EVIDENCE_LAYOUT_INVALID");
      if (entry.isDirectory()) {
        files.push(...(await listRegularFiles(absolutePath, path)));
        continue;
      }
      if (!entry.isFile()) throw new VerticalSliceEvidenceError("EVIDENCE_LAYOUT_INVALID");
      const stat = await lstat(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new VerticalSliceEvidenceError("EVIDENCE_LAYOUT_INVALID");
      }
      files.push(path);
    }
    return files.sort();
  } catch (error: unknown) {
    if (error instanceof VerticalSliceEvidenceError) throw error;
    if (hasErrorCode(error, "ENOENT")) throw new VerticalSliceEvidenceError("EVIDENCE_MISSING");
    throw new VerticalSliceEvidenceError("EVIDENCE_LAYOUT_INVALID");
  }
}

async function assertArtifactChecksums(
  evidenceDirectory: string,
  manifest: EvidenceManifest,
): Promise<void> {
  for (const artifact of manifest.artifacts) {
    const content = await readArtifact(evidenceDirectory, artifact.path);
    if (
      createHash("sha256").update(content, "utf8").digest("hex") !== artifact.sha256 ||
      Buffer.byteLength(content, "utf8") !== artifact.bytes
    ) {
      throw new VerticalSliceEvidenceError("EVIDENCE_TAMPERED");
    }
  }
}

async function readArtifact(evidenceDirectory: string, path: string): Promise<string> {
  try {
    return await readFile(joinEvidencePath(evidenceDirectory, path), "utf8");
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) throw new VerticalSliceEvidenceError("EVIDENCE_MISSING");
    throw new VerticalSliceEvidenceError("EVIDENCE_LAYOUT_INVALID");
  }
}

function joinEvidencePath(evidenceDirectory: string, filePath: string): string {
  const output = resolve(evidenceDirectory);
  const target = resolve(output, filePath);
  const relativePath = relative(output, target);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new VerticalSliceEvidenceError("EVIDENCE_LAYOUT_INVALID");
  }
  return target;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
      .join(",")}}`;
  }
  return "null";
}

function parseArguments(arguments_: readonly string[]): {
  readonly evidenceDirectory: string | undefined;
  readonly requireGo: boolean;
} {
  let evidenceDirectory: string | undefined;
  let requireGo = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--require-go") {
      requireGo = true;
      continue;
    }
    if (argument === "--evidence-dir") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new VerticalSliceEvidenceError("EVIDENCE_INPUT_INVALID");
      evidenceDirectory = value;
      index += 1;
      continue;
    }
    throw new VerticalSliceEvidenceError("EVIDENCE_INPUT_INVALID");
  }
  return { evidenceDirectory, requireGo };
}

export async function runVerticalSliceVerifier(arguments_: readonly string[]): Promise<number> {
  try {
    const { evidenceDirectory, requireGo } = parseArguments(arguments_);
    const result = await verifyVerticalSliceEvidence({ evidenceDirectory });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return verificationExitCode(result, requireGo);
  } catch (error: unknown) {
    const code = error instanceof VerticalSliceEvidenceError ? error.code : "EVIDENCE_INPUT_INVALID";
    process.stdout.write(
      `${JSON.stringify({ integrity: "fail", decision: "no_go", errorCode: code }, null, 2)}\n`,
    );
    return VERTICAL_SLICE_EXIT_CODE.invalidEvidence;
  }
}

const currentModulePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentModulePath) {
  runVerticalSliceVerifier(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
