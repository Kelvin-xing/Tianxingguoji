import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  buildTelemetryEvent,
  AuditContractError,
} from "../../modules/audit/domain/contract.ts";
import {
  buildDeliveryReceipt,
  buildPendingItemNotification,
  evaluateDeliveryEffect,
  MINIMAL_NOTIFICATION_CONTENT_CODE,
  MINIMAL_NOTIFICATION_TEXT,
  NotificationContractError,
} from "../../modules/notifications/domain/contract.ts";
import {
  completeIdempotencyRecord,
  createIdempotencyRecord,
  evaluateIdempotency,
  hashRequestPayload,
} from "../../modules/shared/domain/idempotency.ts";
import { planMigration } from "../../scripts/db/plan-migration.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000201";
const ACTOR_ID = "20000000-0000-4000-8000-000000000201";
const RESOURCE_ID = "30000000-0000-4000-8000-000000000201";
const OTHER_RESOURCE_ID = "30000000-0000-4000-8000-000000000202";
const IDEMPOTENCY_ID = "80000000-0000-4000-8000-000000000201";
const AUDIT_ID = "40000000-0000-4000-8000-000000000201";
const OUTBOX_ID = "50000000-0000-4000-8000-000000000201";
const NOTIFICATION_ID = "60000000-0000-4000-8000-000000000201";
const RECEIPT_ID = "70000000-0000-4000-8000-000000000201";
const REQUEST_ID = "request-p0-11-201";
const CREATED_AT = "2026-08-02T00:00:00.000Z";

test("builds one redacted mutation bundle with matching audit and outbox context", () => {
  const audit = buildAuditEvent({
    id: AUDIT_ID,
    organizationId: ORGANIZATION_ID,
    actorUserId: ACTOR_ID,
    actorKind: "user",
    eventType: "case.updated",
    eventVersion: 1,
    action: "update",
    resourceType: "ServiceCase",
    resourceId: RESOURCE_ID,
    outcome: "succeeded",
    requestId: REQUEST_ID,
    occurredAt: CREATED_AT,
    beforeHashSha256: "a".repeat(64),
    afterHashSha256: "b".repeat(64),
    metadata: { record_version: 2, status: "updated" },
  });
  const outbox = buildOutboxMessage({
    id: OUTBOX_ID,
    auditEventId: AUDIT_ID,
    organizationId: ORGANIZATION_ID,
    aggregateType: "ServiceCase",
    aggregateId: RESOURCE_ID,
    eventType: "case.updated",
    eventVersion: 1,
    idempotencyKey: "case-update-201",
    requestId: REQUEST_ID,
    payload: {
      aggregate_id: RESOURCE_ID,
      record_version: 2,
      request_id: REQUEST_ID,
      status: "updated",
    },
    availableAt: CREATED_AT,
    createdAt: CREATED_AT,
  });

  const bundle = buildAtomicMutationEffects({ audit, outbox });

  assert.equal(bundle.audit.id, AUDIT_ID);
  assert.equal(bundle.outbox.auditEventId, AUDIT_ID);
  assert.equal(bundle.outbox.payload.aggregate_id, RESOURCE_ID);
  assert.equal(JSON.stringify(bundle).includes("Jane Doe"), false);
  assert.throws(
    () =>
      buildOutboxMessage({
        ...outbox,
        payload: { ...outbox.payload, aggregate_id: OTHER_RESOURCE_ID },
      }),
    (error: unknown) =>
      error instanceof AuditContractError && error.code === "AUDIT_CONTEXT_MISMATCH",
  );
  assert.throws(
    () =>
      buildAtomicMutationEffects({
        audit,
        outbox: buildOutboxMessage({
          ...outbox,
          requestId: "different-request",
        }),
      }),
    (error: unknown) =>
      error instanceof AuditContractError && error.code === "AUDIT_CONTEXT_MISMATCH",
  );
});

