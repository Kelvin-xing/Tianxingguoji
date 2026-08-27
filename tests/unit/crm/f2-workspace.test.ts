import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('FE-02 CRM intake uses frozen transport and never auto-associates duplicates', async () => {
  const intake = await readFile(new URL('../../../components/crm/StudentIntake.tsx', import.meta.url), 'utf8')
  const contract = await readFile(new URL('../../../components/crm/f2-contract.ts', import.meta.url), 'utf8')
  assert.match(contract, /\/api\/v1\/crm\/potential-duplicates/)
  assert.match(contract, /\/api\/v1\/students/)
  assert.match(intake, /warning_token/)
  assert.match(intake, /不会自动关联|不会自动关联/)
  assert.match(intake, /confirmed independent|确认仍为独立记录|确认独立建档/)
  assert.doesNotMatch(intake, /automaticMerge|mergeCandidates/i)
})

test('FE-02 case intake carries Advisor, referral source and signed_at, not a client manifest', async () => {
  const intake = await readFile(new URL('../../../components/crm/CaseIntakeWorkspace.tsx', import.meta.url), 'utf8')
  const contract = await readFile(new URL('../../../components/crm/f2-contract.ts', import.meta.url), 'utf8')
  assert.match(contract, /\/api\/v1\/cases\/intake-options/)
  assert.match(intake, /primary_advisor_role_binding_id/)
  assert.match(intake, /referral_source_id/)
  assert.match(intake, /signed_at/)
  assert.match(intake, /background_collection/)
  assert.doesNotMatch(intake, /manifest_id|ManifestStep/)
})

test('FE-02 uses shared typed client and unavailable states for missing APIs', async () => {
  const students = await readFile(new URL('../../../app/(erp)/students/page.tsx', import.meta.url), 'utf8')
  const cases = await readFile(new URL('../../../app/(erp)/cases/new/page.tsx', import.meta.url), 'utf8')
  const caseDetail = await readFile(new URL('../../../app/(erp)/cases/[caseId]/page.tsx', import.meta.url), 'utf8')
  const assessment = await readFile(new URL('../../../components/cases/AssessmentEditor.tsx', import.meta.url), 'utf8')
  assert.match(students, /listStudents/)
  assert.match(cases, /CaseIntakeWorkspace/)
  assert.match(assessment, /requestApi/)
  assert.match(assessment, /blockingFieldIds/)
  assert.match(caseDetail, /initialAvailableWorkflowActions/)
  assert.doesNotMatch(caseDetail, /actor\.role/)
  assert.doesNotMatch(cases, /preview|mock/i)
})
