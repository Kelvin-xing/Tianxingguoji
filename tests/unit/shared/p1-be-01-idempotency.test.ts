import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeJson,
  completeIdempotencyRecord,
  createIdempotencyRecord,
  evaluateIdempotency,
  hashRequestPayload,
  validateIdempotencyActorScope,
} from "../../../modules/shared/public.ts";

const ids = Object.freeze({
  record: "10000000-0000-4000-8000-000000000001",
  organization: "10000000-0000-4000-8000-000000000002",
  user: "10000000-0000-4000-8000-000000000003",
});

test("canonical JSON sorts keys by code point and hashes equivalent commands identically", () => {
  const left = { z: 3, a: { second: true, first: "x" }, items: [2, 1] } as const;
  const right = { items: [2, 1], a: { first: "x", second: true }, z: 3 } as const;

  assert.equal(canonicalizeJson(left),
    '{"a":{"first":"x","second":true},"items":[2,1],"z":3}');
  assert.equal(hashRequestPayload(left), hashRequestPayload(right));
  assert.throws(() => canonicalizeJson({ unsafe: undefined } as never),
    /IDEMPOTENCY_HASH_INVALID/);
});

test("actor kind is part of the idempotency scope and opaque identifiers are bounded", () => {
  assert.deepEqual(validateIdempotencyActorScope({ kind: "portal", opaqueId: ids.user }), {
    kind: "portal",
    opaqueId: ids.user,
  });
  assert.throws(
    () => validateIdempotencyActorScope({ kind: "portal", opaqueId: "token with spaces" }),
    /IDEMPOTENCY_ACTOR_INVALID/,
  );

  const requestHash = hashRequestPayload({ operation: "shared.scope" });
  const record = createIdempotencyRecord({
    id: ids.record,
    organizationId: ids.organization,
    actorKind: "user",
    actorOpaqueId: ids.user,
    operation: "shared.scope",
    key: "scope-key",
    requestHash,
    createdAt: "2026-08-26T00:00:00.000Z",
  });
  assert.deepEqual(evaluateIdempotency({
    actorKind: "portal",
    actorOpaqueId: ids.user,
    key: record.key,
    requestHash,
    existing: record,
  }), { action: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
});

test("completed records replay the stable reference, response hash, and version", () => {
  const requestHash = hashRequestPayload({ operation: "shared.replay", expected_version: 1 });
  const record = completeIdempotencyRecord(createIdempotencyRecord({
    id: ids.record,
    organizationId: ids.organization,
    actorKind: "worker",
    actorOpaqueId: "job-001",
    operation: "shared.replay",
    key: "replay-key",
    requestHash,
    createdAt: "2026-08-26T00:00:00.000Z",
  }), {
    resultReference: "receipt-001",
    responseHash: hashRequestPayload({ id: "receipt-001", record_version: 1 }),
    updatedAt: "2026-08-26T00:00:01.000Z",
  });

  assert.deepEqual(evaluateIdempotency({
    actorKind: record.actorKind,
    actorOpaqueId: record.actorOpaqueId,
    key: record.key,
    requestHash,
    existing: record,
  }), {
    action: "replay",
    state: "completed",
    resultReference: "receipt-001",
    responseHash: record.responseHash,
    recordVersion: 2,
  });
});