test("rejects PII-shaped audit fields and emits only an allowlisted telemetry shape", () => {
  assert.throws(
    () =>
      buildAuditEvent({
        id: AUDIT_ID,
        organizationId: ORGANIZATION_ID,
        actorUserId: ACTOR_ID,
        actorKind: "user",
        eventType: "case.updated",
        eventVersion: 1,
        action: "update",
        resourceType: "ServiceCase",
        resourceId: RESOURCE_ID,
        outcome: "succeeded",
        requestId: REQUEST_ID,
        occurredAt: CREATED_AT,
        metadata: { email: "student@example.test" } as never,
      }),
    (error: unknown) =>
      error instanceof AuditContractError && error.code === "AUDIT_SENSITIVE_FIELD",
  );

  const telemetry = buildTelemetryEvent({
    eventName: "mutation.completed",
    requestId: REQUEST_ID,
    operation: "case.update",
    outcome: "success",
    durationMs: 42,
    retryable: false,
    errorCode: null,
    organizationId: ORGANIZATION_ID,
    email: "student@example.test",
  } as never);

  assert.deepEqual(telemetry, {
    eventName: "mutation.completed",
    requestId: REQUEST_ID,
    operation: "case.update",
    outcome: "success",
    durationMs: 42,
    retryable: false,
    errorCode: null,
    organizationId: ORGANIZATION_ID,
  });
  assert.equal(JSON.stringify(telemetry).includes("student@example.test"), false);
});

test("returns a deterministic replay for the same idempotency request and conflicts on reuse", () => {
  const requestHash = hashRequestPayload({ command: "case.update", expectedVersion: 1 });
  const record = createIdempotencyRecord({
    id: IDEMPOTENCY_ID,
    organizationId: ORGANIZATION_ID,
    actorKind: "user",
    actorOpaqueId: ACTOR_ID,
    operation: "case.update",
    key: "case-update-201",
    requestHash,
    createdAt: CREATED_AT,
  });

  const scope = { actorKind: record.actorKind, actorOpaqueId: record.actorOpaqueId };
  assert.deepEqual(evaluateIdempotency({ ...scope, key: record.key, requestHash, existing: null }), {
    action: "start",
  });
  assert.deepEqual(
    evaluateIdempotency({ ...scope, key: record.key, requestHash, existing: record }),
    { action: "in_progress", code: "IDEMPOTENCY_IN_PROGRESS" },
  );

  const completed = completeIdempotencyRecord(record, {
    resultReference: "audit-receipt-201",
    responseHash: "c".repeat(64),
    updatedAt: "2026-08-02T00:00:01.000Z",
  });
  assert.deepEqual(
    evaluateIdempotency({ ...scope, key: record.key, requestHash, existing: completed }),
    {
      action: "replay",
      state: "completed",
      resultReference: "audit-receipt-201",
      responseHash: "c".repeat(64),
      recordVersion: 2,
    },
  );
  assert.deepEqual(
    evaluateIdempotency({
      ...scope,
      key: record.key,
      requestHash: "d".repeat(64),
      existing: completed,
    }),
    { action: "conflict", code: "IDEMPOTENCY_KEY_REUSED" },
  );
  assert.throws(
    () =>
      completeIdempotencyRecord(record, {
        resultReference: "audit-receipt-201",
        responseHash: "c".repeat(64),
        updatedAt: "2026-08-01T23:59:59.000Z",
      }),
    /IDEMPOTENCY_RECORD_STATE_INVALID/,
  );
});

