import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DocumentTransportConfigurationError,
  loadDocumentTransportConfig,
} from "../../../lib/runtime/document-transport-config.ts";
import { createOpaqueDocumentObjectKey } from "../../../modules/documents/domain/contract.ts";
import type { DocumentObjectReceiptService } from "../../../modules/documents/application/object-receipt-service.ts";
import type { DocumentScanService } from "../../../modules/documents/application/scan-service.ts";
import { DeterministicFakeDocumentScanner } from "../../../modules/documents/infrastructure/deterministic-fake-scanner.ts";
import { DeterministicFakeDocumentTransport } from "../../../modules/documents/infrastructure/deterministic-fake-transport.ts";
import {
  DeterministicFakeDocumentScanQueue,
  DocumentScanRuntimeUnavailable,
  getDocumentScanRuntime,
} from "../../../modules/documents/infrastructure/scan-runtime.ts";
import {
  DocumentTransferRuntimeUnavailable,
  getDocumentTransferRuntime,
} from "../../../modules/documents/infrastructure/transfer-runtime.ts";

const DOCUMENT_ID = "81000000-0000-4000-8000-000000000001";
const VERSION_ID = "81000000-0000-4000-8000-000000000002";

test("local compose and active P4 scripts have no LocalStack, ClamAV, or document worker", async () => {
  const [compose, environment, packageText, server, transferRuntime, scanRuntime] = await Promise.all([
    readFile("compose.local.yml", "utf8"),
    readFile(".env.local.example", "utf8"),
    readFile("package.json", "utf8"),
    readFile("modules/documents/server.ts", "utf8"),
    readFile("modules/documents/infrastructure/transfer-runtime.ts", "utf8"),
    readFile("modules/documents/infrastructure/scan-runtime.ts", "utf8"),
  ]);
  const packageJson = JSON.parse(packageText) as { scripts: Record<string, string> };

  assert.doesNotMatch(compose, /localstack|clamav|3310|4566/i);
  assert.doesNotMatch(environment, /LOCAL_SYNTHETIC_(?:LOCALSTACK|CLAMAV|S3|SQS|AWS)/);
  assert.equal(packageJson.scripts["worker:documents:local"], undefined);
  assert.equal(packageJson.scripts["test:doc-02-dev-http"], undefined);
  assert.equal(packageJson.scripts["test:doc-02-dev-browser"], undefined);
  assert.doesNotMatch(server, /local-object-store|clamav-scanner/);
  assert.doesNotMatch(transferRuntime, /LocalStack|ClamAV|local-object-store|clamav-scanner/);
  assert.doesNotMatch(scanRuntime, /LocalStack|ClamAV|local-object-store|clamav-scanner/);
});

test("deterministic fake is explicit, non-production, version exact, and checksum bound", async () => {
  const config = loadDocumentTransportConfig(fakeEnvironment());
  assert.equal(config.mode, "deterministic-fake");
  if (config.mode !== "deterministic-fake") assert.fail("fake config required");
  const transport = new DeterministicFakeDocumentTransport({ config, now: () => 1_800_000_000_000 });
  const bytes = new Uint8Array(1_048_576);
  bytes.set(Buffer.from("%PDF-1.7\n", "ascii"));
  const checksum = createHash("sha256").update(bytes).digest("base64");
  const key = createOpaqueDocumentObjectKey(DOCUMENT_ID, VERSION_ID);
  const intent = await transport.issueUploadIntent({
    bucket: config.bucket,
    key,
    contentType: "application/pdf",
    checksumSha256Base64: checksum,
    expiresInSeconds: 600,
  });
  assert.equal(intent.url.startsWith(`${config.origin}/api/v1/documents/deterministic-transport/`), true);
  assert.equal(intent.url.includes(key), false);
  const token = new URL(intent.url).pathname.split("/").at(-1);
  assert.ok(token);
  const uploaded = await transport.put(token, new Request(intent.url, {
    method: "PUT",
    headers: { "content-type": "application/pdf", "x-amz-checksum-sha256": checksum },
    body: bytes,
  }));
  assert.match(uploaded.providerVersionId, /^fake-v1-[0-9a-f]{64}$/);
  assert.deepEqual(await transport.headExact({
    bucket: config.bucket,
    key,
    providerVersionId: uploaded.providerVersionId,
  }), {
    sizeBytes: bytes.byteLength,
    contentType: "application/pdf",
    checksumSha256Base64: checksum,
  });
  const download = await transport.issueDownloadIntent({
    bucket: config.bucket,
    key,
    providerVersionId: uploaded.providerVersionId,
    expiresInSeconds: 300,
  });
  const stored = await transport.get(new URL(download.url).pathname.split("/").at(-1) ?? "");
  assert.equal(stored.bytes.byteLength, bytes.byteLength);
});

