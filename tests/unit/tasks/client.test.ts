import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  TaskIdempotencyAttempt,
  classifyTaskFailure,
  createTask,
  createTaskFingerprint,
  completeApplicationTask,
  getTask,
  getTaskAssigneeOptions,
  listTasks,
  transitionTask,
  transitionAutomaticTask,
  automaticTaskTransitionFingerprint,
  transitionTaskFingerprint,
} from "../../../modules/tasks/client.ts";

const TASK_ID = "10000000-0000-4000-8000-000000000001";
const CASE_ID = "20000000-0000-4000-8000-000000000001";
const ASSIGNEE_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_ASSIGNEE_ID = "30000000-0000-4000-8000-000000000002";
const ASSIGNMENT_ID = "30000000-0000-4000-8000-000000000003";
const TARGET_ID = "50000000-0000-4000-8000-000000000001";
const COMPLETION_RECEIPT_ID = "60000000-0000-4000-8000-000000000001";
const EVIDENCE_ID = "70000000-0000-4000-8000-000000000001";

test("Task list and detail strictly decode both audience projections", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request = 0;
  globalThis.fetch = async (input) => {
    request += 1;
    if (request === 1) {
      assert.equal(input, `/api/v1/tasks?case_id=${CASE_ID}`);
      return apiResponse({ audience: "case_workspace", tasks: [caseTask()] });
    }
    if (request === 2) {
      assert.equal(input, "/api/v1/tasks");
      return apiResponse({ audience: "assigned_task", tasks: [assignedTask()] });
    }
    assert.equal(input, `/api/v1/tasks/${TASK_ID}`);
    return apiResponse({ audience: "assigned_task", task: assignedTask() });
  };

  const internal = await listTasks(CASE_ID);
  assert.equal(internal.audience, "case_workspace");
  assert.equal(internal.tasks[0]?.available_transitions[0]?.to, "accepted");
  const assigned = await listTasks();
  assert.equal(assigned.audience, "assigned_task");
  assert.equal("case_id" in assigned.tasks[0]!, false);
  assert.equal((await getTask(TASK_ID)).audience, "assigned_task");
});

test("Task reads reject extra keys, mixed audiences and malformed transitions", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const invalid = [
    { audience: "assigned_task", tasks: [{ ...assignedTask(), case_id: CASE_ID }] },
    { audience: "case_workspace", tasks: [{ ...caseTask(), private_email: "not-allowed@example.invalid" }] },
    { audience: "assigned_task", tasks: [{ ...assignedTask(), available_transitions: [{ to: "accepted", requires_reason: false, requires_assignee: true }] }] },
    { audience: "assigned_task", tasks: [{ ...assignedTask(), available_transitions: [{ to: "accepted", requires_reason: false, requires_assignee: false }, { to: "accepted", requires_reason: false, requires_assignee: false }] }] },
    { audience: "case_workspace", tasks: [{ ...caseTask(), case_id: "20000000-0000-4000-8000-000000000099" }] },
  ];
  for (const value of invalid) {
    globalThis.fetch = async () => apiResponse(value);
    await assert.rejects(listTasks(value.audience === "case_workspace" ? CASE_ID : undefined), malformedResponse);
  }
  globalThis.fetch = async () => apiResponse({ audience: "unknown", task: assignedTask() });
  await assert.rejects(getTask(TASK_ID), malformedResponse);
});

test("Task assignee options are exact, bounded, unique and canonical", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const canonical = [
    { id: ASSIGNEE_ID, role: "advisor", label: "Advisor A" },
    { id: OTHER_ASSIGNEE_ID, role: "contractor", label: "Contractor A" },
  ];
  globalThis.fetch = async (input) => {
    assert.equal(input, `/api/v1/tasks/options?case_id=${CASE_ID}`);
    return apiResponse({ assignees: canonical });
  };
  assert.equal((await getTaskAssigneeOptions(CASE_ID)).assignees.length, 2);

  for (const assignees of [
    [...canonical].reverse(),
    [{ ...canonical[0], email: "not-allowed@example.invalid" }],
    [canonical[0], canonical[0]],
    Array.from({ length: 101 }, (_, index) => ({ id: syntheticUuid(index), role: "advisor", label: `Advisor ${String(index).padStart(3, "0")}` })),
  ]) {
    globalThis.fetch = async () => apiResponse({ assignees });
    await assert.rejects(getTaskAssigneeOptions(CASE_ID), malformedResponse);
  }
});

