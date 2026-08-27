import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  deletionReceiptData,
  deletionDecisionData,
  deletionSummaryData,
  mapDeletionReviewError,
  parseDeletionDecision,
  parseDeletionQueueQuery,
  parseDeletionRequest,
} from "../../app/api/v1/crm/deletion-handler.ts";
import { ApiContractError } from "../../modules/shared/public.ts";

const ID = "51000000-0000-4000-8000-000000000601";

test("parses only the exact lifecycle request and optional enum queue query", async () => {
  const request = json({
    expected_record_version: 3,
    reason_code: "record.lifecycle.pending_delete_requested",
  });
  assert.deepEqual(
    await parseDeletionRequest(request, "student", ID, "request-1"),
    {
      entityType: "student",
      entityId: ID,
      expectedRecordVersion: 3,
      reasonCode: "record.lifecycle.pending_delete_requested",
      requestId: "request-1",
      idempotencyKey: "crm05-key",
    },
  );
  assert.equal(
    parseDeletionQueueQuery(
      new Request("http://local/api/v1/crm/deletion-requests"),
    ),
    null,
  );
  assert.equal(
    parseDeletionQueueQuery(
      new Request(
        "http://local/api/v1/crm/deletion-requests?entity_type=guardian",
      ),
    ),
    "guardian",
  );
});

test("parses exact approve/reject decisions from a canonical server locator", async () => {
  const locator =
    "del_v1_djE6c3R1ZGVudDo1MTAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDA2MDE";
  for (const decision of ["approve", "reject"] as const) {
    const parsed = await parseDeletionDecision(
      new Request("http://local", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "decision-key",
        },
        body: JSON.stringify({ decision, expected_record_version: 4 }),
      }),
      locator,
      "correlation-request",
    );
    assert.deepEqual(parsed, {
      entityType: "student",
      entityId: ID,
      decision,
      expectedRecordVersion: 4,
      correlationRequestId: "correlation-request",
      idempotencyKey: "decision-key",
    });
  }
});

test("rejects extra fields, wrong reason, invalid version and non-enum query", async () => {
  for (const body of [
    { expected_record_version: 1, reason_code: "wrong" },
    {
      expected_record_version: 0,
      reason_code: "record.lifecycle.pending_delete_requested",
    },
    {
      expected_record_version: 1,
      reason_code: "record.lifecycle.pending_delete_requested",
      role: "founder",
    },
  ]) {
    await assert.rejects(
      parseDeletionRequest(json(body), "student", ID, "request"),
    );
  }
  for (const url of [
    "?entity_type=student&extra=1",
    "?entity_type=case",
    "?entity_type=student&entity_type=guardian",
  ]) {
    assert.throws(() =>
      parseDeletionQueueQuery(
        new Request(`http://local/api/v1/crm/deletion-requests${url}`),
      ),
    );
  }

  const decisionRequest = (
    body: unknown,
    headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": "decision-key",
    },
  ) =>
    new Request("http://local", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const locator =
    "del_v1_djE6c3R1ZGVudDo1MTAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDA2MDE";
  for (const body of [
    { decision: "approve", expected_record_version: 1, reason: "client" },
    { decision: "maybe", expected_record_version: 1 },
    { decision: "approve", expected_record_version: 0 },
  ]) {
    await assert.rejects(
      parseDeletionDecision(decisionRequest(body), locator, "request"),
    );
  }
  await assert.rejects(
    parseDeletionDecision(
      decisionRequest(
        { decision: "approve", expected_record_version: 1 },
        {
          "content-type": "text/plain",
          "idempotency-key": "decision-key",
        },
      ),
      locator,
      "request",
    ),
  );
  await assert.rejects(
    parseDeletionDecision(
      decisionRequest(
        { decision: "approve", expected_record_version: 1 },
        {
          "content-type": "application/json",
        },
      ),
      locator,
      "request",
    ),
  );
  await assert.rejects(
    parseDeletionDecision(
      decisionRequest({ decision: "approve", expected_record_version: 1 }),
      "del_v1_invalid",
      "request",
    ),
  );
  await assert.rejects(
    parseDeletionDecision(
      new Request("http://local", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "decision-key",
        },
        body: "{",
      }),
      locator,
      "request",
    ),
  );
});

