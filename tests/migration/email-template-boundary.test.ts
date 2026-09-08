import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const MIGRATION = new URL('../../db/migrations/202609080020_057_email_invitation_template.sql', import.meta.url)

test('057 stores only the current organization invitation template', async () => {
  const sql = await readFile(MIGRATION, 'utf8')
  assert.match(sql, /CREATE TABLE email_templates/)
  assert.match(sql, /PRIMARY KEY \(organization_id, template_kind\)/)
  assert.match(sql, /template_kind = 'internal_user_invitation'/)
  assert.match(sql, /subject_template text NOT NULL/)
  assert.match(sql, /body_text_template text NOT NULL/)
  assert.doesNotMatch(sql, /html_template|script_template|tracking_pixel/)
})

test('057 enforces versioning, tenant isolation and no delete privilege', async () => {
  const sql = await readFile(MIGRATION, 'utf8')
  assert.match(sql, /record_version <> OLD\.record_version \+ 1/)
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/)
  assert.match(sql, /current_setting\('app\.organization_id', true\)/)
  assert.match(sql, /email_templates_no_delete/)
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE email_templates TO tianxing_app/)
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE[^;]*email_templates/i)
})
