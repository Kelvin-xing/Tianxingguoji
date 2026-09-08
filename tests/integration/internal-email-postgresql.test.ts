import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { chromium, type Browser } from 'playwright-core'
import { Client } from 'pg'

import { EmailService } from '../../modules/email/application/service.ts'
import { DeterministicFakeEmailTransport } from '../../modules/email/infrastructure/deterministic-fake-transport.ts'
import { deriveInternalEmailVerifier, InternalEmailService, InternalEmailServiceError } from '../../modules/identity/application/internal-email.ts'
import { PostgresqlInternalEmailRepository } from '../../modules/identity/infrastructure/postgresql-internal-email-repository.ts'
import { closeAuthPoolForTests } from '../../modules/identity/infrastructure/postgresql-client.ts'
import { ONE_ROLE_CANONICAL_ROLE, verifyCommittedOneRoleBaseline } from '../../scripts/db/generate-one-role-baseline.ts'
import { NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS } from '../../scripts/db/neon-test-synthetic-fixture.ts'
import { createOneRoleBaselineClientConfig, executeOneRoleBaselineRun, inspectOneRoleBaselineDatabase, type OneRoleBaselineTarget } from '../../scripts/db/run-one-role-baseline.ts'
import { seedNeonTestRelease1 } from '../../scripts/db/seed-neon-test-release1.ts'

const POSTGRES_IMAGE = 'postgres:17.10-alpine3.24'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const FOUNDER = NEON_TEST_PRINCIPALS.find((principal) => principal.role === 'founder')!
const ADMIN = NEON_TEST_PRINCIPALS.find((principal) => principal.role === 'admin')!