test("serializes exact receipt, queue, and decision DTOs with no extra data", () => {
  const receipt = deletionReceiptData({
    entityType: "student",
    entityId: ID,
    status: "pending_delete",
    deletionRequestedAt: "2026-08-23T00:00:00.000Z",
    recordVersion: 2,
  });
  assert.deepEqual(Object.keys(receipt).sort(), [
    "deletion_requested_at",
    "entity_id",
    "entity_type",
    "record_version",
    "status",
  ]);
  const summary = deletionSummaryData({
    entityType: "student",
    entityId: ID,
    requestId: "del_v1_synthetic",
    displayLabel: "Safe label",
    status: "pending_delete",
    deletionRequestedAt: "2026-08-23T00:00:00.000Z",
    recordVersion: 2,
  });
  assert.deepEqual(Object.keys(summary).sort(), [
    "deletion_requested_at",
    "display_label",
    "entity_id",
    "entity_type",
    "record_version",
    "request_id",
    "status",
  ]);
  const decision = deletionDecisionData({
    entityType: "student",
    entityId: ID,
    status: "deleted",
    recordVersion: 3,
    occurredAt: "2026-08-23T00:00:00.000Z",
  });
  assert.deepEqual(Object.keys(decision).sort(), [
    "entity_id",
    "entity_type",
    "occurred_at",
    "record_version",
    "status",
  ]);
  assert.equal(JSON.stringify(decision).includes("reason"), false);
  assert.equal(JSON.stringify(summary).includes("email"), false);
});

test("maps equivalent stable errors and leaves unknown values fail closed", () => {
  const mappings = new Map([
    ["DELETION_REVIEW_FORBIDDEN", "FORBIDDEN"],
    ["DELETION_REVIEW_INVALID", "VALIDATION_FAILED"],
    ["DELETION_REVIEW_NOT_FOUND", "NOT_FOUND"],
    ["DELETION_REVIEW_STALE", "STALE_VERSION"],
    ["DELETION_REVIEW_CONFLICT", "CONFLICT"],
    ["DELETION_REVIEW_IDEMPOTENCY_KEY_REUSED", "CONFLICT"],
    ["DELETION_REVIEW_IDEMPOTENCY_IN_PROGRESS", "CONFLICT"],
    ["DELETION_REVIEW_UNAVAILABLE", "SERVICE_UNAVAILABLE"],
  ] as const);
  for (const [source, target] of mappings) {
    const mapped = mapDeletionReviewError(equivalent(source));
    assert.equal(mapped instanceof ApiContractError && mapped.code, target);
  }
  const unknown = equivalent("UNKNOWN");
  const plain = {
    name: "DeletionReviewError",
    code: "DELETION_REVIEW_FORBIDDEN",
  };
  assert.strictEqual(mapDeletionReviewError(unknown), unknown);
  assert.strictEqual(mapDeletionReviewError(plain), plain);
});

test("decision route stays on request-time Access and service boundaries", async () => {
  const source = await readFile(
    "app/api/v1/crm/deletion-requests/[requestId]/decisions/route.ts",
    "utf8",
  );
  assert.match(source, /requireApiRequestAccessContext/);
  assert.match(source, /handleApiRequest/);
  assert.match(source, /parseDeletionDecision/);
  assert.match(source, /service\.decideDeletion/);
  assert.match(source, /deletionDecisionData/);
  assert.match(source, /force-dynamic/);
  assert.match(source, /runtime = "nodejs"/);
  assert.doesNotMatch(source, /repository|actor\.role|new Response/);
});

function json(body: unknown) {
  return new Request(`http://local/api/v1/students/${ID}/deletion-requests`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "crm05-key",
    },
    body: JSON.stringify(body),
  });
}
function equivalent(code: string) {
  const error = new Error("redacted");
  error.name = "DeletionReviewError";
  Object.defineProperty(error, "code", { value: code });
  return error;
}
