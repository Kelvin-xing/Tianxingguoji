import assert from "node:assert/strict";
import test from "node:test";

import {
  DueNotificationScheduler,
  DueNotificationSchedulerError,
  dueNotificationEffectType,
  type DueNotificationCandidate,
  type DueNotificationScheduleRepository,
} from "../../../modules/notifications/application/due-scheduler.ts";

const ORGANIZATION_ID = "51000000-0000-4000-8000-000000000001";
const TASK_ID = "51000000-0000-4000-8000-000000000101";

test("due scheduler creates each current candidate and reports duplicate effects", async () => {
  const candidate: DueNotificationCandidate = {
    taskId: TASK_ID,
    organizationId: ORGANIZATION_ID,
    recordVersion: 4,
    dueAt: "2040-01-04T12:00:00.000Z",
    eventType: "tasks.due_3d",
    businessDate: "2040-01-01",
  };
  const calls: number[] = [];
  const repository: DueNotificationScheduleRepository = {
    async listDueNotificationCandidates() {
      return [candidate];
    },
    async scheduleDueNotification() {
      calls.push(1);
      return calls.length === 1 ? "created" : "duplicate";
    },
  };
  const scheduler = new DueNotificationScheduler({ repository });

  assert.deepEqual(await scheduler.runOnce({ organizationId: ORGANIZATION_ID, nowMs: 2_208_988_800_000 }), {
    scanned: 1,
    created: 1,
    duplicates: 0,
  });
  assert.deepEqual(await scheduler.runOnce({ organizationId: ORGANIZATION_ID, nowMs: 2_208_988_800_000 }), {
    scanned: 1,
    created: 0,
    duplicates: 1,
  });
  assert.equal(calls.length, 2);
  assert.equal(dueNotificationEffectType("tasks.due_3d"), "task_due_in_3_days");
});

test("due scheduler rejects invalid time and candidates before scheduling", async () => {
  const repository: DueNotificationScheduleRepository = {
    async listDueNotificationCandidates() {
      return [{
        taskId: TASK_ID,
        organizationId: ORGANIZATION_ID,
        recordVersion: 0,
        dueAt: "2040-01-04T12:00:00.000Z",
        eventType: "tasks.due_3d",
        businessDate: "2040-01-01",
      }];
    },
    async scheduleDueNotification() {
      throw new Error("must not schedule invalid candidates");
    },
  };
  const scheduler = new DueNotificationScheduler({ repository });

  await assert.rejects(
    scheduler.runOnce({ organizationId: ORGANIZATION_ID, nowMs: 0 }),
    (error: unknown) => error instanceof DueNotificationSchedulerError && error.code === "DUE_NOTIFICATION_INVALID_TIME",
  );
  await assert.rejects(
    scheduler.runOnce({ organizationId: ORGANIZATION_ID, nowMs: 2_208_988_800_000 }),
    (error: unknown) => error instanceof DueNotificationSchedulerError && error.code === "DUE_NOTIFICATION_INVALID_CANDIDATE",
  );
});
