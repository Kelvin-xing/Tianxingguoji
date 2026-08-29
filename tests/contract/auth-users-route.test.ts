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
  assert.match(source, /grid-cols-1 gap-2 sm:grid-cols-2/);
  assert.match(source, /type="checkbox" className="mt-0\.5 h-5 w-5 shrink-0"/);
  assert.match(source, /<strong className="break-words">\{roleLabel\(role\)\}<\/strong>/);
  assert.match(source, />昵称</);
  assert.match(source, /未设置昵称/);
  assert.doesNotMatch(source, /显示名称|未设置姓名/);
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

test("own profile presents employee display_name consistently as nickname", async () => {
  const source = await readFile("app/(erp)/profile/page.tsx", "utf8");

  assert.match(source, /工作台昵称/);
  assert.match(source, />昵称</);
  assert.match(source, /昵称已保存/);
  assert.doesNotMatch(source, /显示名称/);
});
