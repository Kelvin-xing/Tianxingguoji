import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  TaskIdempotencyAttempt,
  classifyTaskFailure,
  createTask,
  createTaskFingerprint,
  getTask,
  getTaskAssigneeOptions,
  listTasks,
  transitionTask,
  transitionTaskFingerprint,
} from "../../../modules/tasks/client.ts";

const TASK_ID = "10000000-0000-4000-8000-000000000001";
const CASE_ID = "20000000-0000-4000-8000-000000000001";
const ASSIGNEE_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_ASSIGNEE_ID = "30000000-0000-4000-8000-000000000002";

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
  };
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
