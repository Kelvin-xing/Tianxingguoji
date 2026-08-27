import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  GuardianRelationshipIdempotencyAttempt,
  attachGuardianRelationship,
  classifyGuardianRelationshipFailure,
  getGuardianRelationships,
  guardianAttachFingerprint,
  guardianHandoffFingerprint,
  handoffPrimaryGuardian,
  searchGuardians,
  type AttachGuardianRelationshipDraft,
} from "../../../modules/crm/client.ts";

const STUDENT_ID = "10000000-0000-4000-8000-000000000001";
const PRIMARY_GUARDIAN_ID = "20000000-0000-4000-8000-000000000001";
const SECONDARY_GUARDIAN_ID = "20000000-0000-4000-8000-000000000002";
const PRIMARY_RELATIONSHIP_ID = "30000000-0000-4000-8000-000000000001";
const SECONDARY_RELATIONSHIP_ID = "30000000-0000-4000-8000-000000000002";

test("current relationships and search use strict same-origin contracts", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  let request = 0;

  globalThis.fetch = async (input, init) => {
    request += 1;
    assert.equal(init?.signal instanceof AbortSignal, true);
    if (request === 1) {
      assert.equal(input, `/api/v1/students/${STUDENT_ID}/guardians`);
      assert.equal(init?.method, "GET");
      return apiResponse(currentViewFixture());
    }
    assert.equal(input, `/api/v1/students/${STUDENT_ID}/guardians/search`);
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { query: "Synthetic" });
    assert.equal(new Headers(init?.headers).has("idempotency-key"), false);
    return apiResponse([guardianFixture(SECONDARY_GUARDIAN_ID, "Secondary Guardian")]);
  };

  const view = await getGuardianRelationships(STUDENT_ID, controller.signal);
  const candidates = await searchGuardians(STUDENT_ID, "  Synthetic  ", controller.signal);
  assert.equal(view.student.id, STUDENT_ID);
  assert.equal(view.relationships[0]?.is_primary_contact, true);
  assert.equal(candidates[0]?.email_hint, "s***@example.invalid");
  assert.equal(Object.isFrozen(view.relationships), true);
  assert.equal(Object.isFrozen(candidates), true);
});

