import assert from "node:assert/strict";
import test from "node:test";

import { parseStudentCreateRequest } from "../../../app/api/v1/students/route-contract.ts";
import { ApiContractError } from "../../../modules/shared/public.ts";

test("parses only the frozen JSON aggregate and server command context", async () => {
  const command = await parseStudentCreateRequest(request(validBody()), "crm-route-request-1");
  assert.deepEqual(command, {
    student: {
      displayName: "Synthetic Student",
      dateOfBirth: "2013-06-18",
      contactEmail: null,
      contactPhone: null,
    },
    primaryGuardian: {
      displayName: "Synthetic Guardian",
      email: "guardian@example.invalid",
      phone: null,
      relationshipType: "father",
      isLegalGuardian: true,
    },
    requestId: "crm-route-request-1",
    idempotencyKey: "crm-route-attempt-1",
  });
});

test("rejects unknown identity, organization, authorization and relationship fields", async () => {
  for (const body of [
    { ...validBody(), organization_id: "61000000-0000-4000-8000-000000000001" },
    { ...validBody(), actor_user_id: "61000000-0000-4000-8000-000000000002" },
    { ...validBody(), role: "advisor" },
    { ...validBody(), student: { ...validBody().student, status: "active" } },
    { ...validBody(), primary_guardian: { ...validBody().primary_guardian, is_primary_contact: true } },
  ]) await rejects(body, "INVALID_REQUEST");
  await rejects({
    ...validBody(),
    primary_guardian: { ...validBody().primary_guardian, relationship_type: "parent" },
  }, "VALIDATION_FAILED");
});

test("requires JSON and one nonempty Idempotency-Key", async () => {
  await assert.rejects(
    parseStudentCreateRequest(new Request("http://local/api/v1/students", {
      method: "POST",
      headers: { "content-type": "text/plain", "idempotency-key": "key" },
      body: "{}",
    }), "request-1"),
    apiCode("INVALID_REQUEST"),
  );
  await assert.rejects(
    parseStudentCreateRequest(request(validBody(), ""), "request-1"),
    apiCode("INVALID_REQUEST"),
  );
});

function validBody() {
  return {
    student: {
      display_name: "Synthetic Student",
      date_of_birth: "2013-06-18",
      contact_email: null,
      contact_phone: null,
    },
    primary_guardian: {
      display_name: "Synthetic Guardian",
      email: "guardian@example.invalid",
      phone: null,
      relationship_type: "father",
      is_legal_guardian: true,
    },
  };
}

function request(body: unknown, key = "crm-route-attempt-1"): Request {
  return new Request("http://local/api/v1/students", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

async function rejects(body: unknown, code: ApiContractError["code"]): Promise<void> {
  await assert.rejects(
    parseStudentCreateRequest(request(body), "request-1"),
    apiCode(code),
  );
}

function apiCode(code: ApiContractError["code"]) {
  return (error: unknown) => error instanceof ApiContractError && error.code === code;
}
