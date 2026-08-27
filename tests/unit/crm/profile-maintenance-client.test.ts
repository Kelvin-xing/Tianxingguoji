import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  ProfileUpdateIdempotencyAttempt,
  classifyProfileMaintenanceFailure,
  updateGuardianProfile,
  updateStudentProfile,
  validateGuardianProfileDraft,
  validateStudentProfileDraft,
  type GuardianProfileDraft,
  type StudentProfileDraft,
} from "../../../modules/crm/client.ts";

const STUDENT_ID = "10000000-0000-4000-8000-000000000001";
const GUARDIAN_ID = "20000000-0000-4000-8000-000000000001";

test("Student and Guardian profile PATCH requests send only normalized frozen fields", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request = 0;
  globalThis.fetch = async (input, init) => {
    request += 1;
    assert.equal(init?.method, "PATCH");
    const headers = new Headers(init?.headers);
    if (request === 1) {
      assert.equal(input, `/api/v1/students/${STUDENT_ID}`);
      assert.equal(headers.get("idempotency-key"), "student-profile:attempt-1");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        display_name: "Updated Student",
        date_of_birth: null,
        gender: null,
        contact_email: "student@example.invalid",
        contact_phone: null,
        expected_record_version: 1,
      });
      return apiResponse({ student: studentResult() });
    }
    assert.equal(input, `/api/v1/guardians/${GUARDIAN_ID}`);
    assert.equal(headers.get("idempotency-key"), "guardian-profile:attempt-1");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      display_name: "Updated Guardian",
      email: "guardian@example.invalid",
      phone: null,
      date_of_birth: null,
      gender: null,
      expected_record_version: 2,
    });
    return apiResponse({ guardian: guardianResult() });
  };

  const student = await updateStudentProfile(STUDENT_ID, studentDraft(), "student-profile:attempt-1");
  const guardian = await updateGuardianProfile(GUARDIAN_ID, guardianDraft(), "guardian-profile:attempt-1");
  assert.equal(student.record_version, 2);
  assert.equal(guardian.record_version, 3);
  assert.equal(Object.isFrozen(student), true);
  assert.equal(Object.isFrozen(guardian), true);
});

test("profile success decoders reject missing, extra, malformed and mismatched fields", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const malformedStudents = [
    { student: { id: STUDENT_ID, record_version: 2 } },
    { student: { ...studentResult(), unexpected: true } },
    { student: { ...studentResult(), record_version: 0 } },
    { student: { ...studentResult(), updated_at: "not-a-timestamp" } },
    { student: { ...studentResult(), id: GUARDIAN_ID } },
    { student: { ...studentResult(), display_name: "Profile fields do not belong in the receipt" } },
    { student: studentResult(), unexpected: true },
  ];
  for (const data of malformedStudents) {
    globalThis.fetch = async () => apiResponse(data);
    await assert.rejects(
      updateStudentProfile(STUDENT_ID, studentDraft(), "student-profile:contract"),
      malformedResponse,
    );
  }

  const malformedGuardians = [
    { guardian: { id: GUARDIAN_ID, record_version: 3 } },
    { guardian: { ...guardianResult(), unexpected: true } },
    { guardian: { ...guardianResult(), record_version: 0 } },
    { guardian: { ...guardianResult(), updated_at: "not-a-timestamp" } },
    { guardian: { ...guardianResult(), id: STUDENT_ID } },
    { guardian: { ...guardianResult(), email: "profile-fields-are-rejected@example.invalid" } },
  ];
  for (const data of malformedGuardians) {
    globalThis.fetch = async () => apiResponse(data);
    await assert.rejects(
      updateGuardianProfile(GUARDIAN_ID, guardianDraft(), "guardian-profile:contract"),
      malformedResponse,
    );
  }
});

