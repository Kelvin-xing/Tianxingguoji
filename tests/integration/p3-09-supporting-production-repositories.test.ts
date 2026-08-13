import assert from "node:assert/strict";
import test from "node:test";

import {
  requireSupportingTransactionRunner,
  runSupportingModuleTransaction,
  SupportingRepositoryError,
} from "../../modules/audit/production-repository.ts";
import { readAvailableDocumentObject } from "../../modules/documents/production-repository.ts";
import { recordNotificationEffect } from "../../modules/notifications/production-repository.ts";
import type { DeliveryReceipt } from "../../modules/notifications/contract.ts";
import { rebuildCaseDashboardProjection } from "../../modules/operations/case-dashboard-projection.ts";
import type {
  TenantDatabaseContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../modules/shared/db.ts";

const context: TenantDatabaseContext = Object.freeze({
  organizationId: "10000000-0000-4000-8000-000000000001",
  actorUserId: "10000000-0000-4000-8000-000000000002",
});

class RecordingRunner implements TenantTransactionRunner {
  readonly queries: string[] = [];
  rolledBack = false;
  rows: readonly unknown[] = [];
  failOn = "";

  async run<Result>(
    _context: TenantDatabaseContext,
    operation: (transaction: TenantTransaction) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await operation({
        query: async <Row>(query: { readonly text: string }) => {
          this.queries.push(query.text);
          if (this.failOn && query.text.includes(this.failOn)) throw new Error("database failure");
          return { rows: this.rows as readonly Row[] };
        },
      });
    } catch (error) {
      this.rolledBack = true;
      throw error;
    }
  }
}

test("absent production adapter fails closed with typed 503", () => {
  assert.throws(
    () => requireSupportingTransactionRunner(undefined),
    (error: unknown) => error instanceof SupportingRepositoryError &&
      error.code === "SUPPORTING_ADAPTER_UNAVAILABLE" && error.status === 503,
  );
});

test("module transaction rejects cross-module writes before database execution", async () => {
  const runner = new RecordingRunner();
  await assert.rejects(
    runSupportingModuleTransaction({
      runner, module: "tasks", context,
      operation: (transaction) => transaction.query({
        text: "UPDATE documents_documents SET lifecycle_state = 'deleted' WHERE id = $1",
      }),
    }),
    (error: unknown) => error instanceof SupportingRepositoryError &&
      error.code === "SUPPORTING_MODULE_OWNERSHIP_VIOLATION",
  );
  assert.equal(runner.queries.length, 0);
  assert.equal(runner.rolledBack, true);
});

test("mandatory audit failure rolls the owning mutation transaction back", async () => {
  const runner = new RecordingRunner();
  runner.failOn = "INSERT INTO audit_events";
  const effect = {
    audit: {
      id: "10000000-0000-4000-8000-000000000010", organizationId: context.organizationId,
      actorUserId: context.actorUserId, actorKind: "user" as const, eventType: "tasks.changed",
      eventVersion: 1, action: "update", resourceType: "Task",
      resourceId: "10000000-0000-4000-8000-000000000011", outcome: "succeeded" as const,
      requestId: "request-1", occurredAt: "2026-08-13T00:00:00.000Z",
      beforeHashSha256: null, afterHashSha256: null, metadata: {},
    },
    outbox: {
      id: "10000000-0000-4000-8000-000000000012",
      auditEventId: "10000000-0000-4000-8000-000000000010",
      organizationId: context.organizationId, aggregateType: "Task",
      aggregateId: "10000000-0000-4000-8000-000000000011", eventType: "tasks.changed",
      eventVersion: 1, idempotencyKey: "effect-1", requestId: "request-1", payload: {},
      status: "pending" as const, attemptCount: 0 as const,
      availableAt: "2026-08-13T00:00:00.000Z", createdAt: "2026-08-13T00:00:00.000Z",
    },
  };
  await assert.rejects(runSupportingModuleTransaction({
    runner, module: "tasks", context,
    operation: async (transaction) => {
      await transaction.query({ text: "UPDATE tasks_tasks SET record_version = record_version + 1" });
      await transaction.appendEffects(effect);
    },
  }), /database failure/);
  assert.equal(runner.rolledBack, true);
  assert.equal(runner.queries.some((sql) => sql.includes("INSERT INTO audit_outbox")), false);
});

