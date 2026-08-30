import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../../', import.meta.url)

test('portal FE-06 stays read-only, isolated, and capability/DTO driven', async () => {
  const access = await readFile(new URL('app/(portal)/portal/access/page.tsx', root), 'utf8')
  const internalAccess = await readFile(new URL('app/(erp)/cases/[caseId]/access/page.tsx', root), 'utf8')
  const workspace = await readFile(new URL('app/(portal)/portal/workspace/page.tsx', root), 'utf8')
  const client = await readFile(new URL('components/portal/f5-client.ts', root), 'utf8')
  const source = `${access}\n${workspace}\n${client}`
  assert.match(source, /requestApi/)
  assert.match(source, /paused|closed|revoked|expired|unavailable/)
  assert.match(source, /allowed_actions/)
  assert.doesNotMatch(source, /actor\.role|billing|internal notification|upload/i)
  assert.doesNotMatch(source, /case_number|case number|contact|guardian_email/i)
  assert.match(client, /api\/v1\/portal\/(sessions|workspace)/)
  assert.match(client, /idempotencyKey:\s*crypto\.randomUUID\(\)/)
  assert.match(access, /minLength=\{64\}/)
  assert.match(access, /maxLength=\{512\}/)
  assert.match(internalAccess, /guardian-confirmation-options|guardian_relationship_id/)
  assert.match(internalAccess, /portal-viewers/)
  assert.doesNotMatch(internalAccess, /name="expires"|form\.get\(['"]expires['"]\)/)
})
