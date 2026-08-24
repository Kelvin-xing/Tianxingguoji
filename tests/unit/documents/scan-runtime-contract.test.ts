import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  DocumentScanRuntimeUnavailable,
  getDocumentScanRuntime,
} from "../../../modules/documents/infrastructure/scan-runtime.ts";

test("local worker pins the Release1 tenant and fixed non-user worker context", () => {
  const previous = Object.freeze({
    mode: process.env.APP_RUNTIME_MODE,
    organization: process.env.LOCAL_SYNTHETIC_ORGANIZATION_ID,
    worker: process.env.LOCAL_SYNTHETIC_DOCUMENT_WORKER_CONTEXT_ID,
  });
  try {
    process.env.APP_RUNTIME_MODE = "local-synthetic";
    process.env.LOCAL_SYNTHETIC_ORGANIZATION_ID = "52000000-0000-4000-8000-000000000001";
    process.env.LOCAL_SYNTHETIC_DOCUMENT_WORKER_CONTEXT_ID =
      "10000000-0000-4000-8000-000000000901";
    assert.throws(() => getDocumentScanRuntime(), DocumentScanRuntimeUnavailable);

    process.env.APP_RUNTIME_MODE = "production-aws";
    process.env.LOCAL_SYNTHETIC_ORGANIZATION_ID = "51000000-0000-4000-8000-000000000001";
    assert.throws(() => getDocumentScanRuntime(), DocumentScanRuntimeUnavailable);
  } finally {
    restore("APP_RUNTIME_MODE", previous.mode);
    restore("LOCAL_SYNTHETIC_ORGANIZATION_ID", previous.organization);
    restore("LOCAL_SYNTHETIC_DOCUMENT_WORKER_CONTEXT_ID", previous.worker);
  }
});

test("worker command loads an optional local env without overriding explicit harness env", async () => {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts["worker:documents:local"],
    "node --env-file-if-exists=.env.local --conditions=react-server workers/document-worker.ts",
  );
  const worker = await readFile(resolve("workers/document-worker.ts"), "utf8");
  assert.match(worker, /VisibilityTimeout:\s*180/u);
  assert.match(worker, /staleAfterMs:\s*STALE_SCAN_AFTER_MS/u);
  assert.match(worker, /validateLocalQueueUrl/u);
  assert.match(worker, /useQueueUrlAsEndpoint:\s*false/u);
  assert.match(worker, /LOCAL_SYNTHETIC_DOCUMENT_WORKER_SAFE_EVIDENCE/u);
  assert.match(worker, /root\.Event !== "s3:TestEvent"/u);
  assert.match(worker, /if \(isDocumentS3TestEventMessage\(message, expectedBucket\)\) return "delete";/u);
  assert.match(worker, /Object\.hasOwn\(root, "Records"\)/u);
  assert.match(
    worker,
    /emitDocumentWorkerSafeEvidence\(DOCUMENT_WORKER_MAIN_DELETE_REQUESTED_MARKER\);[\s\S]*await deleteMessage[\s\S]*emitDocumentWorkerSafeEvidence\(DOCUMENT_WORKER_MAIN_DELETE_COMPLETED_MARKER\);/u,
  );
  const requeuePublisher = await readFile(
    resolve("modules/documents/infrastructure/local-scan-requeue-publisher.ts"),
    "utf8",
  );
  assert.match(requeuePublisher, /useQueueUrlAsEndpoint:\s*false/u);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
