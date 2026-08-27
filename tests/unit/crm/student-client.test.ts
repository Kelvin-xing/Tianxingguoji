import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  StudentCreateIdempotencyAttempt,
  classifyStudentRequestFailure,
  createStudentWithPrimaryGuardian,
  getStudent,
  listStudents,
  validateStudentCreateDraft,
  type StudentCreateDraft,
} from "../../../modules/crm/client.ts";

const STUDENT_ID = "10000000-0000-4000-8000-000000000001";
const GUARDIAN_ID = "20000000-0000-4000-8000-000000000001";
const RELATIONSHIP_ID = "30000000-0000-4000-8000-000000000001";

test("student reads use cancellable same-origin API v1 requests and strict decoders", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  const requests: string[] = [];

  globalThis.fetch = async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.signal instanceof AbortSignal, true);
    return requests.length === 1
      ? apiResponse({ students: [studentListFixture()] })
      : apiResponse({ student: studentDetailFixture() });
  };

  const students = await listStudents(controller.signal);
  const detail = await getStudent(STUDENT_ID, controller.signal);
  assert.deepEqual(requests, ["/api/v1/students", `/api/v1/students/${STUDENT_ID}`]);
  assert.equal(students[0]?.id, STUDENT_ID);
  assert.equal(detail.recordVersion, 1);
  assert.equal(detail.guardians[0]?.id, GUARDIAN_ID);
  assert.equal(detail.guardians[0]?.recordVersion, 1);
  assert.equal(Object.isFrozen(detail), true);
  assert.equal(Object.isFrozen(detail.guardians), true);

  globalThis.fetch = async () => apiResponse({ students: [{ ...studentListFixture(), unexpected: true }] });
  await assert.rejects(
    listStudents(),
    (error: unknown) => error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE",
  );
});

test("create sends only the frozen aggregate fields and its idempotency key", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const draft = validDraft();

  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/v1/students");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("idempotency-key"), "student-create-attempt-1");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      student: {
        display_name: "Synthetic Student",
        date_of_birth: "2013-06-18",
        gender: null,
        contact_email: null,
        contact_phone: null,
      },
      primary_guardian: {
        kind: "new",
        display_name: "Synthetic Guardian",
        email: "guardian@example.invalid",
        phone: null,
        date_of_birth: null,
        gender: null,
        relationship_type: "father",
        relationship_description: null,
        is_legal_guardian: true,
        is_emergency_contact: false,
        is_billing_contact: false,
        notification_consent: false,
      },
    });
    for (const forbidden of ["organization", "actor", "role", "record_version", "is_primary_contact"]) {
      assert.equal(String(init?.body).includes(forbidden), false);
    }
    return apiResponse({
      student: { id: STUDENT_ID, record_version: 1 },
      primary_guardian: { id: GUARDIAN_ID, record_version: 1 },
      relationship: { id: RELATIONSHIP_ID, record_version: 1 },
    });
  };

  const result = await createStudentWithPrimaryGuardian(draft, "student-create-attempt-1");
  assert.deepEqual(result, {
    student: { id: STUDENT_ID, record_version: 1 },
    primary_guardian: { id: GUARDIAN_ID, record_version: 1 },
    relationship: { id: RELATIONSHIP_ID, record_version: 1 },
  });
});

test("create decoder validates every ADR-002 field and rejects contract drift", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const valid = {
    student: { id: STUDENT_ID, record_version: 1 },
    primary_guardian: { id: GUARDIAN_ID, record_version: 1 },
    relationship: { id: RELATIONSHIP_ID, record_version: 1 },
  };
  const malformed = [
    { ...valid, student: { id: STUDENT_ID } },
    { ...valid, student: { ...valid.student, unexpected: true } },
    { ...valid, primary_guardian: { ...valid.primary_guardian, record_version: 0 } },
    { ...valid, relationship: { ...valid.relationship, record_version: 0 } },
    { ...valid, unexpected: true },
  ];

  for (const response of malformed) {
    globalThis.fetch = async () => apiResponse(response);
    await assert.rejects(
      createStudentWithPrimaryGuardian(validDraft(), "student-create-contract-test"),
      (error: unknown) => error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE",
    );
  }
});

