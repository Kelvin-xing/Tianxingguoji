import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

test("Case detail embeds CandidateList workspace with authoritative Case facts", async () => {
  const page = await source("app/(erp)/cases/[caseId]/page.tsx");
  assert.match(page, /<CandidateListWorkspace/);
  assert.match(page, /initialCaseRecordVersion=\{record\.recordVersion\}/);
  assert.match(page, /initialCaseStage=\{record\.stage\}/);
  assert.match(page, /initialWorkflowStatus=\{record\.workflowStatus\}/);
  assert.match(page, /selectionReady=\{assessment\.status === 'background_complete'/);
  assert.doesNotMatch(page, /mockCandidate|previewCandidate/);
});

test("CandidateList workspace reads all frozen inputs and reloads after every command", async () => {
  const workspace = await source("components/cases/CandidateListWorkspace.tsx");
  for (const operation of [
    "listCandidateLists",
    "listCandidateSchoolOptions",
    "getGuardianConfirmationOptions",
    "createCandidateList",
    "reviewCandidateList",
    "recordGuardianCandidateListDecision",
  ]) {
    assert.match(workspace, new RegExp(`\\b${operation}\\b`));
  }
  assert.match(workspace, /const authoritative = await listCandidateLists\(caseId\)/);
  assert.match(workspace, /saved\.record_version !== receipt\.record_version/);
  assert.match(workspace, /router\.refresh\(\)/);
  assert.match(workspace, /CandidateListIdempotencyAttempt/);
  assert.doesNotMatch(workspace, /\bfetch\(|localStorage|sessionStorage/);
});

test("CandidateList workspace exposes bounded states, fields and accessible controls", async () => {
  const workspace = await source("components/cases/CandidateListWorkspace.tsx");
  for (const copy of [
    "正在載入候選學校名單",
    "候選學校名單為唯讀",
    "候選學校名單暫時不可用",
    "尚未建立候選名單",
    "建立新版本",
    "Founder 審核",
    "家長確認",
  ]) {
    assert.ok(workspace.includes(copy), `missing ${copy}`);
  }
  assert.match(workspace, /maxLength=\{1000\}/);
  assert.match(workspace, /selectedSchoolIds\.length >= 50/);
  assert.match(workspace, /type="datetime-local"/);
  assert.match(workspace, /application_deadline: new Date\(applicationDeadlines\[school\.school_id\]!\)\.toISOString\(\)/);
  assert.match(workspace, /已逾期風險/);
  assert.match(workspace, /未記錄（歷史版本）/);
  assert.match(workspace, /確認已儲存，申請任務待自動恢復/);
  assert.match(workspace, /已自動建立 \$\{receipt\.automation\.provisioned_count\} 項申請任務/);
  assert.match(workspace, /max=\{toLocalDateTime\(new Date\(\)\)\}/);
  assert.match(workspace, /role="group" aria-label="候選學校"/);
  assert.match(workspace, /grid grid-cols-1 md:grid-cols-2/);
  assert.doesNotMatch(workspace, /Guardian.*登入|guardian.*login/i);
});

test("CandidateList client enforces exact DTO keys and command route contracts", async () => {
  const client = await source("components/cases/candidate-list-client.ts");
  assert.match(client, /exactRecord\(value, \["items"\]\)/);
  assert.match(client, /guardian-confirmation-options/);
  assert.match(client, /schools\/options\?limit=100/);
  assert.match(client, /candidate-lists\/\$\{versionId\}\/review/);
  assert.match(client, /candidate-lists\/\$\{versionId\}\/guardian-decision/);
  assert.match(client, /expected_case_record_version/);
  assert.match(client, /expected_list_record_version/);
  assert.match(client, /bound_founder_decision_sha256/);
  assert.match(client, /application_deadline/);
  assert.match(client, /application_tasks/);
  assert.match(client, /requested_count/);
  assert.match(client, /provisioned_count/);
  assert.doesNotMatch(client, /email|phone_number|token|secret/i);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}
