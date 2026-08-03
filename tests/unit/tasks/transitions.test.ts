import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  approveTaskTransitionPolicy,
  evaluateTaskCreation,
  evaluateTaskTransition,
  proposeTaskTransitionPolicy,
  type TaskTransitionPolicy,
} from "../../../modules/tasks/transition-policy.ts";
import type { TaskTransitionRule } from "../../../modules/tasks/contract.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const caseId = "00000000-0000-4000-8000-000000000002";
const requesterId = "00000000-0000-4000-8000-000000000003";
const reviewerId = "00000000-0000-4000-8000-000000000004";
const assigneeId = "00000000-0000-4000-8000-000000000005";
const approverId = "00000000-0000-4000-8000-000000000006";

const syntheticRules: readonly TaskTransitionRule[] = [
  {
    from: "accepted",
    to: "completed",
    actorKind: "assignee",
    allowedActorRoles: ["advisor", "contractor"],
    requiresReason: true,
    requiresDifferentActor: false,
  },
  {
    from: "completed",
    to: "approved",
    actorKind: "approver",
    allowedActorRoles: ["founder", "advisor"],
    requiresReason: true,
    requiresDifferentActor: true,
  },
];

function candidatePolicy(overrides: Partial<Parameters<typeof proposeTaskTransitionPolicy>[0]> = {}) {
  return proposeTaskTransitionPolicy({
    policyId: "task-policy-v1",
    version: 1,
    organizationId,
    requestedBy: requesterId,
    initialState: null,
    rules: [],
    createdAt: "2026-08-02T13:00:00.000Z",
    ...overrides,
  });
}

function approvedSyntheticPolicy(): TaskTransitionPolicy {
  return approveTaskTransitionPolicy(
    proposeTaskTransitionPolicy({
      policyId: "task-policy-v1",
      version: 1,
      organizationId,
      requestedBy: requesterId,
      initialState: "accepted",
      rules: syntheticRules,
      createdAt: "2026-08-02T13:00:00.000Z",
    }),
    {
      decisionId: "OD-06",
      decisionStatus: "resolved",
      reviewerId,
      reviewerRole: "founder",
      approvedAt: "2026-08-02T13:05:00.000Z",
    },
  );
}

function transitionInput(policy: TaskTransitionPolicy, overrides: Partial<Parameters<typeof evaluateTaskTransition>[0]> = {}) {
  return {
    policy,
    organizationId,
    taskOrganizationId: organizationId,
    caseId,
    taskCaseId: caseId,
    from: "accepted" as const,
    to: "completed" as const,
    actorId: assigneeId,
    actorRole: "advisor" as const,
    actorIsActive: true,
    assigneeId,
    approverId,
    ownerId: requesterId,
    redactedTaskContext: false,
    recordVersion: 2,
    expectedRecordVersion: 2,
    reason: "Synthetic completion reason",
    ...overrides,
  };
}

test("fails closed while OD-06 has not approved an initial state or actor matrix", () => {
  const policy = candidatePolicy({
    rules: syntheticRules,
  });

  assert.deepEqual(evaluateTaskCreation(policy), {
    allowed: false,
    code: "TASK_POLICY_NOT_APPROVED",
  });
  assert.deepEqual(evaluateTaskTransition(transitionInput(policy)), {
    allowed: false,
    code: "TASK_POLICY_NOT_APPROVED",
  });
});

test("requires a resolved OD-06 receipt and separate reviewer before policy activation", () => {
  const policy = candidatePolicy({ initialState: "accepted", rules: syntheticRules });

  assert.throws(
    () =>
      approveTaskTransitionPolicy(policy, {
        decisionId: "OD-06",
        decisionStatus: "open",
        reviewerId,
        reviewerRole: "founder",
        approvedAt: "2026-08-02T13:05:00.000Z",
      }),
    /TASK_POLICY_DECISION_NOT_RESOLVED/,
  );
  assert.throws(
    () =>
      approveTaskTransitionPolicy(policy, {
        decisionId: "OD-06",
        decisionStatus: "resolved",
        reviewerId: requesterId,
        reviewerRole: "founder",
        approvedAt: "2026-08-02T13:05:00.000Z",
      }),
    /TASK_POLICY_SELF_REVIEW_DENIED/,
  );
});

test("allows a policy-defined completion only with an active assignee and reason", () => {
  const policy = approvedSyntheticPolicy();

  assert.deepEqual(evaluateTaskCreation(policy), {
    allowed: true,
    initialState: "accepted",
  });
  assert.deepEqual(evaluateTaskTransition(transitionInput(policy)), { allowed: true });
  assert.deepEqual(
    evaluateTaskTransition(
      transitionInput(policy, { actorIsActive: false }),
    ),
    { allowed: false, code: "TASK_ACTOR_INACTIVE" },
  );
  assert.deepEqual(
    evaluateTaskTransition(
      transitionInput(policy, { reason: "" }),
    ),
    { allowed: false, code: "TASK_REASON_REQUIRED" },
  );
});

