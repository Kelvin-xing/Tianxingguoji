import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('P4 Documents uses typed metadata/upload client and never treats non-clean as downloadable', async () => {
  const workspace = await readFile(new URL('../../../components/documents/DocumentWorkspace.tsx', import.meta.url), 'utf8')
  const client = await readFile(new URL('../../../components/documents/f4-client.ts', import.meta.url), 'utf8')
  assert.match(client, /\/api\/v1\/documents/)
  assert.match(client, /upload-intents/)
  assert.match(workspace, /allowed_actions/)
  assert.match(workspace, /available.*clean.*active/)
  assert.match(workspace, /UnavailableState/)
  assert.doesNotMatch(workspace, /previewCaseWorkspaceAdapter|preview\.url|objectStore\.get/i)
})

test('P4 Case Documents route remains independent from Portal/Contractor', async () => {
  const route = await readFile(new URL('../../../app/(erp)/cases/[caseId]/documents/page.tsx', import.meta.url), 'utf8')
  assert.match(route, /DocumentWorkspace/)
  assert.doesNotMatch(route, /portal|contractor/i)
})
