import assert from "node:assert/strict";
import test from "node:test";

import {
  documentDownloadIntentData,
  documentUploadIntentData,
  documentVersionAcknowledgementData,
  mapDocumentTransferError,
  parseDocumentUploadIntent,
  parseDocumentVersionAbandonment,
  parseDocumentVersionCreate,
  parseEmptyDocumentCommand,
} from "../../app/api/v1/documents/handler.ts";
import { DocumentTransferError } from "../../modules/documents/application/transfer-service.ts";

const ID = "81000000-0000-4000-8000-000000000001";

test("DOC-02 route parsers enforce exact bodies and idempotency placement", async () => {
  const version = await parseDocumentVersionCreate(jsonRequest({
    checksum_sha256: "a".repeat(64),
    content_type: "application/pdf",
    expected_document_record_version: 2,
    size_bytes: 1024,
  }, true), "doc02-create");
  assert.deepEqual(version, {
    checksumSha256: "a".repeat(64),
    contentType: "application/pdf",
    expectedDocumentRecordVersion: 2,
    sizeBytes: 1024,
    requestId: "doc02-create",
    idempotencyKey: "doc02-key",
  });
  await assert.rejects(() => parseDocumentVersionCreate(jsonRequest({
    checksum_sha256: "a".repeat(64),
    content_type: "application/pdf",
    expected_document_record_version: 2,
    size_bytes: 1024,
    filename: "private.pdf",
  }, true), "doc02-create"));
  await assert.rejects(() => parseDocumentVersionCreate(rawJsonRequest(
    `{"checksum_sha256":"${"a".repeat(64)}","content_type":"application/pdf",` +
      '"expected_document_record_version":2,"size_bytes":1024,"\\u0073ize_bytes":1024}',
    true,
  ), "doc02-create"));
  await assert.rejects(() => parseDocumentVersionCreate(rawJsonRequest(
    `{"checksum_sha256":"${"a".repeat(64)}","content_type":"application/pdf",` +
      '"expected_document_record_version":2,"size_bytes":1024,"size_bytes":1024}',
    true,
  ), "doc02-create"));

  assert.deepEqual(
    await parseDocumentUploadIntent(jsonRequest({ expected_record_version: 1 })),
    { expectedRecordVersion: 1 },
  );
  await assert.rejects(() => parseDocumentUploadIntent(
    jsonRequest({ expected_record_version: 1 }, true),
  ));
  assert.deepEqual(await parseDocumentVersionAbandonment(jsonRequest({
    expected_document_record_version: 2,
    expected_version_record_version: 1,
  }, true), "doc02-abandon"), {
    expectedDocumentRecordVersion: 2,
    expectedVersionRecordVersion: 1,
    requestId: "doc02-abandon",
    idempotencyKey: "doc02-key",
  });
  await assert.rejects(() => parseDocumentVersionAbandonment(jsonRequest({
    expected_document_record_version: 2,
    expected_version_record_version: 1,
    reason: "private",
  }, true), "doc02-abandon"));
  await assert.rejects(() => parseDocumentVersionAbandonment(jsonRequest({
    expected_document_record_version: 2,
    expected_version_record_version: 1,
  }), "doc02-abandon"));
  await assert.doesNotReject(() => parseEmptyDocumentCommand(jsonRequest({})));
  await assert.rejects(() => parseEmptyDocumentCommand(jsonRequest({ version_id: ID })));
});

test("DOC-02 response mappers expose only frozen non-PII DTO keys", () => {
  assert.deepEqual(documentVersionAcknowledgementData({ id: ID, recordVersion: 1 }), {
    id: ID,
    record_version: 1,
  });
  const upload = documentUploadIntentData({
    method: "PUT",
    expiresAtMs: 1000,
    url: "http://127.0.0.1:4566/upload?safe=1",
    headers: {
      "content-type": "application/pdf",
      "x-amz-checksum-sha256": "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=",
    },
  }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(upload).sort(), ["expires_at_ms", "headers", "method", "url"].sort());
  assert.deepEqual(Object.keys(upload.headers as Record<string, unknown>).sort(), [
    "content-type", "x-amz-checksum-sha256",
  ]);
  const download = documentDownloadIntentData({
    method: "GET",
    expiresAtMs: 1000,
    url: "http://127.0.0.1:4566/download?safe=1",
    downloadName: "document.pdf",
  }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(download).sort(), [
    "download_name", "expires_at_ms", "method", "url",
  ].sort());
});

test("DOC-02 error mapping is HMR-stable and unknown values fail closed", () => {
  const mappings = [
    ["DOCUMENT_TRANSFER_FORBIDDEN", "FORBIDDEN"],
    ["DOCUMENT_TRANSFER_INVALID", "VALIDATION_FAILED"],
    ["DOCUMENT_TRANSFER_NOT_FOUND", "NOT_FOUND"],
    ["DOCUMENT_TRANSFER_STALE_VERSION", "STALE_VERSION"],
    ["DOCUMENT_TRANSFER_CONFLICT", "CONFLICT"],
    ["DOCUMENT_TRANSFER_UNAVAILABLE", "SERVICE_UNAVAILABLE"],
  ] as const;
  for (const [source, expected] of mappings) {
    assert.equal((mapDocumentTransferError(new DocumentTransferError(source)) as {
      code: string;
    }).code, expected);
  }
  const hmr = Object.assign(new Error("redacted"), {
    name: "DocumentTransferError",
    code: "DOCUMENT_TRANSFER_FORBIDDEN",
  });
  assert.equal((mapDocumentTransferError(hmr) as { code: string }).code, "FORBIDDEN");
  const plain = { name: "DocumentTransferError", code: "DOCUMENT_TRANSFER_FORBIDDEN" };
  assert.equal(mapDocumentTransferError(plain), plain);
});

function jsonRequest(body: unknown, idempotency = false): Request {
  return rawJsonRequest(JSON.stringify(body), idempotency);
}

function rawJsonRequest(body: string, idempotency = false): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (idempotency) headers["idempotency-key"] = "doc02-key";
  return new Request("http://local/api/v1/documents", {
    method: "POST",
    headers,
    body,
  });
}
