import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EVIDENCE_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_SOURCE = "synthetic" as const;

export type HarnessTerminalState =
  | "passed"
  | "needs_human"
  | "blocked"
  | "budget_exhausted"
  | "cancelled";
export type EvidenceVerification = "pass" | "fail";
export type ReleaseEvidenceState = Exclude<HarnessTerminalState, "passed"> | "passed";
export type ApprovalStatus = "not_requested" | "pending" | "approved" | "rejected";
export type EvidenceScalar = string | number | boolean | null;

export interface EvidenceScenarioInput {
  readonly id: string;
  readonly description: string;
  readonly expectedState: HarnessTerminalState;
  readonly actualState: HarnessTerminalState;
  readonly evidence: Readonly<Record<string, EvidenceScalar>>;
  readonly artifactPaths: readonly string[];
}

export interface EvidenceArtifactInput {
  readonly path: string;
  readonly content: string;
}

export interface EvidenceApprovalInput {
  readonly gate: "security" | "privacy" | "operations";
  readonly status: ApprovalStatus;
  readonly reviewerId: string | null;
  readonly payloadHash: string | null;
}

export interface EvidenceManifestInput {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly evidenceType: "release1.synthetic";
  readonly source: typeof EVIDENCE_SOURCE;
  readonly runId: string;
  readonly inputVersion: string;
  readonly generatedAt: string;
  readonly scenarios: readonly EvidenceScenarioInput[];
  readonly artifacts: readonly EvidenceArtifactInput[];
  readonly approvals?: readonly EvidenceApprovalInput[];
}

export interface EvidenceScenarioManifest extends EvidenceScenarioInput {
  readonly verification: EvidenceVerification;
}

export interface EvidenceArtifactManifest {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface EvidenceManifest {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly evidenceType: "release1.synthetic";
  readonly source: typeof EVIDENCE_SOURCE;
  readonly runId: string;
  readonly inputVersion: string;
  readonly generatedAt: string;
  readonly verification: EvidenceVerification;
  readonly releaseState: ReleaseEvidenceState;
  readonly approvalStatus: ApprovalStatus;
  readonly releaseEligible: false;
  readonly scenarios: readonly EvidenceScenarioManifest[];
  readonly artifacts: readonly EvidenceArtifactManifest[];
  readonly approvals: readonly EvidenceApprovalInput[];
  readonly redaction: {
    readonly mode: "synthetic-only";
    readonly rawPiiDetected: false;
    readonly secretDetected: false;
  };
  readonly manifestSha256: string;
}

export interface WriteEvidenceBundleOptions {
  readonly overwrite?: boolean;
}

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SCENARIO_ID = /^[a-z][a-z0-9._:-]{0,127}$/;
const SAFE_ARTIFACT_PATH = /^[a-z0-9][a-z0-9._/-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SENSITIVE_KEY_PATTERN =
  /(?:email|phone|name|birth|dob|address|token|secret|password|cookie|authorization|private[_ -]?key|content|body)/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /\b(?:\+?852[\s-]?)?[2-9]\d{3}[\s-]\d{4}\b/;
const SECRET_TEXT_PATTERN =
  /\b(?:password|passwd|secret|token|authorization|private[_ -]?key)\b/i;

export function createEvidenceManifest(input: EvidenceManifestInput): EvidenceManifest {
  validateInputHeader(input);
  assertSafeIdentifier(input.runId, "runId");
  assertSafeIdentifier(input.inputVersion, "inputVersion");
  assertTimestamp(input.generatedAt, "generatedAt");
  if (input.scenarios.length === 0) throw new EvidenceInputError("At least one scenario is required.");

  const artifacts = normalizeArtifacts(input.artifacts);
  const artifactPaths = new Set(artifacts.map(({ path }) => path));
  const scenarioIds = new Set<string>();
  for (const scenario of input.scenarios) {
    if (scenarioIds.has(scenario.id)) {
      throw new EvidenceInputError(`Duplicate scenario ID: ${scenario.id}`);
    }
    scenarioIds.add(scenario.id);
  }
  const scenarios = input.scenarios
    .map((scenario) => normalizeScenario(scenario, artifactPaths))
    .sort((left, right) => left.id.localeCompare(right.id));
  const approvals = normalizeApprovals(input.approvals ?? []);
  const verification: EvidenceVerification = scenarios.every(
    (scenario) => scenario.expectedState === scenario.actualState,
  )
    ? "pass"
    : "fail";
  const releaseState = calculateReleaseState(scenarios);
  const approvalStatus = calculateApprovalStatus(approvals);

  const unsignedManifest = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceType: input.evidenceType,
    source: EVIDENCE_SOURCE,
    runId: input.runId,
    inputVersion: input.inputVersion,
    generatedAt: input.generatedAt,
    verification,
    releaseState,
    approvalStatus,
    releaseEligible: false as const,
    scenarios,
    artifacts,
    approvals,
    redaction: {
      mode: "synthetic-only" as const,
      rawPiiDetected: false as const,
      secretDetected: false as const,
    },
  };

  return deepFreeze({
    ...unsignedManifest,
    manifestSha256: sha256(canonicalize(unsignedManifest)),
  });
}

export async function writeEvidenceBundle(
  input: EvidenceManifestInput,
  outputDirectory: string,
  options: WriteEvidenceBundleOptions = {},
): Promise<EvidenceManifest> {
  const manifest = createEvidenceManifest(input);
  await mkdir(outputDirectory, { recursive: true });
  const writeFlag = options.overwrite === true ? "w" : "wx";

  for (const artifact of input.artifacts) {
    const artifactPath = resolveArtifactPath(outputDirectory, artifact.path);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, artifact.content, { encoding: "utf8", flag: writeFlag });
  }

