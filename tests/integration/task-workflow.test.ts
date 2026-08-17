import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskWorkflowError,
  TaskWorkflowService,
  type TransitionTaskCommand,
} from "../../modules/tasks/application/service.ts";
import {
  RELEASE_1_TASK_INITIAL_STATE,
  RELEASE_1_TASK_TRANSITION_RULES,
} from "../../modules/tasks/domain/release1-policy.ts";
import {
  approveTaskTransitionPolicy,
  proposeTaskTransitionPolicy,
} from "../../modules/tasks/domain/transition-policy.ts";
import { InMemoryTaskTransitionRepository } from "../fakes/task-workflow.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const PRIMARY_ADVISOR_ID = "44444444-4444-4444-8444-444444444444";
const ASSIGNEE_ID = "55555555-5555-4555-8555-555555555555";
const REPLACEMENT_ASSIGNEE_ID = "66666666-6666-4666-8666-666666666666";
const FOUNDER_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_ADVISOR_ID = "88888888-8888-4888-8888-888888888888";

const PRIMARY_ADVISOR = actor(PRIMARY_ADVISOR_ID, "advisor");
const ASSIGNEE = actor(ASSIGNEE_ID, "advisor");
const FOUNDER = actor(FOUNDER_ID, "founder");
const OTHER_ADVISOR = actor(OTHER_ADVISOR_ID, "advisor");

class FixedClock {
  nowMs(): number {
    return 1_754_265_600_000;
  }
}

function actor(userId: string, role: "advisor" | "founder") {
  return Object.freeze({
    userId,
    organizationId: ORGANIZATION_ID,
    role,
    sessionId: "99999999-9999-4999-8999-999999999999",
    capturedSessionVersion: 1,
    reauthenticatedAtMs: 1_754_265_600_000,
  });
}

function createHarness() {
  const repository = new InMemoryTaskTransitionRepository();
  repository.activateUser({ ...PRIMARY_ADVISOR });
  repository.activateUser({ ...ASSIGNEE });
  repository.activateUser({ ...FOUNDER });
  repository.activateUser({ ...OTHER_ADVISOR });
  repository.activateUser({
    organizationId: ORGANIZATION_ID,
    userId: REPLACEMENT_ASSIGNEE_ID,
    role: "advisor",
  });
  repository.seedAssignedTask({
    taskId: TASK_ID,
    organizationId: ORGANIZATION_ID,
    caseId: CASE_ID,
    primaryAdvisorUserId: PRIMARY_ADVISOR_ID,
    assigneeUserId: ASSIGNEE_ID,
    assigneeRole: "advisor",
  });
  return {
    repository,
    service: new TaskWorkflowService({
      repository,
      clock: new FixedClock(),
      createId: sequenceIds(100),
    }),
  };
}

function command(overrides: Partial<TransitionTaskCommand> = {}): TransitionTaskCommand {
  return {
    to: "accepted",
    expectedRecordVersion: 1,
    reason: "",
    nextAssigneeUserId: null,
    requestId: "request-p1-13-task-001",
    idempotencyKey: "task-transition-p1-13-001",
    ...overrides,
  };
}

async function transition(
  service: TaskWorkflowService,
  currentActor: typeof ASSIGNEE,
  currentCommand: TransitionTaskCommand,
) {
  return service.transitionTask({ actor: currentActor, taskId: TASK_ID, command: currentCommand });
}

test("the approved Release 1 matrix starts assigned and lets the current assignee accept then complete", async () => {
  const { repository, service } = createHarness();

  assert.deepEqual(
    await transition(service, ASSIGNEE, command()),
    { taskId: TASK_ID, state: "accepted", recordVersion: 2 },
  );
  await assert.rejects(
    transition(service, ASSIGNEE, command({
      to: "completed",
      expectedRecordVersion: 2,
      reason: "",
      idempotencyKey: "task-transition-p1-13-002",
    })),
    taskError("TASK_REASON_REQUIRED"),
  );
  assert.deepEqual(
    await transition(service, ASSIGNEE, command({
      to: "completed",
      expectedRecordVersion: 2,
      reason: "materials_checked",
      idempotencyKey: "task-transition-p1-13-003",
    })),
    { taskId: TASK_ID, state: "completed", recordVersion: 3 },
  );
  assert.deepEqual(repository.snapshot(), {
    tasks: 1,
    transitionReceipts: 2,
    assignments: 0,
    audits: 2,
    outbox: 2,
    idempotencyResults: 2,
  });
  assert.doesNotMatch(JSON.stringify(repository.lastEffects()), /materials_checked/);

  const rejected = createHarness();
  assert.deepEqual(
    await transition(rejected.service, ASSIGNEE, command({
      to: "rejected",
      reason: "assignee_declined",
      idempotencyKey: "task-transition-p1-13-011",
    })),
    { taskId: TASK_ID, state: "rejected", recordVersion: 2 },
  );
});