test("builds only minimal in-app notifications and deduplicates delivery effects", () => {
  const notification = buildPendingItemNotification({
    id: NOTIFICATION_ID,
    organizationId: ORGANIZATION_ID,
    recipientUserId: ACTOR_ID,
    outboxId: OUTBOX_ID,
    effectType: "in_app.pending_item",
    effectIdempotencyKey: "case-update-201",
    createdAt: CREATED_AT,
  });

  assert.deepEqual(notification, {
    id: NOTIFICATION_ID,
    organizationId: ORGANIZATION_ID,
    recipientUserId: ACTOR_ID,
    channel: "in_app",
    contentCode: MINIMAL_NOTIFICATION_CONTENT_CODE,
    text: MINIMAL_NOTIFICATION_TEXT,
    outboxId: OUTBOX_ID,
    effectType: "in_app.pending_item",
    effectIdempotencyKey: "case-update-201",
    status: "unread",
    createdAt: CREATED_AT,
  });

  const receipt = buildDeliveryReceipt({
    id: RECEIPT_ID,
    organizationId: ORGANIZATION_ID,
    outboxId: OUTBOX_ID,
    notificationId: NOTIFICATION_ID,
    effectType: "in_app.pending_item",
    effectIdempotencyKey: "case-update-201",
    outcome: "delivered",
    attemptCount: 1,
    createdAt: CREATED_AT,
  });
  assert.deepEqual(
    evaluateDeliveryEffect({
      effectType: receipt.effectType,
      effectIdempotencyKey: receipt.effectIdempotencyKey,
      existingReceipt: receipt,
    }),
    { action: "replay", receiptId: RECEIPT_ID },
  );
  assert.throws(
    () => buildPendingItemNotification({ ...notification, text: "Case Alice is ready" } as never),
    (error: unknown) =>
      error instanceof NotificationContractError &&
      error.code === "NOTIFICATION_CONTENT_NOT_MINIMAL",
  );
});

