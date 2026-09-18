import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { Client } from 'pg'
import { deriveInternalEmailVerifier } from '../../modules/identity/application/internal-email.ts'
import { createOneRoleBaselineClientConfig, type OneRoleBaselineTarget } from '../../scripts/db/run-one-role-baseline.ts'
import { NEON_TEST_ORGANIZATION } from '../../scripts/db/neon-test-synthetic-fixture.ts'

export async function assertTrialMemberBrowser(target: OneRoleBaselineTarget): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(target))
  const password = `Synthetic9!${randomBytes(16).toString('hex')}`
  let directory: string | undefined
  let server: ChildProcess | undefined
  let browser: Browser | undefined
  try {
    await client.connect()
    await client.query("SELECT set_config('app.organization_id',$1,false)", [NEON_TEST_ORGANIZATION.id])
    const people = (await client.query<{ user_id: string; level: string; email: string; name: string }>(`SELECT t.user_id,t.level,u.normalized_email AS email,p.display_name AS name
      FROM access_trial_members t JOIN identity_users u ON u.id=t.user_id
      JOIN access_employee_profiles p ON p.membership_id=t.membership_id WHERE t.status='active' ORDER BY t.user_id`)).rows
    for (const person of people) {
      const salt = randomBytes(32)
      const verifier = await deriveInternalEmailVerifier(Buffer.from(password),salt)
      await client.query(`INSERT INTO identity_internal_credentials(user_id,verifier_version,password_salt,password_verifier)
        VALUES ($1,'scrypt-v1',$2,$3)`, [person.user_id,salt,verifier])
    }
    const founder = people.find((p) => p.level === 'founder')!
    const l2 = people.find((p) => p.level === 'l2')!
    const l1 = people.find((p) => p.level === 'l1')!
    directory = await createIsolatedAppDirectory()
    const port = await reserveLoopbackPort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = startNextDev(directory,port,target.connectionString,baseUrl)
    await waitForNextDev(baseUrl,server)
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
    const rootContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await rootContext.newPage()
    page.setDefaultTimeout(20_000)
    await page.goto(`${baseUrl}/login`)
    await page.getByLabel('帳戶電郵').fill(founder.email)
    await page.getByLabel('密碼', { exact: true }).fill(password)
    await Promise.all([page.waitForURL('**/today'),page.getByRole('button', { name: '登入工作台', exact: true }).click()])
    await page.goto(`${baseUrl}/admin/access/levels`)
    await page.getByRole('button', { name: `設定 ${l2.name} 的權限`, exact: true }).click()
    await page.getByLabel('國際學校', { exact: true }).check()
    const saved = page.waitForResponse((r) => r.url().endsWith(`/${l2.user_id}/trial-access`) && r.request().method() === 'PATCH')
    await page.getByRole('button', { name: '儲存權限', exact: true }).click()
    assert.equal((await saved).status(),200)
    await page.getByRole('heading', { name: `設定 ${l2.name} 的權限`, exact: true }).waitFor({ state: 'hidden' })
    await page.reload()
    await page.getByRole('button', { name: `設定 ${l2.name} 的權限`, exact: true }).waitFor()
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: l2.name, exact: true }) })
    assert.match(await card.innerText(),/國際學校/)
    await page.screenshot({ path: '/tmp/access-trial-founder-levels.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true)
    await page.screenshot({ path: '/tmp/access-trial-founder-levels-mobile.png', fullPage: true })

    const restrictedContext = await browser.newContext()
    const restricted = await restrictedContext.newPage()
    await restricted.goto(`${baseUrl}/login`)
    await restricted.getByLabel('帳戶電郵').fill(l1.email)
    await restricted.getByLabel('密碼', { exact: true }).fill(password)
    await Promise.all([restricted.waitForURL('**/today'),restricted.getByRole('button', { name: '登入工作台', exact: true }).click()])
    assert.equal((await restrictedContext.request.get(`${baseUrl}/api/v1/auth/users/trial-access`)).status(),403)
    assert.equal((await restrictedContext.request.patch(`${baseUrl}/api/v1/auth/users/${l2.user_id}/trial-access`, {
      headers: { 'idempotency-key': `denied-${randomBytes(8).toString('hex')}` },
      data: { level:'founder',categories:[],status:'active',expected_record_version:3 },
    })).status(),403)
    assert.equal(await restricted.getByRole('link', { name: '身份與權限', exact: true }).count(),0)
    const version = (await client.query("SELECT level,categories,record_version FROM access_trial_members WHERE user_id=$1", [l2.user_id])).rows[0]
    assert.equal(version.level,'l2')
    assert.deepEqual(version.categories,['international_school'])
    assert.equal(Number(version.record_version),3)
    process.stdout.write(JSON.stringify({ trial_member_browser:'pass', login:'internal_email', persistence:'reload_verified', l1_direct_api:'403', viewport:'desktop_and_390px' })+'\n')
  } finally {
    await browser?.close()
    await stopNextDev(server)
    if (directory) await rm(directory,{recursive:true,force:true})
    await client.end().catch(() => undefined)
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
