import assert from "node:assert/strict";
import test from "node:test";

import {
  DocumentObjectReceiptService,
  type DocumentObjectReceiptRepository,
} from "../../../modules/documents/application/object-receipt-service.ts";
import { createOpaqueDocumentObjectKey } from "../../../modules/documents/domain/contract.ts";
import type { DocumentScanEvent } from "../../../modules/documents/application/scan-service.ts";

const ORGANIZATION_ID = "51000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "81000000-0000-4000-8000-000000000001";
const VERSION_ID = "81000000-0000-4000-8000-000000000002";

test("repository controls lazy bounded HEAD and abandoned classification performs no HEAD", async () => {
  let heads = 0;
  const repository = {
    async receive() {
      return { status: "abandoned_cleanup", documentVersionId: VERSION_ID } as const;
    },
    async recordAbandonedObjectRemoval() {
      return { status: "recorded" } as const;
    },
    async recordUnboundProviderVersionRemoval() {
      return { status: "recorded" } as const;
    },
  } satisfies DocumentObjectReceiptRepository;
  const service = serviceWith(repository);
  assert.deepEqual(
    await service.receive(event(), async () => {
      heads += 1;
      throw new Error("must not HEAD abandoned objects");
    }),
    { status: "abandoned_cleanup", documentVersionId: VERSION_ID },
  );
  assert.equal(heads, 0);
});

test("HEAD deadline begins lazily and passes an aborted signal on timeout", async () => {
  let repositoryEntered = false;
  let signalAborted = false;
  const repository = {
    async receive(input: Parameters<DocumentObjectReceiptRepository["receive"]>[0]) {
      repositoryEntered = true;
      await input.loadHead();
      throw new Error("unreachable");
    },
    async recordAbandonedObjectRemoval() {
      return { status: "recorded" } as const;
    },
    async recordUnboundProviderVersionRemoval() {
      return { status: "recorded" } as const;
    },
  } satisfies DocumentObjectReceiptRepository;
  const service = serviceWith(repository, 250);
  await assert.rejects(
    () => service.receive(event(), (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        signalAborted = true;
        reject(new Error("bounded head timeout"));
      }, { once: true });
    })),
    /bounded head timeout/u,
  );
  assert.equal(repositoryEntered, true);
  assert.equal(signalAborted, true);
});

