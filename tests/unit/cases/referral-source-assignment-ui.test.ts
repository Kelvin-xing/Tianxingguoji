import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../../', import.meta.url)

test('Case referral source panel is mounted and assignment controls are capability-only', async () => {
  const [panel, page] = await Promise.all([
    source('components/cases/CaseReferralSourcePanel.tsx'),
    source('app/(erp)/cases/[caseId]/page.tsx'),
  ])
  assert.match(page, /<CaseReferralSourcePanel caseId=\{caseId\} \/>/)
  assert.match(panel, /cases\.referral_sources\.assign/)
  assert.doesNotMatch(panel, /access\.role|role === ['"](?:founder|admin|advisor|data_reviewer|contractor)/)
})

test('assignment selection is active-only, explicit and preserves snapshot history language', async () => {
  const panel = await source('components/cases/CaseReferralSourcePanel.tsx')
  assert.match(panel, /listReferralSources\('active'/)
  assert.match(panel, /我確認更換目前來源/)
  assert.match(panel, /原關聯會轉入歷史，不會被覆寫或刪除/)
  assert.match(panel, /來源版本 \{assignment\.source_record_version\}/)
  assert.match(panel, /assignment\.source_display_name/)
  assert.match(panel, /assignment\.source_type/)
  assert.match(panel, /assignment\.starts_at/)
  assert.match(panel, /assignment\.ends_at/)
})

test('assignment mutation uses sync lock, key lifecycle and authoritative GET', async () => {
  const panel = await source('components/cases/CaseReferralSourcePanel.tsx')
  assert.match(panel, /if \(inFlight\.current \|\| saving \|\| !canAssign/)
  assert.match(panel, /inFlight\.current = true/)
  assert.match(panel, /attempt\.current!\.keyFor\(caseReferralSourceFingerprint/)
  assert.match(panel, /const authoritative = await getCaseReferralSourceAssignments\(caseId\)/)
  assert.match(panel, /authoritative\.current\?\.id !== receipt\.id/)
  assert.match(panel, /finally \{[\s\S]*?inFlight\.current = false/)
  assert.doesNotMatch(panel, /localStorage|sessionStorage|console\.|fetch\(/)
})

test('assignment panel distinguishes empty, read-only, stale, conflict and unavailable states', async () => {
  const panel = await source('components/cases/CaseReferralSourcePanel.tsx')
  for (const state of ['loading', 'ready', 'unauthenticated', 'denied', 'unavailable', 'success', 'validation', 'stale', 'conflict']) assert.match(panel, new RegExp(`['"]${state}['"]`))
  assert.match(panel, /尚未設定推薦來源/)
  assert.match(panel, /目前沒有可用的推薦來源/)
  assert.match(panel, /你可以查看案件來源與歷史，但目前不能變更來源/)
  assert.match(panel, /role=\{success \? 'status' : 'alert'\}/)
})

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8')
}
