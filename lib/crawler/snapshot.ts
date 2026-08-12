import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type SnapshotManifestErrorCode =
  | "FILE_SET_MISMATCH"
  | "INVALID_JSON"
  | "SCHEMA_MISMATCH"
  | "COUNT_MISMATCH"
  | "HASH_MISMATCH"
  | "HEALTH_FAILED"
  | "WARNING_RECEIPT_INVALID";

type FileName = "records.json" | "review_queue.json" | "run_summary.json";

interface ManifestFileEntry {
  readonly schema_version: string;
  readonly count: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SnapshotWarningReceipt {
  readonly receipt_id: string;
  readonly manifest_sha256: string;
  readonly warnings: readonly string[];
  readonly reviewer: { readonly actor_id: string; readonly recommendation: "recommend_accept" };
  readonly founder: { readonly actor_id: string; readonly decision: "accept" };
  readonly reason: string;
  readonly accepted_at: string;
  readonly expires_at: string;
}

export interface SnapshotManifest {
  readonly schema_version: "crawler-handoff/v1";
  readonly state: "candidate";
  readonly health: "pass" | "warn" | "fail";
  readonly warnings: readonly string[];
  readonly files: Readonly<Record<FileName, ManifestFileEntry>>;
  readonly manifest_sha256: string;
  readonly published_at: string;
  readonly publisher: string;
  readonly notes: string;
  readonly warning_receipt: SnapshotWarningReceipt | null;
}

export interface ActiveCrawlerSnapshot {
  readonly manifest: SnapshotManifest;
  readonly records: readonly Record<string, unknown>[];
  readonly reviewQueue: readonly Record<string, unknown>[];
  readonly runSummary: Readonly<Record<string, unknown>>;
}

export class SnapshotManifestError extends Error {
  readonly code: SnapshotManifestErrorCode;

