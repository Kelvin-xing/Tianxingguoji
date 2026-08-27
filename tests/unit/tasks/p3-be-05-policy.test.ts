import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { canCompleteTargetTask, canCreateTargetTask, isTaskDueAtStableWhenPaused, isValidApplicationCompletion } from "../../../modules/tasks/domain/p3-be-05-policy.ts";

const actor = { userId: "10000000-0000-4000-8000-000000000001", organizationId: "10000000-0000-4000-8000-000000000002", roles: ["advisor"] as const, workspaceCapabilities: ["tasks.create","tasks.transition"] as const };
test("preparing creates only Advisor application task and allows collaborator", () => {
  assert.equal(canCreateTargetTask({ actor,kind: "application_prepare_submit",assigneeRole: "advisor",isPrimaryAdvisor: false,isCaseAdvisorCollaborator: true,targetState: "preparing",workflowStatus: "active" }),true);
  assert.equal(canCreateTargetTask({ actor,kind: "application_prepare_submit",assigneeRole: "contractor",isPrimaryAdvisor: true,isCaseAdvisorCollaborator: false,targetState: "preparing",workflowStatus: "active" }),false);
});
test("interview task may use Contractor but completion never advances result", () => {
  assert.equal(canCreateTargetTask({ actor,kind: "interview_support",assigneeRole: "contractor",isPrimaryAdvisor: false,isCaseAdvisorCollaborator: false,targetState: "interview",workflowStatus: "active" }),true);
  assert.equal(canCompleteTargetTask({ actor,kind: "interview_support",isAssignee: true,targetState: "interview",hasSubmissionReceipt: false,hasEvidenceReference: false }),true);
});
test("application completion requires submission receipt and evidence", () => {
  assert.equal(canCompleteTargetTask({ actor,kind: "application_prepare_submit",isAssignee: true,targetState: "preparing",hasSubmissionReceipt: true,hasEvidenceReference: true }),true);
  assert.equal(canCompleteTargetTask({ actor,kind: "application_prepare_submit",isAssignee: true,targetState: "preparing",hasSubmissionReceipt: false,hasEvidenceReference: true }),false);
});
test("application receipt validation accepts valid references and rejects invalid combinations", () => {
  const base = {
    submitted_at: "2026-08-26T00:00:00.000Z",
    submission_channel: "school_portal",
    submitter_user_id: actor.userId,
    checklist_snapshot: { transcript: true },
  };
  assert.equal(isValidApplicationCompletion({ ...base, official_submission_reference: "APP-123", no_reference_declared: false }), true);
  assert.equal(isValidApplicationCompletion({ ...base, official_submission_reference: null, no_reference_declared: true }), true);
  assert.equal(isValidApplicationCompletion({ ...base, official_submission_reference: "APP-123", no_reference_declared: true }), false);
  assert.equal(isValidApplicationCompletion({ ...base, official_submission_reference: null, no_reference_declared: false }), false);
  assert.equal(isValidApplicationCompletion({ ...base, official_submission_reference: "", no_reference_declared: false }), false);
});
test("paused Case preserves due_at and keeps risk clock meaningful", () => assert.equal(isTaskDueAtStableWhenPaused("2026-09-01T00:00:00.000Z","2026-08-26T00:00:00.000Z"),true));

test("P3 policy has no legacy actor.role authorization path", async () => {
  const source = await readFile("modules/tasks/domain/p3-be-05-policy.ts", "utf8");
  assert.doesNotMatch(source, /actor\.role|evaluateBootstrapAuthorization/);
});