test("relationship decoders reject unknown, duplicate, excessive and unmasked data", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const malformed = [
    { ...currentViewFixture(), unexpected: true },
    { ...currentViewFixture(), relationships: [relationshipFixture(true), relationshipFixture(true)] },
    { ...currentViewFixture(), relationships: [{ ...relationshipFixture(true), record_version: 0 }] },
    { ...currentViewFixture(), relationships: [{ ...relationshipFixture(true), guardian: { ...guardianFixture(PRIMARY_GUARDIAN_ID, "Primary Guardian"), email_hint: "primary@example.invalid" } }] },
  ];

  for (const data of malformed) {
    globalThis.fetch = async () => apiResponse(data);
    await assert.rejects(
      getGuardianRelationships(STUDENT_ID),
      (error: unknown) => error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE",
    );
  }

  globalThis.fetch = async () => apiResponse(Array.from({ length: 21 }, (_, index) => ({
    ...guardianFixture(SECONDARY_GUARDIAN_ID, `Guardian ${index}`),
    id: `20000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
  })));
  await assert.rejects(
    searchGuardians(STUDENT_ID, "Synthetic"),
    (error: unknown) => error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE",
  );
  assert.throws(() => searchGuardians(STUDENT_ID, "x"), /Invalid guardian search query/);
});

test("attach and handoff send only frozen command fields and decode every response field", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const draft = attachDraft();
  let request = 0;
  globalThis.fetch = async (input, init) => {
    request += 1;
    const headers = new Headers(init?.headers);
    assert.equal(init?.method, "POST");
    if (request === 1) {
      assert.equal(input, `/api/v1/students/${STUDENT_ID}/guardians`);
      assert.equal(headers.get("idempotency-key"), "guardian-attach:attempt-1");
      assert.deepEqual(JSON.parse(String(init?.body)), draft);
      assert.equal(String(init?.body).includes("is_primary_contact"), false);
      return apiResponse({ relationship: commandRelationshipFixture(false) }, 201);
    }
    assert.equal(input, `/api/v1/students/${STUDENT_ID}/guardians/primary-handoffs`);
    assert.equal(headers.get("idempotency-key"), "guardian-handoff:attempt-1");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      successor_guardian_id: SECONDARY_GUARDIAN_ID,
      expected_primary_record_version: 1,
    });
    for (const forbidden of ["reason", "relationship_type", "is_legal_guardian", "organization_id", "role"]) {
      assert.equal(String(init?.body).includes(forbidden), false);
    }
    return apiResponse({
      relationship: commandRelationshipFixture(true),
      closed_relationship_ids: {
        previous_primary: PRIMARY_RELATIONSHIP_ID,
        successor_secondary: SECONDARY_RELATIONSHIP_ID,
      },
    });
  };

  const attached = await attachGuardianRelationship(STUDENT_ID, draft, "guardian-attach:attempt-1");
  const handedOff = await handoffPrimaryGuardian(STUDENT_ID, SECONDARY_GUARDIAN_ID, 1, "guardian-handoff:attempt-1");
  assert.equal(attached.is_primary_contact, false);
  assert.equal(handedOff.relationship.is_primary_contact, true);
  assert.equal(handedOff.closed_relationship_ids.previous_primary, PRIMARY_RELATIONSHIP_ID);
});

test("Guardian mutation attempts reuse uncertain retries and rotate on business changes", () => {
  let attachSequence = 0;
  const attach = new GuardianRelationshipIdempotencyAttempt("attach", () => `attach-attempt-${++attachSequence}`);
  const firstDraft = attachDraft();
  const firstFingerprint = guardianAttachFingerprint(firstDraft);
  const first = attach.keyFor(firstFingerprint);
  assert.equal(attach.keyFor(firstFingerprint), first);

  const changed = guardianAttachFingerprint({ ...firstDraft, notification_consent: true });
  const changedKey = attach.keyFor(changed);
  assert.notEqual(changedKey, first);
  assert.equal(attach.keyFor(changed), changedKey);
  attach.rotate();
  assert.notEqual(attach.keyFor(changed), changedKey);

  let handoffSequence = 0;
  const handoff = new GuardianRelationshipIdempotencyAttempt("handoff", () => `handoff-attempt-${++handoffSequence}`);
  const firstHandoff = handoff.keyFor(guardianHandoffFingerprint(SECONDARY_GUARDIAN_ID, 1));
  assert.equal(handoff.keyFor(guardianHandoffFingerprint(SECONDARY_GUARDIAN_ID, 1)), firstHandoff);
  assert.notEqual(handoff.keyFor(guardianHandoffFingerprint(SECONDARY_GUARDIAN_ID, 2)), firstHandoff);
});

test("Guardian failures distinguish authentication, permission, validation, stale and unavailable", () => {
  assert.equal(classifyGuardianRelationshipFailure(apiError("UNAUTHENTICATED", 401)), "unauthenticated");
  assert.equal(classifyGuardianRelationshipFailure(apiError("FORBIDDEN", 403)), "forbidden");
  assert.equal(classifyGuardianRelationshipFailure(apiError("NOT_FOUND", 404)), "not_found");
  assert.equal(classifyGuardianRelationshipFailure(apiError("VALIDATION_FAILED", 422)), "validation");
  assert.equal(classifyGuardianRelationshipFailure(apiError("STALE_VERSION", 409)), "stale");
  assert.equal(classifyGuardianRelationshipFailure(apiError("CONFLICT", 409)), "conflict");
  assert.equal(classifyGuardianRelationshipFailure(apiError("SERVICE_UNAVAILABLE", 503, true)), "unavailable");
  assert.equal(classifyGuardianRelationshipFailure(new Error("private detail")), "unavailable");
});

function attachDraft(): AttachGuardianRelationshipDraft {
  return {
    guardian_id: SECONDARY_GUARDIAN_ID,
    relationship_type: "mother",
    relationship_description: null,
    is_legal_guardian: true,
    is_emergency_contact: false,
    is_billing_contact: false,
    notification_consent: false,
  };
}

function currentViewFixture() {
  return {
    student: { id: STUDENT_ID, display_name: "Synthetic Student" },
    relationships: [relationshipFixture(true)],
  };
}

function relationshipFixture(primary: boolean) {
  return {
    relationship_id: PRIMARY_RELATIONSHIP_ID,
    guardian: guardianFixture(PRIMARY_GUARDIAN_ID, "Primary Guardian"),
    relationship_type: "father",
    is_legal_guardian: true,
    is_primary_contact: primary,
    is_emergency_contact: false,
    is_billing_contact: false,
    notification_consent: false,
    starts_at: "2026-08-22T00:00:00.000Z",
    record_version: 1,
  };
}

function guardianFixture(id: string, displayName: string) {
  return { id, display_name: displayName, email_hint: "s***@example.invalid", phone_hint: "****1234" };
}

function commandRelationshipFixture(primary: boolean) {
  return {
    relationship_id: SECONDARY_RELATIONSHIP_ID,
    guardian_id: SECONDARY_GUARDIAN_ID,
    relationship_type: "mother",
    is_legal_guardian: true,
    is_primary_contact: primary,
    is_emergency_contact: false,
    is_billing_contact: false,
    notification_consent: false,
    starts_at: "2026-08-22T00:00:00.000Z",
    record_version: primary ? 2 : 1,
  };
}

function apiResponse(data: unknown, status = 200): Response {
  return Response.json({ api_version: "v1", request_id: "guardian-client-test", data }, {
    status,
    headers: { "x-request-id": "guardian-client-test" },
  });
}

function apiError(code: string, status: number, retryable = false): ApiClientError {
  return new ApiClientError({ code, status, retryable, requestId: "guardian-client-test" });
}
