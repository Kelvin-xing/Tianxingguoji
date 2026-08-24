import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  DOCUMENT_SCAN_POLL_TIMEOUT_MS,
  DOCUMENT_UPLOAD_MAX_BYTES,
  DocumentIdempotencyAttempt,
  DocumentTransferError,
  abandonDocumentVersion,
  classifyDocumentFailure,
  createDocumentVersion,
  digestDocumentUploadFile,
  documentAbandonmentFingerprint,
  documentVersionFingerprint,
  fetchDocumentBytes,
  issueDocumentDownloadIntent,
  issueDocumentUploadIntent,
  pollCaseDocumentUntilSettled,
  putDocumentBytes,
  validateDocumentUploadFile,
} from "../../../modules/documents/client.ts";

const CASE_ID = "10000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "20000000-0000-4000-8000-000000000001";
const VERSION_ID = "30000000-0000-4000-8000-000000000001";
const CHECKSUM_HEX = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const CHECKSUM_BASE64 = "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=";

test("DOC-02 hashes one bounded allowed file with browser Web Crypto", async () => {
  const file = new Blob(["hello"], { type: "application/pdf" });
  assert.equal(validateDocumentUploadFile(file), "application/pdf");
  assert.deepEqual(await digestDocumentUploadFile(file), {
    checksum_sha256: CHECKSUM_HEX,
    checksum_base64: CHECKSUM_BASE64,
    size_bytes: 5,
    content_type: "application/pdf",
  });
  for (const invalid of [
    new Blob([], { type: "application/pdf" }),
    new Blob([new Uint8Array(DOCUMENT_UPLOAD_MAX_BYTES + 1)], { type: "application/pdf" }),
    new Blob(["hello"], { type: "text/plain" }),
  ]) assert.throws(() => validateDocumentUploadFile(invalid), transferFailure("validation"));
});

test("DOC-02 creates one durable version with only the frozen command and exact receipt", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(input, `/api/v1/cases/${CASE_ID}/documents/${DOCUMENT_ID}/versions`);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("idempotency-key"), "doc02:version-1");
    assert.deepEqual(JSON.parse(String(init?.body)), versionCommand());
    return apiResponse({ id: VERSION_ID, record_version: 1 }, 201);
  };
  assert.deepEqual(
    await createDocumentVersion(CASE_ID, DOCUMENT_ID, versionCommand(), "doc02:version-1"),
    { id: VERSION_ID, record_version: 1 },
  );
  assert.equal(documentVersionFingerprint(versionCommand()), JSON.stringify(versionCommand()));

  globalThis.fetch = async () => apiResponse({ id: VERSION_ID, record_version: 1, checksum_sha256: CHECKSUM_HEX }, 201);
  await assert.rejects(
    createDocumentVersion(CASE_ID, DOCUMENT_ID, versionCommand(), "doc02:strict"),
    malformedResponse,
  );
});

test("DOC-02 upload intent is exact, bound to the digest, and PUT sets no Content-Length", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const expiresAt = Date.now() + 60_000;
  let request = 0;
  globalThis.fetch = async (input, init) => {
    request += 1;
    if (request === 1) {
      assert.equal(input, `/api/v1/cases/${CASE_ID}/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/upload-intents`);
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).has("idempotency-key"), false);
      assert.deepEqual(JSON.parse(String(init?.body)), { expected_record_version: 1 });
      return apiResponse(uploadIntent(expiresAt));
    }
    assert.equal(input, "http://127.0.0.1:4566/private-upload?signature=opaque");
    assert.equal(init?.method, "PUT");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("content-type"), "application/pdf");
    assert.equal(headers.get("x-amz-checksum-sha256"), CHECKSUM_BASE64);
    assert.equal(headers.has("content-length"), false);
    return new Response(null, { status: 200 });
  };
  const intent = await issueDocumentUploadIntent(CASE_ID, DOCUMENT_ID, VERSION_ID, 1, {
    content_type: "application/pdf",
    checksum_base64: CHECKSUM_BASE64,
  });
  await putDocumentBytes(intent, new Blob(["hello"], { type: "application/pdf" }));
  assert.equal(request, 2);
});

