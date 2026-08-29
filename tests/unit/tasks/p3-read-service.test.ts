import assert from "node:assert/strict";
import test from "node:test";

import { P3TaskReadError, P3TaskReadService, type P3TaskReadDto } from "../../../modules/tasks/application/p3-read-service.ts";
import type { P3TaskReadRepository, P3TaskReadRow } from "../../../modules/tasks/application/p3-read-port.ts";
import type { RequestAccessActor } from "../../../modules/access/public.ts";

const ORGANIZATION_ID = "72000000-0000-4000-8000-000000000001";
const FOUNDER_ID = "72000000-0000-4000-8000-000000000002";
const ADVISOR_ID = "72000000-0000-4000-8000-000000000003";
const OTHER_ID = "72000000-0000-4000-8000-000000000004";
const TASK_ID = "72000000-0000-4000-8000-000000000005";
const TARGET_ID = "72000000-0000-4000-8000-000000000006";
const ASSIGNMENT_ID = "72000000-0000-4000-8000-000000000007";

test("P3 read projects exact fields and keeps accepted application actions state-bound", async () => {
  const row: P3TaskReadRow = Object.freeze({
    id: TASK_ID, task_kind: "application_prepare_submit", school_target_id: TARGET_ID,
    state: "accepted", due_at: "2026-08-30T00:00:00.000Z", is_overdue: false,
    record_version: 3, owner_user_id: ADVISOR_ID,
    current_assignment: Object.freeze({ id: ASSIGNMENT_ID, assignee_user_id: ADVISOR_ID, assignee_role: "advisor", status: "accepted" }),
  });
  const service = new P3TaskReadService(repository(row));
  const result = await service.readTask(actor("advisor", ADVISOR_ID), TASK_ID);
  assert.deepEqual(result, {
    id: TASK_ID, task_kind: "application_prepare_submit", school_target_id: TARGET_ID,
    state: "accepted", due_at: "2026-08-30T00:00:00.000Z", is_overdue: false,
    record_version: 3,
    current_assignment: { id: ASSIGNMENT_ID, assignee_user_id: ADVISOR_ID, assignee_role: "advisor", status: "accepted" },
    allowed_actions: ["complete", "cancel"],
  } satisfies P3TaskReadDto);
});

test("Primary Advisor can reassign a rejected application Task with no active assignment", async () => {
  const row: P3TaskReadRow = Object.freeze({
    ...baseRow("application_prepare_submit"), owner_user_id: ADVISOR_ID, state: "assigned",
    current_assignment: null,
  });
  const service = new P3TaskReadService(repository(row));
  const owner = await service.readTask(actor("advisor", ADVISOR_ID), TASK_ID);
  assert.deepEqual(owner?.allowed_actions, ["reassign", "cancel"]);

  const nonOwner = await service.readTask(actor("advisor", OTHER_ID), TASK_ID);
  assert.deepEqual(nonOwner?.allowed_actions, []);

  const interviewRow: P3TaskReadRow = Object.freeze({
    ...row, task_kind: "interview_support",
  });
  const interview = await new P3TaskReadService(repository(interviewRow)).readTask(actor("advisor", ADVISOR_ID), TASK_ID);
  assert.deepEqual(interview?.allowed_actions, ["cancel"]);
});

test("Founder remains authorized when combined with Admin, while pure Admin is denied and Contractor requires assignment", async () => {
  const row = baseRow("manual");
  const service = new P3TaskReadService(repository(row));
  const founder = await service.readTask(actor(["founder", "admin"], FOUNDER_ID), TASK_ID);
  assert.equal(founder?.task_kind, "manual");
  await assert.rejects(() => service.readTask(actor("admin", FOUNDER_ID), TASK_ID), (error: unknown) =>
    error instanceof P3TaskReadError && error.code === "FORBIDDEN");
  assert.equal(await service.readTask(actor("contractor", OTHER_ID), TASK_ID), null);

  const contractorManual = await new P3TaskReadService(repository(Object.freeze({
    ...row,
    current_assignment: Object.freeze({
      id: ASSIGNMENT_ID, assignee_user_id: OTHER_ID, assignee_role: "contractor", status: "assigned",
    }),
  }))).readTask(actor("contractor", OTHER_ID), TASK_ID);
  assert.deepEqual(contractorManual?.allowed_actions, ["accept", "reject"]);
});

test("Contractor may read and act on an assigned application task", async () => {
  const row: P3TaskReadRow = Object.freeze({
    ...baseRow("application_prepare_submit"),
    current_assignment: Object.freeze({
      id: ASSIGNMENT_ID, assignee_user_id: OTHER_ID, assignee_role: "contractor", status: "assigned",
    }),
  });
  const result = await new P3TaskReadService(repository(row)).readTask(actor("contractor", OTHER_ID), TASK_ID);
  assert.deepEqual(result?.allowed_actions, ["accept", "reject"]);
});

test("assigned listing is scoped to the current user and automatic task actions are state-bound", async () => {
  const assigned: P3TaskReadRow = Object.freeze({
    ...baseRow("interview_support"), state: "assigned",
    current_assignment: Object.freeze({ id: ASSIGNMENT_ID, assignee_user_id: ADVISOR_ID, assignee_role: "advisor", status: "assigned" }),
  });
  const calls: string[] = [];
  const repo: P3TaskReadRepository = Object.freeze({
    async readTask() { return assigned; },
    async listAssigned(input: Parameters<P3TaskReadRepository["listAssigned"]>[0]) { calls.push(input.userId); return [assigned]; },
  });
  const result = await new P3TaskReadService(repo).listAssigned(actor("advisor", ADVISOR_ID));
  assert.deepEqual(result[0]?.allowed_actions, ["accept", "reject"]);
  assert.deepEqual(calls, [ADVISOR_ID]);
});

function repository(row: P3TaskReadRow): P3TaskReadRepository {
  return Object.freeze({
    async readTask(input: Parameters<P3TaskReadRepository["readTask"]>[0]) {
      if (input.actorRole === "contractor" && row.current_assignment?.assignee_user_id !== input.userId) return null;
      return row;
    },
    async listAssigned() { return [row]; },
  });
}

function baseRow(taskKind: P3TaskReadRow["task_kind"]): P3TaskReadRow {
  return Object.freeze({
    id: TASK_ID, task_kind: taskKind, school_target_id: taskKind === "manual" ? null : TARGET_ID,
    state: "assigned", due_at: "2026-08-30T00:00:00.000Z", is_overdue: false,
    record_version: 1, owner_user_id: FOUNDER_ID, current_assignment: null,
  });
}

function actor(role: "founder" | "admin" | "advisor" | "contractor" | readonly ("founder" | "admin" | "advisor" | "contractor")[], userId: string): RequestAccessActor {
  const roles = typeof role === "string" ? [role] : role;
  return Object.freeze({
    userId, organizationId: ORGANIZATION_ID, roles,
    workspaceCapabilities: roles.includes("founder") || roles.includes("advisor") || roles.includes("contractor")
      ? ["tasks.read"] as const : ["tasks.read"] as const,
  });
}
