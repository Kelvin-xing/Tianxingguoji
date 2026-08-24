import assert from "node:assert/strict";
import test from "node:test";

import type { IdentitySessionActor } from "../../../modules/identity/public.ts";
import {
  DocumentTransferError,
  DocumentTransferService,
  type DocumentCapabilitySigner,
  type DocumentDownloadAuthority,
  type DocumentPendingUploadAuthority,
  type DocumentTransferRepository,
} from "../../../modules/documents/application/transfer-service.ts";
import { createOpaqueDocumentObjectKey } from "../../../modules/documents/domain/contract.ts";

const IDS = Object.freeze({
  organization: "51000000-0000-4000-8000-000000000001",
  founder: "81000000-0000-4000-8000-000000000001",
  session: "81000000-0000-4000-8000-000000000002",
  case: "81000000-0000-4000-8000-000000000003",
  document: "81000000-0000-4000-8000-000000000004",
  version: "81000000-0000-4000-8000-000000000005",
});
const BUCKET = "tianxing-documents-local";
const NOW_MS = Date.UTC(2026, 7, 24, 8, 0, 0);

test("creates one pending version from the exact command with redacted atomic effects", async () => {
  const repository = fakeRepository();
  const value = service(repository);
  const result = await value.createVersion({
    actor: actor("founder"),
    caseId: IDS.case,
    documentId: IDS.document,
    command: {
      checksumSha256: "a".repeat(64),
      sizeBytes: 1024,
      contentType: "application/pdf",
      expectedDocumentRecordVersion: 2,
      requestId: "doc02-create-1",
      idempotencyKey: "doc02-create-key-1",
    },
  });
  assert.deepEqual(result, { id: IDS.version, recordVersion: 1 });
  const create = repository.created[0]!;
  assert.equal(create.key, createOpaqueDocumentObjectKey(IDS.document, IDS.version));
  assert.equal(create.bucket, BUCKET);
  assert.equal(create.effects.audit.resourceType, "DocumentVersion");
  assert.equal(create.effects.audit.resourceId, IDS.version);
  const safeEffects = JSON.stringify(create.effects);
  assert.equal(safeEffects.includes(BUCKET), false);
  assert.equal(safeEffects.includes("documents/"), false);
  assert.equal(safeEffects.includes("a".repeat(64)), false);
});

test("issues bounded upload and download capabilities only after authoritative repository locks", async () => {
  const repository = fakeRepository();
  const value = service(repository);
  const upload = await value.issueUploadIntent({
    actor: actor("advisor"),
    caseId: IDS.case,
    documentId: IDS.document,
    versionId: IDS.version,
    expectedRecordVersion: 1,
    requestId: "doc02-upload-intent-1",
  });
  assert.deepEqual(Object.keys(upload).sort(), ["expiresAtMs", "headers", "method", "url"].sort());
  assert.equal(upload.method, "PUT");
  assert.equal(upload.expiresAtMs, NOW_MS + 600_000);
  assert.deepEqual(upload.headers, {
    "content-type": "application/pdf",
    "x-amz-checksum-sha256": Buffer.from("a".repeat(64), "hex").toString("base64"),
  });

  const download = await value.issueDownloadIntent({
    actor: actor("founder"),
    caseId: IDS.case,
    documentId: IDS.document,
    requestId: "doc02-download-intent-1",
  });
  assert.deepEqual(download, {
    method: "GET",
    expiresAtMs: NOW_MS + 300_000,
    url: "http://127.0.0.1:4566/private-download?signature=safe",
    downloadName: "document.pdf",
  });
  const effects = repository.downloads[0]!.effects;
  assert.equal(effects.audit.resourceType, "Document");
  assert.equal(effects.audit.resourceId, IDS.document);
  assert.equal(effects.outbox.aggregateType, "Document");
  const safeEffects = JSON.stringify(effects);
  assert.equal(safeEffects.includes("private-download"), false);
  assert.equal(safeEffects.includes("provider-v1"), false);
  assert.equal(safeEffects.includes(BUCKET), false);
});

test("abandons one pending version with exact replay-safe command and redacted effects", async () => {
  const repository = fakeRepository();
  const result = await service(repository).abandonPendingUpload({
    actor: actor("advisor"),
    caseId: IDS.case,
    documentId: IDS.document,
    versionId: IDS.version,
    command: {
      expectedDocumentRecordVersion: 2,
      expectedVersionRecordVersion: 1,
      requestId: "doc02-abandon-1",
      idempotencyKey: "doc02-abandon-key-1",
    },
  });
  assert.deepEqual(result, { id: IDS.version, recordVersion: 2 });
  const abandonment = repository.abandoned[0]!;
  assert.equal(abandonment.expectedDocumentRecordVersion, 2);
  assert.equal(abandonment.expectedVersionRecordVersion, 1);
  assert.equal(abandonment.effects.audit.eventType, "documents.pending_upload_abandoned");
  assert.equal(abandonment.effects.audit.resourceType, "DocumentVersion");
  assert.equal(abandonment.effects.audit.resourceId, IDS.version);
  assert.deepEqual(abandonment.effects.audit.metadata, {
    effect_type: "documents.pending_upload_abandoned",
    status: "abandoned",
    previous_version: 1,
    next_version: 2,
  });
  const safeEffects = JSON.stringify(abandonment.effects);
  assert.equal(safeEffects.includes(BUCKET), false);
  assert.equal(safeEffects.includes("documents/"), false);
  assert.equal(safeEffects.includes("checksum"), false);
});

