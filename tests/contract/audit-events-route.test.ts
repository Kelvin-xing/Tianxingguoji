import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("audit events route keeps scope and paging server-side", async () => {
  const source = await readFile("app/api/v1/audit/events/route.ts", "utf8");
  assert.match(source, /PostgreSqlAuditReadRepository/);
  assert.match(source, /scope/);
  assert.match(source, /limit/);
  assert.match(source, /actor_user_id/);
});
