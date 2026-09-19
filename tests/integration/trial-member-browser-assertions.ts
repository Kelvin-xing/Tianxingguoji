import {assertTrialCrmDeletionHttp} from './trial-crm-deletion-http-assertions.ts'
import {assertTrialGuardianHttp} from './trial-crm-guardian-http-assertions.ts'
import {assertTrialCrmProfileBrowser} from './trial-crm-profile-browser-assertions.ts'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes,randomUUID } from 'node:crypto'
import { cp, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { Client } from 'pg'
import { deriveInternalEmailVerifier } from '../../modules/identity/application/internal-email.ts'
import { createOneRoleBaselineClientConfig, type OneRoleBaselineTarget } from '../../scripts/db/run-one-role-baseline.ts'
import { NEON_TEST_ORGANIZATION } from '../../scripts/db/neon-test-synthetic-fixture.ts'
import {assertTaskWaitsWithoutHoldingTask} from './trial-task-lock-order-assertions.ts'

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
    const guardianResponse=await restrictedContext.request.get(`${baseUrl}/api/v1/cases/${createdData.case_id}/guardian-confirmation-options`)
    assert.equal(guardianResponse.status(),200)
    const guardianOption=(await guardianResponse.json()).data.items[0]
    const approvedHash=(await client.query('SELECT founder_decision_sha256 FROM cases_candidate_school_list_versions WHERE id=$1',[versionId])).rows[0]!.founder_decision_sha256
    const guardianConfirmed=await restrictedContext.request.post(`${baseUrl}/api/v1/cases/${createdData.case_id}/candidate-lists/${versionId}/guardian-decision`,{
      headers:{'idempotency-key':`browser-guardian-${randomBytes(8).toString('hex')}`},data:{decision:'confirmed',channel:'phone',
        expected_case_record_version:2,expected_list_record_version:3,guardian_decided_at:new Date().toISOString(),
        guardian_id:guardianOption.guardian_id,guardian_relationship_id:guardianOption.guardian_relationship_id,bound_founder_decision_sha256:approvedHash},
    })
    assert.equal(guardianConfirmed.status(),200)
    const automaticRow=(await client.query("SELECT id,school_target_id,assignee_role FROM tasks_tasks WHERE service_case_id=$1 AND task_kind='application_prepare_submit'",[createdData.case_id])).rows[0]!
    assert.ok(automaticRow)
    assert.equal(automaticRow.assignee_role,'l1')
    const automaticTaskId=automaticRow.id as string
    await restricted.goto(`${baseUrl}/tasks/${automaticTaskId}`)
    await restricted.locator(`#automatic-task-action-${automaticTaskId}`).selectOption('reassign')
    await restricted.locator(`#automatic-task-reason-${automaticTaskId}`).fill('Synthetic manager reassignment')
    await restricted.locator(`#automatic-task-assignee-${automaticTaskId}`).selectOption(people.find((p)=>p.level==='l3')!.user_id)
    await restricted.locator('input[name="command_confirmed"]').check()
    const reassigned=restricted.waitForResponse((r)=>r.url().endsWith(`/tasks/${automaticTaskId}/p3-transitions`) && r.request().method()==='POST')
    await restricted.getByRole('button',{name:'確認更新',exact:true}).click()
    assert.equal((await reassigned).status(),200)
    const taskFileCreated=await restrictedContext.request.post(`${baseUrl}/api/v1/cases/${createdData.case_id}/documents`,{
      headers:{'idempotency-key':randomUUID()},data:{display_name:'Synthetic assigned task file',classification:'operational_attachment'}})
    assert.equal(taskFileCreated.status(),201)
    const taskFileId=(await taskFileCreated.json()).data.id as string
    await restricted.reload()
    const taskFileView=await restrictedContext.request.get(`${baseUrl}/api/v1/tasks/${automaticTaskId}/documents`)
    assert.equal(taskFileView.status(),200)
    assert.equal((await taskFileView.json()).data.can_manage,true)
    await restricted.locator(`#task-file-choice-${automaticTaskId}`).selectOption(taskFileId)
    await restricted.getByRole('checkbox',{name:'允許上傳新版本',exact:true}).check()
    await restricted.getByRole('checkbox',{name:'允許下載掃描通過的版本',exact:true}).check()
    await restricted.getByLabel('文件授權原因',{exact:true}).fill('Synthetic browser task-file grant')
    await restricted.getByRole('checkbox',{name:'我確認此任務的文件授權。',exact:true}).check()
    assert.equal(await restricted.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
    await restricted.screenshot({path:'/tmp/access-trial-task-files-manager.png',fullPage:true})
    const fileGrant=restricted.waitForResponse(r=>r.url().endsWith(`/tasks/${automaticTaskId}/documents`)&&r.request().method()==='POST')
    await restricted.getByRole('button',{name:'儲存文件授權',exact:true}).click()
    assert.equal((await fileGrant).status(),200)
    const studentCreateKey=`trial-student-${randomUUID()}`
    const studentCreateBody={
      student:{display_name:`Trial Student ${randomUUID()}`,date_of_birth:'2013-06-18',contact_email:null,contact_phone:null},
      primary_guardian:{kind:'new',display_name:`Trial Guardian ${randomUUID()}`,email:`trial-${randomUUID()}@example.invalid`,phone:null,relationship_type:'father',is_legal_guardian:true,is_emergency_contact:false,is_billing_contact:false,notification_consent:false},
    }
    const studentCreate=await restrictedContext.request.post(`${baseUrl}/api/v1/students`,{headers:{'idempotency-key':studentCreateKey},data:studentCreateBody})
    assert.equal(studentCreate.status(),201,'L1 can create a student and primary guardian atomically')
    const studentReceipt=(await studentCreate.json()).data
    const studentReplay=await restrictedContext.request.post(`${baseUrl}/api/v1/students`,{headers:{'idempotency-key':studentCreateKey},data:studentCreateBody})
    assert.equal(studentReplay.status(),201)
    assert.deepEqual((await studentReplay.json()).data,studentReceipt)
    const createdRelationships=await client.query(`SELECT student_id,guardian_id FROM crm_student_guardian_relationships WHERE student_id=$1 AND ends_at IS NULL AND is_primary_contact`,[studentReceipt.student.id])
    assert.equal(createdRelationships.rows.length,1)
    assert.equal(createdRelationships.rows[0].guardian_id,studentReceipt.primary_guardian.id)
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM audit_events WHERE resource_id=$1 AND event_type='crm.student_primary_guardian_created'`,[studentReceipt.student.id])).rows[0].count,1)
    await assertTrialCrmProfileBrowser({page:restricted,baseUrl,client,studentId:studentReceipt.student.id,guardianId:studentReceipt.primary_guardian.id})
    await assertTrialGuardianHttp({page:restricted,request:restrictedContext.request,baseUrl,client,studentId:studentReceipt.student.id,guardianId:studentReceipt.primary_guardian.id})
    await assertTrialCrmDeletionHttp({page:restricted,request:restrictedContext.request,baseUrl,client,studentId:studentReceipt.student.id})
    const submittedBody = created.request().postDataJSON()
    await restrictedContext.close()
    const l2Context = await browser.newContext()
    const l2Page = await l2Context.newPage()
    await l2Page.goto(`${baseUrl}/login`)
    await l2Page.getByLabel('帳戶電郵').fill(l2.email)
    await l2Page.getByLabel('密碼', { exact: true }).fill(password)
    await Promise.all([l2Page.waitForURL('**/today'),l2Page.getByRole('button', { name: '登入工作台', exact: true }).click()])
    assert.equal((await l2Context.request.post(`${baseUrl}/api/v1/students`,{headers:{'idempotency-key':`denied-${randomUUID()}`},data:studentCreateBody})).status(),403)
    assert.equal((await l2Context.request.patch(`${baseUrl}/api/v1/students/${studentReceipt.student.id}`,{
      headers:{'idempotency-key':`denied-profile-${randomUUID()}`},
      data:{display_name:'Forbidden profile edit',date_of_birth:null,gender:null,contact_email:null,contact_phone:null,expected_record_version:2},
    })).status(),403)
    assert.equal((await l2Context.request.patch(`${baseUrl}/api/v1/guardians/${studentReceipt.primary_guardian.id}`,{
      headers:{'idempotency-key':`denied-profile-${randomUUID()}`},
      data:{display_name:'Forbidden guardian edit',date_of_birth:null,gender:null,email:'forbidden@example.invalid',phone:null,expected_record_version:2},
    })).status(),403)
    assert.equal((await l2Context.request.get(`${baseUrl}/api/v1/cases/intake-options?business_category=local_school`)).status(),403)
    assert.equal((await l2Context.request.get(`${baseUrl}/api/v1/cases/intake-options?business_category=international_school`)).status(),200)
    const scopedStudents=await l2Context.request.get(`${baseUrl}/api/v1/students`)
    assert.equal(scopedStudents.status(),200)
    const expectedStudents=(await client.query(`SELECT DISTINCT s.id FROM crm_students s JOIN cases_service_cases c ON c.student_id=s.id AND c.organization_id=s.organization_id
      WHERE s.status IN ('active','pending_delete') AND c.business_category='international_school'`)).rows.map(row=>row.id).sort()
    assert.deepEqual((await scopedStudents.json()).data.students.map((row:{id:string})=>row.id).sort(),expectedStudents)
    const hiddenStudent=(await client.query(`SELECT s.id,s.display_name FROM crm_students s WHERE s.status='active' AND NOT EXISTS
      (SELECT 1 FROM cases_service_cases c WHERE c.student_id=s.id AND c.business_category='international_school') LIMIT 1`)).rows[0]
    assert.ok(hiddenStudent)
    assert.equal((await l2Context.request.get(`${baseUrl}/api/v1/students/${hiddenStudent.id}`)).status(),404)
    for(const suffix of ['guardians','guardian-relationships/history']){
      assert.equal((await l2Context.request.get(`${baseUrl}/api/v1/students/${hiddenStudent.id}/${suffix}`)).status(),404)
      assert.equal((await l2Context.request.get(`${baseUrl}/api/v1/students/${expectedStudents[0]}/${suffix}`)).status(),200)
    }
    const duplicateResponse=await l2Context.request.post(`${baseUrl}/api/v1/crm/potential-duplicates`,{
      data:{kind:'student',name:hiddenStudent.display_name,email:null,phone:null},
    })
    assert.equal(duplicateResponse.status(),200)
    assert.equal((await duplicateResponse.json()).data.warnings.some((row:{id:string})=>row.id===hiddenStudent.id),false)
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
    assert.equal((await l3Context.request.get(`${baseUrl}/api/v1/students`)).status(),403)
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
    await l3Page.goto(`${baseUrl}/tasks/${automaticTaskId}`)
    await l3Page.getByRole('combobox').selectOption('accept')
    await l3Page.locator('input[name="command_confirmed"]').check()
    const autoAccepted=l3Page.waitForResponse((r)=>r.url().endsWith(`/tasks/${automaticTaskId}/p3-transitions`) && r.request().method()==='POST')
    const acceptanceResponse=await assertTaskWaitsWithoutHoldingTask({target,observer:client,organizationId:NEON_TEST_ORGANIZATION.id,
      actorUserId:l1.user_id,caseId:createdData.case_id,taskId:automaticTaskId,command:async()=>{
        await l3Page.getByRole('button',{name:'確認更新',exact:true}).click();return await autoAccepted;
      }})
    assert.equal(acceptanceResponse.status(),200)
    const originalAcceptance=(await acceptanceResponse.json()).data
    const acceptanceCommand=acceptanceResponse.request().postDataJSON()
    const acceptanceKey=acceptanceResponse.request().headers()['idempotency-key']!
    await l3Page.reload()
    l3Page.on('response',async response=>{const path=new URL(response.url()).pathname;
      if(response.request().method()==='PUT'||path.endsWith('/upload-intents')||path.endsWith('/versions')){
        const json=response.headers()['content-type']?.includes('application/json')??false;
        let code:string|undefined;
        if(response.status()>=400&&json){
          const body=await response.json().catch(()=>null);
          code=['NOT_FOUND','FORBIDDEN','UNAUTHENTICATED','CONFLICT','STALE_VERSION','SERVICE_UNAVAILABLE','INVALID_REQUEST','VALIDATION_FAILED'].includes(body?.error?.code)?body.error.code:'UNRECOGNIZED';
        }
        process.stdout.write(JSON.stringify({trial_upload_http:{method:response.request().method(),status:response.status(),json,code,operation:response.request().method()==='PUT'?'bytes':path.endsWith('/upload-intents')?'intent':'version'}})+'\n');
      }})
    const uploadBytes=Buffer.alloc(1_048_576,0x20);uploadBytes.write('%PDF-1.7\nSynthetic task file\n')
    await l3Page.locator('input[type="file"]').setInputFiles({name:'synthetic-task.pdf',mimeType:'application/pdf',buffer:uploadBytes})
    await l3Page.getByRole('button',{name:'上傳文件',exact:true}).click()
    await l3Page.getByText('文件已上傳並通過檢查。',{exact:true}).waitFor({timeout:30_000}).catch(async error=>{
      process.stdout.write(JSON.stringify({trial_upload_states:(await client.query(`SELECT v.state,s.state AS scan_state,s.engine FROM documents_document_versions v
        LEFT JOIN documents_scan_results s ON s.document_version_id=v.id WHERE v.document_id=$1`,[taskFileId])).rows})+'\n')
      await l3Page.screenshot({path:'/tmp/access-trial-task-upload-error.png',fullPage:true});throw error;
    })
    const downloaded=l3Page.waitForEvent('download')
    await l3Page.getByRole('button',{name:'下載文件',exact:true}).click()
    const download=await downloaded
    const stream=await download.createReadStream();assert.ok(stream)
    const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks),uploadBytes)
    const retainedDownload=(await (await l3Context.request.post(`${baseUrl}/api/v1/tasks/${automaticTaskId}/documents/${taskFileId}/download-intents`,{data:{}})).json()).data
    await l3Page.locator(`#automatic-task-action-${automaticTaskId}`).selectOption('complete')
    await l3Page.locator('input[name="submitted_at"]').fill('2026-09-18T10:00')
    await l3Page.locator('input[name="confirmed_at"]').fill('2026-09-18T10:00')
    await l3Page.locator('input[name="no_reference_declared"]').check()
    await l3Page.locator(`#task-evidence-reference-${automaticTaskId}`).selectOption(taskFileId)
    await l3Page.screenshot({path:'/tmp/access-trial-task-file-completion-mobile.png',fullPage:true})
    await l3Page.locator('input[name="checklist_complete"]').check()
    await l3Page.locator('input[name="command_confirmed"]').check()
    const autoCompleted=l3Page.waitForResponse((r)=>r.url().endsWith(`/tasks/${automaticTaskId}/p3-transitions`) && r.request().method()==='POST')
    await l3Page.getByRole('button',{name:'確認更新',exact:true}).click()
    const autoCompletionResponse=await autoCompleted
    assert.equal(autoCompletionResponse.status(),200)
    assert.equal((await autoCompletionResponse.json()).data.automation.target_transition,'completed')
    const acceptanceReplay=await l3Context.request.post(`${baseUrl}/api/v1/tasks/${automaticTaskId}/p3-transitions`,{
      headers:{'idempotency-key':acceptanceKey},data:acceptanceCommand})
    assert.equal(acceptanceReplay.status(),200)
    assert.deepEqual((await acceptanceReplay.json()).data,originalAcceptance)
    assert.equal((await client.query('SELECT state,record_version FROM tasks_tasks WHERE id=$1',[automaticTaskId])).rows[0]!.state,'completed')
    await l3Page.reload()
    await l3Page.getByRole('heading',{name:'Prepare and submit school application',exact:true}).waitFor()
    assert.equal(await l3Page.getByRole('button',{name:'確認更新',exact:true}).count(),0)
    assert.equal((await client.query('SELECT state FROM cases_school_targets WHERE id=$1',[automaticRow.school_target_id])).rows[0]!.state,'submitted')
    assert.equal(await l3Page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true)
    const linkedFiles=(await (await l3Context.request.get(`${baseUrl}/api/v1/tasks/${automaticTaskId}/documents`)).json()).data
    assert.equal(linkedFiles.can_manage,false)
    assert.deepEqual(linkedFiles.document_options,[])
    assert.equal(linkedFiles.links[0].display_name,'Synthetic assigned task file')
    assert.deepEqual(linkedFiles.links[0].allowed_actions,['document.read','document.download'])
    assert.equal('case_id' in linkedFiles.links[0],false)
    assert.equal((await l3Context.request.post(`${baseUrl}/api/v1/tasks/${automaticTaskId}/documents`,{headers:{'idempotency-key':randomUUID()},data:{
      document_id:taskFileId,expected_record_version:1,allowed_actions:[],reason:'Synthetic L3 grant forbidden'}})).status(),403)
    await l3Page.screenshot({path:'/tmp/access-trial-l3-application-task-mobile.png',fullPage:true})
    const revokeUrl=`${baseUrl}/api/v1/tasks/${automaticTaskId}/assignment-revocations`
    const beforeRevocation=(await (await l3Context.request.get(`${baseUrl}/api/v1/tasks/${automaticTaskId}`)).json()).data
    assert.equal((await l3Context.request.post(revokeUrl,{headers:{'idempotency-key':randomBytes(16).toString('hex')},
      data:{assignment_id:beforeRevocation.task.current_assignment.id,expected_record_version:4,reason:'Synthetic denied revoke'}})).status(),403)
    await l3Page.close()
    const revokeContext=await browser.newContext({viewport:{width:390,height:844}})
    const revokePage=await revokeContext.newPage()
    await revokePage.goto(`${baseUrl}/login`)
    await revokePage.getByLabel('帳戶電郵').fill(l1.email)
    await revokePage.getByLabel('密碼',{exact:true}).fill(password)
    await Promise.all([revokePage.waitForURL('**/today'),revokePage.getByRole('button',{name:'登入工作台',exact:true}).click()])
    const lifecycleUrl=`${baseUrl}/api/v1/cases/${createdData.case_id}/documents/${taskFileId}`
    const fileBefore=(await client.query('SELECT record_version,active_document_version_id FROM documents_documents WHERE id=$1',[taskFileId])).rows[0]!
    const deletionOptions={headers:{'idempotency-key':randomUUID()},data:{expected_record_version:Number(fileBefore.record_version)}}
    assert.equal((await revokeContext.request.post(`${lifecycleUrl}/deletions`,{...deletionOptions,data:{...deletionOptions.data,role:'founder'}})).status(),400)
    assert.equal((await revokeContext.request.post(`${lifecycleUrl}/deletions`,{headers:{...deletionOptions.headers,'content-type':'application/json'},
      data:'{"expected_record_version":1,"expected_record_version":2}'})).status(),400)
    assert.equal((await l3Context.request.post(`${lifecycleUrl}/deletions`,deletionOptions)).status(),404)
    const deletedFile=await revokeContext.request.post(`${lifecycleUrl}/deletions`,deletionOptions)
    assert.equal(deletedFile.status(),200)
    const deletionReceipt=(await deletedFile.json()).data
    assert.equal(deletionReceipt.lifecycle_state,'pending_delete')
    assert.equal(deletionReceipt.active_version_id,null)
    assert.equal((await l3Context.request.get(retainedDownload.url)).status(),404)
    const restoredFile=await revokeContext.request.post(`${lifecycleUrl}/restorations`,{headers:{'idempotency-key':randomUUID()},
      data:{version_id:fileBefore.active_document_version_id,expected_record_version:deletionReceipt.record_version}})
    assert.equal(restoredFile.status(),200)
    const restoreReceipt=(await restoredFile.json()).data
    assert.equal(restoreReceipt.lifecycle_state,'active')
    assert.equal(restoreReceipt.active_version_id,fileBefore.active_document_version_id)
    assert.deepEqual((await (await revokeContext.request.post(`${lifecycleUrl}/deletions`,deletionOptions)).json()).data,deletionReceipt)
    assert.equal((await revokeContext.request.post(`${lifecycleUrl}/version-rollbacks`,{headers:{'idempotency-key':randomUUID()},
      data:{target_version_id:randomUUID(),expected_record_version:restoreReceipt.record_version}})).status(),409)
    assert.equal((await revokeContext.request.post(`${lifecycleUrl}/version-rollbacks`,{headers:{'idempotency-key':randomUUID()},
      data:{target_version_id:fileBefore.active_document_version_id,expected_record_version:restoreReceipt.record_version}})).status(),200)
    process.stdout.write(JSON.stringify({trial_document_lifecycle_http:'pass',l1:'delete_restore_rollback',l3:'denied',deleted_download:'denied',replay:'original_ack'})+'\n')
    assert.equal((await l3Context.request.get(`${lifecycleUrl}/history`)).status(),404)
    const fileHistory=(await (await revokeContext.request.get(`${lifecycleUrl}/history`)).json()).data
    assert.deepEqual(Object.keys(fileHistory.versions[0]).sort(),['active','created_at','id','selectable','state'])
    await revokePage.goto(`${baseUrl}/cases/${createdData.case_id}/documents`)
    const fileRow=revokePage.locator('li').filter({has:revokePage.getByText('Synthetic assigned task file',{exact:true})})
    await fileRow.getByRole('button',{name:'版本與恢復管理',exact:true}).click()
    const newerBytes=Buffer.from(uploadBytes);newerBytes.write('New synthetic version',100)
    await fileRow.locator('input[type="file"]').setInputFiles({name:'synthetic-newer.pdf',mimeType:'application/pdf',buffer:newerBytes})
    await fileRow.getByRole('button',{name:'上載並掃描',exact:true}).click()
    await fileRow.getByText('掃描完成，安全版本已可下載。',{exact:true}).waitFor({timeout:30_000})
    await fileRow.getByRole('button',{name:'版本與恢復管理',exact:true}).click()
    await fileRow.getByLabel('選擇安全版本',{exact:true}).selectOption(fileBefore.active_document_version_id)
    await fileRow.getByRole('checkbox',{name:'我確認本次文件操作。',exact:true}).check()
    await fileRow.getByRole('button',{name:'使用所選版本',exact:true}).click()
    await fileRow.getByText('使用版本已更新，歷史版本仍保留。',{exact:true}).waitFor()
    assert.equal((await client.query('SELECT active_document_version_id FROM documents_documents WHERE id=$1',[taskFileId])).rows[0]!.active_document_version_id,fileBefore.active_document_version_id)
    await fileRow.getByRole('checkbox',{name:'我確認本次文件操作。',exact:true}).check()
    await fileRow.getByRole('button',{name:'刪除文件',exact:true}).click()
    await fileRow.getByText('文件已移至恢復區，30 天內可恢復安全版本。',{exact:true}).waitFor()
    await revokePage.reload()
    await fileRow.getByRole('button',{name:'版本與恢復管理',exact:true}).click()
    await fileRow.getByLabel('選擇安全版本',{exact:true}).selectOption(fileBefore.active_document_version_id)
    await fileRow.getByRole('checkbox',{name:'我確認本次文件操作。',exact:true}).check()
    await fileRow.getByRole('button',{name:'恢復文件',exact:true}).click()
    await fileRow.getByText('文件已恢復。',{exact:true}).waitFor()
    assert.equal(await revokePage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
    await revokePage.screenshot({path:'/tmp/access-trial-document-lifecycle-mobile.png',fullPage:true})
    process.stdout.write(JSON.stringify({trial_document_lifecycle_ui:'pass',history:'no_storage_coordinates',rollback:'older_clean_version',restore:'after_reload',viewport:390})+'\n')
    await revokePage.goto(`${baseUrl}/tasks/${automaticTaskId}`)
    await revokePage.locator(`#task-file-choice-${automaticTaskId}`).selectOption(taskFileId)
    await revokePage.getByLabel('文件授權原因',{exact:true}).fill('Synthetic remove completed task file grant')
    await revokePage.getByRole('checkbox',{name:'我確認此任務的文件授權。',exact:true}).check()
    const fileRevoked=revokePage.waitForResponse(r=>r.url().endsWith(`/tasks/${automaticTaskId}/documents`)&&r.request().method()==='POST')
    await revokePage.getByRole('button',{name:'撤銷文件授權',exact:true}).click()
    assert.equal((await fileRevoked).status(),200)
    assert.deepEqual((await (await l3Context.request.get(`${baseUrl}/api/v1/tasks/${automaticTaskId}/documents`)).json()).data.links,[])
    assert.equal((await l3Context.request.get(retainedDownload.url)).status(),404)
    process.stdout.write(JSON.stringify({trial_task_file_browser:'pass',l1:'grant_and_revoke_ui',l3:'metadata_only_current_link',clean_evidence:'uploaded_selected_and_completed',byte_roundtrip:'verified',old_download_after_revoke:'404',completed_upload:'denied'})+'\n')
    await revokePage.getByLabel('撤銷原因').fill('Synthetic completed task access revocation')
    await revokePage.getByRole('checkbox',{name:'我確認收回原負責人的任務存取權。'}).check()
    const revocationResponse=revokePage.waitForResponse(r=>r.url()===revokeUrl && r.request().method()==='POST')
    await revokePage.getByRole('button',{name:'撤銷存取權',exact:true}).click()
    assert.equal((await revocationResponse).status(),200)
    await revokePage.reload()
    await revokePage.getByRole('heading',{name:'Prepare and submit school application',exact:true}).waitFor()
    assert.equal(await revokePage.getByRole('button',{name:'撤銷存取權',exact:true}).count(),0)
    assert.equal((await l3Context.request.get(`${baseUrl}/api/v1/tasks/${automaticTaskId}`)).status(),404)
    assert.equal((await l3Context.request.post(`${baseUrl}/api/v1/tasks/${automaticTaskId}/p3-transitions`,{
      headers:{'idempotency-key':acceptanceKey},data:acceptanceCommand})).status(),404)
    process.stdout.write(JSON.stringify({trial_historical_task_replay:'pass',after_completion:'original_acceptance',after_revocation:'404'})+'\n')
    assert.equal((await client.query('SELECT state,record_version FROM tasks_tasks WHERE id=$1',[automaticTaskId])).rows[0]!.state,'completed')
    assert.equal((await client.query('SELECT state FROM cases_school_targets WHERE id=$1',[automaticRow.school_target_id])).rows[0]!.state,'submitted')
    assert.equal(await revokePage.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true)
    await revokePage.screenshot({path:'/tmp/access-trial-revocation-mobile.png',fullPage:true})
    const invitationUrl=`${baseUrl}/api/v1/cases/${createdData.case_id}/school-targets/${automaticRow.school_target_id}/interview-invitations`
    const targetBeforeInterview=(await client.query('SELECT record_version FROM cases_school_targets WHERE id=$1',[automaticRow.school_target_id])).rows[0]!
    const invitationBody={expected_record_version:Number(targetBeforeInterview.record_version),interview_at:'2026-09-25T02:00:00Z',interview_method:'Video',interview_language:'English',coaching_requirements:'Practice introduction',background_summary:'Synthetic task context',invitation_document_id:taskFileId}
    assert.equal((await l3Context.request.post(invitationUrl,{headers:{'idempotency-key':randomUUID()},data:invitationBody})).status(),403)
    const targetsForInvitation=await revokeContext.request.get(`${baseUrl}/api/v1/cases/${createdData.case_id}/school-targets`)
    const documentsForInvitation=await revokeContext.request.get(`${baseUrl}/api/v1/cases/${createdData.case_id}/documents`)
    process.stdout.write(JSON.stringify({invitation_inputs:{targets:targetsForInvitation.status(),documents:documentsForInvitation.status(),can_record:(await targetsForInvitation.json()).data?.can_record_interview}})+'\n')
    assert.equal(targetsForInvitation.status(),200);assert.equal(documentsForInvitation.status(),200)
    await revokePage.goto(`${baseUrl}/cases/${createdData.case_id}/interviews`)
    await revokePage.getByLabel('學校',{exact:true}).selectOption(automaticRow.school_target_id).catch(async error=>{await revokePage.screenshot({path:'/tmp/access-trial-invitation-load-failure.png',fullPage:true});throw error;})
    await revokePage.getByLabel('面試時間（香港時間）',{exact:true}).fill('2026-09-25T10:00')
    await revokePage.getByLabel('面試方式',{exact:true}).fill('Video')
    await revokePage.getByLabel('面試語言',{exact:true}).fill('English')
    await revokePage.getByLabel('輔導要求',{exact:true}).fill('Practice introduction')
    await revokePage.getByLabel('必要背景摘要',{exact:true}).fill('Synthetic task context')
    await revokePage.getByLabel('邀請憑證',{exact:true}).selectOption(taskFileId)
    await revokePage.getByRole('checkbox',{name:'我確認學校要求面試，並建立支援任務。',exact:true}).check()
    assert.equal(await revokePage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
    await revokePage.screenshot({path:'/tmp/access-trial-interview-invitation-mobile.png',fullPage:true})
    // Fail task delivery in the disposable database after the invitation commits.
    await client.query("ALTER TABLE tasks_tasks ADD CONSTRAINT trial_interview_delivery_unavailable CHECK (task_kind<>'interview_support') NOT VALID")
    let originalInvitationKey=''
    await revokePage.route(invitationUrl,async route=>{
      originalInvitationKey=route.request().headers()['idempotency-key']!
      const response=await route.fetch()
      assert.equal(response.status(),200)
      assert.equal((await response.json()).data.automation.interview_task,'pending')
      // Lose the response only after the real server has committed the invitation.
      await route.abort('failed')
    },{times:1})
    await revokePage.getByRole('button',{name:'儲存面試邀請',exact:true}).click()
    await revokePage.getByText('暫時無法確認結果，請重試；相同內容不會重複建立。',{exact:true}).waitFor()
    assert.equal((await client.query("SELECT state FROM cases_school_targets WHERE id=$1",[automaticRow.school_target_id])).rows[0]!.state,'interview')
    assert.equal((await client.query("SELECT count(*)::int AS n FROM tasks_tasks WHERE school_target_id=$1 AND task_kind='interview_support'",[automaticRow.school_target_id])).rows[0]!.n,0)
    await revokePage.screenshot({path:'/tmp/access-trial-interview-response-lost.png',fullPage:true})
    assert.equal(await revokePage.getByLabel('必要背景摘要',{exact:true}).inputValue(),'Synthetic task context')
    const stillPending=revokePage.waitForResponse(r=>r.url()===invitationUrl&&r.request().method()==='POST')
    await revokePage.getByRole('button',{name:'儲存面試邀請',exact:true}).click()
    const pendingResponse=await stillPending
    assert.equal(pendingResponse.request().headers()['idempotency-key'],originalInvitationKey)
    assert.equal((await pendingResponse.json()).data.automation.interview_task,'pending')
    await revokePage.getByText('邀請已儲存，面試任務尚未建立。請按重試完成任務建立。',{exact:true}).waitFor()
    await revokePage.screenshot({path:'/tmp/access-trial-interview-pending-mobile.png',fullPage:true})
    await revokePage.reload()
    await revokePage.getByRole('button',{name:'檢查或恢復支援任務',exact:true}).waitFor()
    assert.equal((await l3Context.request.patch(invitationUrl)).status(),403)
    const recoveryPending=revokePage.waitForResponse(r=>r.url()===invitationUrl&&r.request().method()==='PATCH')
    await revokePage.getByRole('button',{name:'檢查或恢復支援任務',exact:true}).click()
    assert.equal((await (await recoveryPending).json()).data.interview_task,'pending')
    await revokePage.getByText('任務暫時未能建立，請稍後再試。',{exact:true}).waitFor()
    await client.query("ALTER TABLE tasks_tasks DROP CONSTRAINT trial_interview_delivery_unavailable")
    const invitationSaved=revokePage.waitForResponse(r=>r.url()===invitationUrl&&r.request().method()==='PATCH')
    await revokePage.getByRole('button',{name:'檢查或恢復支援任務',exact:true}).click()
    const invitationResponse=await invitationSaved
    const invitationKey=originalInvitationKey
    assert.equal(invitationResponse.status(),200)
    assert.equal((await invitationResponse.json()).data.interview_task,'completed')
    assert.equal((await client.query("SELECT count(*)::int AS n FROM audit_events WHERE resource_id=$1 AND event_type='cases.interview_invitation_recorded'",[automaticRow.school_target_id])).rows[0]!.n,1)
    process.stdout.write(JSON.stringify({trial_interview_recovery:'pass',lost_response:'preserved_request',pending:'real_postgresql_failure',retry:'same_key_single_invitation'})+'\n')
    const invitationReplay=await revokeContext.request.post(invitationUrl,{headers:{'idempotency-key':invitationKey},data:invitationBody})
    assert.equal(invitationReplay.status(),200)
    const interviewRows=(await client.query("SELECT id,assignee_user_id FROM tasks_tasks WHERE school_target_id=$1 AND task_kind='interview_support'",[automaticRow.school_target_id])).rows
    assert.equal(interviewRows.length,1);assert.equal(interviewRows[0]!.assignee_user_id,l1.user_id)
    const interviewId=interviewRows[0]!.id as string
    await revokePage.goto(`${baseUrl}/tasks/${interviewId}`)
    await revokePage.locator(`#automatic-task-action-${interviewId}`).selectOption('reassign')
    await revokePage.locator(`#automatic-task-reason-${interviewId}`).fill('Synthetic interview assignment')
    await revokePage.locator(`#automatic-task-assignee-${interviewId}`).selectOption(l3.user_id)
    await revokePage.locator('input[name="command_confirmed"]').check()
    const interviewReassigned=revokePage.waitForResponse(r=>r.url().endsWith(`/tasks/${interviewId}/p3-transitions`)&&r.request().method()==='POST')
    await revokePage.getByRole('button',{name:'確認更新',exact:true}).click()
    assert.equal((await interviewReassigned).status(),200)
    const interviewPage=await l3Context.newPage()
    await interviewPage.setViewportSize({width:390,height:844})
    await interviewPage.goto(`${baseUrl}/tasks/${interviewId}`)
    await interviewPage.getByText(/面試方式：Video/).waitFor()
    assert.match(await interviewPage.locator("main").innerText(),/面試語言：English[\s\S]*Synthetic task context/)
    await interviewPage.locator(`#automatic-task-action-${interviewId}`).selectOption('accept')
    await interviewPage.locator('input[name="command_confirmed"]').check()
    const interviewAccepted=interviewPage.waitForResponse(r=>r.url().endsWith(`/tasks/${interviewId}/p3-transitions`)&&r.request().method()==='POST')
    await interviewPage.getByRole('button',{name:'確認更新',exact:true}).click()
    assert.equal((await interviewAccepted).status(),200)
    await interviewPage.locator(`#automatic-task-action-${interviewId}`).selectOption('complete')
    await interviewPage.getByLabel('完成時間',{exact:true}).fill('2026-09-18T10:00')
    await interviewPage.getByLabel('面試方式',{exact:true}).fill('Video interview')
    await interviewPage.getByLabel('輔導摘要',{exact:true}).fill('Practised a synthetic introduction')
    await interviewPage.locator('input[name="command_confirmed"]').check()
    await interviewPage.screenshot({path:'/tmp/access-trial-interview-mobile.png',fullPage:true})
    const interviewCompleted=interviewPage.waitForResponse(r=>r.url().endsWith(`/tasks/${interviewId}/p3-transitions`)&&r.request().method()==='POST')
    await interviewPage.getByRole('button',{name:'確認更新',exact:true}).click()
    const interviewResponse=await interviewCompleted
    assert.equal(interviewResponse.status(),200)
    assert.equal('automation' in (await interviewResponse.json()).data,false)
    await interviewPage.reload()
    assert.equal(await interviewPage.locator(`#automatic-task-action-${interviewId}`).count(),0)
    assert.equal(await interviewPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
    const savedInterview=(await client.query(`SELECT r.completion_record_json FROM tasks_tasks t JOIN tasks_task_transition_receipts r
      ON r.id=t.last_transition_receipt_id WHERE t.id=$1 AND t.state='completed'`,[interviewId])).rows[0]!
    assert.deepEqual(savedInterview.completion_record_json,{completed_at:'2026-09-18T02:00:00.000Z',interview_method:'Video interview',coaching_summary:'Practised a synthetic introduction'})
    assert.equal((await client.query('SELECT state FROM cases_school_targets WHERE id=$1',[automaticRow.school_target_id])).rows[0]!.state,'interview')
    const interviewCommand=interviewResponse.request().postDataJSON()
    const interviewKey=interviewResponse.request().headers()['idempotency-key']!
    assert.equal((await l3Context.request.post(`${baseUrl}/api/v1/tasks/${interviewId}/p3-transitions`,{
      headers:{'idempotency-key':interviewKey},data:interviewCommand})).status(),200)
    const interviewDetail=(await (await l3Context.request.get(`${baseUrl}/api/v1/tasks/${interviewId}`)).json()).data
    assert.equal('case_id' in interviewDetail.task,false)
    const revokedInterview=await revokeContext.request.post(`${baseUrl}/api/v1/tasks/${interviewId}/assignment-revocations`,{
      headers:{'idempotency-key':randomUUID()},data:{assignment_id:interviewDetail.task.current_assignment.id,
        expected_record_version:4,reason:'Synthetic interview access revoked'}})
    assert.equal(revokedInterview.status(),200)
    assert.equal((await l3Context.request.post(`${baseUrl}/api/v1/tasks/${interviewId}/p3-transitions`,{
      headers:{'idempotency-key':interviewKey},data:interviewCommand})).status(),404)
    await interviewPage.close()
    process.stdout.write(JSON.stringify({trial_interview_completion:'pass',invitation:'form_and_formal_http_automatic_task',l3:'accept_form_complete_readonly',target:'unchanged'})+'\n')
    await revokeContext.close()
    process.stdout.write(JSON.stringify({trial_revocation_browser:'pass',l1:'ui_revoke',l3:'403_then_read_404',history:'completed_preserved'})+'\n')
    process.stdout.write(JSON.stringify({trial_application_browser:'pass',l1:'ui_reassign_l3',l3:'ui_accept_complete',target:'submitted',viewport:'390px'})+'\n')
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
      DOCUMENT_TRANSPORT_MODE:'deterministic-fake',DOCUMENT_FAKE_REGION:'ap-east-1',DOCUMENT_FAKE_BUCKET:'synthetic-private',
      DOCUMENT_FAKE_ORIGIN:baseUrl,DOCUMENT_FAKE_SIGNING_SECRET:Buffer.alloc(32,0x42).toString('hex'),
      DOCUMENT_FAKE_ORGANIZATION_ID:NEON_TEST_ORGANIZATION.id,DOCUMENT_FAKE_WORKER_CONTEXT_ID:'99999999-9999-4999-8999-999999999999',
      APP_BASE_URL: baseUrl, EMAIL_FROM: 'no-reply@tianxing.test.invalid', EMAIL_TRANSPORT: 'deterministic-fake',
      EMAIL_SETTINGS_MASTER_KEY: Buffer.alloc(32, 0x31).toString('base64url'), EMAIL_SETTINGS_MASTER_KEY_VERSION: 'integration-v1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  child.stdout?.on('data',(chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (/ (GET|POST) \/api\/v1\/cases(?: |\?)/.test(line)) process.stdout.write(JSON.stringify({ trial_next_case_route:line.trim() })+'\n') })
  child.stdout?.resume()
  child.stderr?.on('data',(chunk: Buffer) => { const lines=chunk.toString().split('\n').filter((line) => /Error:|Module not found|Cannot find|Failed to|event=document_scan_/.test(line)); for (const line of lines) process.stdout.write(JSON.stringify({ trial_next_error:line.replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]').slice(0,300) })+'\n') })
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
