import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('audit workspace uses the server audit scope and cursor contract', async () => {
  const client = await readFile('components/audit/f7-client.ts', 'utf8')
  const workspace = await readFile('components/audit/AuditWorkspace.tsx', 'utf8')
  const page = await readFile('app/(erp)/audit/page.tsx', 'utf8')

  assert.match(client, /\/api\/v1\/audit\/events/)
  assert.match(client, /scope/)
  assert.match(client, /before/)
  assert.match(client, /metadata/)
  assert.match(workspace, /role === 'founder'/)
  assert.match(workspace, /載入更早記錄/)
  assert.match(workspace, /AuditTable/)
  assert.match(page, /AuditWorkspace/)
})
