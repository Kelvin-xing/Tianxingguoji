import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeliveryReceipt,
  buildPendingItemNotification,
} from "../../../modules/notifications/domain/contract.ts";
import {
  NotificationHttpRepository,
  PostgresqlInAppNotificationRepository,
  type InAppDeliveryWork,
} from "../../../modules/notifications/server.ts";
import type { DatabaseQuery, DatabaseQueryResult, TenantTransactionRunner } from "../../../modules/shared/server.ts";

const ORG = "10000000-0000-4000-8000-000000000001";
const USER = "10000000-0000-4000-8000-000000000002";
const NOTICE = "10000000-0000-4000-8000-000000000003";
const KEY = "read:notice-1";

test("delivery claim locks only the audit outbox row across nullable joins", async () => {
  const queries: string[] = [];
  const runner: TenantTransactionRunner = {
    run: async (_context, operation) => operation({
      query: async <Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>> => {
        queries.push(query.text);
        return { rows: [], rowCount: 0 };
      },
    }),
  };
  const repository = new PostgresqlInAppNotificationRepository({ runner, organizationId: ORG });
  const result = await repository.claimNextInAppDelivery({
    workerId: USER,
    outboxId: null,
    claimedAtMs: Date.parse("2026-08-26T00:00:00.000Z"),
    leaseUntilMs: Date.parse("2026-08-26T00:01:00.000Z"),
  });
  assert.equal(result.status, "idle");
  assert.equal(queries.some((query) => /FOR UPDATE OF o SKIP LOCKED/.test(query)), true);
});

test("notification read uses a scoped idempotency claim and replays the completed result", async () => {
  let completed = false;
  let storedHash = "";
  let notification: Record<string, unknown> = { ...row("unread", 1), read_at: null as string | null };
  let notificationUpdates = 0;
  const runner: TenantTransactionRunner = {
    run: async (_context, operation) => operation({
      query: async <Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>> => {
        let rows: readonly Record<string, unknown>[];
        if (query.text.includes("FROM shared_idempotency_records")) {
          rows = completed ? [{ state: "completed", request_hash: storedHash, result_reference: NOTICE }] : [];
        } else if (query.text.startsWith("INSERT INTO shared_idempotency_records")) {
          storedHash = String(query.values?.[4]);
          rows = [];
        } else if (query.text.startsWith("SELECT id, content_code")) {
          rows = [notification];
        } else if (query.text.startsWith("UPDATE notifications_notifications")) {
          notification = { ...notification, status: "read", record_version: 2, read_at: "2026-08-26T00:00:00.000Z" };
          notificationUpdates += 1;
          rows = [notification];
        } else if (query.text.startsWith("UPDATE shared_idempotency_records")) {
          completed = true;
          rows = [];
        } else {
          throw new Error(`unexpected query: ${query.text}`);
        }
        return { rows: rows as readonly Row[], rowCount: rows.length };
      },
    }),
  };
  const repository = new NotificationHttpRepository(runner);
  const first = await repository.markRead({ organizationId: ORG, userId: USER, notificationId: NOTICE, expectedRecordVersion: 1, idempotencyKey: KEY });
  const replay = await repository.markRead({ organizationId: ORG, userId: USER, notificationId: NOTICE, expectedRecordVersion: 1, idempotencyKey: KEY });
  assert.equal(first.status, "read");
  assert.equal(first.record_version, 2);
  assert.deepEqual(replay, first);
  assert.equal(notificationUpdates, 1);
});