  constructor(code: SnapshotManifestErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SnapshotManifestError";
    this.code = code;
  }
}

const EXPECTED_FILES = ["publish_manifest.json", "records.json", "review_queue.json", "run_summary.json"] as const;
const PAYLOAD_SCHEMAS: Readonly<Record<FileName, string>> = {
  "records.json": "crawler-records/v1",
  "review_queue.json": "crawler-review-queue/v1",
  "run_summary.json": "crawler-run-summary/v1",
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(buffer: Buffer, fileName: string): unknown {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new SnapshotManifestError("INVALID_JSON", `${fileName} is not valid JSON`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function manifestDescriptor(manifest: SnapshotManifest): Record<string, unknown> {
  return {
    schema_version: manifest.schema_version,
    state: manifest.state,
    health: manifest.health,
    warnings: manifest.warnings,
    files: manifest.files,
    published_at: manifest.published_at,
    publisher: manifest.publisher,
    notes: manifest.notes,
  };
}

function validateReceipt(manifest: SnapshotManifest, now: Date): void {
  const receipt = manifest.warning_receipt;
  if (!receipt || !isObject(receipt.reviewer) || !isObject(receipt.founder)) {
    throw new SnapshotManifestError("WARNING_RECEIPT_INVALID", "warning receipt is required");
  }
  const acceptedAt = new Date(receipt.accepted_at);
  const expiresAt = new Date(receipt.expires_at);
  const duration = expiresAt.getTime() - acceptedAt.getTime();
  const valid =
    Boolean(receipt.receipt_id?.trim()) &&
    receipt.manifest_sha256 === manifest.manifest_sha256 &&
    canonicalJson(receipt.warnings) === canonicalJson(manifest.warnings) &&
    Boolean(receipt.reviewer.actor_id?.trim()) &&
    receipt.reviewer.recommendation === "recommend_accept" &&
    Boolean(receipt.founder.actor_id?.trim()) &&
    receipt.founder.decision === "accept" &&
    Boolean(receipt.reason?.trim()) &&
    Number.isFinite(acceptedAt.getTime()) &&
    Number.isFinite(expiresAt.getTime()) &&
    duration > 0 &&
    duration <= 24 * 60 * 60 * 1000 &&
    acceptedAt.getTime() <= now.getTime() &&
    now.getTime() <= expiresAt.getTime();
  if (!valid) {
    throw new SnapshotManifestError("WARNING_RECEIPT_INVALID", "receipt does not bind this exact unexpired warning bundle");
  }
}

function asManifest(value: unknown): SnapshotManifest {
  if (!isObject(value) || value.schema_version !== "crawler-handoff/v1" || value.state !== "candidate") {
    throw new SnapshotManifestError("SCHEMA_MISMATCH", "unsupported manifest schema or state");
  }
  const expectedKeys = [
    "files", "health", "manifest_sha256", "notes", "published_at", "publisher",
    "schema_version", "state", "warning_receipt", "warnings",
  ];
  if (Object.keys(value).sort().join() !== expectedKeys.sort().join()) {
    throw new SnapshotManifestError("SCHEMA_MISMATCH", "manifest fields are not exact");
  }
  if (
    typeof value.manifest_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.manifest_sha256) ||
    typeof value.published_at !== "string" ||
    !Number.isFinite(Date.parse(value.published_at)) ||
    typeof value.publisher !== "string" ||
    typeof value.notes !== "string"
  ) {
    throw new SnapshotManifestError("SCHEMA_MISMATCH", "manifest metadata is invalid");
  }
  if (!isObject(value.files) || Object.keys(value.files).sort().join() !== Object.keys(PAYLOAD_SCHEMAS).sort().join()) {
    throw new SnapshotManifestError("FILE_SET_MISMATCH", "manifest payload file set is not exact");
  }
  if (!Array.isArray(value.warnings) || !value.warnings.every((warning) => typeof warning === "string" && warning.trim())) {
    throw new SnapshotManifestError("SCHEMA_MISMATCH", "warning list is invalid");
  }
  return value as unknown as SnapshotManifest;
}

export async function validateCrawlerSnapshot(directory: string, now = new Date()): Promise<ActiveCrawlerSnapshot> {
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    throw new SnapshotManifestError("FILE_SET_MISMATCH", "snapshot directory is unavailable");
  }
  if (entries.sort().join() !== [...EXPECTED_FILES].sort().join()) {
    throw new SnapshotManifestError("FILE_SET_MISMATCH", "snapshot must contain exactly four files");
  }

  let buffers: Record<(typeof EXPECTED_FILES)[number], Buffer>;
  try {
    const values = await Promise.all(EXPECTED_FILES.map((name) => fs.readFile(path.join(directory, name))));
    buffers = Object.fromEntries(EXPECTED_FILES.map((name, index) => [name, values[index]])) as typeof buffers;
  } catch (error) {
    throw new SnapshotManifestError("FILE_SET_MISMATCH", "snapshot file disappeared during validation");
  }
  const manifest = asManifest(parseJson(buffers["publish_manifest.json"], "publish_manifest.json"));
  const records = parseJson(buffers["records.json"], "records.json");
  const reviewQueue = parseJson(buffers["review_queue.json"], "review_queue.json");
  const runSummary = parseJson(buffers["run_summary.json"], "run_summary.json");
  if (!Array.isArray(records) || !Array.isArray(reviewQueue) || !isObject(runSummary)) {
    throw new SnapshotManifestError("SCHEMA_MISMATCH", "payload JSON shapes are invalid");
  }

  const payloads: Record<FileName, { buffer: Buffer; value: unknown }> = {
    "records.json": { buffer: buffers["records.json"], value: records },
    "review_queue.json": { buffer: buffers["review_queue.json"], value: reviewQueue },
    "run_summary.json": { buffer: buffers["run_summary.json"], value: runSummary },
  };
  for (const fileName of Object.keys(PAYLOAD_SCHEMAS) as FileName[]) {
    const entry = manifest.files[fileName];
    if (!isObject(entry) || entry.schema_version !== PAYLOAD_SCHEMAS[fileName]) {
      throw new SnapshotManifestError("SCHEMA_MISMATCH", `unsupported ${fileName} schema`);
    }
    const payload = payloads[fileName];
    const count = Array.isArray(payload.value) ? payload.value.length : 1;
    if (entry.count !== count || entry.bytes !== payload.buffer.byteLength) {
      throw new SnapshotManifestError("COUNT_MISMATCH", `${fileName} count or byte count differs`);
    }
    if (entry.sha256 !== sha256(payload.buffer)) {
      throw new SnapshotManifestError("HASH_MISMATCH", `${fileName} SHA-256 differs`);
    }
  }

  const summaryRecords = isObject(runSummary.records) ? runSummary.records.total : undefined;
  const summaryReviews = isObject(runSummary.review_queue) ? runSummary.review_queue.total : undefined;
  if (summaryRecords !== records.length || summaryReviews !== reviewQueue.length) {
    throw new SnapshotManifestError("COUNT_MISMATCH", "run summary counts differ from payloads");
  }
  const summaryHealth = runSummary.health === "ok" ? "pass" : runSummary.health;
  const summaryWarnings = summaryHealth === "warn" ? runSummary.action_items : [];
  if (manifest.health !== summaryHealth || canonicalJson(manifest.warnings) !== canonicalJson(summaryWarnings)) {
    throw new SnapshotManifestError("HASH_MISMATCH", "manifest health or warnings differ from run summary");
  }
  if (manifest.manifest_sha256 !== sha256(canonicalJson(manifestDescriptor(manifest)))) {
    throw new SnapshotManifestError("HASH_MISMATCH", "canonical manifest identity differs");
  }
  if (manifest.health === "fail") throw new SnapshotManifestError("HEALTH_FAILED", "failed snapshot cannot activate");
  if (manifest.health === "warn") validateReceipt(manifest, now);
  else if (manifest.health !== "pass" || manifest.warning_receipt !== null) {
    throw new SnapshotManifestError("SCHEMA_MISMATCH", "pass requires no receipt and unknown health is unsupported");
  }

  return Object.freeze({
    manifest: Object.freeze(manifest),
    records: Object.freeze(records),
    reviewQueue: Object.freeze(reviewQueue),
    runSummary: Object.freeze(runSummary),
  });
}

export class CrawlerSnapshotStore {
  private active?: ActiveCrawlerSnapshot;
  lastFailure?: SnapshotManifestError;
  private readonly directory: string;
  private readonly now: () => Date;

  constructor(directory: string, now: () => Date = () => new Date()) {
    this.directory = directory;
    this.now = now;
  }

  async load(): Promise<ActiveCrawlerSnapshot> {
    try {
      const candidate = await validateCrawlerSnapshot(this.directory, this.now());
      this.active = candidate;
      this.lastFailure = undefined;
      return candidate;
    } catch (error) {
      const failure = error instanceof SnapshotManifestError
        ? error
        : new SnapshotManifestError("INVALID_JSON", "unexpected snapshot validation failure");
      this.lastFailure = failure;
      if (this.active) return this.active;
      throw failure;
    }
  }
}
