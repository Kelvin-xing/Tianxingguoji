import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("document scan runtime is explicitly fake-backed outside production", async () => {
  const runtime = await readFile(
    resolve("modules/documents/infrastructure/scan-runtime.ts"),
    "utf8",
  );
  const config = await readFile(resolve("lib/runtime/document-transport-config.ts"), "utf8");

  assert.match(runtime, /deterministic-fake/);
  assert.match(runtime, /DeterministicFakeDocumentScanner/);
  assert.match(runtime, /DeterministicFakeDocumentScanQueue/);
  assert.match(config, /production-s3/);
  assert.match(config, /DOCUMENT_TRANSPORT_MODE/);
  assert.match(config, /DOCUMENT_FAKE_SIGNING_SECRET/);
  assert.doesNotMatch(runtime, /LOCAL_SYNTHETIC_LOCALSTACK|LOCAL_SYNTHETIC_CLAMAV/);
});

test("the retired local document worker is not exposed as a package command", async () => {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    scripts: Record<string, string | undefined>;
  };
  const worker = await readFile(resolve("workers/document-worker.ts"), "utf8");

  assert.equal(packageJson.scripts["worker:documents:local"], undefined);
  assert.match(worker, /DocumentWorkerUnavailable/);
});