test('Founder invitation, rotated link, activation and internal login work on PostgreSQL 17', { timeout: 180_000 }, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`
  const containerName = `tianxing-internal-email-pg17-${suffix}`
  const bootstrapPassword = randomBytes(32).toString('hex')
  const applicationPassword = randomBytes(32).toString('hex')
  let started = false
  let appDirectory: string | undefined
  let devServer: ChildProcess | undefined
  let browser: Browser | undefined
  const originalEnvironment = snapshotEnvironment()

  try {
    await runDocker(['image', 'inspect', POSTGRES_IMAGE], 'postgres_image_missing')
    await runDocker([
      'run', '--rm', '--detach', '--pull=never', '--name', containerName,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=512m',
      '--env', 'POSTGRES_DB=postgres', '--env', 'POSTGRES_USER=postgres',
      '--env', 'POSTGRES_PASSWORD', '--publish', '127.0.0.1::5432', POSTGRES_IMAGE,
    ], 'postgres_container_start', undefined, { ...process.env, POSTGRES_PASSWORD: bootstrapPassword })
    started = true
    await waitForPostgres(containerName)
    await runDocker([
      'exec', '--interactive', containerName, 'psql', '--set=ON_ERROR_STOP=1',
      '--username=postgres', '--dbname=postgres',
    ], 'postgres_database_bootstrap', [
      `CREATE ROLE ${ONE_ROLE_CANONICAL_ROLE} WITH LOGIN PASSWORD '${applicationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
      `CREATE DATABASE tianxing OWNER ${ONE_ROLE_CANONICAL_ROLE};`,
      '',
    ].join('\n'))

    const port = readLoopbackPort((await runDocker(['port', containerName, '5432/tcp'], 'postgres_port_inspection')).stdout)
    const target = localTarget(port, applicationPassword)
    const build = await verifyCommittedOneRoleBaseline()
    const baseline = await executeOneRoleBaselineRun({
      mode: 'apply', target, build,
      dependencies: {
        inspect: () => inspectWithNewClient(target),
        openExecutionConnection: async () => {
          const client = new Client(createOneRoleBaselineClientConfig(target))
          await client.connect()
          return Object.freeze({ client, close: () => client.end() })
        },
      },
    })
    assert.equal(baseline.status, 'pass')
    assert.equal((await seedNeonTestRelease1(target, 'apply')).status, 'pass')

    const founderPassword = 'ExistingFounder9!Password'
    const adminPassword = 'ExistingAdmin9!Password'
    await bootstrapExistingFounderCredential(target, port, bootstrapPassword, founderPassword)
    await bootstrapInternalCredential(port, bootstrapPassword, ADMIN.userId, adminPassword)

    configureInternalEmailEnvironment(target.connectionString)
    const transport = new DeterministicFakeEmailTransport()
    const repository = new PostgresqlInternalEmailRepository()
    const service = new InternalEmailService({
      repository,
      email: new EmailService({ resolve: async () => ({ transport, from: 'no-reply@tianxing.test.invalid' }) }, 'https://workspace.tianxing.test.invalid'),
    })
    const founderLogin = await service.createSession({ email: FOUNDER.email, password: founderPassword })
    assert.equal(founderLogin.actor.userId, FOUNDER.userId)
    assert.equal(founderLogin.actor.role, 'founder')
    await service.revokeSession({ cookieSecret: founderLogin.cookieSecret, reason: 'bootstrap_verified' })
    const created = await service.createFounderInvite({
      actor: { userId: FOUNDER.userId, organizationId: NEON_TEST_ORGANIZATION.id, roles: ['founder'] },
      normalizedEmail: 'invited-advisor@tianxing.test.invalid', role: 'advisor',
      employmentType: 'FULL_TIME', displayName: '待啟用', idempotencyKey: `invite-${suffix}`,
    })
    assert.equal(transport.messages.length, 1)
    const firstCredential = activationCredential(transport.messages[0]!.html)

    const resent = await service.resendFounderInvite({
      actor: { userId: FOUNDER.userId, organizationId: NEON_TEST_ORGANIZATION.id, roles: ['founder'] },
      inviteId: created.inviteId,
    })
    assert.equal(resent.targetUserId, created.targetUserId)
    assert.equal(transport.messages.length, 2)
    const currentCredential = activationCredential(transport.messages[1]!.html)
    assert.notEqual(currentCredential, firstCredential)
    await assert.rejects(
      service.activateInvite({ activationCredential: firstCredential, password: 'Synthetic9!Password', displayName: '邀請顧問' }),
      (error: unknown) => error instanceof InternalEmailServiceError && error.code === 'INVITE_NOT_FOUND',
    )

    const activated = await activateWithDiagnostics(service, currentCredential)
    assert.equal(activated.actor.userId, created.targetUserId)
    assert.equal(activated.actor.role, 'advisor')
    assert.equal((await service.requireSession({ cookieSecret: activated.cookieSecret, sensitiveAction: false })).userId, created.targetUserId)
    assert.equal((await repository.findCredential('invited-advisor@tianxing.test.invalid'))?.userId, created.targetUserId)

    await service.revokeSession({ cookieSecret: activated.cookieSecret, reason: 'integration_relogin' })
    const login = await service.createSession({ email: 'invited-advisor@tianxing.test.invalid', password: 'Synthetic9!Password' })
    assert.equal(login.actor.userId, created.targetUserId)
    assert.equal((await service.requireSession({ cookieSecret: login.cookieSecret, sensitiveAction: false })).role, 'advisor')

    assert.deepEqual(await inspectIdentity(target, created.targetUserId, created.inviteId), {
      userStatus: 'active', membershipStatus: 'active', role: 'advisor', inviteStatus: 'redeemed',
      credentialCount: 1, deliveryReceiptCount: 1, activeSessionCount: 1,
    })

    const browserInvitedEmail = `browser-invited-${suffix}@tianxing.test.invalid`
    const browserInvitedPassword = 'Browser9!Password'
    const browserInvitedNickname = '瀏覽器顧問'
    const browserInvite = await service.createFounderInvite({
      actor: { userId: FOUNDER.userId, organizationId: NEON_TEST_ORGANIZATION.id, roles: ['founder'] },
      normalizedEmail: browserInvitedEmail, role: 'advisor', employmentType: 'FULL_TIME',
      displayName: '待啟用', idempotencyKey: `browser-invite-${suffix}`,
    })
    assert.equal(transport.messages.length, 3)
    const browserCredential = activationCredential(transport.messages[2]!.html)

    appDirectory = await createIsolatedAppDirectory()
    const httpPort = await reserveLoopbackPort()
    const baseUrl = `http://localhost:${httpPort}`
    devServer = startNextDev(appDirectory, httpPort, target.connectionString, baseUrl)
    await waitForNextDev(baseUrl, devServer)
    const httpEvidence = await assertInternalEmailHttpFlow(baseUrl, FOUNDER.email, founderPassword, ADMIN.email, adminPassword, suffix)
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    await assertInternalUserBrowserFlow({
      baseUrl, browser, activationCredential: browserCredential,
      invitedEmail: browserInvitedEmail, invitedPassword: browserInvitedPassword,
      invitedNickname: browserInvitedNickname, founderEmail: FOUNDER.email,
      founderPassword, suffix,
    })
    assert.deepEqual(await inspectIdentity(target, browserInvite.targetUserId, browserInvite.inviteId), {
      userStatus: 'active', membershipStatus: 'active', role: 'admin', inviteStatus: 'redeemed',
      credentialCount: 1, deliveryReceiptCount: 1, activeSessionCount: 0,
    })
    await assertEmailAdministrationBrowserFlow(baseUrl, httpEvidence.adminCookie, browser)
    await inspectEmailSettings(target)
    await inspectEmailTemplate(target)
  } finally {
    await browser?.close().catch(() => undefined)
    await stopNextDev(devServer)
    if (appDirectory) await rm(appDirectory, { recursive: true, force: true })
    await closeAuthPoolForTests().catch(() => undefined)
    restoreEnvironment(originalEnvironment)
    if (started) await runDocker(['rm', '--force', containerName], 'postgres_container_cleanup')
  }
})

