import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelPath = new URL("../../../components/crm/GuardianRelationshipPanel.tsx", import.meta.url);
const detailPath = new URL("../../../components/crm/StudentDetailView.tsx", import.meta.url);

test("detail and management entry obey only students.guardians.manage capability", async () => {
  const [panel, detail] = await Promise.all([readFile(panelPath, "utf8"), readFile(detailPath, "utf8")]);
  assert.match(panel, /capabilities\.includes\("students\.guardians\.manage"\)/);
  assert.match(detail, /capabilities\.includes\('students\.guardians\.manage'\)/);
  assert.doesNotMatch(panel, /access\.role|role === ["'](?:founder|advisor|admin)/);
  assert.doesNotMatch(detail, /access\.role|role === ["'](?:founder|advisor|admin)/);
  assert.match(detail, /canManageGuardians \? <Link href=\{`\/students\/\$\{student\.id\}\/guardians`\}/);
  assert.match(panel, /服務端獨立驗證權限/);
});

test("management page has three sibling work areas and never asks users for raw identifiers or versions", async () => {
  const source = await readFile(panelPath, "utf8");
  const current = source.indexOf('aria-labelledby="current-relationships-heading"');
  const attach = source.indexOf('aria-labelledby="attach-guardian-heading"');
  const handoff = source.indexOf('aria-labelledby="handoff-primary-heading"');
  assert.ok(current >= 0 && current < attach && attach < handoff);
  assert.doesNotMatch(source, /Guardian ID|guardian-id|primary-version|Current primary version|raw UUID/i);
  assert.doesNotMatch(source, /<input[^>]+(?:guardian_id|record_version)/);
  assert.match(source, /primary\.record_version/);
  assert.match(source, /既有歷史會保留，也不會刪除任何監護人/);
});

test("search is explicit, bounded and exposes only masked candidate hints", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /minLength=\{2\}/);
  assert.match(source, /maxLength=\{100\}/);
  assert.match(source, /type="radio" name="guardian-candidate"/);
  assert.match(source, /系統不會自動匹配或建立新監護人/);
  assert.match(source, /candidate\.display_name/);
  assert.match(source, /guardian\.email_hint, guardian\.phone_hint/);
  assert.doesNotMatch(source, /guardian\.email\b|guardian\.phone\b/);
});

test("attach uses fixed relationship choices, safe defaults and no primary control", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.deepEqual(
    [...source.matchAll(/<option value="(father|mother|other_guardian)">/g)].map((match) => match[1]),
    ["father", "mother", "other_guardian"],
  );
  assert.match(source, /is_legal_guardian: true/);
  assert.match(source, /is_emergency_contact: false/);
  assert.match(source, /is_billing_contact: false/);
  assert.match(source, /notification_consent: false/);
  assert.doesNotMatch(source, /name="is_primary_contact"|主要聯絡人[^\n]+type="checkbox"/);
});

test("mutations have synchronous locks, pending recovery, authority refresh and retry-safe messages", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /const attachLockedRef = useRef\(false\)/);
  assert.match(source, /const handoffLockedRef = useRef\(false\)/);
  assert.match(source, /attachLockedRef\.current = true/);
  assert.match(source, /handoffLockedRef\.current = true/);
  assert.match(source, /finally \{[\s\S]*?attachLockedRef\.current = false/);
  assert.match(source, /finally \{[\s\S]*?handoffLockedRef\.current = false/);
  assert.match(source, /await refreshRelationships\(\)/);
  assert.match(source, /重試不會重複建立關係/);
  assert.match(source, /重試不會重複交接/);
  assert.match(source, /kind: "validation"|"validation"/);
  assert.match(source, /kind: "conflict"|"conflict"/);
  assert.match(source, /kind: "stale"|"stale"/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|fetch\(/);
});

test("student detail reads authoritative current relationships and shows masked status", async () => {
  const source = await readFile(detailPath, "utf8");
  assert.match(source, /getGuardianRelationships\(studentId, controller\.signal\)/);
  assert.match(source, /relationship\.guardian\.email_hint/);
  assert.match(source, /relationship\.guardian\.phone_hint/);
  assert.match(source, /主要聯絡人/);
  assert.match(source, /次要聯絡人/);
  assert.match(source, /guardiansById\.get\(relationship\.guardian\.id\)/);
});