test("creation validation enforces names, date and at least one guardian contact", () => {
  assert.deepEqual(validateStudentCreateDraft(validDraft()), {});
  const invalid: StudentCreateDraft = {
    student: { display_name: " ", date_of_birth: "2026-02-31", gender: "", contact_email: "invalid", contact_phone: "" },
    primary_guardian: { display_name: "", email: "", phone: "", date_of_birth: "", gender: "", relationship_type: "mother", relationship_description: "", is_legal_guardian: false, is_emergency_contact: false, is_billing_contact: false, notification_consent: false },
  };
  assert.deepEqual(validateStudentCreateDraft(invalid), {
    studentDisplayName: "請輸入學生姓名。",
    studentDateOfBirth: "請輸入有效的出生日期。",
    studentEmail: "請輸入有效的學生 Email。",
    guardianDisplayName: "請輸入主要監護人姓名。",
    guardianContact: "監護人 Email 和電話至少填寫一項。",
  });
});

test("one logical save and uncertain retries reuse a key; a business edit rotates it", () => {
  let sequence = 0;
  const attempt = new StudentCreateIdempotencyAttempt(() => `student-attempt-${++sequence}`);

  const first = attempt.keyForSubmission();
  assert.equal(attempt.keyForSubmission(), first);
  attempt.markBusinessFieldChanged();
  const afterEdit = attempt.keyForSubmission();
  assert.notEqual(afterEdit, first);
  assert.equal(attempt.keyForSubmission(), afterEdit);
  attempt.complete();
  assert.notEqual(attempt.keyForSubmission(), afterEdit);
});

test("failure classification covers all creation presentation states", () => {
  assert.equal(classifyStudentRequestFailure(apiError("UNAUTHENTICATED", 401)), "unauthenticated");
  assert.equal(classifyStudentRequestFailure(apiError("FORBIDDEN", 403)), "forbidden");
  assert.equal(classifyStudentRequestFailure(apiError("NOT_FOUND", 404)), "not_found");
  assert.equal(classifyStudentRequestFailure(apiError("VALIDATION_FAILED", 422)), "validation");
  assert.equal(classifyStudentRequestFailure(apiError("CONFLICT", 409)), "conflict");
  assert.equal(classifyStudentRequestFailure(apiError("SERVICE_UNAVAILABLE", 503, true)), "unavailable");
  assert.equal(classifyStudentRequestFailure(new Error("private detail")), "unavailable");
});

function validDraft(): StudentCreateDraft {
  return {
    student: { display_name: " Synthetic Student ", date_of_birth: "2013-06-18", gender: "", contact_email: "", contact_phone: "" },
    primary_guardian: { display_name: " Synthetic Guardian ", email: "guardian@example.invalid", phone: "", date_of_birth: "", gender: "", relationship_type: "father", relationship_description: "", is_legal_guardian: true, is_emergency_contact: false, is_billing_contact: false, notification_consent: false },
  };
}

function studentListFixture() {
  return {
    id: STUDENT_ID,
    displayName: "Synthetic Student",
    dateOfBirth: "2013-06-18",
    gender: null,
    status: "active",
    primaryGuardianName: "Synthetic Guardian",
    updatedAt: "2026-08-22T00:00:00.000Z",
  } as const;
}

function studentDetailFixture() {
  return {
    ...studentListFixture(),
    contactEmail: null,
    contactPhone: null,
    recordVersion: 1,
    guardians: [{
      id: GUARDIAN_ID,
      displayName: "Synthetic Guardian",
      email: "guardian@example.invalid",
      phone: null,
      dateOfBirth: null,
      gender: null,
      status: "active",
      recordVersion: 1,
      relationshipType: "father",
      isLegalGuardian: true,
      isPrimaryContact: true,
      isEmergencyContact: false,
      isBillingContact: false,
      notificationConsent: false,
    }],
  } as const;
}

function apiResponse(data: unknown): Response {
  return Response.json({ api_version: "v1", request_id: "student-client-test", data }, {
    headers: { "x-request-id": "student-client-test" },
  });
}

function apiError(code: string, status: number, retryable = false): ApiClientError {
  return new ApiClientError({ code, status, retryable, requestId: "student-client-test" });
}