async function assertInternalUserBrowserFlow(input: Readonly<{
  baseUrl: string
  browser: Browser
  activationCredential: string
  invitedEmail: string
  invitedPassword: string
  invitedNickname: string
  founderEmail: string
  founderPassword: string
  suffix: string
}>): Promise<void> {
  const context = await input.browser.newContext({ baseURL: input.baseUrl, viewport: { width: 1440, height: 1000 } })
  try {
    const page = await context.newPage()
    const authResponses: string[] = []
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/v1/auth/me') authResponses.push(`${response.request().method()}:${response.status()}`)
    })
    await page.goto(`/login/activate#token=${encodeURIComponent(input.activationCredential)}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: '啟用公司帳戶', exact: true }).waitFor({ state: 'visible' })
    await page.getByLabel('暱稱', { exact: true }).fill(input.invitedNickname)
    await page.getByLabel('設定密碼', { exact: true }).fill(input.invitedPassword)
    await page.getByLabel('確認密碼', { exact: true }).fill(input.invitedPassword)
    await page.getByRole('button', { name: '啟用帳戶', exact: true }).click()
    await page.waitForURL('**/today')
    const sessionCookies = await context.cookies()
    const me = await page.request.get(`${input.baseUrl}/api/v1/auth/me`)
    const meText = await me.text()
    if (me.status() !== 200) {
      throw new Error(`activated_session_unavailable:${me.status()}:${sessionCookies.map(({ name, value }) => `${name}:${value.length}`).join(',')}:${meText.slice(0, 500)}`)
    }
    const profileLink = page.locator('a[href="/profile"]').first()
    try {
      await profileLink.waitFor({ state: 'visible' })
    } catch (error) {
      throw new Error(`activated_workspace_unavailable:${page.url()}:${authResponses.join(',')}:${(await page.locator('body').innerText()).slice(0, 500)}`, { cause: error })
    }

    await profileLink.click()
    await page.waitForURL('**/profile')
    await page.locator('h2.page-title').filter({ hasText: '個人資料' }).waitFor({ state: 'visible' })
    await page.getByText(input.invitedEmail, { exact: true }).waitFor({ state: 'visible' })
    const nickname = page.locator('input[maxlength="100"]')
    assert.equal(await nickname.inputValue(), input.invitedNickname)
    const updatedNickname = `${input.invitedNickname}更新`
    await nickname.fill(updatedNickname)
    await page.getByRole('button', { name: '儲存暱稱', exact: true }).click()
    await page.getByText('暱稱已儲存。', { exact: true }).waitFor({ state: 'visible' })

    await page.getByRole('link', { name: '登出', exact: true }).click()
    await page.waitForURL('**/login')
    await page.getByLabel('帳戶電郵', { exact: true }).fill(input.invitedEmail)
    await page.getByLabel('密碼', { exact: true }).fill(input.invitedPassword)
    await page.getByRole('button', { name: '登入工作台', exact: true }).click()
    await page.waitForURL('**/today')
    await page.locator('.sidebar-user-copy').getByText(updatedNickname, { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('link', { name: '登出', exact: true }).click()
    await page.waitForURL('**/login')

    await page.getByLabel('帳戶電郵', { exact: true }).fill(input.founderEmail)
    await page.getByLabel('密碼', { exact: true }).fill(input.founderPassword)
    await page.getByRole('button', { name: '登入工作台', exact: true }).click()
    await page.waitForURL('**/today')
    await page.goto('/admin/access', { waitUntil: 'domcontentloaded' })
    await page.locator('h2.page-title').filter({ hasText: '身份與權限' }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '邀請使用者', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '邀請使用者', exact: true })
    const pendingEmail = `browser-pending-${input.suffix}@tianxing.test.invalid`
    await dialog.getByLabel('公司電郵', { exact: true }).fill(pendingEmail)
    await dialog.getByLabel('暱稱（可稍後由對方設定）', { exact: true }).fill('瀏覽器待啟用')
    await dialog.getByRole('button', { name: '發送邀請', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const pendingRow = page.locator('tr').filter({ has: page.getByText(pendingEmail, { exact: true }) })
    await pendingRow.waitFor({ state: 'visible' })
    await pendingRow.getByRole('button', { name: '重發邀請', exact: true }).click()
    await page.getByText('邀請郵件已重新發送；先前的確認連結已失效。', { exact: true }).waitFor({ state: 'visible' })

    const activeRow = page.locator('tr').filter({ has: page.getByText(input.invitedEmail, { exact: true }) })
    await activeRow.getByRole('button', { name: `編輯 ${updatedNickname}`, exact: true }).click()
    const memberDialog = page.getByRole('dialog').filter({ has: page.getByText(input.invitedEmail, { exact: true }) })
    const roleCheckboxes = memberDialog.getByRole('checkbox')
    await roleCheckboxes.nth(1).check()
    await roleCheckboxes.nth(2).uncheck()
    await memberDialog.getByRole('button', { name: '儲存變更', exact: true }).click()
    await memberDialog.waitFor({ state: 'detached' })
    const updatedRow = page.locator('tr').filter({ has: page.getByText(input.invitedEmail, { exact: true }) })
    await updatedRow.getByText('Admin', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await updatedRow.getByText('Advisor', { exact: true }).count(), 0)

    await page.getByRole('link', { name: '登出', exact: true }).click()
    await page.waitForURL('**/login')
    await page.getByLabel('帳戶電郵', { exact: true }).fill(input.invitedEmail)
    await page.getByLabel('密碼', { exact: true }).fill(input.invitedPassword)
    await page.getByRole('button', { name: '登入工作台', exact: true }).click()
    await page.waitForURL('**/today')
    await page.locator('a[href="/admin/access"]').waitFor({ state: 'visible' })
    await page.getByRole('link', { name: '登出', exact: true }).click()
    await page.waitForURL('**/login')
  } finally {
    await context.close()
  }
}

async function assertInternalEmailHttpFlow(baseUrl: string, email: string, password: string, adminEmail: string, adminPassword: string, suffix: string): Promise<{ readonly adminCookie: string }> {
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password }),
    redirect: 'manual',
  })
  assert.equal(login.status, 303)
  assert.equal(new URL(login.headers.get('location')!).pathname, '/today')
  const setCookie = login.headers.get('set-cookie')
  assert.match(setCookie ?? '', /; HttpOnly/i)
  assert.match(setCookie ?? '', /; SameSite=Lax/i)
  const cookie = setCookie?.split(';', 1)[0]
  assert.ok(cookie)

  const me = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie } })
  assert.equal(me.status, 200)

  const invitedEmail = `http-invited-${suffix}@tianxing.test.invalid`
  const invite = await fetch(`${baseUrl}/api/v1/auth/invites`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'idempotency-key': `http-invite-${suffix}` },
    body: JSON.stringify({ normalized_email: invitedEmail, role: 'advisor', employment_type: 'FULL_TIME' }),
  })
  const inviteText = await invite.text()
  assert.equal(invite.status, 200, inviteText)
  const inviteBody = JSON.parse(inviteText) as { data?: { invite_id?: unknown; delivery_receipt?: { receipt_reference?: unknown } } }
  assert.match(String(inviteBody.data?.invite_id), /^[0-9a-f-]{36}$/i)
  assert.match(String(inviteBody.data?.delivery_receipt?.receipt_reference), /^fake-email-/)

  const directory = await fetch(`${baseUrl}/api/v1/auth/users`, { headers: { cookie } })
  assert.equal(directory.status, 200)
  const directoryBody = await directory.json() as { data?: { can_invite_users?: unknown; users?: Array<{ email?: unknown; user_status?: unknown; pending_invite_id?: unknown }> } }
  assert.equal(directoryBody.data?.can_invite_users, true)
  const invited = directoryBody.data?.users?.find((user) => user.email === invitedEmail)
  assert.equal(invited?.user_status, 'invited')
  assert.equal(invited?.pending_invite_id, inviteBody.data?.invite_id)

  const founderSettings = await fetch(`${baseUrl}/api/v1/email/settings`, { headers: { cookie } })
  assert.equal(founderSettings.status, 403)
  const founderTemplate = await fetch(`${baseUrl}/api/v1/email/templates/internal-user-invitation`, { headers: { cookie } })
  assert.equal(founderTemplate.status, 403)

  const adminLogin = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: adminEmail, password: adminPassword }),
    redirect: 'manual',
  })
  assert.equal(adminLogin.status, 303)
  const adminCookie = adminLogin.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(adminCookie)
  const empty = await fetch(`${baseUrl}/api/v1/email/settings`, { headers: { cookie: adminCookie } })
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json() as { data?: Record<string, unknown> }
  assert.equal(emptyBody.data?.configured, false)
  assert.equal('api_key' in (emptyBody.data ?? {}), false)

  const saved = await fetch(`${baseUrl}/api/v1/email/settings`, {
    method: 'PUT',
    headers: { cookie: adminCookie, 'content-type': 'application/json', 'idempotency-key': `email-settings-${suffix}` },
    body: JSON.stringify({ api_key: 're_synthetic_integration_secret', from_email: 'accounts@example.test.invalid', from_name: '天星顧問', expected_record_version: null }),
  })
  assert.equal(saved.status, 200)
  const savedBody = await saved.json() as { data?: Record<string, unknown> }
  assert.equal(savedBody.data?.record_version, 1)
  assert.equal(JSON.stringify(savedBody).includes('re_synthetic_integration_secret'), false)

  const configured = await fetch(`${baseUrl}/api/v1/email/settings`, { headers: { cookie: adminCookie } })
  assert.equal(configured.status, 200)
  const configuredBody = await configured.json() as { data?: Record<string, unknown> }
  assert.deepEqual(configuredBody.data, {
    configured: true,
    provider: 'resend',
    from_email: 'accounts@example.test.invalid',
    from_name: '天星顧問',
    record_version: 1,
    updated_at: configuredBody.data?.updated_at,
  })
  assert.equal('api_key' in (configuredBody.data ?? {}), false)

  const defaultTemplate = await fetch(`${baseUrl}/api/v1/email/templates/internal-user-invitation`, { headers: { cookie: adminCookie } })
  assert.equal(defaultTemplate.status, 200)
  const defaultTemplateBody = await defaultTemplate.json() as { data?: Record<string, unknown> }
  assert.equal(defaultTemplateBody.data?.template_kind, 'internal_user_invitation')
  assert.equal(defaultTemplateBody.data?.customized, false)
  assert.equal(defaultTemplateBody.data?.record_version, null)

  const savedTemplate = await fetch(`${baseUrl}/api/v1/email/templates/internal-user-invitation`, {
    method: 'PUT',
    headers: { cookie: adminCookie, 'content-type': 'application/json', 'idempotency-key': `email-template-${suffix}` },
    body: JSON.stringify({ subject: '合成邀請主旨', body_text: '請完成合成帳戶設定。', expected_record_version: null }),
  })
  const savedTemplateText = await savedTemplate.text()
  assert.equal(savedTemplate.status, 200, savedTemplateText)
  const savedTemplateBody = JSON.parse(savedTemplateText) as { data?: Record<string, unknown> }
  assert.equal(savedTemplateBody.data?.record_version, 1)

  const customizedTemplate = await fetch(`${baseUrl}/api/v1/email/templates/internal-user-invitation`, { headers: { cookie: adminCookie } })
  assert.equal(customizedTemplate.status, 200)
  const customizedTemplateBody = await customizedTemplate.json() as { data?: Record<string, unknown> }
  assert.equal(customizedTemplateBody.data?.customized, true)
  assert.equal(customizedTemplateBody.data?.subject, '合成邀請主旨')
  assert.equal(customizedTemplateBody.data?.body_text, '請完成合成帳戶設定。')
  return Object.freeze({ adminCookie })
}

async function assertEmailAdministrationBrowserFlow(baseUrl: string, adminCookie: string, browser: Browser): Promise<void> {
  const separator = adminCookie.indexOf('=')
  assert.ok(separator > 0)
  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 } })
  try {
    await context.addCookies([{ name: adminCookie.slice(0, separator), value: adminCookie.slice(separator + 1), url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    await page.goto('/admin/email', { waitUntil: 'domcontentloaded' })
    await page.locator('h2.page-title').filter({ hasText: 'Resend 郵件設定' }).waitFor({ state: 'visible' })
    assert.equal(await page.getByLabel(/^發件電郵/).inputValue(), 'accounts@example.test.invalid')
    assert.equal(await page.getByLabel('發件名稱', { exact: true }).inputValue(), '天星顧問')
    await page.getByLabel(/^Resend API 密鑰/).fill('re_synthetic_browser_rotation')
    await page.getByLabel(/^發件電郵/).fill('browser-accounts@example.test.invalid')
    await page.getByLabel('發件名稱', { exact: true }).fill('天星瀏覽器驗收')
    await page.getByRole('button', { name: '輪換並儲存', exact: true }).click()
    await page.getByText('Resend 設定已安全儲存。API 密鑰不會再次顯示。', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.getByLabel(/^Resend API 密鑰/).inputValue(), '')

    await page.goto('/admin/email/templates', { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: '使用者註冊邀請', exact: true }).waitFor({ state: 'visible' })
    const subject = page.locator('input[maxlength="160"]')
    const body = page.locator('textarea[maxlength="4000"]')
    await subject.waitFor({ state: 'visible' })
    assert.equal(await subject.inputValue(), '合成邀請主旨')
    assert.equal(await body.inputValue(), '請完成合成帳戶設定。')
    await subject.fill('瀏覽器邀請主旨')
    await body.fill('請在瀏覽器中完成帳戶設定。')
    await page.getByRole('button', { name: '儲存範本', exact: true }).click()
    await page.getByText('郵件範本已儲存。', { exact: true }).waitFor({ state: 'visible' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await subject.waitFor({ state: 'visible' })
    assert.equal(await subject.inputValue(), '瀏覽器邀請主旨')
    assert.equal(await body.inputValue(), '請在瀏覽器中完成帳戶設定。')
    assert.equal(await page.getByText('確認並設定帳戶', { exact: true }).count(), 1)
  } finally {
    await context.close()
  }
}

async function bootstrapExistingFounderCredential(target: OneRoleBaselineTarget, port: number, bootstrapPassword: string, password: string): Promise<void> {
  const salt = Buffer.alloc(32, 0x6c)
  const verifier = await deriveInternalEmailVerifier(Buffer.from(password, 'utf8'), salt)
  const admin = new Client({ connectionString: `postgresql://postgres:${encodeURIComponent(bootstrapPassword)}@127.0.0.1:${port}/tianxing` })
  try {
    await admin.connect()
    await admin.query(`INSERT INTO identity_database_test_credentials (user_id, verifier_version, password_salt, password_verifier) VALUES ($1, 'scrypt-v1', $2, $3)`, [FOUNDER.userId, salt, verifier])
    const migration = await readFile('db/migrations/202609070010_055_internal_email_identity.sql', 'utf8')
    const statement = /INSERT INTO identity_internal_credentials \([\s\S]*?ORDER BY credential\.user_id;/.exec(migration)?.[0]
    if (!statement) throw new Error('founder_bootstrap_statement_missing')
    await admin.query(statement)
    const copied = await admin.query<{ count: number }>('SELECT count(*)::int AS count FROM identity_internal_credentials WHERE user_id = $1', [FOUNDER.userId])
    assert.equal(copied.rows[0]?.count, 1)
  } finally {
    verifier.fill(0)
    salt.fill(0)
    await admin.end().catch(() => undefined)
  }
}

async function bootstrapInternalCredential(port: number, bootstrapPassword: string, userId: string, password: string): Promise<void> {
  const salt = Buffer.alloc(32, 0x4d)
  const verifier = await deriveInternalEmailVerifier(Buffer.from(password, 'utf8'), salt)
  const admin = new Client({ connectionString: `postgresql://postgres:${encodeURIComponent(bootstrapPassword)}@127.0.0.1:${port}/tianxing` })
  try {
    await admin.connect()
    await admin.query(`INSERT INTO identity_internal_credentials
      (user_id,verifier_version,password_salt,password_verifier,status,credential_version)
      VALUES ($1,'scrypt-v1',$2,$3,'active',1)`, [userId, salt, verifier])
  } finally {
    verifier.fill(0)
    salt.fill(0)
    await admin.end().catch(() => undefined)
  }
}

async function createIsolatedAppDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tianxing-internal-email-next-dev-'))
  const excluded = new Set(['.git', '.next', 'node_modules'])
  try {
    for (const entry of await readdir(process.cwd())) {
      if (excluded.has(entry) || entry.startsWith('.env') || ['.DS_Store', '.idea', '.kition', '.pnpm-store'].includes(entry)) continue
      await cp(resolve(entry), join(directory, entry), { recursive: true })
    }
    await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir')
    return directory
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function startNextDev(directory: string, port: number, connectionString: string, baseUrl: string): ChildProcess {
  return spawn(process.execPath, [
    resolve('node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port),
  ], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      NEXT_TELEMETRY_DISABLED: '1',
      APP_ENV: 'development', NODE_ENV: 'development', APP_RUNTIME_MODE: 'local-synthetic', AUTH_MODE: 'internal-email',
      LOCAL_SYNTHETIC_DATABASE_URL: connectionString, LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: '5000',
      APP_BASE_URL: baseUrl, EMAIL_FROM: 'no-reply@tianxing.test.invalid', EMAIL_TRANSPORT: 'deterministic-fake',
      EMAIL_SETTINGS_MASTER_KEY: Buffer.alloc(32, 0x31).toString('base64url'), EMAIL_SETTINGS_MASTER_KEY_VERSION: 'integration-v1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  child.stdout?.resume()
  child.stderr?.resume()
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new Error('next_dev_early_exit')
    try {
      const response = await fetch(`${baseUrl}/api/v1/auth/me`)
      if (response.status === 401) return
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  throw new Error('next_dev_readiness_timeout')
}

async function stopNextDev(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    new Promise<boolean>((resolveStopped) => child.once('close', () => resolveStopped(true))),
    new Promise<boolean>((resolveStopped) => setTimeout(() => resolveStopped(false), 10_000)),
  ])
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise<void>((resolveStopped) => child.once('close', () => resolveStopped()))
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error || port < 1 ? reject(error ?? new Error('next_port_reservation')) : resolvePort(port))
    })
  })
}

