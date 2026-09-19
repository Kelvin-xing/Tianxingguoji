import "server-only";

import { randomUUID } from "node:crypto";

import { buildAuditEvent, buildOutboxMessage, type MutationEffectBundle } from "../../audit/public.ts";
import { runSupportingModuleTransaction } from "../../audit/server.ts";
import type { TenantDatabaseContext, TenantTransactionRunner } from "../../shared/server.ts";
import {
  dueNotificationEffectType,
  type DueNotificationCandidate,
  type DueNotificationScheduleRepository,
} from "../application/due-scheduler.ts";

type CandidateRow = Record<string, unknown> & {
  task_id: string;
  organization_id: string;
  record_version: number | string;
  due_at: Date | string;
  event_type: string;
  business_date: string;
};

/** Reads task deadlines and appends only scalar, idempotent notification effects. */
export class PostgresqlDueNotificationScheduleRepository implements DueNotificationScheduleRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly organizationId: string;
  private readonly workerId: string;

  constructor(input: Readonly<{
    readonly runner: TenantTransactionRunner;
    readonly organizationId: string;
    readonly workerId: string;
  }>) {
    this.runner = input.runner;
    this.organizationId = input.organizationId;
    this.workerId = input.workerId;
  }

  async listDueNotificationCandidates(input: Readonly<{
    readonly organizationId: string;
    readonly nowMs: number;
  }>): Promise<readonly DueNotificationCandidate[]> {
    if (input.organizationId !== this.organizationId) throw new DueSchedulerRepositoryError("DUE_SCHEDULER_SCOPE_MISMATCH");
    return runSupportingModuleTransaction({
      runner: this.runner,
      module: "notifications",
      context: workerContext(this.organizationId, this.workerId),
      operation: async (transaction) => {
        const rows = await transaction.query<CandidateRow>({
          text: `SELECT task.id AS task_id, task.organization_id, task.record_version,
                        task.due_at, due.event_type,
                        to_char($2::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS business_date
                   FROM tasks_tasks AS task
                   JOIN cases_service_cases AS service_case
                     ON service_case.id=task.service_case_id
                    AND service_case.organization_id=task.organization_id
                   CROSS JOIN LATERAL (
                     SELECT CASE
                       WHEN ((task.due_at AT TIME ZONE 'UTC')::date -
                             ($2::timestamptz AT TIME ZONE 'UTC')::date) = 3
                         THEN 'tasks.due_3d'
                       WHEN ((task.due_at AT TIME ZONE 'UTC')::date -
                             ($2::timestamptz AT TIME ZONE 'UTC')::date) = 1
                         THEN 'tasks.due_1d'
                       WHEN task.due_at < $2::timestamptz
                         THEN 'tasks.overdue'
                       ELSE NULL
                     END AS event_type
                   ) AS due
                  WHERE task.organization_id=$1::uuid
                    AND task.assignee_user_id IS NOT NULL
                    AND task.state NOT IN ('completed','cancelled','rejected')
                    AND service_case.workflow_status='active'
                    AND service_case.stage <> 'closed'
                    AND due.event_type IS NOT NULL
                  ORDER BY task.id, due.event_type`,
          values: [this.organizationId, new Date(input.nowMs).toISOString()],
        });
        return Object.freeze(rows.map(mapCandidate));
      },
    });
  }

  async scheduleDueNotification(input: Readonly<{
    readonly candidate: DueNotificationCandidate;
    readonly scheduledAtMs: number;
  }>): Promise<"created" | "duplicate"> {
    if (input.candidate.organizationId !== this.organizationId) {
      throw new DueSchedulerRepositoryError("DUE_SCHEDULER_SCOPE_MISMATCH");
    }
    const occurredAt = new Date(input.scheduledAtMs).toISOString();
    const effectType = dueNotificationEffectType(input.candidate.eventType);
    const requestId = `notification-scheduler:${input.candidate.businessDate}:${input.candidate.taskId}:${input.candidate.eventType}`;
    const idempotencyKey = `notification-due:${input.candidate.taskId}:${input.candidate.eventType}:${input.candidate.businessDate}:${input.candidate.recordVersion}`;
    const auditId = randomUUID();
    const outboxId = randomUUID();
    const effects: MutationEffectBundle = {
      audit: buildAuditEvent({
        id: auditId,
        organizationId: this.organizationId,
        actorUserId: null,
        actorKind: "worker",
        eventType: input.candidate.eventType,
        eventVersion: input.candidate.recordVersion,
        action: "notification.schedule_due",
        resourceType: "task",
        resourceId: input.candidate.taskId,
        outcome: "succeeded",
        requestId,
        occurredAt,
        metadata: {
          effect_type: effectType,
          record_version: input.candidate.recordVersion,
          request_id: requestId,
          status: "pending",
          retryable: true,
        },
      }),
      outbox: buildOutboxMessage({
        id: outboxId,
        auditEventId: auditId,
        organizationId: this.organizationId,
        aggregateType: "Task",
        aggregateId: input.candidate.taskId,
        eventType: input.candidate.eventType,
        eventVersion: input.candidate.recordVersion,
        idempotencyKey,
        requestId,
        payload: {
          aggregate_id: input.candidate.taskId,
          record_version: input.candidate.recordVersion,
          request_id: requestId,
          effect_type: effectType,
          status: "pending",
          retryable: true,
        },
        availableAt: occurredAt,
        createdAt: occurredAt,
      }),
    };

    return runSupportingModuleTransaction({
        runner: this.runner,
        module: "notifications",
        context: workerContext(this.organizationId, this.workerId),
        operation: async (transaction) => {
          await transaction.query({
            text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            values: [idempotencyKey],
          });
          const existing = await transaction.query<{ id: string }>({
            text: `SELECT id FROM audit_outbox
                    WHERE organization_id=$1 AND idempotency_key=$2
                    FOR SHARE`,
            values: [this.organizationId, idempotencyKey],
          });
          if (existing.length > 0) return "duplicate" as const;
          await transaction.appendEffects(effects);
          return "created" as const;
        },
      });
  }
}

export class DueSchedulerRepositoryError extends Error {
  readonly code: "DUE_SCHEDULER_SCOPE_MISMATCH";

  constructor(code: "DUE_SCHEDULER_SCOPE_MISMATCH") {
    super(code);
    this.name = "DueSchedulerRepositoryError";
    this.code = code;
  }
}

function mapCandidate(row: CandidateRow): DueNotificationCandidate {
  if (!isDueEventType(row.event_type)) throw new DueSchedulerRepositoryError("DUE_SCHEDULER_SCOPE_MISMATCH");
  return Object.freeze({
    taskId: row.task_id,
    organizationId: row.organization_id,
    recordVersion: Number(row.record_version),
    dueAt: new Date(row.due_at).toISOString(),
    eventType: row.event_type,
    businessDate: row.business_date,
  });
}

function isDueEventType(value: string): value is DueNotificationCandidate["eventType"] {
  return value === "tasks.due_3d" || value === "tasks.due_1d" || value === "tasks.overdue";
}

function workerContext(organizationId: string, workerId: string): TenantDatabaseContext {
  return { organizationId, actorUserId: workerId };
}