test("Vercel test/preview uses the same fake transport contract as local", () => {
  const config = loadDocumentTransportConfig(vercelFakeEnvironment());
  assert.deepEqual(config, {
    mode: "deterministic-fake",
    region: "ap-east-1",
    bucket: "tianxing-preview-documents",
    origin: "https://synthetic-preview.vercel.app",
    signingSecret: "vercel-preview-test-secret-at-least-32-characters",
    organizationId: "51000000-0000-4000-8000-000000000001",
    workerContextId: "10000000-0000-4000-8000-000000000901",
  });
});

test("explicit fake scanner and queue acknowledge a deterministic clean state advance", async () => {
  const config = loadDocumentTransportConfig(fakeEnvironment());
  if (config.mode !== "deterministic-fake") assert.fail("fake config required");
  const transport = new DeterministicFakeDocumentTransport({ config, now: () => 1_800_000_000_000 });
  const bytes = new Uint8Array(1_048_576);
  bytes.set(Buffer.from("%PDF-1.7\n", "ascii"));
  const checksum = createHash("sha256").update(bytes).digest("base64");
  const key = createOpaqueDocumentObjectKey(DOCUMENT_ID, VERSION_ID);
  const intent = await transport.issueUploadIntent({
    bucket: config.bucket,
    key,
    contentType: "application/pdf",
    checksumSha256Base64: checksum,
    expiresInSeconds: 600,
  });
  const uploaded = await transport.put(new URL(intent.url).pathname.split("/").at(-1) ?? "", new Request(intent.url, {
    method: "PUT",
    headers: { "content-type": "application/pdf", "x-amz-checksum-sha256": checksum },
    body: bytes,
  }));
  let completedEngine: string | undefined;
  const work = Object.freeze({
    id: "81000000-0000-4000-8000-000000000003",
    organizationId: config.organizationId,
    documentVersionId: VERSION_ID,
    bucket: config.bucket,
    key,
    versionId: uploaded.providerVersionId,
    scanPolicyVersion: "clamav-release1-v1",
    attemptCount: 1,
    state: "running" as const,
  });
  const queue = new DeterministicFakeDocumentScanQueue({
    objectStore: transport,
    receiptService: {
      async receive() { return { status: "ready" as const }; },
    } as unknown as DocumentObjectReceiptService,
    service: {
      async claimScanWork() { return { status: "claimed" as const, work }; },
      async completeScanWork(input: { scannerEngine?: string }) {
        completedEngine = input.scannerEngine;
        return { status: "available" as const, workId: work.id, documentVersionId: VERSION_ID };
      },
    } as unknown as DocumentScanService,
    scanner: new DeterministicFakeDocumentScanner({ reader: transport, bucket: config.bucket }),
  });
  assert.equal(await queue.publish({
    eventId: "fake-object-test",
    requestId: "fake-scan-test",
    bucket: config.bucket,
    key,
    versionId: uploaded.providerVersionId,
    scanPolicyVersion: "clamav-release1-v1",
    deliveryAttempt: 1,
  }), "available");
  assert.equal(completedEngine, "deterministic-fake-release1");
});

