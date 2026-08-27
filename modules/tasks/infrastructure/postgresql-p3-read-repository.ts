import "server-only";

import type { TenantTransactionRunner } from "../../shared/server.ts";
import type { P3TaskReadRepository, P3TaskReadRow } from "../application/p3-read-port.ts";

export type { P3TaskReadRepository, P3TaskReadRow } from "../application/p3-read-port.ts";

interface DatabaseRow extends Record<string, unknown> {
  id: string;
  task_kind: "application_prepare_submit" | "interview_support" | "manual";
  school_target_id: string | null;
  state: string;
  due_at: Date | string;
  is_overdue: boolean;
  record_version: number | string;
  owner_user_id: string;
  current_assignment_id: string | null;
  current_assignee_user_id: string | null;
  current_assignee_role: "advisor" | "contractor" | null;
  current_assignment_status: string | null;
}

export class PostgresqlP3TaskReadRepository implements P3TaskReadRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  async readTask(input: Parameters<P3TaskReadRepository["readTask"]>[0]): Promise<P3TaskReadRow | null> {
    return this.runner.run({ organizationId: input.organizationId, actorUserId: input.userId }, async (transaction) => {
      const result = await transaction.query<DatabaseRow>({
        text: selectSql("AND task.id=$4::uuid"),
        values: [input.organizationId, input.userId, input.isFounder, input.taskId],
      });
      return result.rows[0] === undefined ? null : mapRow(result.rows[0]);
    });
  }

  async listAssigned(input: Parameters<P3TaskReadRepository["listAssigned"]>[0]): Promise<readonly P3TaskReadRow[]> {
    return this.runner.run({ organizationId: input.organizationId, actorUserId: input.userId }, async (transaction) => {
      const result = await transaction.query<DatabaseRow>({
        text: selectSql("AND task.assignee_user_id=$2::uuid", true),
        values: [input.organizationId, input.userId, input.isFounder],
      });
      return Object.freeze(result.rows.map(mapRow));
    });
  }
}

function selectSql(extraPredicate: string, assignedOnly = false): string {
  return `SELECT task.id,task.task_kind,task.school_target_id,task.state,task.due_at,
      task.record_version,task.owner_user_id,
      (task.due_at < transaction_timestamp() AND task.state NOT IN ('completed','cancelled','rejected')) AS is_overdue,
      current_assignment.id AS current_assignment_id,
      current_assignment.assignee_user_id AS current_assignee_user_id,
      current_assignment.assignee_role AS current_assignee_role,
      current_assignment.status AS current_assignment_status
    FROM tasks_tasks AS task
    JOIN cases_service_cases AS service_case
      ON service_case.id=task.service_case_id AND service_case.organization_id=task.organization_id
    LEFT JOIN LATERAL (
      SELECT assignment.id,assignment.assignee_user_id,assignment.assignee_role,assignment.status
        FROM tasks_task_assignments AS assignment
       WHERE assignment.organization_id=task.organization_id
         AND assignment.task_id=task.id AND assignment.ended_at IS NULL
       ORDER BY assignment.created_at DESC,assignment.id DESC LIMIT 1
    ) AS current_assignment ON true
    WHERE task.organization_id=$1::uuid
      ${extraPredicate}
      AND (${assignedOnly ? "false" : "$3::boolean"} OR task.assignee_user_id=$2::uuid OR service_case.primary_user_id=$2::uuid)
      AND EXISTS (
        SELECT 1
          FROM access_organization_memberships AS membership
          JOIN access_role_bindings AS binding
            ON binding.membership_id=membership.id AND binding.organization_id=membership.organization_id
           AND binding.user_id=membership.user_id AND binding.status='active'
         WHERE membership.organization_id=task.organization_id
           AND membership.user_id=$2::uuid AND membership.status='active'
           AND binding.role = CASE WHEN $3::boolean THEN 'founder' ELSE 'advisor' END
      )
    ORDER BY task.updated_at DESC,task.id`;
}

function mapRow(row: DatabaseRow): P3TaskReadRow {
  return Object.freeze({
    id: row.id,
    task_kind: row.task_kind,
    school_target_id: row.school_target_id,
    state: row.state,
    due_at: new Date(row.due_at).toISOString(),
    is_overdue: row.is_overdue,
    record_version: row.record_version,
    owner_user_id: row.owner_user_id,
    current_assignment: row.current_assignment_id === null ? null : Object.freeze({
      id: row.current_assignment_id,
      assignee_user_id: row.current_assignee_user_id!,
      assignee_role: row.current_assignee_role!,
      status: row.current_assignment_status!,
    }),
  });
}