test("HEAD deadline rejects even when the provider callback ignores abort", async () => {
  const repository = {
    async receive(input: Parameters<DocumentObjectReceiptRepository["receive"]>[0]) {
      await input.loadHead();
      throw new Error("unreachable");
    },
    async recordAbandonedObjectRemoval() {
      return { status: "recorded" } as const;
    },
    async recordUnboundProviderVersionRemoval() {
      return { status: "recorded" } as const;
    },
  } satisfies DocumentObjectReceiptRepository;
  const startedAt = Date.now();
  await assert.rejects(
    () => serviceWith(repository, 250).receive(event(), async () => new Promise(() => undefined)),
    /DOCUMENT_OBJECT_RECEIPT_UNAVAILABLE/u,
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test("rejects malformed repository classifications before cleanup can proceed", async () => {
  const repository = {
    async receive() {
      return { status: "abandoned_cleanup", documentVersionId: DOCUMENT_ID } as const;
    },
    async recordAbandonedObjectRemoval() {
      return { status: "recorded" } as const;
    },
    async recordUnboundProviderVersionRemoval() {
      return { status: "recorded" } as const;
    },
  } satisfies DocumentObjectReceiptRepository;
  await assert.rejects(
    () => serviceWith(repository).receive(event(), async () => ({
      sizeBytes: 1,
      contentType: "application/pdf",
      checksumSha256Base64: "A".repeat(43) + "=",
    })),
    /DOCUMENT_OBJECT_RECEIPT_UNAVAILABLE/u,
  );
});

test("cleanup effect is PII-free and idempotency is stable per exact provider object", async () => {
  const keys: string[] = [];
  const bundles: unknown[] = [];
  const repository = {
    async receive() { return { status: "duplicate" } as const; },
    async recordAbandonedObjectRemoval(
      input: Parameters<DocumentObjectReceiptRepository["recordAbandonedObjectRemoval"]>[0],
    ) {
      keys.push(input.effectIdempotencyKey);
      bundles.push(input.createEffects());
      return keys.length === 1 ? { status: "recorded" } as const : { status: "duplicate" } as const;
    },
    async recordUnboundProviderVersionRemoval() {
      return { status: "recorded" } as const;
    },
  } satisfies DocumentObjectReceiptRepository;
  const service = serviceWith(repository);
  assert.deepEqual(await service.recordAbandonedObjectRemoval(event(), VERSION_ID), { status: "recorded" });
  assert.deepEqual(await service.recordAbandonedObjectRemoval(event(), VERSION_ID), { status: "duplicate" });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0] ?? "", /^document-abandoned-object-removed-[a-f0-9]{64}$/u);

  const serialized = JSON.stringify(bundles);
  assert.match(serialized, /documents\.abandoned_object_removed/u);
  assert.doesNotMatch(serialized, /provider-v1|documents\/|checksum|content_type|size_bytes|filename/u);
});

test("unbound provider cleanup is exact, stable per provider version and PII-free", async () => {
  const keys: string[] = [];
  const bundles: unknown[] = [];
  const repository = {
    async receive() {
      return { status: "unbound_provider_version_cleanup", documentVersionId: VERSION_ID } as const;
    },
    async recordAbandonedObjectRemoval() {
      return { status: "recorded" } as const;
    },
    async recordUnboundProviderVersionRemoval(
      input: Parameters<DocumentObjectReceiptRepository["recordUnboundProviderVersionRemoval"]>[0],
    ) {
      keys.push(input.effectIdempotencyKey);
      bundles.push(input.createEffects());
      return keys.length === 2 ? { status: "duplicate" } as const : { status: "recorded" } as const;
    },
  } satisfies DocumentObjectReceiptRepository;
  const service = serviceWith(repository);
  let heads = 0;
  assert.deepEqual(await service.receive(event(), async () => {
    heads += 1;
    throw new Error("must not HEAD an unbound provider version");
  }), { status: "unbound_provider_version_cleanup", documentVersionId: VERSION_ID });
  assert.equal(heads, 0);

  assert.deepEqual(
    await service.recordUnboundProviderVersionRemoval(event(), VERSION_ID),
    { status: "recorded" },
  );
  assert.deepEqual(
    await service.recordUnboundProviderVersionRemoval(event(), VERSION_ID),
    { status: "duplicate" },
  );
  assert.deepEqual(
    await service.recordUnboundProviderVersionRemoval(
      { ...event(), versionId: "provider-v2" },
      VERSION_ID,
    ),
    { status: "recorded" },
  );
  assert.equal(keys.length, 3);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.match(keys[0] ?? "", /^document-unbound-provider-version-removed-[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(bundles);
  assert.match(serialized, /documents\.unbound_provider_version_removed/u);
  assert.doesNotMatch(serialized, /provider-v1|provider-v2|documents\/|checksum|content_type|size_bytes|filename/u);
});

function serviceWith(repository: DocumentObjectReceiptRepository, headTimeoutMs = 2_000) {
  return new DocumentObjectReceiptService({
    repository,
    organizationId: ORGANIZATION_ID,
    headTimeoutMs,
    now: () => 1_787_548_800_000,
    createId: uuidSequence(),
  });
}

function event(): DocumentScanEvent {
  return Object.freeze({
    eventId: "doc02-event-1",
    requestId: "doc02-request-1",
    bucket: "tianxing-documents-local",
    key: createOpaqueDocumentObjectKey(DOCUMENT_ID, VERSION_ID),
    versionId: "provider-v1",
    scanPolicyVersion: "clamav-release1-v1",
    deliveryAttempt: 1,
  });
}

function uuidSequence(): () => string {
  let value = 30;
  return () => `83000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}
