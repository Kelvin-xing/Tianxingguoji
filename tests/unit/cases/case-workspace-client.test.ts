import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  CaseCreateIdempotencyAttempt,
  CaseWorkflowIdempotencyAttempt,
  classifyCaseRequestFailure,
  createExistingStudentCase,
  executeCaseWorkflowAction,
  getCase,
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
  primaryUser: "60000000-0000-4000-8000-000000000001",
});

test("case reads use cancellable API v1 requests and exact five-stage workflow projections", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.signal instanceof AbortSignal, true);
    if (requests.length === 1) return apiResponse({ options: optionsFixture() });
    if (requests.length === 2) return apiResponse({ cases: [caseListFixture()] });
    return apiResponse({ case: caseDetailFixture() });
  };

  const options = await listCaseWorkspaceOptions(controller.signal);
  const cases = await listCases(controller.signal);
  const detail = await getCase(ids.serviceCase, controller.signal);
  assert.deepEqual(requests, [
    "/api/v1/cases/options",
    "/api/v1/cases",
    `/api/v1/cases/${ids.serviceCase}`,
  ]);
  assert.equal(options.students[0]?.id, ids.student);
  assert.equal(cases[0]?.workflowStatus, "active");
  assert.deepEqual(cases[0]?.availableWorkflowActions, ["pause"]);
  assert.equal(detail.recordVersion, 2);
  assert.equal(Object.isFrozen(detail.availableWorkflowActions), true);
});

test("Case client and permanent browser fixtures contain no retired non-v1 Case routes", () => {
  for (const relativePath of [
    "../../../modules/cases/client.ts",
    "../../integration/case-01-dev-browser.test.ts",
    "../../integration/crm-student-create-dev-browser.test.ts",
    "../../integration/crm-06-referral-source-case-link-dev-browser.test.ts",
    "../../integration/task-01-case-task-workflow-dev-browser.test.ts",
    "../../integration/doc-01-case-document-registration-read-dev-browser.test.ts",
    "../../integration/doc-02-document-upload-scan-download-dev-browser.test.ts",
  ]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.equal(source.includes('"/api/cases'), false, relativePath);
    assert.equal(source.includes("'/api/cases"), false, relativePath);
    assert.equal(source.includes("`/api/cases"), false, relativePath);
    assert.match(source, /\/api\/v1\/cases/);
  }
});

test("case read decoders reject old stages, unknown fields, unordered actions and identity drift", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const malformed = [
    { cases: [{ ...caseListFixture(), stage: "application_submitted" }] },
    { cases: [{ ...caseListFixture(), workflowStatus: "invented" }] },
    { cases: [{ ...caseListFixture(), availableWorkflowActions: ["close", "pause"] }] },
    { cases: [{ ...caseListFixture(), availableWorkflowActions: ["close"] }] },
    { cases: [{ ...caseListFixture(), availableWorkflowActions: ["terminate"] }] },
    { cases: [{ ...caseListFixture(), primaryRole: "founder" }] },
    { cases: [{ ...caseListFixture(), unexpected: true }] },
    { case: { ...caseDetailFixture(), id: "40000000-0000-4000-8000-000000000002" } },
  ];
  for (const [index, data] of malformed.entries()) {
    globalThis.fetch = async () => apiResponse(data);
    await assert.rejects(index < malformed.length - 1 ? listCases() : getCase(ids.serviceCase), malformedResponse);
  }
});

test("case create returns only exact acknowledgement and does not accept the legacy wrapper", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const input = createInput();
  globalThis.fetch = async (request, init) => {
    assert.equal(request, "/api/v1/cases");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("idempotency-key"), "case-create-attempt-1");
    assert.deepEqual(JSON.parse(String(init?.body)), input);
    return apiResponse({ id: ids.serviceCase, record_version: 2 });
  };
  assert.deepEqual(await createExistingStudentCase(input, "case-create-attempt-1"), {
    id: ids.serviceCase,
    record_version: 2,
  });

  for (const invalid of [
    { case: { id: ids.serviceCase, record_version: 2 } },
    { id: ids.serviceCase, record_version: 2, stage: "background_collection" },
    { id: ids.serviceCase, record_version: 0 },
  ]) {
    globalThis.fetch = async () => apiResponse(invalid);
    await assert.rejects(createExistingStudentCase(input, "case-create-strict"), malformedResponse);
  }
});

