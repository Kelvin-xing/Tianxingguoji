import assert from "node:assert/strict";
import test from "node:test";

import {
  isCaseReconstructionEnabled,
  methodNotAllowedResponse,
  parseCreateDraftRequest,
} from "../../modules/cases/reconstruction/route-contract.ts";

test("feature flag is server-only and disabled unless explicitly true", () => {
  assert.equal(isCaseReconstructionEnabled({}), false);
  assert.equal(isCaseReconstructionEnabled({ CASE_RECONSTRUCTION_ENABLED: "false" }), false);
  assert.equal(isCaseReconstructionEnabled({ CASE_RECONSTRUCTION_ENABLED: "true" }), true);
});

test("create parser requires idempotency and accepts only opaque pilot references", async () => {
  const valid = new Request("http://localhost/api/v1/cases/reconstructions", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "draft-001" },
    body: JSON.stringify({ pilot_reference: "pilot-001" }),
  });
  assert.deepEqual(await parseCreateDraftRequest(valid, "req-001"), {
    pilotReference: "pilot-001",
    requestId: "req-001",
    idempotencyKey: "draft-001",
  });

  const invalid = new Request("http://localhost/api/v1/cases/reconstructions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pilot_reference: "student@example.com" }),
  });
  await assert.rejects(parseCreateDraftRequest(invalid, "req-002"));
});

test("method errors use the versioned envelope and Allow header", async () => {
  const response = methodNotAllowedResponse(
    { requestId: "req-method", receivedAt: "2026-08-12T10:00:00.000Z" },
    "POST",
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal((await response.json()).error.code, "METHOD_NOT_ALLOWED");
});
