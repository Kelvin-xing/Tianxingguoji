import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  CaseCreateIdempotencyAttempt,
  classifyCaseRequestFailure,
  createExistingStudentCase,
  listCases,
  listCaseWorkspaceOptions,
  type CreateExistingStudentCaseInput,
} from "../../../modules/cases/client.ts";

const ids = Object.freeze({
  student: "10000000-0000-4000-8000-000000000001",
  binding: "20000000-0000-4000-8000-000000000001",
  manifest: "30000000-0000-4000-8000-000000000001",
  serviceCase: "40000000-0000-4000-8000-000000000001",
  assessment: "50000000-0000-4000-8000-000000000001",
});

test("case reads use cancellable same-origin API v1 requests and strict decoders", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  const requests: string[] = [];

  globalThis.fetch = async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.signal instanceof AbortSignal, true);
    return requests.length === 1
      ? apiResponse({ options: optionsFixture() })
      : apiResponse({ cases: [caseListFixture()] });
  };

  const options = await listCaseWorkspaceOptions(controller.signal);
  const cases = await listCases(controller.signal);
  assert.deepEqual(requests, ["/api/v1/cases/options", "/api/v1/cases"]);
  assert.equal(options.students[0]?.id, ids.student);
  assert.equal(cases[0]?.id, ids.serviceCase);
  assert.equal(Object.isFrozen(options), true);
  assert.equal(Object.isFrozen(options.students), true);
  assert.equal(Object.isFrozen(cases), true);
});

test("case read decoders reject unknown fields, duplicate identifiers and unknown enums", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const malformed = [
    { options: { ...optionsFixture(), unexpected: true } },
    { options: { ...optionsFixture(), students: [optionsFixture().students[0], optionsFixture().students[0]] } },
    { cases: [{ ...caseListFixture(), stage: "invented_stage" }] },
    { cases: [{ ...caseListFixture(), unexpected: true }] },
  ];

  for (const [index, data] of malformed.entries()) {
    globalThis.fetch = async () => apiResponse(data);
    const operation = index < 2 ? listCaseWorkspaceOptions() : listCases();
    await assert.rejects(operation, malformedResponse);
  }
});

test("case create sends only the frozen DTO and idempotency key", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const input = createInput();

  globalThis.fetch = async (request, init) => {
    assert.equal(request, "/api/v1/cases");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("idempotency-key"), "case-create-attempt-1");
    assert.deepEqual(JSON.parse(String(init?.body)), input);
    for (const forbidden of ["organization_id", "actor_user_id", "request_id"]) {
      assert.equal(String(init?.body).includes(forbidden), false);
    }
    return apiResponse({ case: createdFixture() });
  };

  assert.deepEqual(await createExistingStudentCase(input, "case-create-attempt-1"), createdFixture());
});

test("case create decoder validates all nine success fields and request identity", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const valid = createdFixture();
  const malformed = [
    { ...valid, recordVersion: 2 },
    { ...valid, stage: "background_collection" },
    { ...valid, studentId: "10000000-0000-4000-8000-000000000002" },
    { ...valid, unexpected: true },
    Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "assessmentId")),
  ];

  for (const record of malformed) {
    globalThis.fetch = async () => apiResponse({ case: record });
    await assert.rejects(
      createExistingStudentCase(createInput(), "case-create-contract-test"),
      malformedResponse,
    );
  }
});

test("one logical Case save and uncertain retries reuse a key; business edits rotate it", () => {
  let sequence = 0;
  const attempt = new CaseCreateIdempotencyAttempt(() => `case-attempt-${++sequence}`);

  const first = attempt.keyForSubmission();
  assert.equal(attempt.keyForSubmission(), first);
  attempt.markBusinessFieldChanged();
  const afterEdit = attempt.keyForSubmission();
  assert.notEqual(afterEdit, first);
  assert.equal(attempt.keyForSubmission(), afterEdit);
  attempt.complete();
  assert.notEqual(attempt.keyForSubmission(), afterEdit);
});

test("case failure classification covers every create presentation state", () => {
  assert.equal(classifyCaseRequestFailure(apiError("UNAUTHENTICATED", 401)), "unauthenticated");
  assert.equal(classifyCaseRequestFailure(apiError("FORBIDDEN", 403)), "forbidden");
  assert.equal(classifyCaseRequestFailure(apiError("NOT_FOUND", 404)), "not_found");
  assert.equal(classifyCaseRequestFailure(apiError("VALIDATION_FAILED", 422)), "validation");
  assert.equal(classifyCaseRequestFailure(apiError("CONFLICT", 409)), "conflict");
  assert.equal(classifyCaseRequestFailure(apiError("SERVICE_UNAVAILABLE", 503, true)), "unavailable");
  assert.equal(classifyCaseRequestFailure(new Error("private detail")), "unavailable");
});

function optionsFixture() {
  return {
    students: [{ id: ids.student, displayName: "Synthetic Student" }],
    primaryBindings: [{ id: ids.binding, role: "advisor", label: "My Advisor" }],
    manifests: [{ id: ids.manifest, compositionVersion: "k12-v1", label: "K12 v1" }],
  } as const;
}

function caseListFixture() {
  return {
    id: ids.serviceCase,
    caseNumber: "TX-2027-40000000",
    studentId: ids.student,
    studentName: "Synthetic Student",
    intakeYear: 2027,
    admissionType: "transfer",
    stage: "signed",
    updatedAt: "2026-08-23T00:00:00.000Z",
    primaryRole: "advisor",
  } as const;
}

function createInput(): CreateExistingStudentCaseInput {
  return {
    student_id: ids.student,
    intake_year: 2027,
    admission_type: "transfer",
    primary_role_binding_id: ids.binding,
    manifest_id: ids.manifest,
  };
}

function createdFixture() {
  return {
    id: ids.serviceCase,
    caseNumber: "TX-2027-40000000",
    studentId: ids.student,
    assessmentId: ids.assessment,
    intakeYear: 2027,
    admissionType: "transfer",
    stage: "signed",
    manifestId: ids.manifest,
    recordVersion: 1,
  } as const;
}

function apiResponse(data: unknown): Response {
  return Response.json({ api_version: "v1", request_id: "case-client-test", data }, {
    headers: { "x-request-id": "case-client-test" },
  });
}

function malformedResponse(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE";
}

function apiError(code: string, status: number, retryable = false): ApiClientError {
  return new ApiClientError({ code, status, retryable, requestId: "case-client-test" });
}
