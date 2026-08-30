import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('FE-02 CRM intake uses frozen transport and never auto-associates duplicates', async () => {
  const intake = await readFile(new URL('../../../components/crm/StudentIntake.tsx', import.meta.url), 'utf8')
  const contract = await readFile(new URL('../../../components/crm/f2-contract.ts', import.meta.url), 'utf8')
  assert.match(contract, /\/api\/v1\/crm\/potential-duplicates/)
  assert.match(contract, /\/api\/v1\/students/)
  assert.match(intake, /warning_token/)
  assert.match(intake, /不會自動關聯/)
  assert.match(intake, /確認建立獨立資料/)
  assert.doesNotMatch(intake, /automaticMerge|mergeCandidates/i)
})

test('FE-02 case intake carries Advisor, referral source and signed_at, not a client manifest', async () => {
  const intake = await readFile(new URL('../../../components/crm/CaseIntakeWorkspace.tsx', import.meta.url), 'utf8')
  const contract = await readFile(new URL('../../../components/crm/f2-contract.ts', import.meta.url), 'utf8')
  assert.match(contract, /\/api\/v1\/cases\/intake-options/)
  assert.match(intake, /primary_advisor_role_binding_id/)
  assert.match(intake, /referral_source_id/)
  assert.match(intake, /signed_at/)
  assert.match(intake, /signedAtInput\.current\?\.value/)
  assert.match(intake, /onBlur=\{\(event\) => setSignedAt\(event\.currentTarget\.value\)\}/)
  assert.match(intake, /選擇學生/)
  assert.doesNotMatch(intake, /background_collection/)
  assert.doesNotMatch(intake, /manifest_id|ManifestStep/)
})

test('FE-02 uses shared typed client and unavailable states for missing APIs', async () => {
  const students = await readFile(new URL('../../../app/(erp)/students/page.tsx', import.meta.url), 'utf8')
  const cases = await readFile(new URL('../../../app/(erp)/cases/new/page.tsx', import.meta.url), 'utf8')
  const caseDetail = await readFile(new URL('../../../app/(erp)/cases/[caseId]/page.tsx', import.meta.url), 'utf8')
  const assessment = await readFile(new URL('../../../components/cases/AssessmentEditor.tsx', import.meta.url), 'utf8')
  assert.match(students, /listStudents/)
  assert.doesNotMatch(students, /\{student\.id\}<\/div>/)
  assert.match(cases, /CaseIntakeWorkspace/)
  assert.match(assessment, /requestApi/)
  assert.match(assessment, /blockingFieldIds/)
  assert.match(assessment, /answer\.semantic_state === "provided"/)
  assert.match(assessment, /payload\.id !== view\.assessment_id/)
  assert.doesNotMatch(assessment, /payload\.status !== "background_complete"/)
  assert.match(caseDetail, /initialAvailableWorkflowActions/)
  assert.match(await readFile(new URL('../../../components/crm/CaseIntakeWorkspace.tsx', import.meta.url), 'utf8'), /DeniedState/)
  assert.match(await readFile(new URL('../../../components/crm/CaseIntakeWorkspace.tsx', import.meta.url), 'utf8'), /FORBIDDEN/)
  assert.doesNotMatch(caseDetail, /actor\.role/)
  assert.doesNotMatch(cases, /preview|mock/i)
})
