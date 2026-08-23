import assert from "node:assert/strict";
import test from "node:test";

import {
  deletionReceiptData,
  deletionSummaryData,
  mapDeletionReviewError,
  parseDeletionQueueQuery,
  parseDeletionRequest,
} from "../../app/api/v1/crm/deletion-handler.ts";
import { ApiContractError } from "../../modules/shared/public.ts";

const ID = "51000000-0000-4000-8000-000000000601";

test("parses only the exact lifecycle request and optional enum queue query", async () => {
  const request = json({ expected_record_version: 3,
    reason_code: "record.lifecycle.pending_delete_requested" });
  assert.deepEqual(await parseDeletionRequest(request, "student", ID, "request-1"), {
    entityType: "student", entityId: ID, expectedRecordVersion: 3,
    reasonCode: "record.lifecycle.pending_delete_requested", requestId: "request-1",
    idempotencyKey: "crm05-key",
  });
  assert.equal(parseDeletionQueueQuery(new Request("http://local/api/v1/crm/deletion-requests")), null);
  assert.equal(parseDeletionQueueQuery(new Request(
    "http://local/api/v1/crm/deletion-requests?entity_type=guardian")), "guardian");
});

test("rejects extra fields, wrong reason, invalid version and non-enum query", async () => {
  for (const body of [{ expected_record_version: 1, reason_code: "wrong" },
    { expected_record_version: 0, reason_code: "record.lifecycle.pending_delete_requested" },
    { expected_record_version: 1, reason_code: "record.lifecycle.pending_delete_requested", role: "founder" }]) {
    await assert.rejects(parseDeletionRequest(json(body), "student", ID, "request"));
  }
  for (const url of ["?entity_type=student&extra=1", "?entity_type=case", "?entity_type=student&entity_type=guardian"]) {
    assert.throws(() => parseDeletionQueueQuery(new Request(`http://local/api/v1/crm/deletion-requests${url}`)));
  }
});

test("serializes exact five-key receipt and six-key queue item with no extra data", () => {
  const receipt = deletionReceiptData({ entityType: "student", entityId: ID,
    status: "pending_delete", deletionRequestedAt: "2026-08-23T00:00:00.000Z", recordVersion: 2 });
  assert.deepEqual(Object.keys(receipt).sort(), ["deletion_requested_at", "entity_id", "entity_type",
    "record_version", "status"]);
  const summary = deletionSummaryData({ entityType: "student", entityId: ID, displayLabel: "Safe label",
    status: "pending_delete", deletionRequestedAt: "2026-08-23T00:00:00.000Z", recordVersion: 2 });
  assert.deepEqual(Object.keys(summary).sort(), ["deletion_requested_at", "display_label", "entity_id",
    "entity_type", "record_version", "status"]);
  assert.equal(JSON.stringify(summary).includes("email"), false);
});

test("maps equivalent stable errors and leaves unknown values fail closed", () => {
  const denial = equivalent("DELETION_REVIEW_FORBIDDEN");
  const mapped = mapDeletionReviewError(denial);
  assert.equal(mapped instanceof ApiContractError && mapped.code, "FORBIDDEN");
  const unknown = equivalent("UNKNOWN"); const plain = { name: "DeletionReviewError",
    code: "DELETION_REVIEW_FORBIDDEN" };
  assert.strictEqual(mapDeletionReviewError(unknown), unknown);
  assert.strictEqual(mapDeletionReviewError(plain), plain);
});

function json(body: unknown) { return new Request(`http://local/api/v1/students/${ID}/deletion-requests`, {
  method: "POST", headers: { "content-type": "application/json", "idempotency-key": "crm05-key" },
  body: JSON.stringify(body) }); }
function equivalent(code: string) { const error = new Error("redacted"); error.name = "DeletionReviewError";
  Object.defineProperty(error, "code", { value: code }); return error; }
