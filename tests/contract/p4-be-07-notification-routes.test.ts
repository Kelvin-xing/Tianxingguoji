import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

test("P4-BE-07 exposes current-recipient notification read routes through module entrypoints", async () => {
  const list = await source("app/api/v1/notifications/route.ts");
  const unread = await source("app/api/v1/notifications/unread-count/route.ts");
  const read = await source("app/api/v1/notifications/[notificationId]/read/route.ts");
  const resolveTarget = await source("app/api/v1/notifications/[notificationId]/resolve-target/route.ts");
  for (const route of [list, unread, read, resolveTarget]) {
    assert.match(route, /requireApiRequestAccessContext/);
    assert.match(route, /modules\/notifications\/server/);
    assert.match(route, /modules\/shared\/(?:public|server)/);
    assert.doesNotMatch(route, /modules\/notifications\/infrastructure/);
    assert.doesNotMatch(route, /modules\/shared\/infrastructure/);
    assert.match(route, /dynamic = "force-dynamic"/);
  }
  assert.match(read, /expected_record_version/);
  assert.match(read, /IDEMPOTENCY_KEY_PATTERN/);
  assert.match(read, /key !== "expected_record_version"/);
  assert.match(resolveTarget, /WORKSPACE_PENDING_ITEM/);
});

test("P4-BE-07 migration permits suppressed receipt without a visible Notification", async () => {
  const migration = await source("db/migrations/202608260110_048_complete_notifications_delivery.sql");
  assert.match(migration, /ALTER COLUMN notification_id DROP NOT NULL/);
  assert.match(migration, /recipient_user_id SET NOT NULL/);
  assert.match(migration, /outcome IN \('delivered', 'failed', 'compensated'\)/);
  assert.match(migration, /target_opaque_id/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}