test("enforces tenant/case context and optimistic concurrency before actor rules", () => {
  const policy = approvedSyntheticPolicy();

  assert.deepEqual(
    evaluateTaskTransition(
      transitionInput(policy, { taskOrganizationId: "00000000-0000-4000-8000-000000000099" }),
    ),
    { allowed: false, code: "TASK_CONTEXT_MISMATCH" },
  );
  assert.deepEqual(
    evaluateTaskTransition(
      transitionInput(policy, { expectedRecordVersion: 1 }),
    ),
    { allowed: false, code: "TASK_STALE_VERSION" },
  );
});

test("keeps completion and approval separate and denies assignee self-approval", () => {
  const policy = approvedSyntheticPolicy();

  assert.deepEqual(
    evaluateTaskTransition(
      transitionInput(policy, {
        from: "completed",
        to: "approved",
        actorId: assigneeId,
        actorRole: "advisor",
        reason: "Synthetic approval",
      }),
    ),
    { allowed: false, code: "TASK_APPROVAL_SEPARATION_REQUIRED" },
  );
  assert.deepEqual(
    evaluateTaskTransition(
      transitionInput(policy, {
        from: "completed",
        to: "approved",
        actorId: approverId,
        actorRole: "founder",
        reason: "Synthetic approval",
      }),
    ),
    { allowed: true },
  );
});

test("requires a redacted task-only context for contractors", () => {
  const policy = approvedSyntheticPolicy();

  assert.deepEqual(
    evaluateTaskTransition(
      transitionInput(policy, {
        actorRole: "contractor",
        redactedTaskContext: false,
      }),
    ),
    { allowed: false, code: "TASK_CONTRACTOR_CONTEXT_REQUIRED" },
  );
  assert.deepEqual(
    evaluateTaskTransition(
      transitionInput(policy, {
        actorRole: "contractor",
        redactedTaskContext: true,
      }),
    ),
    { allowed: true },
  );
});

test("rejects collapsed completion/approval rules and duplicate transitions", () => {
  assert.throws(
    () =>
      candidatePolicy({
        initialState: "accepted",
        rules: [
          {
            from: "accepted",
            to: "accepted",
            actorKind: "assignee",
            allowedActorRoles: ["advisor"],
            requiresReason: false,
            requiresDifferentActor: false,
          },
        ],
      }),
    /TASK_TRANSITION_SELF_LOOP/,
  );
  assert.throws(
    () =>
      approveTaskTransitionPolicy(
        candidatePolicy({
          initialState: "accepted",
          rules: [
            ...syntheticRules,
            syntheticRules[0],
          ],
        }),
        {
          decisionId: "OD-06",
          decisionStatus: "resolved",
          reviewerId,
          reviewerRole: "founder",
          approvedAt: "2026-08-02T13:05:00.000Z",
        },
      ),
    /TASK_TRANSITION_DUPLICATE/,
  );
});

test("planner payload contains task tables, immutable receipts, and fail-closed policy triggers", async () => {
  const migrationPath = "db/migrations/202608022230_005_expand_tasks.sql";
  const migration = await readFile(migrationPath, "utf8");

  assert.doesNotMatch(migration, /CREATE\s+(?:TABLE|INDEX|FUNCTION|TRIGGER)\s+IF\s+NOT\s+EXISTS/i);
  assert.match(migration, /CREATE TABLE tasks_transition_policies/);
  assert.match(migration, /CREATE TABLE tasks_transition_rules/);
  assert.match(migration, /CREATE TABLE tasks_tasks/);
  assert.match(migration, /CREATE TABLE tasks_task_assignments/);
  assert.match(migration, /CREATE TABLE tasks_task_transition_receipts/);
  assert.match(migration, /tasks_validate_task_write/);
  assert.match(migration, /tasks_validate_transition_policy/);
  assert.match(migration, /tasks_reject_immutable_delete/);
  assert.match(migration, /tasks_reject_immutable_update/);
  assert.match(migration, /tasks_one_approved_policy_idx/);
  assert.match(migration, /tasks_tasks_case_fk/);

  const actualSha = createHash("sha256").update(migration).digest("hex");
  assert.equal(actualSha, "2a617638b88be65c3c875e4689fa9ee87819d9deb7e11cb2d3147aff19daa4ac");
});