async function inspectIdentity(target: OneRoleBaselineTarget, userId: string, inviteId: string) {
  const client = new Client(createOneRoleBaselineClientConfig(target))
  try {
    await client.connect()
    await client.query(`SELECT set_config('app.organization_id',$1,false), set_config('app.actor_user_id',$2,false)`, [NEON_TEST_ORGANIZATION.id, FOUNDER.userId])
    const result = await client.query(`SELECT
      (SELECT status FROM identity_users WHERE id=$1) AS user_status,
      (SELECT status FROM access_organization_memberships WHERE user_id=$1 AND organization_id=$2) AS membership_status,
      (SELECT role FROM access_role_bindings WHERE user_id=$1 AND organization_id=$2 AND status='active' LIMIT 1) AS role,
      (SELECT status FROM identity_invites WHERE id=$3) AS invite_status,
      (SELECT count(*)::int FROM identity_internal_credentials WHERE user_id=$1) AS credential_count,
      (SELECT count(*)::int FROM identity_invite_delivery_receipts WHERE invite_id=$3) AS delivery_receipt_count,
      (SELECT count(*)::int FROM identity_sessions WHERE user_id=$1 AND session_kind='internal_email' AND status='active') AS active_session_count`, [userId, NEON_TEST_ORGANIZATION.id, inviteId])
    const row = result.rows[0]
    return {
      userStatus: row.user_status, membershipStatus: row.membership_status, role: row.role,
      inviteStatus: row.invite_status, credentialCount: row.credential_count,
      deliveryReceiptCount: row.delivery_receipt_count, activeSessionCount: row.active_session_count,
    }
  } finally { await client.end().catch(() => undefined) }
}

