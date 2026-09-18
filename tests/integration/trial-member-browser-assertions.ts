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
    // Compile the intake surfaces before browser interactions; dev HMR is not a business event.
    for (const path of ['/api/v1/cases','/api/v1/cases/intake-options','/api/v1/cases/00000000-0000-4000-8000-000000000000/assessment']) await fetch(`${baseUrl}${path}`,{ signal:AbortSignal.timeout(20_000) })
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

    await rootContext.close()
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
    assert.equal((await restrictedContext.request.get(`${baseUrl}/api/v1/cases`)).status(),200)
    await restricted.goto(`${baseUrl}/cases/new`)
    const loadedOptions = restricted.waitForResponse((r) => r.url().includes('/api/v1/cases/intake-options?'))
    await restricted.getByLabel('業務分類', { exact: true }).selectOption('international_school')
    assert.equal((await loadedOptions).status(),200)
    await restricted.screenshot({ path: '/tmp/access-trial-case-intake-form.png', fullPage: true })
    await restricted.getByLabel('學生', { exact: true }).selectOption({ index: 1 })
    await restricted.getByLabel('主要顧問', { exact: true }).selectOption({ label: `${l1.name} · ${l1.email}` })
    await restricted.getByLabel(/入學年度/).fill('2099')
    await restricted.getByLabel(/簽署時間/).fill('2026-09-18T10:00')
    const createdResponse = restricted.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/cases' && r.request().method() === 'POST')
    await restricted.getByRole('button', { name: '建立案件', exact: true }).click()
    await restricted.screenshot({ path: '/tmp/access-trial-case-intake-after-submit.png', fullPage: true })
    const created = await createdResponse
    assert.equal(created.status(),200)
    await created.finished()
    await restricted.screenshot({ path: '/tmp/access-trial-case-intake-result.png', fullPage: true })
    await restricted.getByText('案件已建立', { exact: true }).waitFor()
    await restricted.setViewportSize({ width: 390, height: 844 })
    assert.equal(await restricted.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true)
    await restricted.screenshot({ path: '/tmp/access-trial-case-intake-mobile.png', fullPage: true })
    const createdData = (await created.json()).data as { case_id: string }
    const storedCase = (await client.query('SELECT business_category,primary_role,primary_user_id FROM cases_service_cases WHERE id=$1',[createdData.case_id])).rows[0]
    assert.equal(storedCase.business_category,'international_school')
    assert.equal(storedCase.primary_role,'l1')
    assert.equal(storedCase.primary_user_id,l1.user_id)
    const replay = await restrictedContext.request.post(`${baseUrl}/api/v1/cases`, {
      headers: { 'idempotency-key': created.request().headers()['idempotency-key']! },
      data: created.request().postDataJSON(),
    })
    assert.equal(replay.status(),200)
    await restricted.goto(`${baseUrl}/cases/${createdData.case_id}/assessment`)
    const birthDate = restricted.getByLabel('student_profile.date_of_birth value', { exact:true })
    await restricted.getByLabel('student_profile.date_of_birth semantic state', { exact:true }).selectOption('provided')
    await birthDate.fill('2014-03-12')
    const answerSaved = restricted.waitForResponse((r) => r.url().endsWith(`/${createdData.case_id}/assessment`) && r.request().method() === 'PATCH')
    await restricted.getByRole('button',{ name:'儲存全部修改',exact:true }).click()
    assert.equal((await answerSaved).status(),200)
    await restricted.reload()
    assert.equal(await birthDate.inputValue(),'2014-03-12')
    assert.equal(await restricted.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true)
    await restricted.screenshot({ path:'/tmp/access-trial-assessment-mobile.png',fullPage:true })
    await restricted.setViewportSize({ width:1280,height:900 })
    await restricted.screenshot({ path:'/tmp/access-trial-assessment-desktop.png',fullPage:true })
    const assessmentUrl = `${baseUrl}/api/v1/cases/${createdData.case_id}/assessment`
    const assessmentView = (await (await restrictedContext.request.get(assessmentUrl)).json()).data
    for (const [index,field] of assessmentView.schema.fields.entries()) {
      if (field.field_id === 'student_profile.date_of_birth') continue
      const value = field.value_type === 'date' ? '2014-03-12' : field.value_type === 'integer' ? index+1
        : field.value_type === 'enum' ? field.enum_values[0] : field.value_type === 'enum_set' ? [field.enum_values[0]] : `Synthetic-${index}`
      assert.equal((await restrictedContext.request.patch(assessmentUrl,{ headers:{ 'idempotency-key':`browser-assess-${randomBytes(8).toString('hex')}` },
        data:{ field_id:field.field_id,semantic_state:'provided',value:{ type:field.value_type,value },value_type:field.value_type,expected_record_version:0 } })).status(),200)
    }
    assert.equal((await restrictedContext.request.post(`${assessmentUrl}/background-completion`,{ headers:{ 'idempotency-key':`browser-complete-${randomBytes(8).toString('hex')}` },data:{ expected_record_version:1 } })).status(),200)
    const schoolPin = (await client.query(`INSERT INTO schools_resolved_revisions
      (id,organization_id,school_id,base_snapshot_id,overlay_revision_id,resolution_sha256,fields_json,provenance_json,conflicts_json)
      SELECT gen_random_uuid(),organization_id,school_id,snapshot_id,NULL,record_sha256,fields_json,provenance_json,'[]'::jsonb
      FROM schools_snapshot_records ORDER BY id LIMIT 1 RETURNING id,school_id,resolution_sha256`)).rows[0]!
    const listCreated = await restrictedContext.request.post(`${baseUrl}/api/v1/cases/${createdData.case_id}/candidate-lists`,{
      headers:{ 'idempotency-key':`browser-list-${randomBytes(8).toString('hex')}` },data:{ previous_version_id:null,expected_case_record_version:2,
        change_summary:'Synthetic browser list',items:[{ school_id:schoolPin.school_id,pinned_resolved_revision_id:schoolPin.id,
          pinned_resolution_sha256:schoolPin.resolution_sha256,ordinal:1,application_deadline:'2099-04-15T12:00:00.000Z' }] },
    })
    assert.equal(listCreated.status(),200)
    const versionId = (await listCreated.json()).data.id as string
    // Warm mutation compilation before opening the interactive review page.
    const reviewUrl = `${baseUrl}/api/v1/cases/${createdData.case_id}/candidate-lists/${versionId}/review`
    await restrictedContext.request.post(reviewUrl,{ data:{} })
    await restricted.goto(`${baseUrl}/cases/${createdData.case_id}`)
    await restricted.getByLabel('原因',{ exact:true }).fill('Synthetic L1 approval')
    const reviewed = restricted.waitForResponse((r) => r.url() === reviewUrl && r.request().method() === 'POST')
    await restricted.getByRole('button',{ name:'提交審核',exact:true }).click()
    assert.equal((await reviewed).status(),200)
    await restricted.reload()
    await restricted.getByText('批准 · Synthetic L1 approval',{ exact:true }).waitFor()
    assert.equal((await client.query('SELECT founder_decided_by_user_id FROM cases_candidate_school_list_versions WHERE id=$1',[versionId])).rows[0]!.founder_decided_by_user_id,l1.user_id)
    await restricted.setViewportSize({ width:390,height:844 })
    assert.equal(await restricted.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true)
    await restricted.screenshot({ path:'/tmp/access-trial-candidate-approval-mobile.png',fullPage:true })
    const trialTaskResponse = await restrictedContext.request.post(`${baseUrl}/api/v1/tasks`,{
      headers:{ 'idempotency-key':`browser-task-${randomBytes(8).toString('hex')}` },
      data:{ case_id:createdData.case_id,title:'Synthetic L3 task',task_brief:'Only assigned task instructions',
        due_at:'2099-04-15T12:00:00.000Z',assignee_user_id:people.find((p)=>p.level==='l3')!.user_id },
    })
    assert.equal(trialTaskResponse.status(),201)
    const trialTaskId = (await trialTaskResponse.json()).data.id as string
    const submittedBody = created.request().postDataJSON()
    await restrictedContext.close()
    const l2Context = await browser.newContext()
    const l2Page = await l2Context.newPage()
    await l2Page.goto(`${baseUrl}/login`)
    await l2Page.getByLabel('帳戶電郵').fill(l2.email)
    await l2Page.getByLabel('密碼', { exact: true }).fill(password)
    await Promise.all([l2Page.waitForURL('**/today'),l2Page.getByRole('button', { name: '登入工作台', exact: true }).click()])
    assert.equal((await l2Context.request.get(`${baseUrl}/api/v1/cases/intake-options?business_category=local_school`)).status(),403)
    assert.equal((await l2Context.request.get(`${baseUrl}/api/v1/cases/intake-options?business_category=international_school`)).status(),200)
    assert.equal((await l2Context.request.get(`${baseUrl}/api/v1/cases/${createdData.case_id}/assessment`)).status(),200)
    assert.equal((await l2Context.request.post(reviewUrl,{ headers:{ 'idempotency-key':`denied-review-${randomBytes(8).toString('hex')}` },
      data:{ decision:'approved',expected_record_version:3,reason:'Denied L2 approval' } })).status(),403)
    assert.equal((await l2Context.request.post(`${baseUrl}/api/v1/cases`, {
      headers: { 'idempotency-key': `denied-case-${randomBytes(8).toString('hex')}` },
      data: { ...submittedBody, business_category: 'local_school' },
    })).status(),403)
    await l2Context.close()
    const l3 = people.find((p) => p.level === 'l3')!
    const l3Context = await browser.newContext()
    const l3Page = await l3Context.newPage()
    await l3Page.goto(`${baseUrl}/login`)
    await l3Page.getByLabel('帳戶電郵').fill(l3.email)
    await l3Page.getByLabel('密碼', { exact:true }).fill(password)
    await Promise.all([l3Page.waitForURL('**/today'),l3Page.getByRole('button',{ name:'登入工作台',exact:true }).click()])
    assert.equal((await l3Context.request.get(`${baseUrl}/api/v1/cases/${createdData.case_id}/assessment`)).status(),403)
    await l3Page.goto(`${baseUrl}/tasks/${trialTaskId}`)
    await l3Page.getByRole('heading',{ name:'Synthetic L3 task',exact:true }).waitFor()
    assert.equal(await l3Page.getByRole('link',{ name:'返回案件',exact:true }).count(),0)
    for (const state of ['accepted','completed']) {
      const observed=(await (await l3Context.request.get(`${baseUrl}/api/v1/tasks/${trialTaskId}`)).json()).data
      process.stdout.write(JSON.stringify({ trial_task_browser_step:state, state:observed.task.state,kind:observed.task.task_kind,transitions:observed.task.available_transitions })+'\n')
      await l3Page.screenshot({ path:`/tmp/access-trial-l3-task-before-${state}.png`,fullPage:true })
      await l3Page.getByRole('combobox').selectOption(state)
      await l3Page.getByRole('checkbox').check()
      const updated = l3Page.waitForResponse((r)=>r.url().includes(`/tasks/${trialTaskId}/transition`) && r.request().method()==='POST')
      await l3Page.getByRole('button',{ name:'確認更新',exact:true }).click()
      assert.equal((await updated).status(),200)
      await l3Page.reload()
      await l3Page.getByRole('heading',{ name:'Synthetic L3 task',exact:true }).waitFor()
    }
    assert.equal(await l3Page.getByRole('button',{ name:'確認更新',exact:true }).count(),0)
    const taskPayload=(await (await l3Context.request.get(`${baseUrl}/api/v1/tasks/${trialTaskId}`)).json()).data
    assert.equal(taskPayload.audience,'assigned_task')
    assert.equal('case_id' in taskPayload.task,false)
    assert.equal(taskPayload.task.state,'completed')
    await l3Page.setViewportSize({ width:390,height:844 })
    assert.equal(await l3Page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true)
    await l3Page.screenshot({ path:'/tmp/access-trial-l3-task-mobile.png',fullPage:true })
    process.stdout.write(JSON.stringify({ trial_manual_task_browser:'pass', l3:'accept_complete_reload_readonly', case_data:'omitted', viewport:'390px' })+'\n')
    process.stdout.write(JSON.stringify({ trial_assessment_browser:'pass', l1_edit:'persisted_after_reload', l2_scope:'200', l3_full_assessment:'403', viewport:'desktop_and_390px' })+'\n')
    process.stdout.write(JSON.stringify({ trial_candidate_browser:'pass', l1_approval:'persisted_actual_actor', l2_approval:'403', viewport:'390px' })+'\n')
    process.stdout.write(JSON.stringify({ trial_case_intake_browser:'pass', l1_create:'persisted_actual_role', replay:'200', l2_cross_category:'403', viewport:'390px' })+'\n')
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
  child.stdout?.on('data',(chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (/ (GET|POST) \/api\/v1\/cases(?: |\?)/.test(line)) process.stdout.write(JSON.stringify({ trial_next_case_route:line.trim() })+'\n') })
  child.stdout?.resume()
  child.stderr?.on('data',(chunk: Buffer) => { const lines=chunk.toString().split('\n').filter((line) => /Error:|Module not found|Cannot find|Failed to/.test(line)); for (const line of lines) process.stdout.write(JSON.stringify({ trial_next_error:line.replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]').slice(0,300) })+'\n') })
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
