import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

test("profile edit entries obey only students.profiles.manage capability", async () => {
  const detail = await source("components/crm/StudentDetailView.tsx");
  assert.match(detail, /capabilities\.includes\('students\.profiles\.manage'\)/);
  assert.doesNotMatch(detail, /access\.role|role === ['"](?:founder|advisor|admin)/);
  assert.match(detail, /canManageProfiles \? <button[^>]+>.*編輯學生資料/s);
  assert.match(detail, /canManageProfiles \? <button[^>]+>.*編輯監護人資料/s);
});

test("focused editors expose only the frozen profile fields with Save and Cancel", async () => {
  const panel = await source("components/crm/ProfileEditPanel.tsx");
  for (const label of [
    "學生姓名",
    "出生日期",
    "學生電郵",
    "學生電話",
    "監護人姓名",
    "監護人電郵",
    "監護人電話",
  ]) assert.match(panel, new RegExp(`label=["']${label}["']`));
  assert.match(panel, /saveLabel="儲存學生資料"/);
  assert.match(panel, /saveLabel="儲存監護人資料"/);
  assert.match(panel, />取消<\/button>/);
  assert.doesNotMatch(panel, /type=["']hidden|name=["'][^"']*(?:uuid|version)|localStorage|sessionStorage|URLSearchParams|console\.|analytics|fetch\(/i);
});

test("profile mutations use synchronous locks, retry-safe attempts and authoritative refresh", async () => {
  const [panel, detail] = await Promise.all([
    source("components/crm/ProfileEditPanel.tsx"),
    source("components/crm/StudentDetailView.tsx"),
  ]);
  assert.match(panel, /const savingLock = useRef\(false\)/g);
  assert.match(panel, /if \(savingLock\.current\) return/g);
  assert.match(panel, /savingLock\.current = true/g);
  assert.match(panel, /finally \{[\s\S]*?savingLock\.current = false/g);
  assert.match(panel, /attempt\.current\.keyForSubmission\(\)/g);
  assert.match(panel, /attempt\.current\.markBusinessFieldChanged\(\)/g);
  assert.match(detail, /setReloadToken\(\(value\) => value \+ 1\)/);
  assert.match(detail, /getStudent\(studentId, controller\.signal\)/);
  assert.match(panel, /這筆資料已被更新。請重新載入最新資料後再編輯。/);
  assert.doesNotMatch(panel, /setDraft\([^\n]+record_version|last-write-wins/i);
});

test("profile UI distinguishes saving, validation, stale, denied, unavailable and success", async () => {
  const [panel, detail] = await Promise.all([
    source("components/crm/ProfileEditPanel.tsx"),
    source("components/crm/StudentDetailView.tsx"),
  ]);
  for (const state of ["saving", "validation", "stale", "conflict", "denied", "unauthenticated", "unavailable", "success"]) {
    assert.match(panel, new RegExp(`["']${state}["']`));
  }
  assert.match(panel, /aria-busy=\{pending\}/);
  assert.match(panel, /role="alert"/);
  assert.match(detail, /role="status" tabIndex=\{-1\}/);
  assert.match(detail, /學生資料已儲存。/);
  assert.match(detail, /監護人資料已儲存。/);
});

test("read cards remain masked while editors receive exact matched Guardian profiles", async () => {
  const detail = await source("components/crm/StudentDetailView.tsx");
  assert.match(detail, /relationship\?\.guardian\.email_hint/);
  assert.match(detail, /relationship\?\.guardian\.phone_hint/);
  assert.match(detail, /relationshipsByGuardianId\.get\(guardian\.id\)/);
  assert.match(detail, /guardian=\{guardian\}/);
  assert.match(detail, /Guardian profile data does not match the current relationship view/);
});

test("selection cards hide only their direct radio and leave descendant profile inputs interactive", async () => {
  const styles = await source("app/globals.css");
  const selectionInputSelectors = styles
    .split("\n")
    .filter((line) => line.includes(".selection-card") && line.includes("input"))
    .map((line) => line.slice(0, line.indexOf("{")).trim());
  assert.deepEqual(selectionInputSelectors, ['.selection-card > input[type="radio"]']);
  assert.doesNotMatch(styles, /\.selection-card\s+input\s*\{/);
  assert.doesNotMatch(styles, /\.selection-card[^\n{]*form[^\n{]*input/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}
