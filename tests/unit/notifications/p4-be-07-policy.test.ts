import assert from "node:assert/strict";
import test from "node:test";
import {
  canReceiveInAppNotification,
  isApprovedNotificationEffect,
  notificationDeduplicationKey,
  notificationEffectForEvent,
} from "../../../modules/notifications/server.ts";

const actor = { userId: "10000000-0000-4000-8000-000000000001", organizationId: "10000000-0000-4000-8000-000000000002", roles: ["founder","advisor"] as const, workspaceCapabilities: ["today.read"] as const };
test("only Advisor and Founder with request-time capability receive notices", () => {
  assert.equal(canReceiveInAppNotification({ actor,recipientRole: "founder" }),true);
  assert.equal(canReceiveInAppNotification({ actor,recipientRole: "advisor" }),true);
  for (const recipientRole of ["admin","guardian","student","contractor"] as const) assert.equal(canReceiveInAppNotification({ actor,recipientRole }),false);
});
test("effects are allowlisted and deduplicated by recipient/effect/source/date/version", () => {
  assert.equal(isApprovedNotificationEffect("task_overdue_daily"),true);
  assert.equal(isApprovedNotificationEffect("email.send"),false);
  assert.equal(notificationDeduplicationKey({ recipientUserId: actor.userId,effectType: "task_overdue_daily",sourceOpaqueId: "opaque-task",businessDate: "2026-08-26",version: 1 }),notificationDeduplicationKey({ recipientUserId: actor.userId,effectType: "task_overdue_daily",sourceOpaqueId: "opaque-task",businessDate: "2026-08-26",version: 1 }));
});

test("producer event types are normalized before approved-effect validation", () => {
  assert.equal(isApprovedNotificationEffect("tasks.overdue"), false);
  const effect = notificationEffectForEvent("tasks.overdue");
  assert.equal(effect, "task_overdue_daily");
  assert.equal(isApprovedNotificationEffect(effect), true);
});