test("missing fake opt-in and every production composition fail closed", () => {
  assert.throws(
    () => loadDocumentTransportConfig({ ...fakeEnvironment(), DOCUMENT_TRANSPORT_MODE: undefined }),
    DocumentTransportConfigurationError,
  );
  withEnvironment(productionEnvironment(false), () => {
    assert.throws(() => getDocumentTransferRuntime(), DocumentTransferRuntimeUnavailable);
  });
  withEnvironment(productionEnvironment(true), () => {
    assert.throws(() => getDocumentTransferRuntime(), DocumentTransferRuntimeUnavailable);
  });
  assert.throws(() => getDocumentScanRuntime(), DocumentScanRuntimeUnavailable);
});

function fakeEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "development",
    NODE_ENV: "development",
    APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "database-test",
    DOCUMENT_TRANSPORT_MODE: "deterministic-fake",
    DOCUMENT_FAKE_REGION: "ap-east-1",
    DOCUMENT_FAKE_BUCKET: "tianxing-local-documents",
    DOCUMENT_FAKE_ORIGIN: "http://localhost:3000",
    DOCUMENT_FAKE_SIGNING_SECRET: "local-only-test-secret-at-least-32-characters",
    DOCUMENT_FAKE_ORGANIZATION_ID: "51000000-0000-4000-8000-000000000001",
    DOCUMENT_FAKE_WORKER_CONTEXT_ID: "10000000-0000-4000-8000-000000000901",
  };
}

function productionEnvironment(configured: boolean): Record<string, string | undefined> {
  return {
    APP_ENV: "production",
    NODE_ENV: "production",
    APP_RUNTIME_MODE: "production-aws",
    AUTH_MODE: "cognito",
    ...(configured
      ? {
          DOCUMENT_TRANSPORT_MODE: "production-s3",
          DOCUMENT_S3_REGION: "ap-east-1",
          DOCUMENT_S3_BUCKET: "tianxing-production-documents",
        }
      : {}),
  };
}

function vercelFakeEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "test",
    NODE_ENV: "production",
    APP_RUNTIME_MODE: "test-database",
    AUTH_MODE: "database-test",
    VERCEL: "1",
    VERCEL_ENV: "preview",
    DOCUMENT_TRANSPORT_MODE: "deterministic-fake",
    DOCUMENT_FAKE_REGION: "ap-east-1",
    DOCUMENT_FAKE_BUCKET: "tianxing-preview-documents",
    DOCUMENT_FAKE_ORIGIN: "https://synthetic-preview.vercel.app",
    DOCUMENT_FAKE_SIGNING_SECRET: "vercel-preview-test-secret-at-least-32-characters",
    DOCUMENT_FAKE_ORGANIZATION_ID: "51000000-0000-4000-8000-000000000001",
    DOCUMENT_FAKE_WORKER_CONTEXT_ID: "10000000-0000-4000-8000-000000000901",
  };
}

function withEnvironment(environment: Record<string, string | undefined>, action: () => void): void {
  const names = [
    "APP_ENV", "NODE_ENV", "APP_RUNTIME_MODE", "AUTH_MODE", "DOCUMENT_TRANSPORT_MODE",
    "DOCUMENT_S3_REGION", "DOCUMENT_S3_BUCKET", "DOCUMENT_FAKE_REGION",
    "DOCUMENT_FAKE_BUCKET", "DOCUMENT_FAKE_ORIGIN", "DOCUMENT_FAKE_SIGNING_SECRET",
    "DOCUMENT_FAKE_ORGANIZATION_ID", "DOCUMENT_FAKE_WORKER_CONTEXT_ID",
    "VERCEL", "VERCEL_ENV",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(environment)) {
      if (value !== undefined) process.env[name] = value;
    }
    action();
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
