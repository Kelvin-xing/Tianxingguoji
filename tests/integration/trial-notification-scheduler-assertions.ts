import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, type ClientConfig } from "pg";

import { DueNotificationScheduler } from "../../modules/notifications/application/due-scheduler.ts";
import { PostgresqlDueNotificationScheduleRepository } from "../../modules/notifications/infrastructure/postgresql-due-scheduler-repository.ts";
import type { DatabaseQuery, TenantTransactionRunner } from "../../modules/shared/server.ts";
import {
  NEON_TEST_MANIFEST_ID,
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
  NEON_TEST_STUDENTS,
} from "../../scripts/db/neon-test-synthetic-fixture.ts";

/** Verifies deadline event production independently from notification delivery. */
export async function assertTrialNotificationScheduler(config: ClientConfig): Promise<void> {
  const client = new Client(config);
  const organizationId = NEON_TEST_ORGANIZATION.id;
  const founder = NEON_TEST_PRINCIPALS[0]!;
  const advisor = NEON_TEST_PRINCIPALS[2]!;
  const caseId = randomUUID();
  const assignmentId = randomUUID();
  const taskId = randomUUID();
  const workerId = founder.userId;
  const nowMs = Date.parse("2040-01-01T12:00:00.000Z");

  await client.connect();
  await client.query("BEGIN");
  await client.query("SET CONSTRAINTS ALL DEFERRED");
  await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)", [organizationId, founder.userId]);

  const runner: TenantTransactionRunner = {
    async run(context, operation) {
      await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)", [context.organizationId, context.actorUserId]);
      return operation({
        async query<Row = Record<string, unknown>>(query: DatabaseQuery) {
          const result = await client.query(query.text, query.values ? [...query.values] : undefined);
          return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
        },
      });
    },
  };

  try {
    await client.query(`INSERT INTO cases_service_cases
      (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
       primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,
       workflow_status,record_version,current_primary_advisor_assignment_id,business_category)
      VALUES ($1,$2,$3,$4,'k12',2090,'transfer',$5,$6,$7,'advisor','signed',
        'active',1,$8,'international_school')`, [
      caseId, organizationId, NEON_TEST_STUDENTS[0]!.id, `TRIAL-SCHEDULER-${caseId}`,
      advisor.roleBindingId, advisor.membershipId, advisor.userId, assignmentId,
    ]);
    await client.query(`INSERT INTO cases_primary_advisor_assignments
      (id,organization_id,service_case_id,advisor_role_binding_id,membership_id,
       advisor_user_id,advisor_role,starts_at,assignment_reason)
      VALUES ($1,$2,$3,$4,$5,$6,'advisor',transaction_timestamp(),'notification_scheduler_fixture')`, [
      assignmentId, organizationId, caseId, advisor.roleBindingId, advisor.membershipId, advisor.userId,
    ]);
    await client.query(`INSERT INTO cases_assessments
      (id,organization_id,service_case_id,manifest_id,status,record_version)
      VALUES (gen_random_uuid(),$1,$2,$3,'draft',1)`, [organizationId, caseId, NEON_TEST_MANIFEST_ID]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [advisor.userId]);
    await client.query("SELECT * FROM cases_advance_new_service_case($1,'advisor',$2,transaction_timestamp())", [caseId, randomUUID()]);
    await client.query(`INSERT INTO tasks_tasks
      (id,organization_id,service_case_id,title,task_brief,due_at,state,assignee_user_id,assignee_role,record_version)
      VALUES ($1,$2,$3,'Synthetic due scheduler task','Synthetic due scheduler task brief',
        $4::timestamptz,'assigned',$5,'advisor',1)`, [
      taskId, organizationId, caseId, "2040-01-04T12:00:00.000Z", advisor.userId,
    ]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");

    const scheduler = new DueNotificationScheduler({
      repository: new PostgresqlDueNotificationScheduleRepository({ runner, organizationId, workerId }),
    });
    assert.deepEqual(await scheduler.runOnce({ organizationId, nowMs }), { scanned: 1, created: 1, duplicates: 0 });
    assert.deepEqual(await scheduler.runOnce({ organizationId, nowMs }), { scanned: 1, created: 0, duplicates: 1 });

    const result = await client.query<{ count: number; event_type: string; record_version: number }>(
      `SELECT count(*)::int AS count, min(event_type) AS event_type, min(event_version)::int AS record_version
         FROM audit_outbox
        WHERE organization_id=$1 AND aggregate_id=$2 AND event_type='tasks.due_3d'`,
      [organizationId, taskId],
    );
    assert.deepEqual(result.rows[0], { count: 1, event_type: "tasks.due_3d", record_version: 1 });
    process.stdout.write(JSON.stringify({ trial_notification_scheduler: "pass", generated: 1, duplicate: 1 }) + "\n");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}