test("effects from another tenant are rejected before database execution", async () => {
  const runner = new RecordingRunner();
  const effect = {
    audit: {
      id: "10000000-0000-4000-8000-000000000050", organizationId: "10000000-0000-4000-8000-000000000099",
      actorUserId: context.actorUserId, actorKind: "user" as const, eventType: "tasks.changed",
      eventVersion: 1, action: "update", resourceType: "Task",
      resourceId: "10000000-0000-4000-8000-000000000051", outcome: "succeeded" as const,
      requestId: "request-cross-tenant", occurredAt: "2026-08-13T00:00:00.000Z",
      beforeHashSha256: null, afterHashSha256: null, metadata: {},
    },
    outbox: {
      id: "10000000-0000-4000-8000-000000000052",
      auditEventId: "10000000-0000-4000-8000-000000000050",
      organizationId: "10000000-0000-4000-8000-000000000099", aggregateType: "Task",
      aggregateId: "10000000-0000-4000-8000-000000000051", eventType: "tasks.changed",
      eventVersion: 1, idempotencyKey: "effect-cross-tenant", requestId: "request-cross-tenant",
      payload: {}, status: "pending" as const, attemptCount: 0 as const,
      availableAt: "2026-08-13T00:00:00.000Z", createdAt: "2026-08-13T00:00:00.000Z",
    },
  };
  await assert.rejects(runSupportingModuleTransaction({
    runner, module: "tasks", context,
    operation: (transaction) => transaction.appendEffects(effect),
  }), (error: unknown) => error instanceof SupportingRepositoryError &&
    error.code === "SUPPORTING_EFFECT_CONFLICT" && error.status === 409 && !error.retryable);
  assert.equal(runner.queries.length, 0);
});

test("document object lookup requires active document and available non-revoked version", async () => {
  const runner = new RecordingRunner();
  await assert.rejects(readAvailableDocumentObject({
    runner, context, documentId: "10000000-0000-4000-8000-000000000020",
    versionId: "10000000-0000-4000-8000-000000000021",
  }), (error: unknown) => error instanceof SupportingRepositoryError &&
    error.code === "SUPPORTING_DOCUMENT_UNAVAILABLE");
  assert.match(runner.queries[0], /d\.lifecycle_state = 'active'/);
  assert.match(runner.queries[0], /v\.state = 'available'/);
  assert.match(runner.queries[0], /v\.revoked_at IS NULL/);
});

test("notification effect collision is denied instead of misreported as replay", async () => {
  const receipt: DeliveryReceipt = Object.freeze({
    id: "10000000-0000-4000-8000-000000000030", organizationId: context.organizationId,
    outboxId: "10000000-0000-4000-8000-000000000031",
    notificationId: "10000000-0000-4000-8000-000000000032",
    effectType: "in_app.pending_item", effectIdempotencyKey: "delivery-effect-1",
    outcome: "delivered", attemptCount: 1, createdAt: "2026-08-13T00:00:00.000Z",
  });
  const runner = new RecordingRunner();
  runner.rows = [{ ...receipt, outboxId: "10000000-0000-4000-8000-000000000039" }];
  await assert.rejects(recordNotificationEffect({ runner, context, receipt }),
    (error: unknown) => error instanceof SupportingRepositoryError &&
      error.code === "SUPPORTING_EFFECT_CONFLICT");
  assert.equal(runner.queries.some((sql) => sql.includes("INSERT INTO notifications_delivery_receipts")), false);
});

test("notification effect requires an exact prior receipt for replay", async () => {
  const receipt: DeliveryReceipt = Object.freeze({
    id: "10000000-0000-4000-8000-000000000030", organizationId: context.organizationId,
    outboxId: "10000000-0000-4000-8000-000000000031",
    notificationId: "10000000-0000-4000-8000-000000000032",
    effectType: "in_app.pending_item", effectIdempotencyKey: "delivery-effect-1",
    outcome: "delivered", attemptCount: 1, createdAt: "2026-08-13T00:00:00.000Z",
  });
  const runner = new RecordingRunner();
  runner.rows = [{ ...receipt, outcome: "failed" }];
  await assert.rejects(recordNotificationEffect({ runner, context, receipt }),
    (error: unknown) => error instanceof SupportingRepositoryError &&
      error.code === "SUPPORTING_EFFECT_CONFLICT");
});

test("projection rebuild is deterministic from the authoritative source snapshot", () => {
  const source = Object.freeze({
    schemaVersion: "case_dashboard_source_v1" as const,
    sourceSnapshotId: "snapshot-20260813-1",
    sourceCapturedAtMs: Date.parse("2026-08-13T00:00:00.000Z"),
    organizationId: context.organizationId,
    cases: Object.freeze([
      Object.freeze({
        caseId: "10000000-0000-4000-8000-000000000041", caseNumber: "CASE-2",
        organizationId: context.organizationId,
        studentDisplayName: "Student B", stage: "signed" as const, blockerCount: 0,
        nextAction: null, nextActionDueAtMs: null, educationProfileCompleteness: 0,
        schoolTargetCount: 0, openTaskCount: 0, unreadCommunicationCount: 0,
      }),
      Object.freeze({
        caseId: "10000000-0000-4000-8000-000000000040", caseNumber: "CASE-1",
        organizationId: context.organizationId,
        studentDisplayName: "Student A", stage: "signed" as const, blockerCount: 0,
        nextAction: null, nextActionDueAtMs: null, educationProfileCompleteness: 0,
        schoolTargetCount: 0, openTaskCount: 0, unreadCommunicationCount: 0,
      }),
    ]),
  });
  const first = rebuildCaseDashboardProjection(source);
  const second = rebuildCaseDashboardProjection(source);
  assert.deepEqual(second, first);
  assert.deepEqual(first.cases.map((item) => item.caseNumber), ["CASE-1", "CASE-2"]);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
});
