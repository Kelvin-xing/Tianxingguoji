import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("auth/users is a request-time Access directory without credential fields", async () => {
  const source = await readFile("app/api/v1/auth/users/route.ts", "utf8");

  assert.match(source, /requireApiRequestAccessContext\(\)/);
  assert.match(source, /service\.listUsers\(actor\)/);
  assert.match(source, /total: users\.length/);
  assert.match(source, /user_id: user\.userId/);
  assert.match(source, /roles: user\.roles\.map/);
  assert.match(source, /access_version: user\.accessVersion/);
  assert.doesNotMatch(source, /password|secret|token|session_hash/i);
});

test("access page reads users and submits the frozen member access command", async () => {
  const source = await readFile("app/(erp)/admin/access/page.tsx", "utf8");

  assert.match(source, /\/api\/v1\/auth\/users/);
  assert.match(source, /共 \{total\} 位使用者/);
  assert.match(source, /重新载入/);
  assert.match(source, /method: 'PATCH'/);
  assert.match(source, /expected_access_version: user\.access_version/);
  assert.match(source, /Contractor 必须是唯一角色/);
  assert.doesNotMatch(source, /password|secret|token|session_hash/i);
});

test("member and own-profile routes keep role management separate from self display name", async () => {
  const [member, profile] = await Promise.all([
    readFile("app/api/v1/auth/users/[userId]/access/route.ts", "utf8"),
    readFile("app/api/v1/auth/me/profile/route.ts", "utf8"),
  ]);
  assert.match(member, /requireApiRequestAccessContext\(\)/);
  assert.match(member, /service\.updateMemberAccess/);
  assert.match(profile, /service\.updateOwnDisplayName/);
  assert.match(profile, /service\.getOwnProfile/);
  assert.doesNotMatch(profile, /employmentType:|roles:/);
});
