import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PAGE = new URL("../../app/platform/billing/page.tsx", import.meta.url);

test("platform billing page declares bounded operational states", async () => {
  const source = await readFile(PAGE, "utf8");
  for (const state of ["loading", "empty", "denied", "unavailable", "error", "ready"]) {
    assert.match(source, new RegExp(`['\"]${state}['\"]`));
  }
  assert.match(source, /\/api\/v1\/platform\/billing\/overview/);
  assert.match(source, /cache:\s*['\"]no-store['\"]/);
});

test("platform billing page contains no prohibited billing or tenant controls", async () => {
  const source = (await readFile(PAGE, "utf8")).toLowerCase();
  for (const forbidden of ["invoice", "calculate amount", "generate notice", "approve notice", "send notice", "delivery", "manual receipt", "drill-down", "activate tenant"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(source, /(?:href|onclick|aria-label|title)[^\n>]*export/);
  assert.doesNotMatch(source, />\s*export\s*</);
});