test("DOC-02 upload intent binding mismatch is a fixed conflict before direct PUT", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let putCount = 0;
  globalThis.fetch = async (input) => {
    if (String(input).startsWith("/api/")) {
      return apiResponse({
        ...uploadIntent(Date.now() + 60_000),
        headers: {
          "content-type": "image/png",
          "x-amz-checksum-sha256": CHECKSUM_BASE64,
        },
      });
    }
    putCount += 1;
    return new Response(null, { status: 200 });
  };
  await assert.rejects(
    issueDocumentUploadIntent(CASE_ID, DOCUMENT_ID, VERSION_ID, 1, {
      content_type: "application/pdf",
      checksum_base64: CHECKSUM_BASE64,
    }),
    transferFailure("conflict"),
  );
  assert.equal(putCount, 0);
});

test("DOC-02 abandonment sends the exact body/key and accepts only the incremented two-key ack", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const input = {
    expected_document_record_version: 2,
    expected_version_record_version: 1,
  } as const;
  globalThis.fetch = async (request, init) => {
    assert.equal(request, `/api/v1/cases/${CASE_ID}/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/abandonments`);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("idempotency-key"), "doc02:abandon-1");
    assert.deepEqual(JSON.parse(String(init?.body)), input);
    return apiResponse({ id: VERSION_ID, record_version: 2 });
  };
  assert.deepEqual(
    await abandonDocumentVersion(CASE_ID, DOCUMENT_ID, VERSION_ID, input, "doc02:abandon-1"),
    { id: VERSION_ID, record_version: 2 },
  );
  assert.equal(documentAbandonmentFingerprint(input), JSON.stringify(input));

  globalThis.fetch = async () => apiResponse({ id: VERSION_ID, record_version: 3 });
  await assert.rejects(
    abandonDocumentVersion(CASE_ID, DOCUMENT_ID, VERSION_ID, input, "doc02:abandon-strict"),
    malformedResponse,
  );
});

test("DOC-02 abandonment reuses uncertain retries and rotates on authoritative version changes", () => {
  const keys = ["doc02:abandon-attempt-1", "doc02:abandon-attempt-2"];
  const attempt = new DocumentIdempotencyAttempt(() => keys.shift()!);
  const initial = documentAbandonmentFingerprint({
    expected_document_record_version: 2,
    expected_version_record_version: 1,
  });
  const changedAuthority = documentAbandonmentFingerprint({
    expected_document_record_version: 4,
    expected_version_record_version: 1,
  });
  assert.equal(attempt.keyFor(initial), "doc02:abandon-attempt-1");
  assert.equal(attempt.keyFor(initial), "doc02:abandon-attempt-1");
  assert.equal(attempt.keyFor(changedAuthority), "doc02:abandon-attempt-2");
});

test("DOC-02 rejects malformed, unbound, unsafe or expired upload capabilities", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const invalid = [
    { ...uploadIntent(Date.now() + 60_000), private_key: "forbidden" },
    uploadIntent(Date.now() - 1),
    uploadIntent(Date.now() + 700_000),
    { ...uploadIntent(Date.now() + 60_000), method: "POST" },
    { ...uploadIntent(Date.now() + 60_000), url: "http://example.com/private" },
    { ...uploadIntent(Date.now() + 60_000), headers: { "content-type": "application/pdf", "x-amz-checksum-sha256": "invalid" } },
  ];
  for (const value of invalid) {
    globalThis.fetch = async () => apiResponse(value);
    await assert.rejects(
      issueDocumentUploadIntent(CASE_ID, DOCUMENT_ID, VERSION_ID, 1, {
        content_type: "application/pdf",
        checksum_base64: CHECKSUM_BASE64,
      }),
      malformedResponse,
    );
  }
});

test("DOC-02 keeps direct PUT expiry and 403 recoverable for the same durable version", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(null, { status: 403 });
  await assert.rejects(
    putDocumentBytes(uploadIntent(Date.now() + 60_000), new Blob(["hello"], { type: "application/pdf" })),
    (error) => error instanceof DocumentTransferError && error.kind === "conflict" && error.recoverable,
  );
  await assert.rejects(
    putDocumentBytes(uploadIntent(Date.now() - 1), new Blob(["hello"], { type: "application/pdf" })),
    (error) => error instanceof DocumentTransferError && error.kind === "conflict" && error.recoverable,
  );
});