  await writeFile(
    resolve(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: writeFlag },
  );
  return manifest;
}

export class EvidenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceInputError";
  }
}

function validateInputHeader(input: EvidenceManifestInput): void {
  if (input.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new EvidenceInputError("Unsupported evidence schema version.");
  }
  if (input.evidenceType !== "release1.synthetic") {
    throw new EvidenceInputError("Evidence type must be release1.synthetic.");
  }
  if (input.source !== EVIDENCE_SOURCE) {
    throw new EvidenceInputError("Evidence source must be synthetic.");
  }
}

function normalizeScenario(
  scenario: EvidenceScenarioInput,
  artifactPaths: ReadonlySet<string>,
): EvidenceScenarioManifest {
  if (!SAFE_SCENARIO_ID.test(scenario.id)) {
    throw new EvidenceInputError(`Unsafe scenario ID: ${scenario.id}`);
  }
  assertSafeText(scenario.description, `scenario ${scenario.id} description`);
  assertState(scenario.expectedState);
  assertState(scenario.actualState);
  const artifactRefs = [...new Set(scenario.artifactPaths.map(normalizeArtifactPath))].sort();
  for (const artifactPath of artifactRefs) {
    if (!artifactPaths.has(artifactPath)) {
      throw new EvidenceInputError(
        `Scenario ${scenario.id} references an artifact that is not present: ${artifactPath}`,
      );
    }
  }
  const evidence = normalizeEvidence(scenario.evidence, scenario.id);
  return deepFreeze({
    id: scenario.id,
    description: scenario.description,
    expectedState: scenario.expectedState,
    actualState: scenario.actualState,
    evidence,
    artifactPaths: artifactRefs,
    verification: scenario.expectedState === scenario.actualState ? "pass" : "fail",
  });
}

function normalizeArtifacts(
  artifacts: readonly EvidenceArtifactInput[],
): readonly EvidenceArtifactManifest[] {
  const seen = new Set<string>();
  return artifacts
    .map((artifact) => {
      const path = normalizeArtifactPath(artifact.path);
      if (seen.has(path)) throw new EvidenceInputError(`Duplicate artifact path: ${path}`);
      seen.add(path);
      assertSafeArtifactContent(artifact.content, `artifact ${path}`);
      return {
        path,
        sha256: sha256(artifact.content),
        bytes: Buffer.byteLength(artifact.content, "utf8"),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeApprovals(
  approvals: readonly EvidenceApprovalInput[],
): readonly EvidenceApprovalInput[] {
  const seen = new Set<string>();
  return approvals
    .map((approval) => {
      if (seen.has(approval.gate)) throw new EvidenceInputError(`Duplicate approval gate: ${approval.gate}`);
      seen.add(approval.gate);
      if (!["security", "privacy", "operations"].includes(approval.gate)) {
        throw new EvidenceInputError(`Unknown approval gate: ${approval.gate}`);
      }
      if (!["not_requested", "pending", "approved", "rejected"].includes(approval.status)) {
        throw new EvidenceInputError(`Unknown approval status: ${approval.status}`);
      }
      if (approval.reviewerId !== null) assertSafeIdentifier(approval.reviewerId, "reviewerId");
      if (approval.payloadHash !== null && !SHA256_PATTERN.test(approval.payloadHash)) {
        throw new EvidenceInputError(`Approval payload hash is not SHA-256: ${approval.gate}`);
      }
      if (
        approval.status === "approved" &&
        (approval.reviewerId === null || approval.payloadHash === null)
      ) {
        throw new EvidenceInputError(
          `Approved evidence gate requires reviewer and payload hash: ${approval.gate}`,
        );
      }
      return deepFreeze({ ...approval });
    })
    .sort((left, right) => left.gate.localeCompare(right.gate));
}

function normalizeEvidence(
  evidence: Readonly<Record<string, EvidenceScalar>>,
  scenarioId: string,
): Readonly<Record<string, EvidenceScalar>> {
  const normalized: Record<string, EvidenceScalar> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new EvidenceInputError(`Sensitive evidence key is not allowed: ${scenarioId}.${key}`);
    }
    assertSafeText(key, `scenario ${scenarioId} evidence key`);
    if (typeof value === "string") assertSafeText(value, `scenario ${scenarioId}.${key}`);
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new EvidenceInputError(`Non-finite evidence value: ${scenarioId}.${key}`);
    }
    normalized[key] = value;
  }
  return deepFreeze(Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right))));
}

