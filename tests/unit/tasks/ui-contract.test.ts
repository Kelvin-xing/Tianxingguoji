import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

test("Task routes use authoritative frontend components and Case detail mounts the panel", async () => {
  const [listPage, detailPage, casePage, list] = await Promise.all([
    source("app/(erp)/tasks/page.tsx"),
    source("app/(erp)/tasks/[taskId]/page.tsx"),
    source("app/(erp)/cases/[caseId]/page.tsx"),
    source("components/tasks/TasksDirectory.tsx"),
  ]);
  assert.match(listPage, /<TasksDirectory \/>/);
  assert.match(detailPage, /<TaskDetailView taskId=\{taskId\} \/>/);
  assert.match(casePage, /<CaseTasksPanel key=\{`\$\{record\.id\}-\$\{record\.recordVersion\}`\} caseId=\{caseId\} \/>/);
  assert.doesNotMatch(list, /previewCaseWorkspaceAdapter|Preview adapter|mock|fetch\(/i);
});

test("Case task panel is collapsed by default and opens the create form on demand", async () => {
  const panel = await source("components/tasks/CaseTasksPanel.tsx");
  assert.match(panel, /useState\(false\)/);
  assert.match(panel, /aria-controls="case-task-content"/);
  assert.match(panel, /aria-controls="case-task-create-form"/);
  assert.match(panel, /const openCreate = useCallback/);
  assert.match(panel, /getTaskAssigneeOptions\(caseId, nextController\.signal\)/);
  assert.match(panel, /assignees\.map\(\(assignee\)/);
  assert.doesNotMatch(panel, /assignees\.filter\(\(assignee\) => assignee\.role === "advisor"\)/);
});

test("Task commands are capability-only and consume server available transitions", async () => {
  const [list, detail, panel, transitions] = await Promise.all([
    source("components/tasks/TasksDirectory.tsx"),
    source("components/tasks/TaskDetailView.tsx"),
    source("components/tasks/CaseTasksPanel.tsx"),
    source("components/tasks/TaskTransitionControls.tsx"),
  ]);
  assert.match(list, /tasks\.read/);
  assert.match(detail, /tasks\.read/);
  assert.match(detail, /tasks\.transition/);
  assert.match(panel, /tasks\.create/);
  assert.match(transitions, /task\.available_transitions\.map/);
  assert.match(transitions, /getTaskAssigneeOptions\(caseId/);
  assert.doesNotMatch(transitions, /ACTIONS_BY_STATE|Next assignee ID|type=["']text["'][^>]*assignee|fetch\(/);
  for (const content of [list, detail, panel, transitions]) {
    assert.doesNotMatch(content, /access\.role|snapshot\.role|capabilitiesByRole|ROLE_(?:CAPABILITIES|NAVIGATION)/);
    assert.doesNotMatch(content, /localStorage|sessionStorage|console\./);
  }
});

test("Task create and transition use sync locks, idempotency attempts and authoritative GET", async () => {
  const [panel, transitions] = await Promise.all([
    source("components/tasks/CaseTasksPanel.tsx"),
    source("components/tasks/TaskTransitionControls.tsx"),
  ]);
  assert.match(panel, /if \(submitting\.current \|\| pending \|\| !canCreate/);
  assert.match(panel, /attempt\.current!\.keyFor\(createTaskFingerprint\(input\)\)/);
  assert.match(panel, /const authoritative = await listTasks\(caseId\)/);
  assert.match(panel, /created\.record_version !== receipt\.record_version/);
  assert.match(transitions, /if \(submitting\.current \|\| pending \|\| selected === null\) return/);
  assert.match(transitions, /attempt\.current!\.keyFor\(transitionTaskFingerprint\(task\.id, input\)\)/);
  assert.match(transitions, /const authoritative = await getTask\(task\.id\)/);
  assert.match(transitions, /authoritative\.task\.record_version !== receipt\.record_version/);
});

test("Task UI covers truthful states, redaction, accessibility and responsive controls", async () => {
  const [list, detail, panel, transitions, shared] = await Promise.all([
    source("components/tasks/TasksDirectory.tsx"),
    source("components/tasks/TaskDetailView.tsx"),
    source("components/tasks/CaseTasksPanel.tsx"),
    source("components/tasks/TaskTransitionControls.tsx"),
    source("components/tasks/task-ui.tsx"),
  ]);
  for (const state of ["loading", "ready", "unauthenticated", "denied", "unavailable"]) assert.match(list, new RegExp(`["]${state}["]`));
  for (const state of ["success", "validation", "stale", "conflict", "denied", "unavailable"]) assert.match(transitions, new RegExp(`["]${state}["]`));
  assert.match(detail, /result\.audience === "case_workspace"/);
  assert.match(shared, /audience === "case_workspace"/);
  assert.match(shared, /不包含案件或學生資料/);
  assert.match(panel, /type="datetime-local"/);
  assert.match(transitions, /aria-busy=\{pending\}/);
  assert.match(transitions, /type="checkbox"/);
  assert.match(transitions, /flex flex-col-reverse sm:flex-row/);
  assert.doesNotMatch(`${list}\n${detail}\n${panel}\n${transitions}`, /error\.message|requestId|UUID|raw/i);
});

test("Task detail owns transition success after authoritative refresh without duplicate child status", async () => {
  const [detail, transitions, automatic] = await Promise.all([
    source("components/tasks/TaskDetailView.tsx"),
    source("components/tasks/TaskTransitionControls.tsx"),
    source("components/tasks/AutomaticTaskTransitionControls.tsx"),
  ]);
  assert.match(transitions, /authoritative\.task\.record_version !== receipt\.record_version/);
  assert.match(transitions, /onAuthoritativeChange\(authoritative, "success"\)/);
  assert.match(transitions, /onAuthoritativeChange\(authoritative, "stale"\)/);
  assert.doesNotMatch(transitions, /resetForm\("success"\)|notice === "success"|任務已更新，內容已重新載入。/);
  assert.match(detail, /const \[transitionOutcome, setTransitionOutcome\]/);
  assert.match(detail, /setTransitionOutcome\(null\)/);
  assert.match(detail, /setTransitionOutcome\(outcome\)/);
  assert.match(detail, /role="status"/);
  assert.match(detail, /任務已更新，內容已重新載入。/);
  assert.match(detail, /canTransition && task\.task_kind === "manual" && task\.available_transitions\.length > 0/);
  assert.match(detail, /task\.task_kind !== "manual"/);
  assert.match(automatic, /completeApplicationTask\(/);
  assert.match(automatic, /onInput=\{\(event\) => onChange\("submittedAt", event\.currentTarget\.value\)\}/);
  assert.match(automatic, /onInput=\{\(event\) => onChange\("confirmedAt", event\.currentTarget\.value\)\}/);
  assert.match(automatic, /transitionAutomaticTask\(/);
  assert.doesNotMatch(automatic, /\/api\/v1\/tasks\/\$\{task\.id\}\/transitions["']/);
  assert.match(automatic, /task\.task_kind === "interview_support"/);
  assert.match(automatic, /面試完成記錄尚未開放/);
  assert.match(automatic, /submitter_user_id: actorUserId/);
  assert.match(automatic, /target_pending/);
});

test("TASK-01 permanent browser gate is isolated, privacy-safe and complete", async () => {
  const [browser, packageJson] = await Promise.all([
    source("tests/integration/task-01-case-task-workflow-dev-browser.test.ts"),
    source("package.json"),
  ]);
  assert.match(packageJson, /"test:task-01-dev-browser": "node --conditions=react-server --test tests\/integration\/task-01-case-task-workflow-dev-browser\.test\.ts"/);
  for (const contract of [
    "postgres:17.10-alpine3.24",
    "verifyCommittedOneRoleBaseline",
    "seedNeonTestRelease1",
    "launchPersistentContext",
    "client_validation",
    "create_idempotency",
    "create_authoritative_refresh",
    "relogin_persistence",
    "stale_recovery",
    "advisor_transition",
    "founder_read_only",
    "contractor_redaction",
    "denied_roles",
    "browser_log_safety",
  ]) assert.match(browser, new RegExp(contract));
  assert.match(browser, /uncertain_retry_same_key/);
  assert.match(browser, /changed_command_new_key/);
  assert.match(browser, /synchronous_double_post_count/);
  assert.match(browser, /horizontal_overflow/);
  assert.match(browser, /out_of_bounds_controls/);
  assert.match(browser, /overlapping_controls/);
  assert.match(browser, /clipped_text/);
  assert.match(browser, /cleanup\.context_closed/);
  assert.match(browser, /cleanup\.container_removed/);
  assert.doesNotMatch(browser, /console\.(?:log|error)|context\.addCookies|localStorage|sessionStorage/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}