test("workflow actions send only frozen pause/resume DTOs and strict acknowledgements", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requests: unknown[] = [];
  globalThis.fetch = async (request, init) => {
    assert.equal(request, `/api/v1/cases/${ids.serviceCase}/workflow-actions`);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("idempotency-key"), "workflow-attempt-1");
    requests.push(JSON.parse(String(init?.body)));
    return apiResponse({ id: ids.serviceCase, record_version: requests.length + 2 });
  };
  assert.equal((await executeCaseWorkflowAction(ids.serviceCase, {
    action: "pause", expected_record_version: 2, reason: "Need family response",
  }, "workflow-attempt-1")).record_version, 3);
  assert.equal((await executeCaseWorkflowAction(ids.serviceCase, {
    action: "resume", expected_record_version: 3, reason: null,
  }, "workflow-attempt-1")).record_version, 4);
  assert.deepEqual(requests, [
    { action: "pause", expected_record_version: 2, reason: "Need family response" },
    { action: "resume", expected_record_version: 3, reason: null },
  ]);
  await assert.rejects(executeCaseWorkflowAction(ids.serviceCase, {
    action: "pause", expected_record_version: 2, reason: "",
  }, "workflow-attempt-1"), TypeError);
  await assert.rejects(executeCaseWorkflowAction(ids.serviceCase, {
    action: "resume", expected_record_version: 3, reason: "not allowed",
  }, "workflow-attempt-1"), TypeError);
});

test("Case create and workflow attempts reuse uncertain keys and rotate on semantic change", () => {
  let createSequence = 0;
  const createAttempt = new CaseCreateIdempotencyAttempt(() => `case-attempt-${++createSequence}`);
  const first = createAttempt.keyForSubmission();
  assert.equal(createAttempt.keyForSubmission(), first);
  createAttempt.markBusinessFieldChanged();
  assert.notEqual(createAttempt.keyForSubmission(), first);

  let workflowSequence = 0;
  const workflowAttempt = new CaseWorkflowIdempotencyAttempt(
    () => `workflow-attempt-${++workflowSequence}`,
  );
  const pause = { action: "pause", expected_record_version: 2, reason: "Waiting" } as const;
  const firstPause = workflowAttempt.keyFor(pause);
  assert.equal(workflowAttempt.keyFor(pause), firstPause);
  assert.notEqual(workflowAttempt.keyFor({ ...pause, reason: "Changed" }), firstPause);
  assert.notEqual(workflowAttempt.keyFor({
    action: "resume", expected_record_version: 3, reason: null,
  }), firstPause);
  workflowAttempt.complete();
});

test("case failure classification includes stale and fails unknown errors closed", () => {
  assert.equal(classifyCaseRequestFailure(apiError("UNAUTHENTICATED", 401)), "unauthenticated");
  assert.equal(classifyCaseRequestFailure(apiError("FORBIDDEN", 403)), "forbidden");
  assert.equal(classifyCaseRequestFailure(apiError("NOT_FOUND", 404)), "not_found");
  assert.equal(classifyCaseRequestFailure(apiError("VALIDATION_FAILED", 422)), "validation");
  assert.equal(classifyCaseRequestFailure(apiError("STALE_VERSION", 409)), "stale");
  assert.equal(classifyCaseRequestFailure(apiError("CONFLICT", 409)), "conflict");
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
    stage: "background_collection",
    workflowStatus: "active",
    recordVersion: 2,
    availableWorkflowActions: ["pause"],
    updatedAt: "2026-08-23T00:00:00.000Z",
    primaryRole: "advisor",
  } as const;
}

function caseDetailFixture() {
  return {
    ...caseListFixture(),
    assessmentId: ids.assessment,
    assessmentStatus: "draft",
    manifestId: ids.manifest,
    primaryBindingLabel: "My Advisor",
    primaryUserId: ids.primaryUser,
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

function apiResponse(data: unknown): Response {
  return Response.json({ api_version: "v1", request_id: "case-client-test", data }, {
    headers: { "x-request-id": "case-client-test" },
  });
}

function malformedResponse(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE";
}

function apiError(code: string, status: number): ApiClientError {
  return new ApiClientError({ code, status, retryable: false, requestId: "case-client-test" });
}
