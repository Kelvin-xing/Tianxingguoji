import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

test("case list and create entry obey only cases.read and cases.create capabilities", async () => {
  const [form, directory] = await Promise.all([
    source("components/cases/CaseCreateForm.tsx"),
    source("app/(erp)/cases/page.tsx"),
  ]);
  assert.match(form, /access\.capabilities\.includes\('cases\.read'\)/);
  assert.match(form, /String\(capability\) === 'cases\.create'/);
  assert.match(directory, /access\.capabilities\.includes\('cases\.read'\)/);
  assert.match(directory, /String\(capability\) === 'cases\.create'/);
  assert.doesNotMatch(form, /access\.role|role === ['"](?:founder|advisor|admin)/);
  assert.doesNotMatch(directory, /access\.role|role === ['"](?:founder|advisor|admin)/);
  assert.match(directory, /loadState === 'ready' && canCreate \? <Link href="\/cases\/new"/);
  assert.match(form, /服務端仍會獨立驗證每次保存/);
});

test("case pages use the module client without direct fetch or response assertions", async () => {
  const files = await Promise.all([
    source("components/cases/CaseCreateForm.tsx"),
    source("app/(erp)/cases/new/page.tsx"),
    source("app/(erp)/cases/page.tsx"),
  ]);
  assert.equal(files.every((content) => !/\bfetch\(|response\.json\(/.test(content)), true);
  assert.match(files[0]!, /listCaseWorkspaceOptions\(controller\.signal\)/);
  assert.match(files[0]!, /createExistingStudentCase\(\{/);
  assert.match(files[1]!, /<CaseCreateForm/);
  assert.match(files[2]!, /listCases\(controller\.signal\)/);
});

test("case directory separates the desktop table from a complete mobile case list", async () => {
  const directory = await source("app/(erp)/cases/page.tsx");
  assert.match(directory, /className="hidden md:block overflow-x-auto -mx-5"/);
  assert.match(directory, /className="md:hidden divide-y" role="list"/);
  assert.match(directory, /<CaseMobileItem key=\{item\.id\} item=\{item\} \/>/);
  assert.match(directory, /<th className="hidden sm:table-cell" \/>/);
  assert.match(directory, /<td className="hidden sm:table-cell"><Link href=\{`\/cases\/\$\{item\.id\}`\}/);
  assert.match(directory, /<td><Link href=\{`\/cases\/\$\{item\.id\}`\} className="table-primary">\{item\.caseNumber\}<\/Link>/);
  assert.match(directory, /function CaseMobileItem/);
  assert.match(directory, /<Link href=\{`\/cases\/\$\{item\.id\}`\} className="table-primary break-words">\{item\.caseNumber\}<\/Link>/);
  assert.match(directory, /<Link href=\{`\/students\/\$\{item\.studentId\}`\} className="table-primary break-words">\{item\.studentName\}<\/Link>/);
  assert.match(directory, /\{caseStageLabels\[item\.stage\]\}/);
  assert.match(directory, /item\.primaryRole === 'advisor' \? '顧問' : '創辦人'/);
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
  assert.match(form, /router\.push\(`\/cases\/\$\{created\.id\}`\)/);
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
    ["主要負責人", "case-primary-binding"],
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
  const [form, directory] = await Promise.all([
    source("components/cases/CaseCreateForm.tsx"),
    source("app/(erp)/cases/page.tsx"),
  ]);
  for (const content of [form, directory]) {
    assert.doesNotMatch(content, /PostgreSQL|Neon|synthetic|UUID|database constraint|organization-scoped|localStorage|sessionStorage|console\./i);
    assert.doesNotMatch(content, /JSON\.stringify\(|idempotency-key/i);
  }
  assert.doesNotMatch(directory, /\{item\.studentId\}<\/div>/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}
