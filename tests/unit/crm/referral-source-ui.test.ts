import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../../', import.meta.url)

test('ReferralSource routes and entry are capability-only', async () => {
  const [directory, detail, students, listPage, detailPage] = await Promise.all([
    source('components/crm/ReferralSourcesDirectory.tsx'),
    source('components/crm/ReferralSourceDetail.tsx'),
    source('components/crm/StudentsDirectory.tsx'),
    source('app/(erp)/referral-sources/page.tsx'),
    source('app/(erp)/referral-sources/[sourceId]/page.tsx'),
  ])
  assert.match(directory, /referral_sources\.read/)
  assert.match(directory, /referral_sources\.manage/)
  assert.match(detail, /referral_sources\.read/)
  assert.match(detail, /referral_sources\.manage/)
  assert.match(students, /referral_sources\.read/)
  assert.match(students, /href="\/referral-sources"/)
  assert.match(listPage, /ReferralSourcesDirectory/)
  assert.match(detailPage, /ReferralSourceDetail/)
  for (const content of [directory, detail, students]) {
    assert.doesNotMatch(content, /access\.role|role === ['"](?:founder|admin|advisor|data_reviewer|contractor)/)
  }
})

test('source management uses fixed types and excludes partner identity and destructive controls', async () => {
  const [directory, detail] = await Promise.all([
    source('components/crm/ReferralSourcesDirectory.tsx'),
    source('components/crm/ReferralSourceDetail.tsx'),
  ])
  assert.match(directory, /REFERRAL_SOURCE_TYPES\.map/)
  assert.match(detail, /來源類型建立後不能更改/)
  assert.match(detail, /不能重新啟用/)
  assert.doesNotMatch(`${directory}\n${detail}`, /type=["']email|type=["']tel|account_number|partner_user|method:\s*['"]DELETE|>重新啟用</)
})

test('source writes use a synchronous lock, idempotent attempt and authoritative detail/list refresh', async () => {
  const [directory, detail] = await Promise.all([
    source('components/crm/ReferralSourcesDirectory.tsx'),
    source('components/crm/ReferralSourceDetail.tsx'),
  ])
  assert.match(directory, /if \(submitting\.current \|\| saving \|\| !canManage\) return/)
  assert.match(directory, /submitting\.current = true/)
  assert.match(directory, /attempt\.current!\.keyFor\(fingerprint\)/)
  assert.match(directory, /await getReferralSource\(receipt\.id\)/)
  assert.match(directory, /await listReferralSources/)
  assert.match(detail, /if \(inFlight\.current \|\| saving/)
  assert.match(detail, /await getReferralSource\(source\.id\)/)
  assert.match(detail, /authoritative\.record_version !== receipt\.record_version/)
  for (const content of [directory, detail]) {
    assert.doesNotMatch(content, /localStorage|sessionStorage|console\.|fetch\(/)
  }
})

test('source UI distinguishes lifecycle, access, conflict and recovery states', async () => {
  const [directory, detail] = await Promise.all([
    source('components/crm/ReferralSourcesDirectory.tsx'),
    source('components/crm/ReferralSourceDetail.tsx'),
  ])
  for (const state of ['loading', 'ready', 'unauthenticated', 'denied', 'unavailable']) assert.match(directory, new RegExp(`['"]${state}['"]`))
  for (const notice of ['success', 'validation', 'stale', 'conflict', 'denied', 'unavailable']) assert.match(detail, new RegExp(`['"]${notice}['"]`))
  assert.match(directory, /目前沒有推薦來源/)
  assert.match(detail, /已停用/)
  assert.match(detail, /role=\{success \? 'status' : 'alert'\}/)
})

test('permanent Local Dev browser gate is registered without remote environment access', async () => {
  const [browser, packageJson] = await Promise.all([
    source('tests/integration/crm-06-referral-source-case-link-dev-browser.test.ts'),
    source('package.json'),
  ])
  for (const stage of [
    'source_idempotency', 'source_inactivate', 'assignment_idempotency',
    'assignment_replace', 'assignment_stale', 'assignment_persistence',
    'advisor_read_assign', 'admin_manage_no_case', 'denied_roles',
    'desktop_viewport', 'mobile_viewport', 'browser_log_safety', 'cleanup',
  ]) assert.match(browser, new RegExp(`['"]${stage}['"]`))
  assert.match(browser, /postgres:17\.10-alpine3\.24/)
  assert.match(browser, /--pull=never/)
  assert.match(browser, /playwright-core/)
  assert.match(packageJson, /"test:crm-06-dev-browser"/)
  assert.doesNotMatch(browser, /neon\.tech|vercel\.app|amazonaws\.com/)
})

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8')
}
