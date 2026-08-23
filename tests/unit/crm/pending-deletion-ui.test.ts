import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../../', import.meta.url)

test('request and review entries use capabilities only', async () => {
  const [detail, directory, queue] = await Promise.all([
    source('components/crm/StudentDetailView.tsx'),
    source('components/crm/StudentsDirectory.tsx'),
    source('components/crm/DeletionRequestsQueue.tsx'),
  ])
  assert.match(detail, /students\.deletion\.request/)
  assert.match(directory, /students\.deletion\.review/)
  assert.match(directory, /href="\/students\/deletion-requests"/)
  assert.match(queue, /students\.deletion\.review/)
  for (const content of [detail, directory, queue]) {
    assert.doesNotMatch(content, /access\.role|role === ['"](?:founder|advisor|admin|data_reviewer|contractor)/)
  }
  assert.ok(queue.indexOf('await getWorkspaceAccessSnapshot') < queue.indexOf('await listPendingDeletionRequests'))
})

test('confirmation is explicitly non-destructive and has no free-text reason', async () => {
  const control = await source('components/crm/PendingDeletionRequestControl.tsx')
  assert.match(control, /申請待刪除審查/)
  assert.match(control, /不會刪除這筆資料或既有歷史/)
  assert.match(control, /type="checkbox"/)
  assert.match(control, /確認送交審查/)
  assert.doesNotMatch(control, /textarea|name=["']reason|自由輸入|purge|restore|cancel deletion/i)
})

test('pending Student and Guardian status hide related write commands after authoritative reads', async () => {
  const [detail, relationships] = await Promise.all([
    source('components/crm/StudentDetailView.tsx'),
    source('components/crm/GuardianRelationshipPanel.tsx'),
  ])
  assert.match(detail, /const active = student\.status === 'active'/)
  assert.match(detail, /active && canCreateCases/)
  assert.match(detail, /active && canManageProfiles/)
  assert.match(detail, /active && canManageGuardians/)
  assert.match(detail, /const active = guardian\.status === 'active'/)
  assert.match(detail, /studentActive && active/)
  assert.match(detail, /待刪除審查/)
  assert.match(relationships, /getStudent\(studentId, controller\.signal\)/)
  assert.match(relationships, /panel\.studentStatus === "pending_delete"/)
  assert.match(relationships, /關聯監護人和交接主要聯絡人已受限制/)
})

test('queue exposes only the six safe lifecycle facts and no destructive claim', async () => {
  const queue = await source('components/crm/DeletionRequestsQueue.tsx')
  for (const field of ['entity_type', 'entity_id', 'display_label', 'status', 'deletion_requested_at', 'record_version']) {
    assert.match(queue, new RegExp(`item\\.${field}`))
  }
  assert.doesNotMatch(queue, /item\.(?:email|phone|date_of_birth|requester|reason|retention|legal_hold)/)
  assert.doesNotMatch(queue, /可刪除|可以刪除|永久刪除|恢復資料|取消申請/)
  assert.match(queue, /本頁不提供刪除或復原操作/)
  assert.match(queue, /<option value="all">全部<\/option>/)
  assert.match(queue, /<option value="student">學生<\/option>/)
  assert.match(queue, /<option value="guardian">監護人<\/option>/)
})

test('mutation uses a synchronous lock, uncertain retry key and authoritative refresh', async () => {
  const [control, client] = await Promise.all([
    source('components/crm/PendingDeletionRequestControl.tsx'),
    source('modules/crm/client.ts'),
  ])
  assert.match(control, /const submissionLock = useRef\(false\)/)
  assert.match(control, /if \(submissionLock\.current\) return/)
  assert.match(control, /submissionLock\.current = true/)
  assert.match(control, /finally \{[\s\S]*?submissionLock\.current = false/)
  assert.match(control, /attempt\.current\.keyFor\(fingerprint\)/)
  assert.match(control, /await onRequested\(\)/)
  assert.match(client, /reason_code: PENDING_DELETION_REASON_CODE/)
  assert.match(client, /"idempotency-key": idempotencyKey/)
  assert.doesNotMatch(control, /localStorage|sessionStorage|console\.|fetch\(/)
})

test('UI distinguishes loading, empty, denied, stale, conflict, pending and unavailable states', async () => {
  const [control, queue] = await Promise.all([
    source('components/crm/PendingDeletionRequestControl.tsx'),
    source('components/crm/DeletionRequestsQueue.tsx'),
  ])
  for (const state of ['submitting', 'validation', 'stale', 'conflict', 'denied', 'unauthenticated', 'unavailable']) {
    assert.match(control, new RegExp(`['"]${state}['"]`))
  }
  for (const state of ['loading', 'ready', 'unauthenticated', 'denied', 'unavailable']) {
    assert.match(queue, new RegExp(`['"]${state}['"]`))
  }
  assert.match(control, /role="alert"/)
  assert.match(control, /role="status"/)
  assert.match(queue, /目前沒有待刪除審查/)
})

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8')
}
