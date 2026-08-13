import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

const runtimeUrl = process.env.P3_EMPTY_TENANT_BASE_URL;
const approvedRuntime = process.env.P3_EMPTY_TENANT_APPROVED === "true";

const requiredChecks = [
  "desktop empty case list",
  "mobile empty case list",
  "loading announcement",
  "typed service error",
  "authorization denied without business detail",
  "long bounded value wraps without horizontal page overflow",
  "keyboard-only reconstruction draft",
  "reconstruction draft has no activation side effect",
] as const;

test("P3-14 browser contract names every required fail-closed surface", async () => {
  assert.equal(new Set(requiredChecks).size, 8);
  await access("app/cases/page.tsx");
  await access("app/(erp)/cases/reconstructions/new/page.tsx");
  await access("components/cases/CaseWorkspace.tsx");
});

test("P3-14 approved empty-tenant browser smoke", { skip: runtimeSkipReason() }, async () => {
  // This executable gate deliberately remains unavailable until Playwright and
  // the exact P3-13 role/runtime receipt are supplied by an approved run.
  assert.ok(runtimeUrl);
  assert.fail("Approved browser driver is not installed; P3-14 cannot pass from source-only evidence.");
});

function runtimeSkipReason(): string | false {
  if (!approvedRuntime) return "P3_EMPTY_TENANT_APPROVED=true was not supplied; no customer runtime is authorized.";
  if (!runtimeUrl) return "P3_EMPTY_TENANT_BASE_URL is required for an approved runtime probe.";
  return false;
}
