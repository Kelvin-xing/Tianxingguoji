import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const formPath = new URL("../../../components/crm/StudentCreateForm.tsx", import.meta.url);
const directoryPath = new URL("../../../components/crm/StudentsDirectory.tsx", import.meta.url);

test("creation entry and page obey only the students.create capability", async () => {
  const [form, directory] = await Promise.all([
    readFile(formPath, "utf8"),
    readFile(directoryPath, "utf8"),
  ]);
  assert.match(form, /capability\) => String\(capability\) === 'students\.create'/);
  assert.match(directory, /capability\) => String\(capability\) === 'students\.create'/);
  assert.doesNotMatch(form, /access\.role|role === ['"](?:founder|advisor|admin)/);
  assert.doesNotMatch(directory, /access\.role|role === ['"](?:founder|advisor|admin)/);
  assert.doesNotMatch(form, /服務端仍會獨立驗證每次保存/);
});

test("relationship is a fixed native select and no identity or authorization fields are submitted", async () => {
  const source = await readFile(formPath, "utf8");
  const relationship = source.match(/<select id="guardian-relationship-type"[\s\S]*?<\/select>/)?.[0];
  assert.ok(relationship);
  assert.deepEqual(
    [...relationship.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]),
    ["father", "mother", "other_guardian"],
  );
  assert.doesNotMatch(source, /name="(?:student_id|guardian_id|organization_id|actor|role|is_primary_contact)"/);
});

test("form protects duplicate submits and does not persist or log private fields", async () => {
  const source = await readFile(formPath, "utf8");
  assert.match(source, /const submissionLocked = useRef\(false\)/);
  assert.match(source, /if \(submissionLocked\.current \|\| accessState !== 'allowed'\) return/);
  assert.match(source, /submissionLocked\.current = true/);
  assert.match(source, /disabled=\{pending\}/);
  assert.match(source, /aria-busy=\{pending\}/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|JSON\.stringify\(draft/);
});

test("form exposes required, contact validation, success and retry-safe unavailable states", async () => {
  const source = await readFile(formPath, "utf8");
  assert.match(source, /validateStudentCreateDraft\(draft\)/);
  assert.match(source, /電郵和電話至少填寫一項/);
  assert.match(source, /學生與主要監護人已建立/);
  assert.match(source, /重試不會重複建立資料/);
  assert.match(source, /router\.push\(`\/students\/\$\{result\.student\.id\}`\)/);
});
