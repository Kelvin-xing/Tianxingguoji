import assert from "node:assert/strict";
import test from "node:test";

import {
  RECONSTRUCTION_ACTIONS,
  buildReconstructionCommand,
  isReconstructionEnabled,
} from "../../modules/cases/application/reconstruction/route-contract.ts";

test("reconstruction routes are disabled by default and only enabled explicitly", () => {
  assert.equal(isReconstructionEnabled(undefined), false);
  assert.equal(isReconstructionEnabled("false"), false);
  assert.equal(isReconstructionEnabled("true"), true);
});

test("route command uses the server request context and caller idempotency key", () => {
  assert.deepEqual(
    buildReconstructionCommand(
      {
        expected_record_version: 4,
        event: {
          event_type: "service_case.stage_changed.v1",
          occurred_at: "2026-08-01T00:00:00.000Z",
          sequence_no: 1,
          evidence_type: "customer_record",
          evidence_ref: "source-01",
        },
      },
      { requestId: "request-server-01", idempotencyKey: "replay-safe-01" },
      "record_event",
    ),
    {
      expectedRecordVersion: 4,
      requestId: "request-server-01",
      idempotencyKey: "replay-safe-01",
      event: {
        eventType: "service_case.stage_changed.v1",
        occurredAt: "2026-08-01T00:00:00.000Z",
        sequenceNo: 1,
        evidenceType: "customer_record",
        evidenceRef: "source-01",
      },
    },
  );
});

test("route action contract is explicit and has no patch action", () => {
  assert.deepEqual(RECONSTRUCTION_ACTIONS, [
    "record-event",
    "record-gap",
    "submit",
    "request-changes",
    "create-next-draft",
    "approve",
    "activate",
    "append-correction",
  ]);
});
