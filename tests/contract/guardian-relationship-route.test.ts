import assert from "node:assert/strict";
import test from "node:test";

import {
  mapGuardianRelationshipError,
  parseAttachCommand,
  parseHandoffCommand,
  parseSearchRequest,
  toCurrentRelationshipsData,
} from "../../app/api/v1/students/[studentId]/guardians/handler.ts";
import { ApiContractError } from "../../modules/shared/public.ts";

const STUDENT_ID = "51000000-0000-4000-8000-000000000601";
const GUARDIAN_ID = "51000000-0000-4000-8000-000000000702";

test("parses frozen attach, search and handoff DTOs", async () => {
  assert.deepEqual(await parseAttachCommand(jsonRequest(validAttach(), true), STUDENT_ID, "crm02.attach"), {
    studentId: STUDENT_ID,
    guardianId: GUARDIAN_ID,
    relationshipType: "father",
    isLegalGuardian: true,
    isEmergencyContact: false,
    isBillingContact: false,
    notificationConsent: false,
    requestId: "crm02.attach",
    idempotencyKey: "crm02-attempt-1",
  });
  assert.deepEqual(await parseSearchRequest(jsonRequest({ query: "  guardian  " }), STUDENT_ID), {
    studentId: STUDENT_ID,
    query: "guardian",
  });
  assert.deepEqual(await parseHandoffCommand(jsonRequest({
    successor_guardian_id: GUARDIAN_ID,
    expected_primary_record_version: 1,
  }, true), STUDENT_ID, "crm02.handoff"), {
    studentId: STUDENT_ID,
    successorGuardianId: GUARDIAN_ID,
    expectedPrimaryRecordVersion: 1,
    requestId: "crm02.handoff",
    idempotencyKey: "crm02-attempt-1",
  });
});

test("rejects client primary, reason, identity and unknown fields", async () => {
  for (const body of [
    { ...validAttach(), is_primary_contact: false },
    { ...validAttach(), organization_id: "51000000-0000-4000-8000-000000000001" },
    { ...validAttach(), role: "advisor" },
  ]) await reject(parseAttachCommand(jsonRequest(body, true), STUDENT_ID, "request"), "INVALID_REQUEST");
  await reject(parseHandoffCommand(jsonRequest({
    successor_guardian_id: GUARDIAN_ID,
    expected_primary_record_version: 1,
    reason: "guardian.primary.handoff",
  }, true), STUDENT_ID, "request"), "INVALID_REQUEST");
  await reject(parseSearchRequest(jsonRequest({ query: "guardian", email: "private@example.invalid" }), STUDENT_ID),
    "INVALID_REQUEST");
});

test("rejects invalid relationship vocabulary, query length, content type and missing idempotency", async () => {
  await reject(parseAttachCommand(jsonRequest({ ...validAttach(), relationship_type: "parent" }, true),
    STUDENT_ID, "request"), "VALIDATION_FAILED");
  await reject(parseSearchRequest(jsonRequest({ query: "x" }), STUDENT_ID), "VALIDATION_FAILED");
  await reject(parseAttachCommand(jsonRequest(validAttach(), false), STUDENT_ID, "request"), "INVALID_REQUEST");
  await reject(parseSearchRequest(new Request("http://local/search", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ query: "guardian" }),
  }), STUDENT_ID), "INVALID_REQUEST");
});

test("serializes the unchanged current relationship DTO with masked hints", () => {
  const data = toCurrentRelationshipsData({
    student: { id: STUDENT_ID, displayName: "Synthetic Student" },
    relationships: [{
      relationship: {
        relationshipId: "51000000-0000-4000-8000-000000000801",
        studentId: STUDENT_ID,
        guardianId: GUARDIAN_ID,
        relationshipType: "mother",
        isLegalGuardian: true,
        isPrimaryContact: true,
        isEmergencyContact: false,
        isBillingContact: false,
        notificationConsent: false,
        startsAt: "2026-08-23T00:00:00.000Z",
        recordVersion: 2,
      },
      guardian: {
        id: GUARDIAN_ID,
        displayName: "Synthetic Guardian",
        emailHint: "s***@example.invalid",
        phoneHint: "******1234",
      },
    }],
  });
  assert.deepEqual(Object.keys(data).sort(), ["relationships", "student"]);
  assert.deepEqual(Object.keys(data.student).sort(), ["display_name", "id"]);
  assert.deepEqual(Object.keys(data.relationships[0]!).sort(), [
    "guardian", "is_billing_contact", "is_emergency_contact", "is_legal_guardian",
    "is_primary_contact", "notification_consent", "record_version", "relationship_id",
    "relationship_type", "starts_at",
  ]);
  assert.deepEqual(Object.keys(data.relationships[0]!.guardian).sort(), [
    "display_name", "email_hint", "id", "phone_hint",
  ]);
  assert.equal(data.relationships[0]!.guardian.email_hint, "s***@example.invalid");
});

test("maps stable not-found errors and rejects unknown error shapes", () => {
  const equivalent = Object.assign(new Error("safe"), {
    name: "GuardianRelationshipError",
    code: "GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND",
  });
  const mapped = mapGuardianRelationshipError(equivalent);
  assert.ok(mapped instanceof ApiContractError);
  assert.equal(mapped.code, "NOT_FOUND");
  const plain = { name: "GuardianRelationshipError", code: "GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND" };
  assert.equal(mapGuardianRelationshipError(plain), plain);
  const unknown = Object.assign(new Error("safe"), {
    name: "GuardianRelationshipError",
    code: "GUARDIAN_RELATIONSHIP_UNKNOWN",
  });
  assert.equal(mapGuardianRelationshipError(unknown), unknown);
});

function validAttach() {
  return {
    guardian_id: GUARDIAN_ID,
    relationship_type: "father",
    is_legal_guardian: true,
    is_emergency_contact: false,
    is_billing_contact: false,
    notification_consent: false,
  };
}

function jsonRequest(body: unknown, idempotent = false): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (idempotent) headers["idempotency-key"] = "crm02-attempt-1";
  return new Request("http://local/api/v1/students/guardians", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function reject(promise: Promise<unknown>, code: ApiContractError["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof ApiContractError && error.code === code);
}