test("Task writes send exact bodies and accept only exact two-key acknowledgements", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request = 0;
  globalThis.fetch = async (input, init) => {
    request += 1;
    assert.equal(new Headers(init?.headers).get("idempotency-key"), `task:test-${request}`);
    if (request === 1) {
      assert.equal(input, "/api/v1/tasks");
      assert.deepEqual(JSON.parse(String(init?.body)), createInput());
      return apiResponse({ id: TASK_ID, record_version: 1 });
    }
    assert.equal(input, `/api/v1/tasks/${TASK_ID}/transitions`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      to: "accepted",
      expected_record_version: 1,
      reason: "",
      next_assignee_user_id: null,
    });
    return apiResponse({ id: TASK_ID, record_version: 2 });
  };
  assert.deepEqual(await createTask(createInput(), "task:test-1"), { id: TASK_ID, record_version: 1 });
  assert.deepEqual(await transitionTask(TASK_ID, { to: "accepted", expected_record_version: 1, reason: "", next_assignee_user_id: null }, "task:test-2"), { id: TASK_ID, record_version: 2 });

  for (const invalid of [
    { id: TASK_ID, record_version: 1, state: "assigned" },
    { id: TASK_ID, record_version: 2 },
    { id: "invalid", record_version: 1 },
  ]) {
    globalThis.fetch = async () => apiResponse(invalid);
    await assert.rejects(createTask(createInput(), "task:strict"), malformedResponse);
  }
  globalThis.fetch = async () => apiResponse({ id: OTHER_ASSIGNEE_ID, record_version: 2 });
  await assert.rejects(transitionTask(TASK_ID, { to: "accepted", expected_record_version: 1, reason: "", next_assignee_user_id: null }, "task:strict"), malformedResponse);
});

test("Automatic Task writes only use p3-transitions and strictly decode automation", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request = 0;
  globalThis.fetch = async (input, init) => {
    request += 1;
    assert.equal(input, `/api/v1/tasks/${TASK_ID}/p3-transitions`);
    assert.doesNotMatch(String(input), /\/transitions$/);
    if (request === 1) {
      assert.deepEqual(JSON.parse(String(init?.body)), { action: "accept", expected_record_version: 1 });
      return apiResponse({ id: TASK_ID, record_version: 2, state: "accepted", completion_receipt_id: null });
    }
    assert.deepEqual(JSON.parse(String(init?.body)), completionInput());
    return apiResponse({
      id: TASK_ID,
      record_version: 3,
      state: "completed",
      completion_receipt_id: COMPLETION_RECEIPT_ID,
      automation: { target_transition: "pending", target_id: TARGET_ID, target_record_version: null },
    });
  };
  assert.deepEqual(
    await transitionAutomaticTask(TASK_ID, { action: "accept", expected_record_version: 1 }, "task:p3-accept"),
    { id: TASK_ID, record_version: 2, state: "accepted", completion_receipt_id: null },
  );
  assert.equal(
    (await completeApplicationTask(TASK_ID, TARGET_ID, completionInput(), "task:p3-complete")).automation.target_transition,
    "pending",
  );

  for (const invalid of [
    { id: TASK_ID, record_version: 3, state: "completed", completion_receipt_id: COMPLETION_RECEIPT_ID },
    { id: TASK_ID, record_version: 3, state: "completed", completion_receipt_id: COMPLETION_RECEIPT_ID,
      automation: { target_transition: "completed", target_id: TARGET_ID, target_record_version: null } },
    { id: TASK_ID, record_version: 3, state: "completed", completion_receipt_id: COMPLETION_RECEIPT_ID,
      automation: { target_transition: "pending", target_id: OTHER_ASSIGNEE_ID, target_record_version: null } },
  ]) {
    globalThis.fetch = async () => apiResponse(invalid);
    await assert.rejects(completeApplicationTask(TASK_ID, TARGET_ID, completionInput(), "task:p3-strict"), malformedResponse);
  }
});

test("Automatic Task rejection receipt preserves assigned Task state", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(input, `/api/v1/tasks/${TASK_ID}/p3-transitions`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      action: "reject",
      expected_record_version: 1,
      reason: "需要更換處理人",
    });
    return apiResponse({ id: TASK_ID, record_version: 2, state: "assigned", completion_receipt_id: null });
  };
  assert.deepEqual(
    await transitionAutomaticTask(TASK_ID, { action: "reject", expected_record_version: 1, reason: "需要更換處理人" }, "task:p3-reject"),
    { id: TASK_ID, record_version: 2, state: "assigned", completion_receipt_id: null },
  );
});

test("Automatic Task reassignment sends the replacement advisor and preserves assigned state", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(input, `/api/v1/tasks/${TASK_ID}/p3-transitions`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      action: "reassign",
      expected_record_version: 2,
      reason: "改派給另一位 Primary Advisor",
      next_assignee_user_id: OTHER_ASSIGNEE_ID,
    });
    return apiResponse({ id: TASK_ID, record_version: 3, state: "assigned", completion_receipt_id: null });
  };
  assert.deepEqual(
    await transitionAutomaticTask(TASK_ID, {
      action: "reassign", expected_record_version: 2,
      reason: "改派給另一位 Primary Advisor", next_assignee_user_id: OTHER_ASSIGNEE_ID,
    }, "task:p3-reassign"),
    { id: TASK_ID, record_version: 3, state: "assigned", completion_receipt_id: null },
  );
});

