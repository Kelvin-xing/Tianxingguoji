import "server-only";

import { loadTrialPrincipal } from "../../access/server.ts";
import { P3TaskReadError } from "../application/p3-read-service.ts";
import type { TaskFactsAssigneeRole } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
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
  trial_manager: boolean;
  writable: boolean;
  current_assignment_id: string | null;
  current_assignee_user_id: string | null;
  current_assignee_role: TaskFactsAssigneeRole | null;
  current_assignment_status: string | null;
  current_assignment_redaction_profile: string | null;
}

export class PostgresqlP3TaskReadRepository implements P3TaskReadRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  async readTask(input: Parameters<P3TaskReadRepository["readTask"]>[0]): Promise<P3TaskReadRow | null> {
    return this.runner.run({ organizationId: input.organizationId, actorUserId: input.userId }, async (transaction) => {
      const principal=await currentPrincipal(transaction,input);
      const result = await transaction.query<DatabaseRow>({
        text: selectSql("AND task.id=$5::uuid"),
        values: [input.organizationId, input.userId, input.isFounder, input.actorRole, input.taskId,!!principal,principal?.categories ?? []],
      });
      return result.rows[0] === undefined ? null : mapRow(result.rows[0]);
    });
  }

  async listAssigned(input: Parameters<P3TaskReadRepository["listAssigned"]>[0]): Promise<readonly P3TaskReadRow[]> {
    return this.runner.run({ organizationId: input.organizationId, actorUserId: input.userId }, async (transaction) => {
      const principal=await currentPrincipal(transaction,input);
      const result = await transaction.query<DatabaseRow>({
        text: selectSql("AND task.assignee_user_id=$2::uuid AND $5::uuid IS NULL", true),
        values: [input.organizationId, input.userId, input.isFounder, input.actorRole,null,!!principal,principal?.categories ?? []],
      });
      return Object.freeze(result.rows.map(mapRow));
    });
  }
}

function selectSql(extraPredicate: string, assignedOnly = false): string {
  return `SELECT task.id,task.task_kind,task.school_target_id,task.state,task.due_at,
      task.record_version,task.owner_user_id,
      ($6::boolean AND $4 IN ('founder','l1','l2')) AS trial_manager,
      (service_case.workflow_status='active' AND service_case.stage<>'closed' AND student.status='active') AS writable,
      (task.due_at < transaction_timestamp() AND task.state NOT IN ('completed','cancelled','rejected')) AS is_overdue,
      current_assignment.id AS current_assignment_id,
      current_assignment.assignee_user_id AS current_assignee_user_id,
      current_assignment.assignee_role AS current_assignee_role,
      current_assignment.status AS current_assignment_status,
      current_assignment.redaction_profile AS current_assignment_redaction_profile
    FROM tasks_tasks AS task
    JOIN cases_service_cases AS service_case
      ON service_case.id=task.service_case_id AND service_case.organization_id=task.organization_id
    JOIN crm_students student ON student.id=service_case.student_id AND student.organization_id=service_case.organization_id
    LEFT JOIN LATERAL (
      SELECT assignment.id,assignment.assignee_user_id,assignment.assignee_role,assignment.status,
             assignment.redaction_profile
        FROM tasks_task_assignments AS assignment
       WHERE assignment.organization_id=task.organization_id
         AND assignment.task_id=task.id AND assignment.ended_at IS NULL
       ORDER BY assignment.created_at DESC,assignment.id DESC LIMIT 1
    ) AS current_assignment ON true
    WHERE task.organization_id=$1::uuid
      ${extraPredicate}
      AND (CASE WHEN $6::boolean THEN
        service_case.business_category IN ('international_school','local_school') AND (
          $4 IN ('founder','l1') OR ($4='l2' AND service_case.business_category=ANY($7::text[]))
          OR ($4='l3' AND task.assignee_user_id=$2 AND task.assignee_role='l3'
            AND task.assignee_redaction_profile='task_only' AND student.status='active'
            AND task.state IN ('assigned','accepted','completed') AND current_assignment.assignee_user_id=$2
            AND current_assignment.assignee_role='l3' AND current_assignment.redaction_profile='task_only'
            AND current_assignment.status IN ('assigned','accepted','reassigned')))
        ELSE (($3::boolean AND ${assignedOnly ? "task.assignee_user_id=$2::uuid" : "true"})
        OR ($4::text='advisor' AND (task.assignee_user_id=$2::uuid OR service_case.primary_user_id=$2::uuid))
        OR ($4::text='contractor'
          AND task.assignee_user_id=$2::uuid
          AND task.assignee_role='contractor'
          AND task.assignee_redaction_profile='task_only'
          AND task.state NOT IN ('completed','cancelled','rejected')
          AND current_assignment.assignee_user_id=$2::uuid
          AND current_assignment.assignee_role='contractor'
          AND current_assignment.redaction_profile='task_only'
          AND current_assignment.status IN ('assigned','accepted','reassigned'))) END)
      AND EXISTS (
        SELECT 1
          FROM access_organization_memberships AS membership
          JOIN access_role_bindings AS binding
            ON binding.membership_id=membership.id AND binding.organization_id=membership.organization_id
           AND binding.user_id=membership.user_id AND binding.status='active'
         WHERE membership.organization_id=task.organization_id
           AND membership.user_id=$2::uuid AND membership.status='active'
           AND binding.role = $4::text
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
    owner_user_id: row.owner_user_id,trial_manager:row.trial_manager,writable:row.writable,
    current_assignment: row.current_assignment_id === null ? null : Object.freeze({
      id: row.current_assignment_id,
      assignee_user_id: row.current_assignee_user_id!,
      assignee_role: row.current_assignee_role!,
      status: row.current_assignment_status!,
    }),
  });
}

async function currentPrincipal(transaction:TenantTransaction,input:{ organizationId:string;userId:string;actorRole:string }) {
  const principal=await loadTrialPrincipal({query:async<Row extends Record<string,unknown>>(text:string,values?:readonly unknown[])=>transaction.query<Row>({text,values})},{...input,lock:true});
  if ((principal && (!principal.active || principal.level!==input.actorRole)) || (!principal && ["l1","l2","l3"].includes(input.actorRole))) throw new P3TaskReadError("FORBIDDEN");
  return principal;
}