async function inspectEmailSettings(target: OneRoleBaselineTarget): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target))
  try {
    await client.connect()
    await client.query(`SELECT set_config('app.organization_id',$1,false), set_config('app.actor_user_id',$2,false)`, [NEON_TEST_ORGANIZATION.id, ADMIN.userId])
    const result = await client.query<{ ciphertext: Buffer; audit_count: number }>(`SELECT
      (SELECT api_key_ciphertext FROM email_provider_settings WHERE organization_id=$1) AS ciphertext,
      (SELECT count(*)::int FROM audit_events WHERE organization_id=$1 AND event_type='email.provider_settings.updated') AS audit_count`, [NEON_TEST_ORGANIZATION.id])
    assert.ok(result.rows[0]?.ciphertext)
    assert.notEqual(result.rows[0]!.ciphertext.toString('utf8'), 're_synthetic_integration_secret')
    assert.equal(result.rows[0]?.audit_count, 2)
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function inspectEmailTemplate(target: OneRoleBaselineTarget): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target))
  try {
    await client.connect()
    await client.query(`SELECT set_config('app.organization_id',$1,false), set_config('app.actor_user_id',$2,false)`, [NEON_TEST_ORGANIZATION.id, ADMIN.userId])
    const result = await client.query<{ subject_template: string; body_text_template: string; audit_count: number }>(`SELECT
      (SELECT subject_template FROM email_templates WHERE organization_id=$1 AND template_kind='internal_user_invitation') AS subject_template,
      (SELECT body_text_template FROM email_templates WHERE organization_id=$1 AND template_kind='internal_user_invitation') AS body_text_template,
      (SELECT count(*)::int FROM audit_events WHERE organization_id=$1 AND event_type='email.template.updated') AS audit_count`, [NEON_TEST_ORGANIZATION.id])
    assert.equal(result.rows[0]?.subject_template, '瀏覽器邀請主旨')
    assert.equal(result.rows[0]?.body_text_template, '請在瀏覽器中完成帳戶設定。')
    assert.equal(result.rows[0]?.audit_count, 2)
  } finally {
    await client.end().catch(() => undefined)
  }
}