test("notification read completes a new idempotency claim when the row is already read", async () => {
  let completed = false;
  let storedHash = "";
  let completionUpdates = 0;
  const notification: Record<string, unknown> = { ...row("read", 2), read_at: "2026-08-26T00:00:00.000Z" };
  const runner: TenantTransactionRunner = {
    run: async (_context, operation) => operation({
      query: async <Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>> => {
        let rows: readonly Record<string, unknown>[];
        if (query.text.includes("FROM shared_idempotency_records")) {
          rows = completed ? [{ state: "completed", request_hash: storedHash, result_reference: NOTICE }] : [];
        } else if (query.text.startsWith("INSERT INTO shared_idempotency_records")) {
          storedHash = String(query.values?.[4]);
          rows = [];
        } else if (query.text.startsWith("SELECT id, content_code")) {
          rows = [notification];
        } else if (query.text.startsWith("UPDATE shared_idempotency_records")) {
          completed = true;
          completionUpdates += 1;
          rows = [];
        } else {
          throw new Error(`unexpected query: ${query.text}`);
        }
        return { rows: rows as readonly Row[], rowCount: rows.length };
      },
    }),
  };
  const repository = new NotificationHttpRepository(runner);
  const first = await repository.markRead({ organizationId: ORG, userId: USER, notificationId: NOTICE, expectedRecordVersion: 2, idempotencyKey: "read:already-read" });
  const replay = await repository.markRead({ organizationId: ORG, userId: USER, notificationId: NOTICE, expectedRecordVersion: 2, idempotencyKey: "read:already-read" });
  assert.deepEqual(replay, first);
  assert.equal(first.status, "read");
  assert.equal(completionUpdates, 1);
});

test("suppressed delivery replay keeps a compensated receipt without a visible notification", async () => {
  const work: InAppDeliveryWork = {
    outboxId: NOTICE,
    organizationId: ORG,
    recipientUserId: USER,
    eventType: "task_assigned",
    effectIdempotencyKey: KEY,
    attemptCount: 1,
    leaseVersion: 2,
  };
  const deliveredNotification = buildPendingItemNotification({
    id: "10000000-0000-4000-8000-000000000004",
    organizationId: ORG,
    recipientUserId: USER,
    outboxId: NOTICE,
    effectType: work.eventType,
    effectIdempotencyKey: KEY,
    createdAt: "2026-08-26T00:00:00.000Z",
  });
  const suppressedNotification = buildPendingItemNotification({
    ...deliveredNotification,
    status: "suppressed",
  });
  const compensatedReceipt = buildDeliveryReceipt({
    id: "10000000-0000-4000-8000-000000000005",
    organizationId: ORG,
    outboxId: NOTICE,
    notificationId: null,
    recipientUserId: USER,
    effectType: work.eventType,
    effectIdempotencyKey: KEY,
    outcome: "compensated",
    attemptCount: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
  });
  const runner: TenantTransactionRunner = {
    run: async (_context, operation) => operation({
      query: async <Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>> => {
        let rows: readonly Record<string, unknown>[];
        if (query.text.includes("FROM access_role_bindings")) {
          rows = [];
        } else if (query.text.includes("FROM notifications_delivery_receipts")) {
          rows = [{
            id: compensatedReceipt.id,
            organizationId: ORG,
            outboxId: NOTICE,
            notificationId: null,
            recipientUserId: USER,
            effectType: work.eventType,
            effectIdempotencyKey: KEY,
            outcome: "compensated",
            attemptCount: 1,
            createdAt: "2026-08-26T00:00:00.000Z",
          }];
        } else if (query.text.includes("FROM notifications_notifications")) {
          rows = [];
        } else {
          throw new Error(`unexpected query: ${query.text}`);
        }
        return { rows: rows as readonly Row[], rowCount: rows.length };
      },
    }),
  };
  const repository = new PostgresqlInAppNotificationRepository({ runner, organizationId: ORG });
  const result = await repository.completeInAppDelivery({
    work,
    completedAtMs: Date.parse("2026-08-26T00:00:00.000Z"),
    deliveredNotification,
    deliveredReceipt: { ...compensatedReceipt, id: "10000000-0000-4000-8000-000000000006", notificationId: deliveredNotification.id, outcome: "delivered" },
    suppressedNotification,
    suppressedReceipt: compensatedReceipt,
  });
  assert.equal(result.status, "duplicate");
  assert.equal(result.notification.status, "suppressed");
  assert.equal(result.receipt.outcome, "compensated");
  assert.equal(result.receipt.notificationId, null);
});

function row(status: "unread" | "read", record_version: number): Record<string, unknown> {
  return {
    id: NOTICE, content_code: "PENDING_ITEM", status, created_at: "2026-08-26T00:00:00.000Z",
    read_at: null, record_version, target_kind: "workspace", target_opaque_id: "opaque", target_action: "resolve_target",
  };
}
