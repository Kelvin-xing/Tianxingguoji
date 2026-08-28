import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("auth/users is a read-only request-time Access route", async () => {
  const source = await readFile("app/api/v1/auth/users/route.ts", "utf8");

  assert.match(source, /requireApiRequestAccessContext\(\)/);
  assert.match(source, /service\.listUsers\(actor\)/);
  assert.match(source, /total: users\.length/);
  assert.match(source, /user_id: user\.userId/);
  assert.match(source, /roles: user\.roles\.map/);
  assert.doesNotMatch(source, /password|secret|token|session_hash/i);
});

test("access page reads the user directory and exposes no role mutation command", async () => {
  const source = await readFile("app/(erp)/admin/access/page.tsx", "utf8");

  assert.match(source, /\/api\/v1\/auth\/users/);
  assert.match(source, /共 \{total\} 位使用者/);
  assert.match(source, /重新載入/);
  assert.doesNotMatch(source, /<button[^>]*>[^<]*(邀請使用者|取消角色)/);
});
