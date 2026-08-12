import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("portal pages cover bounded operational states without forbidden capabilities", async () => {
  const access = await readFile(new URL("app/portal/access/page.tsx", root), "utf8");
  const workspace = await readFile(new URL("app/portal/workspace/page.tsx", root), "utf8");
  const internal = await readFile(new URL("app/cases/[caseId]/access/page.tsx", root), "utf8");
  const source = `${access}\n${workspace}\n${internal}`;

  for (const state of ["loading", "empty", "denied", "expired", "unavailable"]) {
    assert.match(source, new RegExp(`[\"']${state}[\"']`));
  }
  assert.match(source, /rawSecretOnce/);
  assert.match(source, /只顯示一次/);
  assert.match(source, /cache:\s*["']no-store["']/);
  for (const forbidden of ["document download", "export case", "edit case", "internal note"]) {
    assert.equal(source.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test("AppFrame excludes every portal path from internal authentication and navigation", async () => {
  const source = await readFile(new URL("components/layout/AppFrame.tsx", root), "utf8");
  assert.match(source, /pathname\.startsWith\(['"]\/portal(?:\/|['"])/);
  assert.match(source, /isExternalPortal/);
  assert.match(source, /<main[^>]*>\{children\}<\/main>/);
});
