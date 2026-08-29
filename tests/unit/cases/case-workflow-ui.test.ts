import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

test("Case detail projects the frozen workflow contract into capability-only controls", async () => {
  const [page, controls] = await Promise.all([
    source("app/(erp)/cases/[caseId]/page.tsx"),
    source("components/cases/CaseStageControls.tsx"),
  ]);

  assert.match(page, /<CaseWorkflowControls/);
  assert.match(page, /initialWorkflowStatus=\{record\.workflowStatus\}/);
  assert.match(page, /initialRecordVersion=\{record\.recordVersion\}/);
  assert.match(page, /initialAvailableWorkflowActions=\{record\.availableWorkflowActions\}/);
  assert.match(controls, /String\(capability\) === "cases\.workflow\.manage"/);
  assert.match(controls, /availableActions\.includes\("pause"\)/);
  assert.match(controls, /availableActions\.includes\("resume"\)/);
  assert.match(controls, /const \[pauseEditorOpen, setPauseEditorOpen\] = useState\(false\)/);
  assert.match(controls, /pauseEditorOpen \? \(/);
  assert.match(controls, /setPauseEditorOpen\(true\)/);
  assert.match(controls, /暫停案件/);
  assert.match(controls, /確認暫停/);
  assert.match(controls, /autoFocus/);
  assert.doesNotMatch(controls, /access\.role|role\s*===|founder|advisor/);
  assert.doesNotMatch(controls, /terminate|closeCase|to_stage|workflow\/advance|workflow\/rollback/);
});

test("pause and resume follow the frozen reason and idempotency contracts", async () => {
  const controls = await source("components/cases/CaseStageControls.tsx");

  assert.match(controls, /const submissionLocked = useRef\(false\)/);
  assert.match(controls, /if \(submissionLocked\.current \|\| accessState !== "manage"\) return/);
  assert.match(controls, /attempt\.current\.keyFor\(command\)/);
  assert.match(controls, /attempt\.current\.complete\(\)/);
  assert.match(controls, /action === "pause" \? reason\.trim\(\) : null/);
  assert.match(controls, /normalizedReason\.length > 1000/);
  assert.match(controls, /minLength=\{1\}/);
  assert.match(controls, /maxLength=\{1000\}/);
  assert.match(controls, /void submit\("resume"\)/);
  assert.equal((controls.match(/id="case-workflow-pause-reason"/g) ?? []).length, 1);
  assert.doesNotMatch(controls, /恢復原因/);
});

test("workflow writes accept only receipt plus matching authoritative GET", async () => {
  const controls = await source("components/cases/CaseStageControls.tsx");

  assert.match(controls, /const receipt = await executeCaseWorkflowAction/);
  assert.match(controls, /const authoritative = await getCase\(caseId\)/);
  assert.match(controls, /receipt\.id !== authoritative\.id/);
  assert.match(controls, /receipt\.record_version !== authoritative\.recordVersion/);
  assert.match(controls, /setAvailableActions\(authoritative\.availableWorkflowActions\)/);
  assert.match(controls, /role=\{feedback\.kind === "success" \? "status" : "alert"\}/);
  assert.match(controls, /headingRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(controls, /router\.refresh/);
});

test("Assessment maintenance follows only the exact server access projection and authoritative GET", async () => {
  const [page, editor] = await Promise.all([
    source("app/(erp)/cases/[caseId]/page.tsx"),
    source("components/cases/AssessmentEditor.tsx"),
  ]);

  assert.match(page, /<AssessmentEditor caseId=\{caseId\} caseStage=\{record\.stage\} \/>/);
  assert.doesNotMatch(page, /cases\.assessments\.manage|actor\.role|canManage/);
  assert.match(editor, /getCaseAssessment\(caseId/);
  assert.match(editor, /view\.access\.editable_field_ids/);
  assert.match(editor, /savedAnswer\.semantic_state !== command\.semantic_state/);
  assert.match(editor, /savedAnswer\.value_type !== command\.value_type/);
  assert.match(editor, /assessmentValueEquals\(savedAnswer\.value, command\.value\)/);
  assert.match(editor, /view\.access\.can_complete_background/);
  assert.match(editor, /caseStage === "background_collection"/);
  assert.match(editor, /readonly caseStage: CaseWorkspaceStage/);
  assert.match(editor, /updateCaseAssessmentAnswer/);
  assert.match(editor, /completeCaseAssessmentBackground/);
  assert.match(editor, /receipt\.id !== latestView\.assessment_id/);
  assert.match(editor, /savedAnswer\?\.record_version !== receipt\.record_version/);
  assert.doesNotMatch(editor, /\bfetch\(|globalThis\.crypto\.randomUUID/);
  assert.match(editor, /answer\.semantic_state === "provided"/);
  assert.match(editor, /你目前可以查看評估，但沒有編輯權限/);
});

test("Case detail removes legacy target writes and hides ad-hoc Task creation while paused", async () => {
  const [page, targets, tasks, workflowContext] = await Promise.all([
    source("app/(erp)/cases/[caseId]/page.tsx"),
    source("components/cases/SchoolTargetsPanel.tsx"),
    source("components/tasks/CaseTasksPanel.tsx"),
    source("components/cases/CaseWorkflowContext.tsx"),
  ]);

  assert.match(page, /<CaseWorkflowProvider initialWorkflowStatus=\{record\.workflowStatus\}>/);
  assert.match(targets, /getSchoolTargets\(caseId/);
  assert.doesNotMatch(targets, /createSchoolTarget|SchoolTargetIdempotencyAttempt|建立候選目標/);
  assert.match(tasks, /workflowStatus === "active"/);
  assert.match(tasks, /workflowStatus === "paused"/);
  assert.match(tasks, /案件暫停期間不能建立臨時任務/);
  assert.match(workflowContext, /setAuthoritativeWorkflowStatus/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}
