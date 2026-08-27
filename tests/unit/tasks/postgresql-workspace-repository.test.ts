import assert from "node:assert/strict";
import test from "node:test";

import { TaskWorkspaceService } from "../../../modules/tasks/application/workspace-service.ts";
import { RELEASE_1_TASK_TRANSITION_RULES } from "../../../modules/tasks/domain/release1-policy.ts";
import { PostgresqlTaskWorkspaceRepository } from "../../../modules/tasks/infrastructure/postgresql-workspace-repository.ts";
import type { IdentitySessionActor } from "../../../modules/identity/public.ts";
import type {
  DatabaseQuery,
  DatabaseQueryResult,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../../modules/shared/server.ts";

const ORGANIZATION_ID = "71000000-0000-4000-8000-000000000001";
const CURRENT_PRIMARY_ID = "71000000-0000-4000-8000-000000000002";
const OLD_OWNER_ID = "71000000-0000-4000-8000-000000000003";
const ASSIGNEE_ID = "71000000-0000-4000-8000-000000000004";
const TASK_ID = "71000000-0000-4000-8000-000000000005";
const CASE_ID = "71000000-0000-4000-8000-000000000006";
const IDS = [
  "71000000-0000-4000-8000-000000000011",
  "71000000-0000-4000-8000-000000000012",
  "71000000-0000-4000-8000-000000000013",
] as const;

const ACTOR: IdentitySessionActor = Object.freeze({
  userId: CURRENT_PRIMARY_ID,
  organizationId: ORGANIZATION_ID,
  role: "advisor",
  sessionId: "71000000-0000-4000-8000-000000000014",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: null,
});

test("transition locks current Case authority and synchronizes a changed Primary into task owner", async () => {
  const seam = transitionSeam(1);
  const result = await service(seam.runner).transition({
    actor: ACTOR,
    taskId: TASK_ID,
    command: command(),
  });

  assert.deepEqual(result, { id: TASK_ID, recordVersion: 2 });
  assert.match(seam.caseLockingQuery(), /FOR UPDATE OF service_case FOR SHARE OF student/);
  assert.match(seam.taskLockingQuery(), /FOR UPDATE OF task/);
  assert.deepEqual(seam.lockOrder(), ["locate", "case", "actor", "task", "assignment"]);
  assert.equal(seam.updateValues()?.[8], CURRENT_PRIMARY_ID);
});

test("transition maps a lost task UPDATE race to stale instead of reporting success", async () => {
  const seam = transitionSeam(0);
  await assert.rejects(
    service(seam.runner).transition({ actor: ACTOR, taskId: TASK_ID, command: command() }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "TaskWorkspaceError" &&
      (error as Error & { code?: unknown }).code === "TASK_STALE_VERSION",
  );
});

test("legacy transition boundary rejects automatic P3 tasks", async () => {
  const seam = transitionSeam(1, "application_prepare_submit");
  await assert.rejects(
    service(seam.runner).transition({ actor: ACTOR, taskId: TASK_ID, command: command() }),
    (error: unknown) => error instanceof Error &&
      error.name === "TaskWorkspaceError" &&
      (error as Error & { code?: unknown }).code === "TASK_FORBIDDEN",
  );
});

function service(runner: TenantTransactionRunner): TaskWorkspaceService {
  let index = 0;
  return new TaskWorkspaceService(
    new PostgresqlTaskWorkspaceRepository(runner),
    () => IDS[index++]!,
    () => Date.parse("2026-08-23T00:00:00.000Z"),
  );
}

function command() {
  return Object.freeze({
    to: "cancelled" as const,
    expectedRecordVersion: 1,
    reason: "synthetic cancellation",
    nextAssigneeUserId: null,
    requestId: "task01-owner-change",
    idempotencyKey: "task01-owner-change",
  });
}

function transitionSeam(updateRowCount: number, taskKind: "manual" | "application_prepare_submit" | "interview_support" = "manual") {
  const observedLockOrder: string[] = [];
  let caseLockingQuery = "";
  let taskLockingQuery = "";
  let taskUpdateValues: readonly unknown[] | undefined;
  const runner: TenantTransactionRunner = Object.freeze({
    async run<Result>(
      _context: { readonly organizationId: string; readonly actorUserId: string },
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ): Promise<Result> {
      const transaction = Object.freeze({
        async query<Row = Record<string, unknown>>(
          query: DatabaseQuery,
        ): Promise<DatabaseQueryResult<Row>> {
          const sql = query.text;
          if (sql.includes("INSERT INTO shared_idempotency_records")) {
            return result([{ id: IDS[0] }]) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("SELECT request_hash,state,result_reference")) {
            return result([]) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("SELECT service_case_id FROM tasks_tasks")) {
            observedLockOrder.push("locate");
            return result([{ service_case_id: CASE_ID }]) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("SELECT service_case.id,service_case.primary_user_id")) {
            observedLockOrder.push("case");
            caseLockingQuery = sql;
            return result([caseRow()]) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("SELECT binding.role FROM identity_users")) {
            observedLockOrder.push("actor");
            return result([{ role: "advisor" }]) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("SELECT task.id,task.service_case_id")) {
            observedLockOrder.push("task");
            taskLockingQuery = sql;
            return result([taskRow(taskKind)]) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("FROM tasks_task_assignments AS assignment")) {
            observedLockOrder.push("assignment");
            return result([{ id: IDS[2] }]) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("SELECT id,initial_state FROM tasks_transition_policies")) {
            return result([{ id: "71000000-0000-4000-8000-000000000020", initial_state: "assigned" }]) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("SELECT from_state,to_state,actor_kind")) {
            return result(RELEASE_1_TASK_TRANSITION_RULES.map((rule) => ({
              from_state: rule.from,
              to_state: rule.to,
              actor_kind: rule.actorKind,
              allowed_actor_roles: [...rule.allowedActorRoles],
              requires_reason: rule.requiresReason,
              requires_different_actor: rule.requiresDifferentActor,
            }))) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("INSERT INTO tasks_task_transition_receipts")) {
            return result([], 1) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("UPDATE tasks_tasks SET state=")) {
            taskUpdateValues = query.values;
            return result([], updateRowCount) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("INSERT INTO audit_events") || sql.includes("INSERT INTO audit_outbox")) {
            return result([], 1) as DatabaseQueryResult<Row>;
          }
          if (sql.includes("UPDATE shared_idempotency_records SET state='completed'")) {
            return result([], 1) as DatabaseQueryResult<Row>;
          }
          throw new Error("Unexpected repository query in TASK-01 test seam.");
        },
      });
      return operation(transaction);
    },
  });
  return Object.freeze({
    runner,
    caseLockingQuery: () => caseLockingQuery,
    taskLockingQuery: () => taskLockingQuery,
    lockOrder: () => observedLockOrder,
    updateValues: () => taskUpdateValues,
  });
}

function caseRow() {
  return Object.freeze({
    id: CASE_ID,
    primary_user_id: CURRENT_PRIMARY_ID,
    primary_role: "advisor",
    stage: "background_collection",
    workflow_status: "active",
    student_status: "active",
  });
}

function taskRow(taskKind: "manual" | "application_prepare_submit" | "interview_support" = "manual") {
  return Object.freeze({
    id: TASK_ID,
    service_case_id: CASE_ID,
    task_kind: taskKind,
    case_number: "CASE-SYNTHETIC",
    title: "Synthetic task",
    task_brief: "Synthetic task brief",
    due_at: "2027-06-01T00:00:00.000Z",
    state: "assigned",
    assignee_user_id: ASSIGNEE_ID,
    assignee_role: "advisor",
    assignee_redaction_profile: null,
    assignee_binding_id: "71000000-0000-4000-8000-000000000007",
    owner_user_id: OLD_OWNER_ID,
    primary_user_id: CURRENT_PRIMARY_ID,
    primary_role: "advisor",
    record_version: 1,
    updated_at: "2026-08-23T00:00:00.000Z",
    student_status: "active",
    case_stage: "signed",
  });
}

function result(rows: readonly Record<string, unknown>[], rowCount = rows.length) {
  return Object.freeze({ rows, rowCount });
}