test("only the current Primary Advisor can reassign or cancel an active task", async () => {
  const { repository, service } = createHarness();

  await assert.rejects(
    transition(service, OTHER_ADVISOR, command({
      to: "reassigned",
      reason: "capacity_change",
      nextAssigneeUserId: REPLACEMENT_ASSIGNEE_ID,
    })),
    taskError("TASK_ACTOR_NOT_ALLOWED"),
  );
  assert.deepEqual(
    await transition(service, PRIMARY_ADVISOR, command({
      to: "reassigned",
      reason: "capacity_change",
      nextAssigneeUserId: REPLACEMENT_ASSIGNEE_ID,
      idempotencyKey: "task-transition-p1-13-004",
    })),
    { taskId: TASK_ID, state: "reassigned", recordVersion: 2 },
  );
  assert.deepEqual(repository.task(TASK_ID), {
    state: "reassigned",
    recordVersion: 2,
    assigneeUserId: REPLACEMENT_ASSIGNEE_ID,
  });
  assert.deepEqual(repository.snapshot(), {
    tasks: 1,
    transitionReceipts: 1,
    assignments: 1,
    audits: 1,
    outbox: 1,
    idempotencyResults: 1,
  });

  const cancelled = createHarness();
  await transition(cancelled.service, ASSIGNEE, command({
    idempotencyKey: "task-transition-p1-13-012",
  }));
  assert.deepEqual(
    await transition(cancelled.service, PRIMARY_ADVISOR, command({
      to: "cancelled",
      expectedRecordVersion: 2,
      reason: "case_halted",
      idempotencyKey: "task-transition-p1-13-013",
    })),
    { taskId: TASK_ID, state: "cancelled", recordVersion: 3 },
  );
});

test("a non-assignee Founder alone can approve an already completed task with a reason", async () => {
  const { service } = createHarness();

  await transition(service, ASSIGNEE, command());
  await transition(service, ASSIGNEE, command({
    to: "completed",
    expectedRecordVersion: 2,
    reason: "completed_by_assignee",
    idempotencyKey: "task-transition-p1-13-005",
  }));
  await assert.rejects(
    transition(service, OTHER_ADVISOR, command({
      to: "approved",
      expectedRecordVersion: 3,
      reason: "reviewed",
      idempotencyKey: "task-transition-p1-13-006",
    })),
    taskError("TASK_ACTOR_NOT_ALLOWED"),
  );
  await assert.rejects(
    transition(service, FOUNDER, command({
      to: "approved",
      expectedRecordVersion: 3,
      reason: "",
      idempotencyKey: "task-transition-p1-13-007",
    })),
    taskError("TASK_REASON_REQUIRED"),
  );
  assert.deepEqual(
    await transition(service, FOUNDER, command({
      to: "approved",
      expectedRecordVersion: 3,
      reason: "founder_reviewed",
      idempotencyKey: "task-transition-p1-13-008",
    })),
    { taskId: TASK_ID, state: "approved", recordVersion: 4 },
  );
});

test("stale versions, unsupported transitions, and missing reassign targets deny without an effect", async () => {
  const { repository, service } = createHarness();

  await assert.rejects(
    transition(service, ASSIGNEE, command({ expectedRecordVersion: 2 })),
    taskError("TASK_TRANSITION_STALE_VERSION"),
  );
  await assert.rejects(
    transition(service, ASSIGNEE, command({ to: "cancelled", reason: "not_authorized" })),
    taskError("TASK_ACTOR_NOT_ALLOWED"),
  );
  await assert.rejects(
    transition(service, PRIMARY_ADVISOR, command({
      to: "reassigned",
      reason: "target_required",
      nextAssigneeUserId: null,
    })),
    taskError("TASK_ASSIGNMENT_TARGET_REQUIRED"),
  );
  assert.deepEqual(repository.snapshot(), {
    tasks: 1,
    transitionReceipts: 0,
    assignments: 0,
    audits: 0,
    outbox: 0,
    idempotencyResults: 0,
  });
});

test("idempotency replays one original transition and a pre-commit failure leaves no partial facts", async () => {
  const { repository, service } = createHarness();
  const input = command({ idempotencyKey: "task-transition-p1-13-009" });

  const first = await transition(service, ASSIGNEE, input);
  assert.deepEqual(await transition(service, ASSIGNEE, input), first);
  await assert.rejects(
    transition(service, ASSIGNEE, command({
      reason: "changed_payload",
      idempotencyKey: input.idempotencyKey,
    })),
    taskError("TASK_IDEMPOTENCY_KEY_REUSED"),
  );
  assert.deepEqual(repository.snapshot(), {
    tasks: 1,
    transitionReceipts: 1,
    assignments: 0,
    audits: 1,
    outbox: 1,
    idempotencyResults: 1,
  });

  const second = createHarness();
  second.repository.failOnceBeforeCommit();
  await assert.rejects(
    transition(second.service, ASSIGNEE, command({ idempotencyKey: "task-transition-p1-13-010" })),
    /synthetic transaction failure/,
  );
  assert.deepEqual(second.repository.snapshot(), {
    tasks: 1,
    transitionReceipts: 0,
    assignments: 0,
    audits: 0,
    outbox: 0,
    idempotencyResults: 0,
  });
});

test("policy activation rejects every matrix other than the resolved Release 1 policy", () => {
  const candidate = proposeTaskTransitionPolicy({
    policyId: "00000000-0000-4000-8000-000000000081",
    version: 1,
    organizationId: ORGANIZATION_ID,
    requestedBy: "00000000-0000-4000-8000-000000000082",
    initialState: RELEASE_1_TASK_INITIAL_STATE,
    rules: RELEASE_1_TASK_TRANSITION_RULES.filter((rule) => rule.to !== "cancelled"),
    createdAt: "2026-08-07T00:00:00.000Z",
  });
  assert.throws(
    () => approveTaskTransitionPolicy(candidate, {
      decisionId: "OD-06",
      decisionStatus: "resolved",
      reviewerId: "00000000-0000-4000-8000-000000000083",
      reviewerRole: "founder",
      approvedAt: "2026-08-07T00:05:00.000Z",
    }),
    errorWithCode("TASK_POLICY_MATRIX_MISMATCH"),
  );
});

function taskError(code: string) {
  return (error: unknown) => error instanceof TaskWorkflowError && error.code === code;
}

function errorWithCode(code: string) {
  return (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sequenceIds(start: number): () => string {
  let current = start;
  return () => {
    current += 1;
    return `00000000-0000-4000-8000-${String(current).padStart(12, "0")}`;
  };
}
