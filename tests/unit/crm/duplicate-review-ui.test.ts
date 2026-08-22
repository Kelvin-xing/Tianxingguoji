import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const queuePath = new URL('../../../components/crm/DuplicateCandidatesQueue.tsx', import.meta.url)
const reviewPath = new URL('../../../components/crm/DuplicateCandidateReview.tsx', import.meta.url)
const directoryPath = new URL('../../../components/crm/StudentsDirectory.tsx', import.meta.url)

test('duplicate review entry and commands use capabilities only', async () => {
  const [queue, review, directory] = await Promise.all([
    readFile(queuePath, 'utf8'),
    readFile(reviewPath, 'utf8'),
    readFile(directoryPath, 'utf8'),
  ])
  assert.match(directory, /students\.duplicates\.review/)
  assert.match(directory, /href="\/students\/duplicates"/)
  assert.match(queue, /students\.duplicates\.review/)
  assert.match(review, /students\.duplicates\.review/)
  assert.match(review, /students\.duplicates\.merge/)
  for (const source of [queue, review, directory]) {
    assert.doesNotMatch(source, /access\.role|role === ['"](?:founder|advisor|admin|data_reviewer|contractor)/)
  }
  assert.ok(queue.indexOf('await getWorkspaceAccessSnapshot') < queue.indexOf('await listDuplicateCandidates'))
  assert.ok(review.indexOf('await getWorkspaceAccessSnapshot') < review.indexOf('await getDuplicateCandidate'))
})

test('queue exposes only quiet review facts and never asserts identity or confidence', async () => {
  const source = await readFile(queuePath, 'utf8')
  assert.match(source, /candidate\.entity_type/)
  assert.match(source, /candidate\.left_record\.display_label/)
  assert.match(source, /candidate\.right_record\.display_label/)
  assert.match(source, /candidate\.matching_signals/)
  assert.match(source, /candidate\.record_version/)
  assert.doesNotMatch(source, /confidence|confidence score|置信度|信心分數|同一個人|同一个人/i)
  assert.doesNotMatch(source, /candidate\.(?:left_record|right_record)\.id\}/)
})

test('record selection is explicit, bounded and never stores or logs PII drafts', async () => {
  const source = await readFile(queuePath, 'utf8')
  assert.match(source, /minLength=\{2\}/)
  assert.match(source, /maxLength=\{100\}/)
  assert.match(source, /type="radio" name=\{`duplicate-record-/)
  assert.match(source, /不會自動選擇或合併/)
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|fetch\(/)
  assert.doesNotMatch(source, /Idempotency-Key|idempotency-key/)
})

test('review starts with no automatic canonical, source or field choice', async () => {
  const source = await readFile(reviewPath, 'utf8')
  assert.match(source, /useState\(''\)/)
  assert.match(source, /useState<Partial<Record<DuplicateSupportedField, string>>>\(\{\}\)/)
  assert.match(source, /checked=\{selected === record\.id\}/)
  assert.match(source, /checked=\{selected === profile\.id\}/)
  assert.match(source, /主要資料、來源資料和每個欄位都必須由你明確選擇/)
})

test('merge and correction preserve history, use synchronous locks and authoritative refresh', async () => {
  const source = await readFile(reviewPath, 'utf8')
  assert.match(source, /const mergeLock = useRef\(false\)/)
  assert.match(source, /const correctionLock = useRef\(false\)/)
  assert.match(source, /mergeLock\.current = true/)
  assert.match(source, /correctionLock\.current = true/)
  assert.match(source, /finally \{[\s\S]*?mergeLock\.current = false/)
  assert.match(source, /finally \{[\s\S]*?correctionLock\.current = false/)
  assert.ok((source.match(/await getDuplicateCandidate\(/g) ?? []).length >= 3)
  assert.match(source, /UUID、原始欄位和歷史紀錄都會保留/)
  assert.match(source, /不會刪除任何學生、監護人、關係或案件/)
  assert.match(source, /已更正/)
})

test('review distinguishes denied, stale, conflict, unavailable, success and corrected states', async () => {
  const source = await readFile(reviewPath, 'utf8')
  for (const state of ['loading', 'denied', 'stale', 'conflict', 'unavailable', 'success', 'corrected']) {
    assert.match(source, new RegExp(`['"]${state}['"]`))
  }
  assert.match(source, /role="alert"/)
  assert.match(source, /role="status"/)
  assert.match(source, /tabIndex=\{-1\}/)
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|fetch\(/)
})