test("rejects forbidden roles, invalid size and unsafe signed or provider URLs fail closed", async () => {
  const repository = fakeRepository();
  const value = service(repository);
  for (const role of ["admin", "data_reviewer", "contractor"] as const) {
    assert.throws(
      () => value.createVersion({
        actor: actor(role),
        caseId: IDS.case,
        documentId: IDS.document,
        command: {
          checksumSha256: "a".repeat(64),
          sizeBytes: 1,
          contentType: "application/pdf",
          expectedDocumentRecordVersion: 1,
          requestId: `doc02-denied-${role}`,
          idempotencyKey: `doc02-denied-key-${role}`,
        },
      }),
      (error: unknown) => error instanceof DocumentTransferError &&
        error.code === "DOCUMENT_TRANSFER_FORBIDDEN",
    );
  }
  assert.throws(
    () => value.createVersion({
      actor: actor("founder"),
      caseId: IDS.case,
      documentId: IDS.document,
      command: {
        checksumSha256: "a".repeat(64),
        sizeBytes: 0,
        contentType: "application/pdf",
        expectedDocumentRecordVersion: 1,
        requestId: "doc02-invalid-size",
        idempotencyKey: "doc02-invalid-size-key",
      },
    }),
    /DOCUMENT_TRANSFER_INVALID/u,
  );

  repository.downloadAuthority = { ...downloadAuthority(), providerVersionId: "x".repeat(1025) };
  await assert.rejects(
    () => value.issueDownloadIntent({
      actor: actor("founder"),
      caseId: IDS.case,
      documentId: IDS.document,
      requestId: "doc02-provider-too-long",
    }),
    /DOCUMENT_TRANSFER_INTENT_MISMATCH/u,
  );
  const unsafe = service(fakeRepository(), {
    async issueUploadIntent() { return { url: "http://outside.invalid/private" }; },
    async issueDownloadIntent() { return { url: "http://outside.invalid/private" }; },
  });
  await assert.rejects(
    () => unsafe.issueUploadIntent({
      actor: actor("founder"),
      caseId: IDS.case,
      documentId: IDS.document,
      versionId: IDS.version,
      expectedRecordVersion: 1,
      requestId: "doc02-unsafe-url",
    }),
    /DOCUMENT_TRANSFER_INTENT_MISMATCH/u,
  );
});

function service(repository: FakeRepository, signer: DocumentCapabilitySigner = safeSigner()) {
  return new DocumentTransferService({
    repository,
    signer,
    bucket: BUCKET,
    allowedHttpOrigin: "http://127.0.0.1:4566",
    createId: idSequence(),
    now: () => NOW_MS,
  });
}

type CreateInput = Parameters<DocumentTransferRepository["createVersion"]>[0];
type AbandonInput = Parameters<DocumentTransferRepository["abandonPendingUpload"]>[0];
type UploadInput = Parameters<DocumentTransferRepository["issueUploadIntent"]>[0];
type DownloadInput = Parameters<DocumentTransferRepository["issueDownloadIntent"]>[0];

interface FakeRepository extends DocumentTransferRepository {
  readonly created: CreateInput[];
  readonly abandoned: AbandonInput[];
  readonly uploads: UploadInput[];
  readonly downloads: DownloadInput[];
  downloadAuthority: DocumentDownloadAuthority;
}

function fakeRepository(): FakeRepository {
  const created: CreateInput[] = [];
  const abandoned: AbandonInput[] = [];
  const uploads: UploadInput[] = [];
  const downloads: DownloadInput[] = [];
  return {
    created,
    abandoned,
    uploads,
    downloads,
    downloadAuthority: downloadAuthority(),
    async createVersion(input) {
      created.push(input);
      return { id: input.versionId, recordVersion: 1 };
    },
    async abandonPendingUpload(input) {
      abandoned.push(input);
      return { id: input.versionId, recordVersion: input.expectedVersionRecordVersion + 1 };
    },
    async issueUploadIntent(input) {
      uploads.push(input);
      return input.issue(uploadAuthority());
    },
    async issueDownloadIntent(input) {
      downloads.push(input);
      return input.issue(this.downloadAuthority);
    },
  };
}

function uploadAuthority(): DocumentPendingUploadAuthority {
  return {
    id: IDS.version,
    documentId: IDS.document,
    recordVersion: 1,
    contentType: "application/pdf",
    checksumSha256: "a".repeat(64),
    bucket: BUCKET,
    key: createOpaqueDocumentObjectKey(IDS.document, IDS.version),
  };
}

function downloadAuthority(): DocumentDownloadAuthority {
  return {
    documentId: IDS.document,
    documentRecordVersion: 3,
    versionId: IDS.version,
    versionRecordVersion: 4,
    contentType: "application/pdf",
    bucket: BUCKET,
    key: createOpaqueDocumentObjectKey(IDS.document, IDS.version),
    providerVersionId: "provider-v1",
  };
}

function safeSigner(): DocumentCapabilitySigner {
  return {
    async issueUploadIntent() {
      return { url: "http://127.0.0.1:4566/private-upload?signature=safe" };
    },
    async issueDownloadIntent() {
      return { url: "http://127.0.0.1:4566/private-download?signature=safe" };
    },
  };
}

function actor(role: IdentitySessionActor["role"]): IdentitySessionActor {
  return {
    userId: IDS.founder,
    organizationId: IDS.organization,
    role,
    sessionId: IDS.session,
    capturedSessionVersion: 1,
    reauthenticatedAtMs: null,
  };
}

function idSequence(): () => string {
  let value = 4;
  return () => value++ === 4
    ? IDS.version
    : `83000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
