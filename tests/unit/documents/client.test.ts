import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  DocumentIdempotencyAttempt,
  classifyDocumentFailure,
  documentRegistrationFingerprint,
  getCaseDocument,
  listCaseDocuments,
  listDocuments,
  registerCaseDocument,
} from "../../../modules/documents/client.ts";

const CASE_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_CASE_ID = "10000000-0000-4000-8000-000000000002";
const DOCUMENT_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_DOCUMENT_ID = "20000000-0000-4000-8000-000000000002";

test("Document reads use no-query paths and strictly decode all three exact wrappers", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request = 0;
  globalThis.fetch = async (input) => {
    request += 1;
    if (request === 1) {
      assert.equal(input, "/api/v1/documents");
      return apiResponse({ documents: [documentItem(), documentItem({ id: OTHER_DOCUMENT_ID, updated_at: "2026-08-23T01:00:00.000Z" })] });
    }
    if (request === 2) {
      assert.equal(input, `/api/v1/cases/${CASE_ID}/documents`);
      return apiResponse({ documents: [documentItem()] });
    }
    assert.equal(input, `/api/v1/cases/${CASE_ID}/documents/${DOCUMENT_ID}`);
    return apiResponse({ document: documentItem() });
  };

  assert.equal((await listDocuments()).documents.length, 2);
  assert.equal((await listCaseDocuments(CASE_ID)).documents[0]?.case_id, CASE_ID);
  assert.equal((await getCaseDocument(CASE_ID, DOCUMENT_ID)).document.id, DOCUMENT_ID);
});

test("Document reads reject extra keys, malformed enums, authority mismatches and impossible version state", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const invalid = [
    { ...documentItem(), private_email: "not-allowed@example.invalid" },
    documentItem({ classification: "temporary_upload" }),
    documentItem({ lifecycle_state: "deleted" }),
    documentItem({ latest_version_state: "clean" }),
    documentItem({ latest_version_state: null, has_active_version: true }),
    documentItem({ case_id: OTHER_CASE_ID }),
  ];
  for (const item of invalid) {
    globalThis.fetch = async () => apiResponse({ documents: [item] });
    await assert.rejects(listCaseDocuments(CASE_ID), malformedResponse);
  }
  globalThis.fetch = async () => apiResponse({ document: documentItem({ id: OTHER_DOCUMENT_ID }) });
  await assert.rejects(getCaseDocument(CASE_ID, DOCUMENT_ID), malformedResponse);
});

test("Document list enforces limit, uniqueness and updated-at/id canonical order", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const invalidLists = [
    [documentItem(), documentItem()],
    [documentItem({ updated_at: "2026-08-23T01:00:00.000Z" }), documentItem({ id: OTHER_DOCUMENT_ID, updated_at: "2026-08-23T02:00:00.000Z" })],
    [documentItem({ id: OTHER_DOCUMENT_ID }), documentItem()],
    Array.from({ length: 101 }, (_, index) => documentItem({ id: syntheticUuid(index) })),
  ];
  for (const documents of invalidLists) {
    globalThis.fetch = async () => apiResponse({ documents });
    await assert.rejects(listDocuments(), malformedResponse);
  }
});

test("Document registration sends only frozen fields and accepts only the exact two-key receipt", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(input, `/api/v1/cases/${CASE_ID}/documents`);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("idempotency-key"), "document:test-1");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      display_name: "Synthetic evidence",
      classification: "identity_and_case_evidence",
    });
    return apiResponse({ id: DOCUMENT_ID, record_version: 1 });
  };
  assert.deepEqual(await registerCaseDocument(CASE_ID, registration(), "document:test-1"), { id: DOCUMENT_ID, record_version: 1 });

  for (const invalid of [
    { id: DOCUMENT_ID, record_version: 1, display_name: "private" },
    { id: DOCUMENT_ID, record_version: 2 },
    { id: "invalid", record_version: 1 },
  ]) {
    globalThis.fetch = async () => apiResponse(invalid);
    await assert.rejects(registerCaseDocument(CASE_ID, registration(), "document:strict"), malformedResponse);
  }
});

test("Document idempotency reuses uncertain retries and rotates only on command changes or completion", () => {
  let sequence = 0;
  const attempt = new DocumentIdempotencyAttempt(() => `document:${++sequence}`);
  const fingerprint = documentRegistrationFingerprint(registration());
  const first = attempt.keyFor(fingerprint);
  assert.equal(attempt.keyFor(fingerprint), first);
  const changedName = attempt.keyFor(documentRegistrationFingerprint({ ...registration(), display_name: "Changed" }));
  assert.notEqual(changedName, first);
  const changedClassification = attempt.keyFor(documentRegistrationFingerprint({ ...registration(), classification: "operational_attachment" }));
  assert.notEqual(changedClassification, changedName);
  attempt.rotate();
  assert.notEqual(attempt.keyFor(documentRegistrationFingerprint({ ...registration(), classification: "operational_attachment" })), changedClassification);
  attempt.complete();
  assert.notEqual(attempt.keyFor(fingerprint), first);
});

test("Document failures are classified without exposing server details", () => {
  assert.equal(classifyDocumentFailure(apiError("UNAUTHENTICATED", 401)), "unauthenticated");
  assert.equal(classifyDocumentFailure(apiError("FORBIDDEN", 403)), "forbidden");
  assert.equal(classifyDocumentFailure(apiError("NOT_FOUND", 404)), "not_found");
  assert.equal(classifyDocumentFailure(apiError("VALIDATION_FAILED", 422)), "validation");
  assert.equal(classifyDocumentFailure(apiError("CONFLICT", 409)), "conflict");
  assert.equal(classifyDocumentFailure(apiError("SERVICE_UNAVAILABLE", 503)), "unavailable");
  assert.equal(classifyDocumentFailure(new Error("private detail")), "unavailable");
});

function documentItem(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: DOCUMENT_ID,
    case_id: CASE_ID,
    case_number: "TX-2026-0001",
    display_name: "Synthetic evidence",
    classification: "identity_and_case_evidence",
    lifecycle_state: "active",
    latest_version_state: null,
    has_active_version: false,
    record_version: 1,
    updated_at: "2026-08-23T02:00:00.000Z",
    ...overrides,
  };
}

function registration() {
  return { display_name: "Synthetic evidence", classification: "identity_and_case_evidence" as const };
}

function syntheticUuid(index: number): string {
  return `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function apiResponse(data: unknown): Response {
  return Response.json({ api_version: "v1", request_id: "document-test", data }, { headers: { "x-request-id": "document-test" } });
}

function malformedResponse(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE";
}

function apiError(code: string, status: number): ApiClientError {
  return new ApiClientError({ code, status, retryable: false, requestId: "document-test" });
}
