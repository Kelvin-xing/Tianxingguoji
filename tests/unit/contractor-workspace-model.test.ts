import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContractorTaskWorkspaceModel,
  contractorTaskActions,
} from "../../modules/tasks/application/contractor-workspace-model.ts";

const task = Object.freeze({
  task_id: "00000000-0000-4000-8000-000000000404",
  title: "Prepare the school submission checklist",
  task_brief: "Confirm the listed deliverables and record completion.",
  due_at: "2026-08-14T09:00:00.000Z",
  state: "assigned" as const,
  record_version: 3,
});

test("contractor browser model contains task presentation only and no case navigation", () => {
  const model = buildContractorTaskWorkspaceModel(task);

  assert.deepEqual(Object.keys(model).sort(), [
    "actions",
    "brief",
    "dueLabel",
    "recordVersion",
    "state",
    "stateLabel",
    "taskId",
    "title",
  ]);
  assert.deepEqual(model.actions, ["accepted", "rejected"]);
  const serialized = JSON.stringify(model);
  for (const forbidden of [
    "/cases/",
    "caseId",
    "student",
    "guardian",
    "family",
    "contact",
    "notes",
    "export",
    "reassigned",
    "cancelled",
    "approved",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("contractor browser actions expose only assignee transitions from the resolved OD-06 matrix", () => {
  assert.deepEqual(contractorTaskActions("assigned"), ["accepted", "rejected"]);
  assert.deepEqual(contractorTaskActions("accepted"), ["completed"]);
  for (const terminal of [
    "created",
    "rejected",
    "reassigned",
    "completed",
    "approved",
    "overdue",
    "cancelled",
  ] as const) {
    assert.deepEqual(contractorTaskActions(terminal), []);
  }
});

test("long task text remains content, not a source of new links or actions", () => {
  const model = buildContractorTaskWorkspaceModel({
    ...task,
    title: "A".repeat(300),
    task_brief: "B".repeat(4_000),
  });

  assert.equal(model.title.length, 300);
  assert.equal(model.brief.length, 4_000);
  assert.deepEqual(model.actions, ["accepted", "rejected"]);
});