test("profile validation enforces the frozen field constraints", () => {
  assert.deepEqual(validateStudentProfileDraft(studentDraft()), {});
  assert.deepEqual(validateGuardianProfileDraft(guardianDraft()), {});
  assert.deepEqual(validateStudentProfileDraft({
    display_name: " ",
    date_of_birth: "2026-02-31",
    gender: "",
    contact_email: "invalid",
    contact_phone: "x".repeat(65),
    expected_record_version: 1,
  }), {
    displayName: "學生姓名必須為 1 至 512 個字元。",
    dateOfBirth: "請輸入有效的出生日期。",
    email: "請輸入有效的學生 Email。",
    phone: "學生電話不可超過 64 個字元。",
  });
  assert.deepEqual(validateGuardianProfileDraft({
    display_name: " ",
    email: "",
    phone: "",
    date_of_birth: "",
    gender: "",
    expected_record_version: 1,
  }), {
    displayName: "監護人姓名必須為 1 至 512 個字元。",
    contact: "監護人 Email 和電話至少填寫一項。",
  });
  assert.throws(
    () => validateStudentProfileDraft({ ...studentDraft(), expected_record_version: 0 }),
    /record version/,
  );
});

test("profile Save attempts reuse uncertain retries, rotate after edits and stay namespaced", () => {
  let studentSequence = 0;
  let guardianSequence = 0;
  const student = new ProfileUpdateIdempotencyAttempt(
    "student",
    () => `student-profile:attempt-${++studentSequence}`,
  );
  const guardian = new ProfileUpdateIdempotencyAttempt(
    "guardian",
    () => `guardian-profile:attempt-${++guardianSequence}`,
  );
  const firstStudent = student.keyForSubmission();
  assert.equal(student.keyForSubmission(), firstStudent);
  student.markBusinessFieldChanged();
  assert.notEqual(student.keyForSubmission(), firstStudent);
  const firstGuardian = guardian.keyForSubmission();
  assert.equal(guardian.keyForSubmission(), firstGuardian);
  assert.equal(student.operationName(), "student");
  assert.equal(guardian.operationName(), "guardian");
  assert.notEqual(firstStudent, firstGuardian);
});

test("profile failures distinguish stale from validation, denial and unavailable", () => {
  assert.equal(classifyProfileMaintenanceFailure(apiError("UNAUTHENTICATED", 401)), "unauthenticated");
  assert.equal(classifyProfileMaintenanceFailure(apiError("FORBIDDEN", 403)), "forbidden");
  assert.equal(classifyProfileMaintenanceFailure(apiError("NOT_FOUND", 404)), "not_found");
  assert.equal(classifyProfileMaintenanceFailure(apiError("VALIDATION_FAILED", 422)), "validation");
  assert.equal(classifyProfileMaintenanceFailure(apiError("STALE_VERSION", 409)), "stale");
  assert.equal(classifyProfileMaintenanceFailure(apiError("CONFLICT", 409)), "conflict");
  assert.equal(classifyProfileMaintenanceFailure(apiError("SERVICE_UNAVAILABLE", 503, true)), "unavailable");
  assert.equal(classifyProfileMaintenanceFailure(new Error("private detail")), "unavailable");
});

function studentDraft(): StudentProfileDraft {
  return {
    display_name: " Updated Student ",
    date_of_birth: "",
    gender: "",
    contact_email: " Student@Example.Invalid ",
    contact_phone: "",
    expected_record_version: 1,
  };
}

function guardianDraft(): GuardianProfileDraft {
  return {
    display_name: " Updated Guardian ",
    email: " Guardian@Example.Invalid ",
    phone: "",
    date_of_birth: "",
    gender: "",
    expected_record_version: 2,
  };
}

function studentResult() {
  return {
    id: STUDENT_ID,
    record_version: 2,
    updated_at: "2026-08-23T00:00:00.000Z",
  } as const;
}

function guardianResult() {
  return {
    id: GUARDIAN_ID,
    record_version: 3,
    updated_at: "2026-08-23T00:00:00.000Z",
  } as const;
}

function malformedResponse(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE";
}

function apiResponse(data: unknown): Response {
  return Response.json({ api_version: "v1", request_id: "profile-client-test", data }, {
    headers: { "x-request-id": "profile-client-test" },
  });
}

function apiError(code: string, status: number, retryable = false): ApiClientError {
  return new ApiClientError({ code, status, retryable, requestId: "profile-client-test" });
}
