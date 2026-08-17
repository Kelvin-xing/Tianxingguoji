import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CrawlerSnapshotStore,
  SnapshotManifestError,
  type SnapshotManifest,
} from "../../../modules/schools/infrastructure/crawler/snapshot.ts";

const NOW = new Date("2026-08-10T04:00:00Z");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeBundle(
  directory: string,
  options: { health?: "pass" | "warn" | "fail"; warningReceipt?: SnapshotManifest["warning_receipt"] } = {},
): Promise<SnapshotManifest> {
  const health = options.health ?? "pass";
  const warnings = health === "warn" ? ["Review one high-priority record."] : [];
  const payloads = {
    "records.json": JSON.stringify([{ school_key: "school-1" }, { school_key: "school-2" }]),
    "review_queue.json": JSON.stringify([{ school_key: "school-2", review_priority: "high" }]),
    "run_summary.json": JSON.stringify({
      schema_version: "crawler-run-summary/v1",
      health: health === "pass" ? "ok" : health,
      records: { total: 2 },
      review_queue: { total: 1 },
      action_items: warnings,
    }),
  };
  const files = {
    "records.json": { schema_version: "crawler-records/v1", count: 2, bytes: Buffer.byteLength(payloads["records.json"]), sha256: sha(payloads["records.json"]) },
    "review_queue.json": { schema_version: "crawler-review-queue/v1", count: 1, bytes: Buffer.byteLength(payloads["review_queue.json"]), sha256: sha(payloads["review_queue.json"]) },
    "run_summary.json": { schema_version: "crawler-run-summary/v1", count: 1, bytes: Buffer.byteLength(payloads["run_summary.json"]), sha256: sha(payloads["run_summary.json"]) },
  } as const;
  const descriptor = {
    schema_version: "crawler-handoff/v1",
    state: "candidate",
    health,
    warnings,
    files,
    published_at: "2026-08-10T03:00:00Z",
    publisher: "synthetic-test",
    notes: "fixture",
  };
  const manifest: SnapshotManifest = {
    ...descriptor,
    manifest_sha256: sha(canonical(descriptor)),
    warning_receipt: options.warningReceipt ?? null,
  };
  await Promise.all([
    ...Object.entries(payloads).map(([name, value]) => writeFile(join(directory, name), value)),
    writeFile(join(directory, "publish_manifest.json"), JSON.stringify(manifest)),
  ]);
  return manifest;
}

async function fixture(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "crawler-snapshot-v1-"));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("valid exact-four candidate becomes the active immutable snapshot", async (context) => {
  const { directory, cleanup } = await fixture();
  context.after(cleanup);
  const expected = await writeBundle(directory);
  const store = new CrawlerSnapshotStore(directory, () => NOW);

  const active = await store.load();

  assert.equal(active.manifest.manifest_sha256, expected.manifest_sha256);
  assert.equal(active.records.length, 2);
  assert.equal(active.reviewQueue.length, 1);
});

test("partial or corrupt candidate preserves the prior active identity", async (context) => {
  const { directory, cleanup } = await fixture();
  context.after(cleanup);
  const first = await writeBundle(directory);
  const store = new CrawlerSnapshotStore(directory, () => NOW);
  await store.load();
  await writeFile(join(directory, "records.json"), JSON.stringify([{ school_key: "changed" }]));

  const retained = await store.load();

  assert.equal(retained.manifest.manifest_sha256, first.manifest_sha256);
  assert.equal(retained.records[0]?.school_key, "school-1");
});

test("otherwise-valid warning without exact receipt stays non-active and preserves prior identity", async (context) => {
  const { directory, cleanup } = await fixture();
  context.after(cleanup);
  const prior = await writeBundle(directory);
  const store = new CrawlerSnapshotStore(directory, () => NOW);
  await store.load();
  const warning = await writeBundle(directory, { health: "warn" });
  assert.notEqual(warning.manifest_sha256, prior.manifest_sha256);

  const retained = await store.load();

  assert.equal(retained.manifest.manifest_sha256, prior.manifest_sha256);
  assert.equal(store.lastFailure?.code, "WARNING_RECEIPT_INVALID");
});