test("publishes the P0-11 migration contract through the planner", async () => {
  const migrationPath = resolve("db/migrations/202608022530_007_expand_audit_outbox.sql");
  const migration = await readFile(migrationPath, "utf8");
  for (const table of [
    "shared_idempotency_records",
    "audit_events",
    "audit_outbox",
    "notifications_notifications",
    "notifications_delivery_receipts",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  for (const marker of [
    "audit_events_append_only",
    "audit_outbox_idempotency_key",
    "audit_outbox_audit_event_fk",
    "notifications_delivery_effect_key",
    "audit_assert_safe_json",
    "audit_outbox_validate_write",
  ]) {
    assert.match(migration, new RegExp(marker));
  }

  const plan = await planMigration({
    migrationDirectory: resolve("db/migrations"),
    snapshot: {
      target: "empty",
      applied: [],
      expectedSchemaSha256: null,
      actualSchemaSha256: null,
    },
  });
  assert.equal(plan.status, "pass");
  assert.equal(
    plan.migrations.find(({ name }) => name === "202608022530_007_expand_audit_outbox.sql")
      ?.sha256,
    "893f3853ec04ed27b15a79b1bfe8b62162bce2e33afd7549627c865913d705e8",
  );
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "applies P0-11 and keeps audit/outbox/notification effects linked and redacted",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is required for PostgreSQL evidence" },
  async () => {
    const { Client } = await import("pg");
    const migrationNames = [
      "202608021330_001_expand_identity_access.sql",
      "202608021630_002_expand_crm.sql",
      "202608021830_003_expand_cases.sql",
      "202608022030_004_expand_school_overlay.sql",
      "202608022230_005_expand_tasks.sql",
      "202608022430_006_expand_documents.sql",
      "202608022530_007_expand_audit_outbox.sql",
    ];
    const client = new Client({ connectionString: testDatabaseUrl });

    await client.connect();
    try {
      await client.query("BEGIN");
      for (const migrationName of migrationNames) {
        await client.query(await readFile(resolve("db/migrations", migrationName), "utf8"));
      }

      await client.query(`
        INSERT INTO identity_users (id, normalized_email, status)
        VALUES ('${ACTOR_ID}', 'p0-11@example.invalid', 'active');
        INSERT INTO access_organizations (id, display_name, status, created_by_user_id)
        VALUES ('${ORGANIZATION_ID}', 'P0-11 synthetic', 'active', '${ACTOR_ID}');
      `);
      await client.query(
        `INSERT INTO audit_events (
           id, organization_id, actor_user_id, actor_kind, event_type, event_version,
           action, resource_type, resource_id, outcome, request_id, occurred_at,
           metadata
         ) VALUES ($1, $2, $3, 'user', 'case.updated', 1, 'update', 'ServiceCase',
                   $4, 'succeeded', $5, $6, $7::jsonb)`,
        [
          AUDIT_ID,
          ORGANIZATION_ID,
          ACTOR_ID,
          RESOURCE_ID,
          REQUEST_ID,
          CREATED_AT,
          JSON.stringify({ record_version: 2, status: "updated" }),
        ],
      );
      await client.query(
        `INSERT INTO audit_outbox (
           id, audit_event_id, organization_id, aggregate_type, aggregate_id,
           event_type, event_version, idempotency_key, request_id, payload,
           available_at
         ) VALUES ($1, $2, $3, 'ServiceCase', $4, 'case.updated', 1, $5, $6, $7::jsonb, $8)`,
        [
          OUTBOX_ID,
          AUDIT_ID,
          ORGANIZATION_ID,
          RESOURCE_ID,
          "case-update-201",
          REQUEST_ID,
          JSON.stringify({
            aggregate_id: RESOURCE_ID,
            record_version: 2,
            request_id: REQUEST_ID,
            status: "updated",
          }),
          CREATED_AT,
        ],
      );
      await client.query(
        `INSERT INTO notifications_notifications (
           id, organization_id, recipient_user_id, outbox_id, effect_type,
           effect_idempotency_key, channel, content_code
         ) VALUES ($1, $2, $3, $4, 'in_app.pending_item', 'case-update-201', 'in_app', 'PENDING_ITEM')`,
        [NOTIFICATION_ID, ORGANIZATION_ID, ACTOR_ID, OUTBOX_ID],
      );
      await client.query(
        `INSERT INTO notifications_delivery_receipts (
           id, organization_id, outbox_id, notification_id, effect_type,
           effect_idempotency_key, outcome, attempt_count
         ) VALUES ($1, $2, $3, $4, 'in_app.pending_item', 'case-update-201', 'delivered', 1)`,
        [RECEIPT_ID, ORGANIZATION_ID, OUTBOX_ID, NOTIFICATION_ID],
      );

      const counts = await client.query<{ audit: string; outbox: string; notification: string; receipt: string }>(
        `SELECT
           (SELECT count(*)::text FROM audit_events) AS audit,
           (SELECT count(*)::text FROM audit_outbox) AS outbox,
           (SELECT count(*)::text FROM notifications_notifications) AS notification,
           (SELECT count(*)::text FROM notifications_delivery_receipts) AS receipt`,
      );
      assert.deepEqual(counts.rows[0], {
        audit: "1",
        outbox: "1",
        notification: "1",
        receipt: "1",
      });
      await expectSqlState(
        client,
        () =>
          client.query(
            `INSERT INTO audit_outbox (
               id, audit_event_id, organization_id, aggregate_type, aggregate_id,
               event_type, event_version, idempotency_key, request_id, payload, available_at
             ) VALUES ('50000000-0000-4000-8000-000000000202', $1, $2, 'ServiceCase', $3,
                       'case.updated', 1, 'case-update-201', $4, $5::jsonb, $6)`,
            [
              AUDIT_ID,
              ORGANIZATION_ID,
              RESOURCE_ID,
              REQUEST_ID,
              JSON.stringify({ aggregate_id: RESOURCE_ID, request_id: REQUEST_ID }),
              CREATED_AT,
            ],
          ),
        "23505",
        "audit_outbox_idempotency_key",
      );
      await expectSqlState(
        client,
        () =>
          client.query(
            "UPDATE audit_events SET metadata = $1::jsonb WHERE id = $2",
            [JSON.stringify({ email: "student@example.test" }), AUDIT_ID],
          ),
        "23514",
        "audit_events_append_only",
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  },
);

let expectedFailureSequence = 0;

async function expectSqlState(
  client: import("pg").Client,
  operation: () => Promise<unknown>,
  expectedCode: string,
  expectedConstraint: string,
): Promise<void> {
  const savepoint = `p0_11_failure_${expectedFailureSequence++}`;
  let caughtError: unknown;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await operation();
  } catch (error: unknown) {
    caughtError = error;
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  assert.ok(caughtError instanceof Error, `Expected SQLSTATE ${expectedCode}`);
  const databaseError = caughtError as Error & { code?: string; constraint?: string };
  assert.equal(databaseError.code, expectedCode);
  assert.equal(databaseError.constraint, expectedConstraint);
}