function normalizeArtifactPath(path: string): string {
  if (
    !SAFE_ARTIFACT_PATH.test(path) ||
    path.startsWith("/") ||
    path.includes("..") ||
    path.includes("\\")
  ) {
    throw new EvidenceInputError(`Unsafe artifact path: ${path}`);
  }
  if (path === "manifest.json") {
    throw new EvidenceInputError("manifest.json is reserved for the compiled manifest.");
  }
  return path;
}

function resolveArtifactPath(outputDirectory: string, path: string): string {
  const normalized = normalizeArtifactPath(path);
  const resolvedOutput = resolve(outputDirectory);
  const resolvedArtifact = resolve(resolvedOutput, normalized);
  if (resolvedArtifact !== resolvedOutput && !resolvedArtifact.startsWith(`${resolvedOutput}/`)) {
    throw new EvidenceInputError(`Artifact path escapes output directory: ${path}`);
  }
  return resolvedArtifact;
}

function assertSafeText(value: string, context: string): void {
  if (EMAIL_PATTERN.test(value) || PHONE_PATTERN.test(value) || SECRET_TEXT_PATTERN.test(value)) {
    throw new EvidenceInputError(`Sensitive text is not allowed in ${context}.`);
  }
}

function assertSafeArtifactContent(content: string, context: string): void {
  assertSafeText(content, context);

  try {
    const parsed: unknown = JSON.parse(content);
    assertSafeJson(parsed, context);
  } catch (error: unknown) {
    if (error instanceof EvidenceInputError) throw error;
    // Plain-text evidence is still checked by assertSafeText above.
  }
}

function assertSafeJson(value: unknown, context: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJson(item, `${context}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        throw new EvidenceInputError(`Sensitive artifact key is not allowed: ${context}.${key}`);
      }
      assertSafeText(key, `${context} key`);
      assertSafeJson(nested, `${context}.${key}`);
    }
    return;
  }
  if (typeof value === "string") assertSafeText(value, context);
}

function assertSafeIdentifier(value: string, context: string): void {
  if (!SAFE_IDENTIFIER.test(value)) throw new EvidenceInputError(`Unsafe ${context}: ${value}`);
}

function assertTimestamp(value: string, context: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new EvidenceInputError(`Invalid ${context}.`);
}

function assertState(value: string): asserts value is HarnessTerminalState {
  if (!["passed", "needs_human", "blocked", "budget_exhausted", "cancelled"].includes(value)) {
    throw new EvidenceInputError(`Unknown harness terminal state: ${value}`);
  }
}

function calculateReleaseState(
  scenarios: readonly EvidenceScenarioManifest[],
): ReleaseEvidenceState {
  const states = new Set(scenarios.map(({ actualState }) => actualState));
  if (states.has("blocked")) return "blocked";
  if (states.has("budget_exhausted")) return "budget_exhausted";
  if (states.has("cancelled")) return "cancelled";
  if (states.has("needs_human")) return "needs_human";
  return "passed";
}

function calculateApprovalStatus(approvals: readonly EvidenceApprovalInput[]): ApprovalStatus {
  if (approvals.some(({ status }) => status === "rejected")) return "rejected";
  if (approvals.length === 0 || approvals.some(({ status }) => status === "not_requested")) {
    return "not_requested";
  }
  if (approvals.every(({ status }) => status === "approved")) return "approved";
  return "pending";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EvidenceInputError("Cannot hash a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
      .join(",")}}`;
  }
  throw new EvidenceInputError("Evidence contains an unsupported value.");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function readArgument(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index >= 0 ? arguments_[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new EvidenceInputError(`Missing argument: ${name}`);
  return value;
}

async function runCli(arguments_: readonly string[]): Promise<number> {
  const inputPath = readArgument(arguments_, "--input");
  const outputPath = readArgument(arguments_, "--output");
  const input = JSON.parse(await readFile(inputPath, "utf8")) as EvidenceManifestInput;
  const manifest = await writeEvidenceBundle(input, outputPath, {
    overwrite: arguments_.includes("--force"),
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.verification === "pass" ? 0 : 2;
}

const currentModulePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentModulePath) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Evidence manifest generation failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
