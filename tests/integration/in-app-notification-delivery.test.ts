import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type OutboxMessage,
} from "../../modules/audit/domain/contract.ts";
import {
  MINIMAL_NOTIFICATION_CONTENT_CODE,
  MINIMAL_NOTIFICATION_TEXT,
} from "../../modules/notifications/domain/contract.ts";
import {
  InAppNotificationService,
} from "../../modules/notifications/application/service.ts";
import {
  getInAppNotificationRuntime,
  InAppNotificationRuntimeUnavailable,
} from "../../modules/notifications/infrastructure/runtime.ts";
import { InMemoryInAppNotificationRepository } from "../fakes/in-app-notification.ts";
import {
  deliverNextInAppNotification,
  InAppDeliveryDeadLetterWorkerError,
  InAppDeliveryRetryableWorkerError,
} from "../../workers/deliver-in-app.ts";

const ORGANIZATION_ID = uuid(1);
const RECIPIENT_ID = uuid(2);
const WORKER_ID = uuid(3);
const CREATED_AT = "2026-08-07T00:00:00.000Z";

class FixedClock {
  nowMs(): number {
    return 1_754_524_800_000;
  }
}

function createService(repository: InMemoryInAppNotificationRepository, seed: number) {
  return new InAppNotificationService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(seed),
  });
}

function seedProducer(
  repository: InMemoryInAppNotificationRepository,
  input: {
    readonly serial: number;
    readonly eventType: "tasks.task_transitioned" | "cases.service_case_stage_transitioned";
  },
) {
  const factId = uuid(input.serial * 10 + 1);
  const aggregateId = uuid(input.serial * 10 + 2);
  const auditId = uuid(input.serial * 10 + 3);
  const outboxId = uuid(input.serial * 10 + 4);
  const eventName = input.eventType === "tasks.task_transitioned"
    ? "task_transitioned"
    : "service_case_stage_transitioned";
  const outbox = buildOutboxMessage({
    id: outboxId,
    auditEventId: auditId,
    organizationId: ORGANIZATION_ID,
    aggregateType: input.eventType.startsWith("tasks") ? "Task" : "ServiceCase",
    aggregateId,
    eventType: input.eventType,
    eventVersion: 1,
    idempotencyKey: `p1-15-outbox-${input.serial}`,
    requestId: `request-p1-15-${input.serial}`,
    payload: {
      aggregate_id: aggregateId,
      record_version: 2,
      request_id: `request-p1-15-${input.serial}`,
      effect_type: eventName,
      operation: input.eventType.startsWith("tasks") ? "tasks.transition" : "cases.transition",
      status: "completed",
    },
    availableAt: CREATED_AT,
    createdAt: CREATED_AT,
  });
  const audit = buildAuditEvent({
    id: auditId,
    organizationId: ORGANIZATION_ID,
    actorUserId: RECIPIENT_ID,
    actorKind: "user",
    eventType: input.eventType,
    eventVersion: 1,
    action: "transition",
    resourceType: input.eventType.startsWith("tasks") ? "Task" : "ServiceCase",
    resourceId: aggregateId,
    outcome: "succeeded",
    requestId: `request-p1-15-${input.serial}`,
    occurredAt: CREATED_AT,
    metadata: { effect_type: eventName, next_version: 2, status: "completed" },
  });
  buildAtomicMutationEffects({ audit, outbox });
  repository.seedProducerFact({
    businessFactId: factId,
    outbox,
    recipientUserId: RECIPIENT_ID,
  });
  return { factId, outbox };
}

test("one P1-13 effect produces one redacted pending-item notification and receipt", async () => {
  const repository = new InMemoryInAppNotificationRepository();
  const { outbox } = seedProducer(repository, { serial: 11, eventType: "tasks.task_transitioned" });
  const result = await deliverNextInAppNotification(
    { workerId: WORKER_ID, outboxId: outbox.id },
    { service: createService(repository, 100) },
  );

  assert.equal(result.status, "delivered");
  assert.deepEqual(repository.snapshot(), {
    businessFacts: 1,
    pendingOutbox: 0,
    processingOutbox: 0,
    deliveredOutbox: 1,
    deadLetterOutbox: 0,
    notifications: 1,
    unreadNotifications: 1,
    suppressedNotifications: 0,
    receipts: 1,
  });
  const notification = repository.notificationForOutbox(outbox.id);
  const receipt = repository.receiptForOutbox(outbox.id);
  assert.ok(notification);
  assert.ok(receipt);
  assert.equal(notification.contentCode, MINIMAL_NOTIFICATION_CONTENT_CODE);
  assert.equal(notification.text, MINIMAL_NOTIFICATION_TEXT);
  assert.equal(receipt.outcome, "delivered");
  assert.doesNotMatch(
    JSON.stringify({ contentCode: notification.contentCode, text: notification.text }),
    /Student|Guardian|ServiceCase|Task|document|reason|case/i,
  );
});

