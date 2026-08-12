import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCaseWorkspaceTab,
  moveCaseWorkspaceTab,
  resolveCaseWorkspaceTab,
  workspaceTabHref,
  type CaseWorkspaceTabProjection,
} from "../../components/cases/workspace-model.ts";

const projectedTabs: readonly CaseWorkspaceTabProjection[] = [
  { id: "overview", label: "Overview", visible: true, capability: "view" },
  { id: "assessment", label: "Assessment", visible: true, capability: "edit" },
  { id: "schools", label: "Schools", visible: false, capability: null },
  { id: "tasks", label: "Tasks", visible: true, capability: "view" },
  { id: "documents", label: "Documents", visible: false, capability: null },
  { id: "timeline", label: "Timeline", visible: false, capability: null },
];

test("workspace model accepts only declared tab identifiers", () => {
  assert.equal(parseCaseWorkspaceTab("assessment"), "assessment");
  assert.equal(parseCaseWorkspaceTab("export"), null);
  assert.equal(parseCaseWorkspaceTab(undefined), null);
});

test("workspace model honors the server-projected visible tab list", () => {
  assert.equal(resolveCaseWorkspaceTab(parseCaseWorkspaceTab("tasks"), projectedTabs), "tasks");
  assert.equal(resolveCaseWorkspaceTab(parseCaseWorkspaceTab("documents"), projectedTabs), "overview");
  assert.equal(resolveCaseWorkspaceTab(null, projectedTabs), "overview");
});

test("workspace model does not turn an all-denied projection into a visible tab", () => {
  const denied = projectedTabs.map((tab) => ({ ...tab, visible: false, capability: null }));
  assert.equal(resolveCaseWorkspaceTab(parseCaseWorkspaceTab("overview"), denied), null);
});

test("workspace tab links preserve the selected server route", () => {
  assert.equal(workspaceTabHref("/cases/abc/workspace", "documents"), "/cases/abc/workspace?tab=documents");
});

test("workspace tab keyboard movement stays within the server-projected visible tabs", () => {
  assert.equal(moveCaseWorkspaceTab("assessment", projectedTabs, "ArrowRight"), "tasks");
  assert.equal(moveCaseWorkspaceTab("overview", projectedTabs, "ArrowLeft"), "tasks");
  assert.equal(moveCaseWorkspaceTab("tasks", projectedTabs, "Home"), "overview");
  assert.equal(moveCaseWorkspaceTab("overview", projectedTabs, "End"), "tasks");
});