test("DOC-02 polls only authoritative detail until a terminal scan state", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const states = ["pending_upload", "quarantined", "scanning", "available"] as const;
  const observed: string[] = [];
  globalThis.fetch = async (input) => {
    assert.equal(input, `/api/v1/cases/${CASE_ID}/documents/${DOCUMENT_ID}`);
    const state = states[Math.min(observed.length, states.length - 1)]!;
    observed.push(state);
    return apiResponse({ document: documentItem(state) });
  };
  const result = await pollCaseDocumentUntilSettled(CASE_ID, DOCUMENT_ID, {
    timeoutMs: 100,
    intervalMs: 1,
    onAuthoritativeChange: (document) => assert.equal(document.latest_version_state, observed.at(-1)),
  });
  assert.equal(result.document.latest_version_state, "available");
  assert.deepEqual(observed, [...states]);
  assert.equal(DOCUMENT_SCAN_POLL_TIMEOUT_MS, 90_000);
});

test("DOC-02 download intent and byte fetch use a fresh fixed-name private capability", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const expiresAt = Date.now() + 60_000;
  let request = 0;
  globalThis.fetch = async (input, init) => {
    request += 1;
    if (request === 1) {
      assert.equal(input, `/api/v1/cases/${CASE_ID}/documents/${DOCUMENT_ID}/download-intents`);
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), {});
      assert.equal(new Headers(init?.headers).has("idempotency-key"), false);
      return apiResponse({
        method: "GET",
        expires_at_ms: expiresAt,
        url: "https://private-download.example.test/object?signature=opaque",
        download_name: "document.pdf",
      });
    }
    assert.equal(input, "https://private-download.example.test/object?signature=opaque");
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "omit");
    return new Response("downloaded bytes", { status: 200, headers: { "content-type": "application/pdf" } });
  };
  const intent = await issueDocumentDownloadIntent(CASE_ID, DOCUMENT_ID);
  const bytes = await fetchDocumentBytes(intent);
  assert.equal(intent.download_name, "document.pdf");
  assert.equal(await bytes.text(), "downloaded bytes");
});

test("DOC-02 transfer failures remain fixed and redact private transport details", () => {
  assert.equal(classifyDocumentFailure(new DocumentTransferError("timeout")), "timeout");
  assert.equal(classifyDocumentFailure(new DocumentTransferError("conflict")), "conflict");
  assert.equal(new DocumentTransferError("conflict", true).recoverable, true);
  assert.equal(classifyDocumentFailure(new Error("private signed URL")), "unavailable");
});

function versionCommand() {
  return {
    checksum_sha256: CHECKSUM_HEX,
    size_bytes: 5,
    content_type: "application/pdf" as const,
    expected_document_record_version: 1,
  };
}

function uploadIntent(expiresAt: number) {
  return {
    method: "PUT" as const,
    expires_at_ms: expiresAt,
    url: "http://127.0.0.1:4566/private-upload?signature=opaque",
    headers: {
      "content-type": "application/pdf" as const,
      "x-amz-checksum-sha256": CHECKSUM_BASE64,
    },
  };
}

function documentItem(state: string) {
  return {
    id: DOCUMENT_ID,
    case_id: CASE_ID,
    case_number: "TX-2026-0001",
    display_name: "Synthetic evidence",
    classification: "identity_and_case_evidence",
    lifecycle_state: "active",
    latest_version_state: state,
    pending_upload: state === "pending_upload" ? { id: VERSION_ID, record_version: 1 } : null,
    has_active_version: state === "available",
    record_version: state === "available" ? 3 : 2,
    updated_at: "2026-08-24T02:00:00.000Z",
  };
}

function apiResponse(data: unknown, status = 200): Response {
  return Response.json(
    { api_version: "v1", request_id: "doc02-test", data },
    { status, headers: { "x-request-id": "doc02-test" } },
  );
}

function malformedResponse(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE";
}

function transferFailure(kind: DocumentTransferError["kind"]): (error: unknown) => boolean {
  return (error) => error instanceof DocumentTransferError && error.kind === kind;
}