test("access revoked after claim suppresses a P1-14 effect immediately before delivery", async () => {
  const repository = new InMemoryInAppNotificationRepository();
  const { outbox } = seedProducer(repository, {
    serial: 12,
    eventType: "cases.service_case_stage_transitioned",
  });
  repository.revokeAccessAfterNextClaim();

  const result = await deliverNextInAppNotification(
    { workerId: WORKER_ID, outboxId: outbox.id },
    { service: createService(repository, 200) },
  );

  assert.equal(result.status, "suppressed");
  assert.equal(repository.notificationForOutbox(outbox.id), undefined);
  assert.equal(repository.receiptForOutbox(outbox.id)?.outcome, "compensated");
  assert.equal(repository.receiptForOutbox(outbox.id)?.notificationId, null);
  assert.deepEqual(repository.snapshot(), {
    businessFacts: 1,
    pendingOutbox: 0,
    processingOutbox: 0,
    deliveredOutbox: 1,
    deadLetterOutbox: 0,
    notifications: 0,
    unreadNotifications: 0,
    suppressedNotifications: 0,
    receipts: 1,
  });
});

test("duplicate delivery of the same effect replays one receipt without a second notification", async () => {
  const repository = new InMemoryInAppNotificationRepository();
  const { outbox } = seedProducer(repository, { serial: 13, eventType: "tasks.task_transitioned" });
  const service = createService(repository, 300);

  const delivered = await deliverNextInAppNotification(
    { workerId: WORKER_ID, outboxId: outbox.id },
    { service },
  );
  const duplicate = await deliverNextInAppNotification(
    { workerId: WORKER_ID, outboxId: outbox.id },
    { service },
  );

  assert.equal(delivered.status, "delivered");
  assert.deepEqual(duplicate, {
    status: "duplicate",
    outboxId: outbox.id,
    receiptId: delivered.receiptId,
  });
  assert.equal(repository.snapshot().notifications, 1);
  assert.equal(repository.snapshot().receipts, 1);
});

test("bounded delivery failure reaches DLQ without reversing the producer fact", async () => {
  const repository = new InMemoryInAppNotificationRepository();
  const { factId, outbox } = seedProducer(repository, { serial: 14, eventType: "tasks.task_transitioned" });
  const service = createService(repository, 400);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    repository.failNextCompletion();
    await assert.rejects(
      deliverNextInAppNotification({ workerId: WORKER_ID, outboxId: outbox.id }, { service }),
      InAppDeliveryRetryableWorkerError,
    );
    assert.equal(repository.snapshot().businessFacts, 1);
    assert.equal(repository.snapshot().pendingOutbox, 1);
    assert.equal(repository.snapshot().notifications, 0);
    assert.equal(repository.snapshot().receipts, 0);
  }

  repository.failNextCompletion();
  await assert.rejects(
    deliverNextInAppNotification({ workerId: WORKER_ID, outboxId: outbox.id }, { service }),
    InAppDeliveryDeadLetterWorkerError,
  );

  assert.equal(factId, uuid(141));
  assert.deepEqual(repository.snapshot(), {
    businessFacts: 1,
    pendingOutbox: 0,
    processingOutbox: 0,
    deliveredOutbox: 0,
    deadLetterOutbox: 1,
    notifications: 0,
    unreadNotifications: 0,
    suppressedNotifications: 0,
    receipts: 1,
  });
  assert.equal(repository.receiptForOutbox(outbox.id)?.outcome, "failed");
});

test("unconfigured HK worker runtime fails closed", async () => {
  assert.throws(getInAppNotificationRuntime, InAppNotificationRuntimeUnavailable);
  await assert.rejects(
    deliverNextInAppNotification({ workerId: WORKER_ID }),
    InAppNotificationRuntimeUnavailable,
  );
});

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function sequenceIds(seed: number): () => string {
  let current = seed;
  return () => uuid(++current);
}