function activationCredential(html: string): string {
  const match = /href="([^"]+)"/.exec(html)
  const credential = match ? new URLSearchParams(new URL(match[1]!.replaceAll('&amp;', '&')).hash.slice(1)).get('token') : null
  if (!credential) throw new Error('activation_credential_missing')
  return credential
}

async function activateWithDiagnostics(service: InternalEmailService, credential: string) {
  try {
    return await service.activateInvite({ activationCredential: credential, password: 'Synthetic9!Password', displayName: '邀請顧問' })
  } catch (error) {
    const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined
    const database = cause instanceof Error ? cause as Error & { code?: unknown; constraint?: unknown; where?: unknown; internalQuery?: unknown } : undefined
    throw new Error(`current_activation_failed:${String(database?.code ?? 'unknown')}:${String(database?.constraint ?? 'unknown')}:${database?.message ?? 'unknown'}:${String(database?.where ?? database?.internalQuery ?? 'unknown')}`, { cause: error })
  }
}

function configureInternalEmailEnvironment(connectionString: string): void {
  Object.assign(process.env, {
    APP_ENV: 'development', NODE_ENV: 'development', APP_RUNTIME_MODE: 'local-synthetic',
    AUTH_MODE: 'internal-email', LOCAL_SYNTHETIC_DATABASE_URL: connectionString,
    LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: '5000',
  })
}

