import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('P4 notifications use recipient DTO, allowed actions and stable minimal copy', async () => {
  const client = await readFile(new URL('../../../components/notifications/f4-client.ts', import.meta.url), 'utf8')
  const workspace = await readFile(new URL('../../../components/notifications/NotificationsWorkspace.tsx', import.meta.url), 'utf8')
  const topbar = await readFile(new URL('../../../components/layout/TopBar.tsx', import.meta.url), 'utf8')
  assert.match(client, /unread-count/)
  assert.match(client, /resolve-target/)
  assert.match(workspace, /allowed_actions/)
  assert.match(workspace, /有待办事项需要处理/)
  assert.match(workspace, /StaleState/)
  assert.match(topbar, /unreadCount/)
  assert.doesNotMatch(workspace, /window\.fetch|sendEmail|sendSms|portalGrant/i)
})