test("exact unexpired warning receipt permits that candidate identity", async (context) => {
  const { directory, cleanup } = await fixture();
  context.after(cleanup);
  const unsigned = await writeBundle(directory, { health: "warn" });
  const receipt: NonNullable<SnapshotManifest["warning_receipt"]> = {
    receipt_id: "receipt-20260810-001",
    manifest_sha256: unsigned.manifest_sha256,
    warnings: unsigned.warnings,
    reviewer: { actor_id: "data-reviewer-1", recommendation: "recommend_accept" },
    founder: { actor_id: "founder-1", decision: "accept" },
    reason: "Reviewed this exact synthetic bundle.",
    accepted_at: "2026-08-10T03:00:00Z",
    expires_at: "2026-08-11T03:00:00Z",
  };
  await writeBundle(directory, { health: "warn", warningReceipt: receipt });

  const active = await new CrawlerSnapshotStore(directory, () => NOW).load();

  assert.equal(active.manifest.manifest_sha256, unsigned.manifest_sha256);
  assert.equal(active.manifest.warning_receipt?.receipt_id, receipt.receipt_id);
});

test("invalid initial candidate fails closed instead of returning empty data", async (context) => {
  const { directory, cleanup } = await fixture();
  context.after(cleanup);
  await writeBundle(directory, { health: "warn" });
  const store = new CrawlerSnapshotStore(directory, () => NOW);

  await assert.rejects(store.load(), (error: unknown) => {
    assert.ok(error instanceof SnapshotManifestError);
    assert.equal(error.code, "WARNING_RECEIPT_INVALID");
    return true;
  });
});

test("missing and extra files fail the exact file-set contract", async (context) => {
  const { directory, cleanup } = await fixture();
  context.after(cleanup);
  await writeBundle(directory);
  await unlink(join(directory, "review_queue.json"));
  await assert.rejects(new CrawlerSnapshotStore(directory, () => NOW).load(), (error: unknown) => {
    assert.ok(error instanceof SnapshotManifestError);
    assert.equal(error.code, "FILE_SET_MISMATCH");
    return true;
  });

  await writeFile(join(directory, "review_queue.json"), "[]");
  await writeFile(join(directory, "README.md"), "stale");
  await assert.rejects(new CrawlerSnapshotStore(directory, () => NOW).load(), (error: unknown) => {
    assert.ok(error instanceof SnapshotManifestError);
    assert.equal(error.code, "FILE_SET_MISMATCH");
    return true;
  });
});

test("wrong manifest schema and count fail closed", async (context) => {
  const { directory, cleanup } = await fixture();
  context.after(cleanup);
  const manifest = await writeBundle(directory);
  await writeFile(join(directory, "publish_manifest.json"), JSON.stringify({ ...manifest, schema_version: "crawler-handoff/v999" }));
  await assert.rejects(new CrawlerSnapshotStore(directory, () => NOW).load(), (error: unknown) => {
    assert.ok(error instanceof SnapshotManifestError);
    assert.equal(error.code, "SCHEMA_MISMATCH");
    return true;
  });

  const valid = await writeBundle(directory);
  const changed = {
    ...valid,
    files: { ...valid.files, "records.json": { ...valid.files["records.json"], count: 3 } },
  };
  await writeFile(join(directory, "publish_manifest.json"), JSON.stringify(changed));
  await assert.rejects(new CrawlerSnapshotStore(directory, () => NOW).load(), (error: unknown) => {
    assert.ok(error instanceof SnapshotManifestError);
    assert.equal(error.code, "COUNT_MISMATCH");
    return true;
  });
});

test("manifest identity binds metadata and future-dated warning receipts fail", async (context) => {
  const { directory, cleanup } = await fixture();
  context.after(cleanup);
  const manifest = await writeBundle(directory);
  await writeFile(
    join(directory, "publish_manifest.json"),
    JSON.stringify({ ...manifest, publisher: "different-publisher" }),
  );
  await assert.rejects(new CrawlerSnapshotStore(directory, () => NOW).load(), (error: unknown) => {
    assert.ok(error instanceof SnapshotManifestError);
    assert.equal(error.code, "HASH_MISMATCH");
    return true;
  });

  const unsigned = await writeBundle(directory, { health: "warn" });
  const futureReceipt: NonNullable<SnapshotManifest["warning_receipt"]> = {
    receipt_id: "receipt-future",
    manifest_sha256: unsigned.manifest_sha256,
    warnings: unsigned.warnings,
    reviewer: { actor_id: "data-reviewer-1", recommendation: "recommend_accept" },
    founder: { actor_id: "founder-1", decision: "accept" },
    reason: "Synthetic future receipt must not activate.",
    accepted_at: "2026-08-10T05:00:00Z",
    expires_at: "2026-08-10T06:00:00Z",
  };
  await writeBundle(directory, { health: "warn", warningReceipt: futureReceipt });
  await assert.rejects(new CrawlerSnapshotStore(directory, () => NOW).load(), (error: unknown) => {
    assert.ok(error instanceof SnapshotManifestError);
    assert.equal(error.code, "WARNING_RECEIPT_INVALID");
    return true;
  });
});