test("Application Task completion validates reference, evidence, checklist and future time before fetch", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  const valid = completionInput();
  for (const input of [
    { ...valid, completion_record: { ...valid.completion_record, submitted_at: "2999-08-28T01:00:00.000Z" } },
    { ...valid, completion_record: { ...valid.completion_record, checklist_snapshot: { ...valid.completion_record.checklist_snapshot, all_required_items_complete: false } } },
    { ...valid, completion_record: { ...valid.completion_record, official_submission_reference: null, no_reference_declared: false } },
    { ...valid, completion_record: { ...valid.completion_record, official_submission_reference: "REF-1", no_reference_declared: true } },
    { ...valid, evidence_reference: null },
  ]) {
    assert.throws(
      () => completeApplicationTask(TASK_ID, TARGET_ID, input as Parameters<typeof completeApplicationTask>[2], "task:p3-invalid"),
      TypeError,
    );
  }
});

test("Task idempotency attempts reuse uncertain retries and rotate for command changes", () => {
  let sequence = 0;
  const attempt = new TaskIdempotencyAttempt(() => `task:${++sequence}`);
  const create = createTaskFingerprint(createInput());
  const first = attempt.keyFor(create);
  assert.equal(attempt.keyFor(create), first);
  assert.notEqual(attempt.keyFor(createTaskFingerprint({ ...createInput(), title: "Changed title" })), first);
  const transition = transitionTaskFingerprint(TASK_ID, { to: "accepted", expected_record_version: 1, reason: "", next_assignee_user_id: null });
  const transitionKey = attempt.keyFor(transition);
  attempt.rotate();
  assert.notEqual(attempt.keyFor(transition), transitionKey);
  attempt.complete();
  assert.notEqual(attempt.keyFor(create), first);
  const automatic = automaticTaskTransitionFingerprint(TASK_ID, { action: "accept", expected_record_version: 1 });
  assert.match(automatic, /"action":"accept"/);
});

test("Task failure classification remains distinct and fails closed", () => {
  assert.equal(classifyTaskFailure(apiError("UNAUTHENTICATED", 401)), "unauthenticated");
  assert.equal(classifyTaskFailure(apiError("FORBIDDEN", 403)), "forbidden");
  assert.equal(classifyTaskFailure(apiError("NOT_FOUND", 404)), "not_found");
  assert.equal(classifyTaskFailure(apiError("VALIDATION_FAILED", 422)), "validation");
  assert.equal(classifyTaskFailure(apiError("STALE_VERSION", 409)), "stale");
  assert.equal(classifyTaskFailure(apiError("CONFLICT", 409)), "conflict");
  assert.equal(classifyTaskFailure(new Error("private detail")), "unavailable");
});

function caseTask() {
  return {
    id: TASK_ID,
    case_id: CASE_ID,
    case_number: "HK26-0001",
    title: "Synthetic task",
    task_brief: "Complete the synthetic work item.",
    due_at: "2026-09-01T02:00:00.000Z",
    state: "assigned",
    assignee: { id: ASSIGNEE_ID, role: "advisor", label: "Advisor A" },
    record_version: 1,
    updated_at: "2026-08-23T02:00:00.000Z",
    available_transitions: [{ to: "accepted", requires_reason: false, requires_assignee: false }],
    task_kind: "manual",
    school_target_id: null,
    is_overdue: false,
    current_assignment: { id: ASSIGNMENT_ID, assignee_user_id: ASSIGNEE_ID, assignee_role: "advisor", status: "assigned" },
    allowed_actions: [],
  };
}

function completionInput() {
  return {
    action: "complete",
    expected_record_version: 2,
    completion_record: {
      submitted_at: "2026-08-27T02:00:00.000Z",
      submission_channel: "school_portal",
      submitter_user_id: ASSIGNEE_ID,
      checklist_snapshot: { all_required_items_complete: true, confirmed_at: "2026-08-27T02:05:00.000Z" },
      official_submission_reference: null,
      no_reference_declared: true,
    },
    evidence_reference: EVIDENCE_ID,
  } as const;
}

function assignedTask() {
  const task = caseTask();
  return {
    id: task.id,
    title: task.title,
    task_brief: task.task_brief,
    due_at: task.due_at,
    state: task.state,
    record_version: task.record_version,
    updated_at: task.updated_at,
    available_transitions: task.available_transitions,
    task_kind: task.task_kind,
    school_target_id: task.school_target_id,
    is_overdue: task.is_overdue,
    current_assignment: task.current_assignment,
    allowed_actions: task.allowed_actions,
  };
}

function createInput() {
  return {
    case_id: CASE_ID,
    title: "Synthetic task",
    task_brief: "Complete the synthetic work item.",
    due_at: "2026-09-01T02:00:00.000Z",
    assignee_user_id: ASSIGNEE_ID,
  };
}

function syntheticUuid(index: number): string {
  return `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function apiResponse(data: unknown): Response {
  return Response.json({ api_version: "v1", request_id: "task-test", data }, { headers: { "x-request-id": "task-test" } });
}

function malformedResponse(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE";
}

function apiError(code: string, status: number): ApiClientError {
  return new ApiClientError({ code, status, retryable: false, requestId: "task-test" });
}
