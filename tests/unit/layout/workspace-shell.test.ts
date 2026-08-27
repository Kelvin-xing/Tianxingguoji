import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  capabilityForPath,
  decodeWorkspaceAuth,
  defaultWorkspacePath,
  isContractorWorkspace,
  isReleaseOneInternalRole,
  visibleWorkspaceNavigation,
} from "../../../components/layout/workspace-navigation.ts";

test("navigation is derived from server capabilities and contractor is tasks-only", () => {
  const contractor = ["tasks.read"] as const;
  assert.deepEqual(visibleWorkspaceNavigation(contractor).map((item) => item.href), ["/tasks"]);
  assert.equal(isContractorWorkspace(contractor), true);
  assert.equal(defaultWorkspacePath(contractor), "/tasks");
  assert.equal(capabilityForPath("/today"), "today.read");
});

test("combination capabilities expose the union without using role in the browser", () => {
  const capabilities = ["today.read", "cases.read", "access.manage"] as const;
  assert.deepEqual(visibleWorkspaceNavigation(capabilities).map((item) => item.href), ["/today", "/cases", "/admin/access"]);
  assert.equal(isContractorWorkspace(capabilities), false);
});

test("workspace auth accepts the complete server capability vocabulary", () => {
  const auth = decodeWorkspaceAuth({
    user_id: "51000000-0000-4000-8000-000000000101",
    organization_id: "51000000-0000-4000-8000-000000000001",
    role: "founder",
    capabilities: [
      "cases.create",
      "cases.assessments.read",
      "students.profiles.manage",
      "documents.upload",
      "today.read",
    ],
  });
  assert.deepEqual(auth.capabilities, [
    "cases.create",
    "cases.assessments.read",
    "students.profiles.manage",
    "documents.upload",
    "today.read",
  ]);
});

test("Data Reviewer remains outside Release 1 entrypoints", () => {
  assert.equal(isReleaseOneInternalRole("data_reviewer"), false);
  assert.equal(isReleaseOneInternalRole("founder"), true);
});

test("ERP shell keeps Portal independent and excludes Release 1 billing/crawler entrypoints", async () => {
  const appFrame = await readFile(new URL("../../../components/layout/AppFrame.tsx", import.meta.url), "utf8");
  const sidebar = await readFile(new URL("../../../components/layout/Sidebar.tsx", import.meta.url), "utf8");
  assert.match(appFrame, /isExternalPortal/);
  assert.match(appFrame, /EXCLUDED_INTERNAL_PREFIXES/);
  assert.match(appFrame, /requiredCapability/);
  assert.match(sidebar, /visibleWorkspaceNavigation/);
  assert.doesNotMatch(sidebar, /RELEASE_ONE_NAVIGATION_PLACEHOLDERS/);
  assert.doesNotMatch(sidebar, /href=.*platform\/billing/);
  assert.doesNotMatch(sidebar, /href=.*admin\/crawler/);
});

test("Today consumes the typed v1 client rather than preview case data", async () => {
  const today = await readFile(new URL("../../../app/(erp)/today/page.tsx", import.meta.url), "utf8");
  assert.match(today, /requestApi/);
  assert.match(today, /\/api\/v1\/dashboard\/cases/);
  assert.match(today, /LoadingState/);
  assert.match(today, /UnavailableState/);
  assert.doesNotMatch(today, /previewCaseWorkspaceAdapter/);
});
