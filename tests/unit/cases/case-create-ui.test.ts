import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

test("case directory keeps intake entry separate from case management", async () => {
  const [form, directory] = await Promise.all([
    source("components/crm/CaseIntakeWorkspace.tsx"),
    source("app/(erp)/cases/page.tsx"),
  ]);
  assert.match(form, /listIntakeOptions\(\)/);
  assert.match(form, /createK12Case\(/);
  assert.match(directory, /<Link href="\/cases\/new"/);
  assert.doesNotMatch(directory, /<Metric /);
});

test("case pages use the module client without direct fetch or response assertions", async () => {
  const files = await Promise.all([
    source("components/crm/CaseIntakeWorkspace.tsx"),
    source("app/(erp)/cases/new/page.tsx"),
    source("app/(erp)/cases/page.tsx"),
  ]);
  assert.equal(files.every((content) => !/\bfetch\(|response\.json\(/.test(content)), true);
  assert.match(files[0]!, /listIntakeOptions\(\)/);
  assert.match(files[0]!, /createK12Case\(/);
  assert.match(files[1]!, /<CaseIntakeWorkspace/);
  assert.match(files[2]!, /listCases\(\)/);
});

test("case directory uses a searchable status and stage filter instead of summary cards", async () => {
  const directory = await source("app/(erp)/cases/page.tsx");
  assert.match(directory, /type CaseStatusFilter = 'all' \| 'active' \| 'closed'/);
  assert.match(directory, /aria-label="案件狀態"/);
  assert.match(directory, /aria-label="案件階段"/);
  assert.match(directory, /共 \{caseRecords\.length\} 宗案件/);
  assert.doesNotMatch(directory, /<Metric /);
  assert.match(directory, /\{caseStageLabels\[item\.stage\]\}/);
  assert.match(directory, /application_in_progress: '申請處理中'/);
  assert.match(directory, />主要顧問</);
  assert.match(directory, /\{formatDate\(item\.updatedAt\)\}/);
});

test("case create has a synchronous lock, retry-safe key lifecycle and authoritative redirect", async () => {
  const form = await source("components/cases/CaseCreateForm.tsx");
  assert.match(form, /const submissionLocked = useRef\(false\)/);
  assert.match(form, /if \(submissionLocked\.current \|\| accessState !== 'allowed'\) return/);
  assert.match(form, /submissionLocked\.current = true/);
  assert.match(form, /finally \{[\s\S]*submissionLocked\.current = false/);
  assert.match(form, /attempt\.current\.keyForSubmission\(\)/);
  assert.match(form, /attempt\.current\.markBusinessFieldChanged\(\)/);
  assert.match(form, /const receipt = await createExistingStudentCase/);
  assert.match(form, /const authoritative = await getCase\(receipt\.id\)/);
  assert.match(form, /authoritative\.id !== receipt\.id/);
  assert.match(form, /authoritative\.recordVersion !== receipt\.record_version/);
  assert.match(form, /authoritative\.stage !== 'background_collection'/);
  assert.match(form, /authoritative\.workflowStatus !== 'active'/);
  assert.match(form, /router\.push\(`\/cases\/\$\{authoritative\.id\}`\)/);
  assert.match(form, /router\.refresh\(\)/);
  assert.match(form, /disabled=\{pending\}/);
  assert.match(form, /aria-busy=\{pending\}/);
});

test("case create exposes accessible controls and complete bounded states", async () => {
  const form = await source("components/cases/CaseCreateForm.tsx");
  for (const [label, id] of [
    ["學生", "case-student"],
    ["入學年度", "case-intake-year"],
    ["申請類型", "case-admission-type"],
    ["主要顧問", "case-primary-binding"],
    ["評估表版本", "case-manifest"],
  ]) {
    assert.match(form, new RegExp(`<Field label=["']${label}["'] id=["']${id}["']`));
  }
  assert.match(form, /<label htmlFor=\{id\}>/);
  assert.match(form, /正在載入案件選項/);
  assert.match(form, /工作階段已失效/);
  assert.match(form, /無法建立案件/);
  assert.match(form, /案件服務暫時不可用/);
  assert.match(form, /部分資料未通過檢查/);
  assert.match(form, /已有相同入學設定的進行中案件/);
  assert.match(form, /案件已建立，正在開啟案件詳情/);
  assert.match(form, /重試不會重複建立案件/);
});

test("case UI does not display identifiers or leak implementation and request details", async () => {
  const directory = await source("app/(erp)/cases/page.tsx");
  assert.doesNotMatch(directory, /PostgreSQL|Neon|synthetic|UUID|database constraint|organization-scoped|localStorage|sessionStorage|console\./i);
  assert.doesNotMatch(directory, /JSON\.stringify\(|idempotency-key/i);
  assert.doesNotMatch(directory, /\{item\.studentId\}<\/div>/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}
