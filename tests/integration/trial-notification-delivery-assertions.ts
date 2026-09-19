import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, type ClientConfig } from "pg";

import { InAppNotificationService } from "../../modules/notifications/application/service.ts";
import { PostgresqlInAppNotificationRepository } from "../../modules/notifications/infrastructure/postgresql-repository.ts";
import type { DatabaseQuery, TenantTransactionRunner } from "../../modules/shared/server.ts";
import {
  NEON_TEST_MANIFEST_ID,
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
  NEON_TEST_STUDENTS,
} from "../../scripts/db/neon-test-synthetic-fixture.ts";

/** Exercises recipient fan-out and daily de-duplication on real PostgreSQL. */
export async function assertTrialNotificationDelivery(config: ClientConfig): Promise<void> {
  const client = new Client(config);
  const organizationId = NEON_TEST_ORGANIZATION.id;
  const founder = NEON_TEST_PRINCIPALS[0]!;
  const advisor = NEON_TEST_PRINCIPALS[2]!;
  const caseId = randomUUID();
  const assignmentId = randomUUID();
  const taskId = randomUUID();
  const firstOutboxId = randomUUID();

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
      caseId, organizationId, NEON_TEST_STUDENTS[0]!.id, `TRIAL-NOTIFY-${caseId}`,
      advisor.roleBindingId, advisor.membershipId, advisor.userId, assignmentId,
    ]);
    await client.query(`INSERT INTO cases_primary_advisor_assignments
      (id,organization_id,service_case_id,advisor_role_binding_id,membership_id,
       advisor_user_id,advisor_role,starts_at,assignment_reason)
      VALUES ($1,$2,$3,$4,$5,$6,'advisor',transaction_timestamp(),'notification_fixture')`, [
      assignmentId, organizationId, caseId, advisor.roleBindingId, advisor.membershipId, advisor.userId,
    ]);
    await client.query(`INSERT INTO cases_assessments
      (id,organization_id,service_case_id,manifest_id,status,record_version)
      VALUES (gen_random_uuid(),$1,$2,$3,'draft',1)`, [organizationId, caseId, NEON_TEST_MANIFEST_ID]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [advisor.userId]);
    await client.query("SELECT * FROM cases_advance_new_service_case($1,'advisor',$2,transaction_timestamp())", [caseId, randomUUID()]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [founder.userId]);
    await client.query(`INSERT INTO tasks_tasks
      (id,organization_id,service_case_id,title,task_brief,due_at,state,assignee_user_id,assignee_role,record_version)
      VALUES ($1,$2,$3,'Synthetic overdue task','Synthetic overdue task brief',
        transaction_timestamp() - interval '1 day','assigned',$4,'advisor',1)`, [
      taskId, organizationId, caseId, advisor.userId,
    ]);

    await insertOutbox(client, {
      outboxId: firstOutboxId,
      organizationId,
      aggregateId: taskId,
      eventType: "tasks.overdue",
      idempotencyKey: `trial-notify-${randomUUID()}`,
    });
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");

    const repository = new PostgresqlInAppNotificationRepository({ runner, organizationId });
    const service = new InAppNotificationService({ repository });
    const recipients = new Set<string>();
    const firstClaim = await service.claimNextDelivery({ workerId: founder.userId });
    assert.equal(firstClaim.status, "claimed");
    recipients.add(firstClaim.work.recipientUserId);
    assert.equal((await service.completeDelivery(firstClaim.work)).status, "delivered");

    const secondClaim = await service.claimNextDelivery({ workerId: founder.userId });
    assert.equal(secondClaim.status, "claimed");
    recipients.add(secondClaim.work.recipientUserId);
    assert.equal((await service.completeDelivery(secondClaim.work)).status, "delivered");
    assert.deepEqual(recipients, new Set([advisor.userId, founder.userId]));
    assert.equal((await service.claimNextDelivery({ workerId: founder.userId })).status, "idle");

    const duplicateOutboxId = randomUUID();
    await insertOutbox(client, {
      outboxId: duplicateOutboxId,
      organizationId,
      aggregateId: taskId,
      eventType: "tasks.overdue",
      idempotencyKey: `trial-notify-${randomUUID()}`,
    });
    const duplicateClaim = await service.claimNextDelivery({ workerId: founder.userId });
    assert.equal(duplicateClaim.status, "claimed");
    assert.equal((await service.completeDelivery(duplicateClaim.work)).status, "duplicate");
    assert.equal((await service.claimNextDelivery({ workerId: founder.userId })).status, "idle");

    const counts = await client.query<{ notifications: number; receipts: number; delivered: number }>(
      `SELECT
         (SELECT count(*)::int FROM notifications_notifications WHERE organization_id=$1) AS notifications,
         (SELECT count(*)::int FROM notifications_delivery_receipts WHERE organization_id=$1) AS receipts,
         (SELECT count(*)::int FROM audit_outbox WHERE organization_id=$1 AND status='delivered' AND id IN ($2,$3)) AS delivered`,
      [organizationId, firstOutboxId, duplicateOutboxId],
    );
    assert.deepEqual(counts.rows[0], { notifications: 2, receipts: 2, delivered: 2 });
    process.stdout.write(JSON.stringify({
      trial_notification_delivery: "pass",
      recipients: ["advisor", "founder"],
      daily_deduplication: "same_effect_key",
      outboxes: 2,
    }) + "\n");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

async function insertOutbox(
  client: Client,
  input: Readonly<{
    outboxId: string;
    organizationId: string;
    aggregateId: string;
    eventType: string;
    idempotencyKey: string;
  }>,
): Promise<void> {
  const auditEventId = randomUUID();
  const requestId = `trial-notify-${randomUUID()}`;
  await client.query(`INSERT INTO audit_events
    (id,organization_id,actor_kind,event_type,event_version,action,resource_type,resource_id,
     outcome,request_id,occurred_at,metadata)
    VALUES ($1,$2,'worker',$3,1,'overdue','Task',$4,'succeeded', $5, transaction_timestamp(),'{}'::jsonb)`, [
    auditEventId, input.organizationId, input.eventType, input.aggregateId, requestId,
  ]);
  await client.query(`INSERT INTO audit_outbox
    (id,audit_event_id,organization_id,aggregate_type,aggregate_id,event_type,event_version,
     idempotency_key,request_id,payload,status)
    VALUES ($1,$2,$3,'Task',$4,$5,1,$6,$7,
      jsonb_build_object('aggregate_id',$4::uuid::text,'request_id',$7::text),'pending')`, [
    input.outboxId, auditEventId, input.organizationId, input.aggregateId,
    input.eventType, input.idempotencyKey, requestId,
  ]);
}