const ENVIRONMENT_KEYS = ['APP_ENV', 'NODE_ENV', 'APP_RUNTIME_MODE', 'AUTH_MODE', 'LOCAL_SYNTHETIC_DATABASE_URL', 'LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS'] as const
function snapshotEnvironment(): Map<string, string | undefined> { return new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])) }
function restoreEnvironment(snapshot: Map<string, string | undefined>): void { for (const key of ENVIRONMENT_KEYS) { const value = snapshot.get(key); if (value === undefined) Reflect.deleteProperty(process.env, key); else Reflect.set(process.env, key, value) } }

async function inspectWithNewClient(target: OneRoleBaselineTarget) {
  const client = new Client(createOneRoleBaselineClientConfig(target))
  try { await client.connect(); return await inspectOneRoleBaselineDatabase(client) }
  finally { await client.end().catch(() => undefined) }
}

function localTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({ connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`, host: '127.0.0.1', port, database: 'tianxing', user: ONE_ROLE_CANONICAL_ROLE, ssl: false })
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = await runDocker(['exec', containerName, 'pg_isready', '--host=127.0.0.1', '--username=postgres', '--dbname=postgres'], 'postgres_readiness', undefined, process.env, true)
    if (probe.exitCode === 0) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('postgres_readiness_timeout')
}

function readLoopbackPort(output: string): number {
  const port = Number(/^127\.0\.0\.1:([0-9]+)\s*$/.exec(output)?.[1])
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('postgres_port_invalid')
  return port
}

async function runDocker(arguments_: readonly string[], stage: string, input?: string, environment: NodeJS.ProcessEnv = process.env, allowFailure = false): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', arguments_, { cwd: process.cwd(), env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk }); child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', () => reject(new Error(stage)))
    child.once('close', (code) => { const exitCode = code ?? 1; if (exitCode !== 0 && !allowFailure) reject(new Error(`${stage}:${stderr.slice(0, 300)}`)); else resolve({ exitCode, stdout }) })
    child.stdin.end(input)
  })
}
