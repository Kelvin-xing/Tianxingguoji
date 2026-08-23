import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoDocumentQuery,
  documentAcknowledgementData,
  documentCollectionData,
  documentDetailData,
  mapDocumentWorkspaceError,
  parseDocumentRegistration,
} from "../../app/api/v1/documents/handler.ts";
import { DocumentWorkspaceError } from "../../modules/documents/application/workspace-service.ts";

const ID = "81000000-0000-4000-8000-000000000101";
const CASE_ID = "81000000-0000-4000-8000-000000000102";

test("DOC-01 route parsers reject query keys and enforce the exact registration body", async () => {
  assert.doesNotThrow(() => assertNoDocumentQuery(new Request("http://local/api/v1/documents")));
  assert.throws(() => assertNoDocumentQuery(new Request("http://local/api/v1/documents?status=active")));

  const parsed = await parseDocumentRegistration(jsonRequest({
    display_name: "Synthetic Case Evidence",
    classification: "operational_attachment",
  }), "doc-01-request");
  assert.deepEqual(parsed, {
    displayName: "Synthetic Case Evidence",
    classification: "operational_attachment",
    requestId: "doc-01-request",
    idempotencyKey: "doc-01-key",
  });
  await assert.rejects(() => parseDocumentRegistration(jsonRequest({
    display_name: "Synthetic Case Evidence",
    classification: "operational_attachment",
    case_id: CASE_ID,
  }), "doc-01-request"));
  await assert.rejects(() => parseDocumentRegistration(new Request("http://local/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      display_name: "Synthetic Case Evidence",
      classification: "operational_attachment",
    }),
  }), "doc-01-request"));
});

test("DOC-01 response mappers expose only the frozen acknowledgement and ten-key read item", () => {
  const item = {
    id: ID,
    caseId: CASE_ID,
    caseNumber: "SYNTHETIC-CASE",
    displayName: "Synthetic Case Evidence",
    classification: "identity_and_case_evidence" as const,
    lifecycleState: "active" as const,
    latestVersionState: null,
    hasActiveVersion: false,
    recordVersion: 1,
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
  const collection = documentCollectionData({ documents: [item] }) as {
    documents: Record<string, unknown>[];
  };
  assert.deepEqual(Object.keys(collection), ["documents"]);
  assert.deepEqual(Object.keys(collection.documents[0]!).sort(), [
    "id", "case_id", "case_number", "display_name", "classification", "lifecycle_state",
    "latest_version_state", "has_active_version", "record_version", "updated_at",
  ].sort());
  const detail = documentDetailData(item) as { document: Record<string, unknown> };
  assert.deepEqual(detail.document, collection.documents[0]);
  assert.deepEqual(documentAcknowledgementData({ id: ID, recordVersion: 1 }), {
    id: ID,
    record_version: 1,
  });
});

test("DOC-01 route error mapping is HMR-stable and fail closed", () => {
  const equivalent = Object.assign(new Error("redacted"), {
    name: "DocumentWorkspaceError",
    code: "DOCUMENT_WORKSPACE_FORBIDDEN",
  });
  assert.equal((mapDocumentWorkspaceError(equivalent) as { code: string }).code, "FORBIDDEN");
  const mappings = [
    ["DOCUMENT_WORKSPACE_INVALID", "VALIDATION_FAILED"],
    ["DOCUMENT_WORKSPACE_NOT_FOUND", "NOT_FOUND"],
    ["DOCUMENT_WORKSPACE_CONFLICT", "CONFLICT"],
    ["DOCUMENT_WORKSPACE_UNAVAILABLE", "SERVICE_UNAVAILABLE"],
  ] as const;
  for (const [source, expected] of mappings) {
    assert.equal((mapDocumentWorkspaceError(new DocumentWorkspaceError(source)) as {
      code: string;
    }).code, expected);
  }
  const plain = { name: "DocumentWorkspaceError", code: "DOCUMENT_WORKSPACE_FORBIDDEN" };
  assert.equal(mapDocumentWorkspaceError(plain), plain);
  const unknown = new Error("unknown");
  assert.equal(mapDocumentWorkspaceError(unknown), unknown);
});

function jsonRequest(body: unknown): Request {
  return new Request("http://local/api/v1/cases/case/documents", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "doc-01-key" },
    body: JSON.stringify(body),
  });
}
