import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, cp, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { Client } from 'pg'

import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  verifyCommittedOneRoleBaseline,
} from '../../scripts/db/generate-one-role-baseline.ts'
import {
  NEON_TEST_MANIFEST_ID,
  NEON_TEST_PRINCIPALS,
  NEON_TEST_STUDENTS,
} from '../../scripts/db/neon-test-synthetic-fixture.ts'
import {
  runDatabaseTestProvisionCli,
  type DatabaseTestProvisionTarget,
} from '../../scripts/db/provision-database-test-identity.ts'
import { seedNeonTestRelease1 } from '../../scripts/db/seed-neon-test-release1.ts'
import {
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  type OneRoleBaselineDatabaseState,
  type OneRoleBaselineTarget,
} from '../../scripts/db/run-one-role-baseline.ts'

const DOCKER = '/opt/homebrew/bin/docker'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const POSTGRES_IMAGE = 'postgres:17.10-alpine3.24'
type ActorName = 'founder' | 'admin' | 'advisor' | 'data_reviewer' | 'contractor'
const FOUNDER = principal('founder')
const ADMIN = principal('admin')
const ADVISOR = principal('advisor')
const DATA_REVIEWER = principal('data_reviewer')
const CONTRACTOR = principal('contractor')
const ACTORS = [FOUNDER, ADMIN, ADVISOR, DATA_REVIEWER, CONTRACTOR] as const
type Stage =
  | 'runtime_preflight' | 'postgres_setup' | 'baseline_seed' | 'identity_provision'
  | 'next_dev' | 'canonical_origin' | 'chrome_launch' | 'login'
  | 'founder_entry' | 'source_validation' | 'source_idempotency' | 'source_create'
  | 'duplicate_name' | 'source_stale' | 'source_inactivate'
  | 'source_inactivate_controls_ready' | 'source_inactivate_submit'
  | 'source_inactivate_receipt_contract' | 'source_inactivate_authoritative_refresh'
  | 'source_inactivate_feedback' | 'source_inactivate_inactive_badge'
  | 'case_fixture_first_submit' | 'case_fixture_first_receipt'
  | 'case_fixture_second_submit' | 'case_fixture_second_receipt'
  | 'assignment_validation' | 'assignment_idempotency' | 'assignment_replace'
  | 'retry_first_submit' | 'retry_first_feedback'
  | 'retry_second_submit' | 'retry_second_feedback'
  | 'changed_controls_ready' | 'changed_submit' | 'changed_receipt_contract'
  | 'changed_authoritative_refresh' | 'changed_feedback'
  | 'changed_key_assertion' | 'changed_double_submit_assertion'
  | 'replace_controls_ready' | 'replace_submit' | 'replace_receipt_contract'
  | 'replace_authoritative_refresh' | 'replace_feedback' | 'replace_history'
  | 'assignment_stale' | 'stale_current_version_read'
  | 'stale_seed_submit' | 'stale_seed_receipt' | 'stale_controls_ready'
  | 'stale_ui_submit' | 'stale_ui_status' | 'stale_authoritative_refresh' | 'stale_feedback'
  | 'assignment_persistence' | 'advisor_read_assign'
  | 'advisor_scope_denied' | 'advisor_scope_denied_transport'
  | 'advisor_scope_denied_status' | 'advisor_scope_denied_contract'
  | 'advisor_scope_denied_privacy' | 'admin_manage_no_case' | 'denied_roles'
  | 'desktop_viewport' | 'mobile_viewport' | 'browser_log_safety'
  | 'cleanup' | 'complete'

interface GateEvidence {
  baseline_generated_files: number | null
  founder_source_entry: boolean
  source_validation_zero_post: boolean
  source_retry_same_key: boolean
  source_change_rotates_key: boolean
  source_double_submit_posts: number | null
  duplicate_names_allowed: boolean
  duplicate_link_count: number
  duplicate_source_ids_unique: boolean
  source_c_differs_source_b: boolean
  source_stale_recovered: boolean
  source_inactivated: boolean
  source_inactivate: SourceInactivateEvidence
  case_fixture_first: CaseFixtureEvidence
  case_fixture_second: CaseFixtureEvidence
  assignment_validation_zero_post: boolean
  assignment_retry_same_key: boolean
  assignment_change_rotates_key: boolean
  assignment_double_submit_posts: number | null
  assignment_idempotency: AssignmentIdempotencyEvidence
  assignment_replace: AssignmentReplaceEvidence
  assignment_history_preserved: boolean
  assignment_stale: AssignmentStaleEvidence
  assignment_stale_recovered: boolean
  relogin_persisted: boolean
  advisor_read_only_source: boolean
  advisor_assigned_case_write: boolean
  advisor_unassigned_direct_404: boolean
  advisor_scope_denied: AdvisorScopeDeniedEvidence
  admin_source_manage: boolean
  admin_case_entry_hidden: boolean
  denied_role_source_403: number
  denied_role_assignment_403: number
  desktop: ViewportEvidence | null
  mobile: ViewportEvidence | null
  page_errors: number
  sensitive_log_matches: number
}

interface CleanupEvidence {
  context_closed: boolean
  dev_stopped: boolean
  app_removed: boolean
  profile_removed: boolean
  container_removed: boolean
  volume_removed: boolean
}

interface ViewportEvidence {
  overflow: number
  out_of_bounds: number
  overlapping: number
  clipped: number
}

interface CreatedSource {
  id: string
  recordVersion: number
}

interface CreatedCase {
  id: string
}

type CaseFixtureSafeCode =
  | 'NONE' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'VALIDATION_FAILED' | 'STALE_VERSION' | 'CONFLICT'
  | 'SERVICE_UNAVAILABLE' | 'INTERNAL_ERROR' | 'OTHER' | null

interface CaseFixtureEvidence {
  request_started: boolean
  response_received: boolean
  status: number | null
  json_parseable: boolean
  exact_case_success_dto: boolean
  code: CaseFixtureSafeCode
}

type DirectRequestSafeCode = 'NONE' | 'FORBIDDEN' | 'NOT_FOUND' | 'STALE_VERSION' | 'CONFLICT' | 'OTHER'

interface AdvisorScopeDeniedEvidence {
  fetch_completed: boolean
  json_parseable: boolean
  status: number | null
  code: DirectRequestSafeCode | null
  private_echo: boolean | null
}

interface AssignmentReplaceEvidence {
  source_option_count: number
  source_option_disabled: boolean
  select_value_matches_source_a: boolean
  select_enabled: boolean
  assign_control_still_visible: boolean
  native_checkbox_count: number
  exact_accessible_checkbox_count: number
  source_select_count: number
  source_select_visible: boolean
  confirmation_count: number
  confirmation_visible: boolean
  submit_button_count: number
  submit_button_visible: boolean
  post_request_started: boolean
  post_response_received: boolean
  post_status: number | null
  post_json_parseable: boolean
  exact_two_key_ack: boolean
  get_request_started: boolean
  get_response_received: boolean
  get_status: number | null
  get_json_parseable: boolean
  exact_current_history: boolean
  feedback_count: number
  feedback_visible: boolean
  history_count: number
}

interface SourceInactivateEvidence {
  checkbox_count: number
  checkbox_visible: boolean
  submit_button_count: number
  submit_button_visible: boolean
  patch_request_started: boolean
  patch_response_received: boolean
  patch_status: number | null
  patch_json_parseable: boolean
  receipt_data_object: boolean
  receipt_data_key_count: number
  receipt_exact_key_set: boolean
  receipt_id_uuid_valid: boolean
  receipt_id_matches_target: boolean
  receipt_record_version_positive: boolean
  receipt_record_version_matches_expected: boolean
  exact_two_key_ack: boolean
  get_request_started: boolean
  get_response_received: boolean
  get_status: number | null
  get_json_parseable: boolean
  exact_inactive_source: boolean
  feedback_count: number
  feedback_visible: boolean
  inactive_badge_count: number
  inactive_badge_visible: boolean
}

interface ReferralSourceReceiptValidation {
  readonly exact: boolean
  readonly dataObject: boolean
  readonly dataKeyCount: number
  readonly exactKeySet: boolean
  readonly idUuidValid: boolean
  readonly idMatchesTarget: boolean
  readonly recordVersionPositive: boolean
  readonly recordVersionMatchesExpected: boolean
  readonly id: string | null
  readonly recordVersion: number | null
}

interface AssignmentAttemptEvidence {
  post_request_started: boolean
  post_response_received: boolean
  post_status: number | null
  post_json_parseable: boolean
  exact_two_key_ack: boolean
  get_request_started: boolean
  get_response_received: boolean
  get_status: number | null
  get_json_parseable: boolean
  exact_current_history: boolean
  key_header_present: boolean
  post_count: number
  feedback_count: number
  feedback_visible: boolean
}

interface AssignmentIdempotencyEvidence {
  retry_first: AssignmentAttemptEvidence
  retry_second: AssignmentAttemptEvidence
  changed: AssignmentAttemptEvidence
  select_count: number
  select_visible: boolean
  submit_button_count: number
  submit_button_visible: boolean
  same_key: boolean
  changed_key: boolean
  changed_post_count: number | null
  changed_current_present: boolean
  changed_current_source_matches_source_c: boolean
  target_source_a_differs_current: boolean
}

interface AssignmentStaleEvidence {
  current_version_positive: boolean
  seed_request_started: boolean
  seed_response_received: boolean
  seed_status: number | null
  seed_json_parseable: boolean
  seed_exact_two_key_ack: boolean
  checkbox_count: number
  checkbox_visible: boolean
  submit_button_count: number
  submit_button_visible: boolean
  ui_request_started: boolean
  ui_response_received: boolean
  ui_status: number | null
  ui_json_parseable: boolean
  ui_stale_version_code: boolean
  ui_private_echo: boolean
  get_request_started: boolean
  get_response_received: boolean
  get_status: number | null
  get_json_parseable: boolean
  get_exact_current_history: boolean
  alert_count: number
  alert_visible: boolean
}

interface AssignmentReceiptValidation {
  readonly exact: boolean
  readonly id: string | null
  readonly recordVersion: number | null
}

interface AssignmentAuthorityValidation {
  readonly exact: boolean
  readonly currentId: string | null
  readonly currentSourceId: string | null
  readonly currentVersion: number | null
  readonly historyCount: number
}

const DEV_LOGS = new WeakMap<ChildProcess, { stdout: string; stderr: string }>()

test('CRM-06 ReferralSource management and Case assignment work through a real local browser', {
  timeout: 600_000,
}, async () => {
  let stage: Stage = 'runtime_preflight'
  const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`
  const containerName = `tianxing-crm06-browser-pg17-${suffix}`
  const volumeName = `tianxing-crm06-browser-secret-${suffix}`
  const applicationPassword = randomBytes(32).toString('hex')
  const passwords = new Map(ACTORS.map((actor) => [actor.role, randomBytes(32).toString('base64url')]))
  const evidence: GateEvidence = {
    baseline_generated_files: null,
    founder_source_entry: false,
    source_validation_zero_post: false,
    source_retry_same_key: false,
    source_change_rotates_key: false,
    source_double_submit_posts: null,
    duplicate_names_allowed: false,
    duplicate_link_count: 0,
    duplicate_source_ids_unique: false,
    source_c_differs_source_b: false,
    source_stale_recovered: false,
    source_inactivated: false,
    source_inactivate: emptySourceInactivateEvidence(),
    case_fixture_first: emptyCaseFixtureEvidence(),
    case_fixture_second: emptyCaseFixtureEvidence(),
    assignment_validation_zero_post: false,
    assignment_retry_same_key: false,
    assignment_change_rotates_key: false,
    assignment_double_submit_posts: null,
    assignment_idempotency: emptyAssignmentIdempotencyEvidence(),
    assignment_replace: emptyAssignmentReplaceEvidence(),
    assignment_history_preserved: false,
    assignment_stale: emptyAssignmentStaleEvidence(),
    assignment_stale_recovered: false,
    relogin_persisted: false,
    advisor_read_only_source: false,
    advisor_assigned_case_write: false,
    advisor_unassigned_direct_404: false,
    advisor_scope_denied: {
      fetch_completed: false,
      json_parseable: false,
      status: null,
      code: null,
      private_echo: null,
    },
    admin_source_manage: false,
    admin_case_entry_hidden: false,
    denied_role_source_403: 0,
    denied_role_assignment_403: 0,
    desktop: null,
    mobile: null,
    page_errors: 0,
    sensitive_log_matches: 0,
  }
  const cleanup: CleanupEvidence = {
    context_closed: false,
    dev_stopped: false,
    app_removed: false,
    profile_removed: false,
    container_removed: false,
    volume_removed: false,
  }
  let containerStarted = false
  let volumeCreated = false
  let appDirectory = ''
  let profileDirectory = ''
  let devServer: ChildProcess | undefined
  let context: BrowserContext | undefined
  let failureStage: Stage | null = null

  try {
    await Promise.all([access(DOCKER), access(CHROME)])
    await runDocker(['image', 'inspect', POSTGRES_IMAGE], stage)

    stage = 'postgres_setup'
    await runDocker(['volume', 'create', volumeName], stage)
    volumeCreated = true
    await runDocker([
      'run', '--rm', '--interactive', '--pull=never', '--volume', `${volumeName}:/run/secrets`,
      POSTGRES_IMAGE, '/bin/sh', '-c',
      'umask 022; cat > /run/secrets/local_postgres_password; chmod 0444 /run/secrets/local_postgres_password',
    ], stage, applicationPassword)
    await runDocker([
      'run', '--rm', '--detach', '--pull=never', '--name', containerName,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=512m',
      '--env', 'POSTGRES_DB=tianxing', '--env', 'POSTGRES_USER=postgres',
      '--env', 'POSTGRES_PASSWORD_FILE=/run/secrets/local_postgres_password',
      '--volume', `${volumeName}:/run/secrets:ro`,
      '--volume', `${resolve('infra/local/postgres/init')}:/docker-entrypoint-initdb.d:ro`,
      '--volume', `${resolve('infra/local/postgres/healthcheck.sh')}:/usr/local/bin/tianxing-postgres-healthcheck:ro`,
      '--publish', '127.0.0.1::5432', POSTGRES_IMAGE,
    ], stage)
    containerStarted = true
    await waitForPostgres(containerName)
    const port = readLoopbackPort((await runDocker(['port', containerName, '5432/tcp'], stage)).stdout)
    const target = localTarget(port, applicationPassword)

    stage = 'baseline_seed'
    const build = await verifyCommittedOneRoleBaseline()
    evidence.baseline_generated_files = build.files.length
    assert.equal(evidence.baseline_generated_files, 36)
    const baseline = await executeOneRoleBaselineRun({ mode: 'apply', target, build, dependencies: baselineDependencies(target) })
    assert.equal(baseline.status, 'pass')
    assert.equal(baseline.baseline_id, ONE_ROLE_BASELINE_ID)
    assert.equal((await seedNeonTestRelease1(target, 'apply')).status, 'pass')

    stage = 'identity_provision'
    for (const actor of ACTORS) {
      assert.equal(await provision(target, actor.email, passwords.get(actor.role)!), 'created')
    }

    stage = 'next_dev'
    appDirectory = await createIsolatedAppDirectory()
    profileDirectory = await mkdtemp(join(tmpdir(), 'tianxing-crm06-chrome-'))
    const httpPort = await reserveLoopbackPort()
    devServer = startNextDev(appDirectory, httpPort, target.connectionString)
    const listenUrl = `http://127.0.0.1:${httpPort}`
    await waitForNextDev(listenUrl, devServer)

    stage = 'canonical_origin'
    const baseUrl = await discoverCanonicalBaseUrl(listenUrl, httpPort)

    stage = 'chrome_launch'
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: CHROME,
      headless: true,
      baseURL: baseUrl,
      viewport: { width: 1440, height: 1000 },
    })
    context.setDefaultTimeout(30_000)
    const page = context.pages()[0] ?? await context.newPage()
    const browserMessages: string[] = []
    page.on('pageerror', () => { evidence.page_errors += 1 })
    page.on('console', (message) => { browserMessages.push(message.text()) })

    stage = 'login'
    await login(page, baseUrl, FOUNDER.email, passwords.get('founder')!)

    stage = 'founder_entry'
    await openStudents(page, baseUrl)
    const sourceEntry = page.getByRole('link', { name: '推薦來源', exact: true })
    await sourceEntry.waitFor({ state: 'visible' })
    evidence.founder_source_entry = await sourceEntry.count() === 1
    assert.equal(evidence.founder_source_entry, true)
    await sourceEntry.click()
    await openSourceDirectory(page, baseUrl)

    stage = 'source_validation'
    let sourcePosts = 0
    const sourceKeys: string[] = []
    const observeSourcePost = (request: { method(): string; url(): string; headers(): Record<string, string> }) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/referral-sources') {
        sourcePosts += 1
        sourceKeys.push(request.headers()['idempotency-key'] ?? '')
      }
    }
    page.on('request', observeSourcePost)
    await page.getByRole('button', { name: '建立來源', exact: true }).click()
    evidence.source_validation_zero_post = sourcePosts === 0
    assert.equal(evidence.source_validation_zero_post, true)

    stage = 'source_idempotency'
    await fillSourceCreate(page, 'CRM06 Synthetic Source A', 'bank')
    let intercepted = 0
    await page.route('**/api/v1/referral-sources', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      intercepted += 1
      if (intercepted <= 2) return route.abort('timedout')
      return route.continue()
    })
    const createButton = page.getByRole('button', { name: '建立來源', exact: true })
    await createButton.click()
    await unavailableNotice(page)
    await createButton.click()
    await unavailableNotice(page)
    evidence.source_retry_same_key = sourceKeys.length >= 2 && sourceKeys[0] !== '' && sourceKeys[0] === sourceKeys[1]
    assert.equal(evidence.source_retry_same_key, true)
    await page.getByRole('textbox', { name: '顯示名稱', exact: true }).fill('CRM06 Synthetic Source A Updated')
    const beforeDouble = sourcePosts
    await createButton.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click() })
    await page.getByRole('status').filter({ hasText: '推薦來源已建立' }).waitFor({ state: 'visible' })
    evidence.source_change_rotates_key = sourceKeys[2] !== '' && sourceKeys[2] !== sourceKeys[1]
    evidence.source_double_submit_posts = sourcePosts - beforeDouble
    assert.equal(evidence.source_change_rotates_key, true)
    assert.equal(evidence.source_double_submit_posts, 1)
    await page.unroute('**/api/v1/referral-sources')

    stage = 'source_create'
    const sourceA = await sourceFromDirectory(page, 'CRM06 Synthetic Source A Updated')
    assert.equal(sourceA.recordVersion, 1)

    stage = 'duplicate_name'
    await fillSourceCreate(page, 'CRM06 Duplicate Label', 'insurance')
    await createButton.click()
    await page.getByRole('status').filter({ hasText: '推薦來源已建立' }).waitFor({ state: 'visible' })
    const sourceB = await sourceFromDirectory(page, 'CRM06 Duplicate Label')
    await fillSourceCreate(page, 'CRM06 Duplicate Label', 'other_partner')
    await createButton.click()
    await page.getByRole('status').filter({ hasText: '推薦來源已建立' }).waitFor({ state: 'visible' })
    const duplicateLinks = page.getByRole('link', { name: 'CRM06 Duplicate Label', exact: true })
    evidence.duplicate_link_count = await duplicateLinks.count()
    evidence.duplicate_names_allowed = evidence.duplicate_link_count === 2
    assert.equal(evidence.duplicate_names_allowed, true)
    const duplicateSources = await Promise.all([
      sourceFromHref(await duplicateLinks.nth(0).getAttribute('href')),
      sourceFromHref(await duplicateLinks.nth(1).getAttribute('href')),
    ])
    evidence.duplicate_source_ids_unique = new Set(duplicateSources.map((source) => source.id)).size === 2
    assert.equal(evidence.duplicate_source_ids_unique, true)
    const sourceC = duplicateSources.find((source) => source.id !== sourceB.id)
    evidence.source_c_differs_source_b = sourceC !== undefined && sourceC.id !== sourceB.id
    assert.equal(evidence.source_c_differs_source_b, true)
    assert.ok(sourceC)

    stage = 'source_stale'
    await page.goto(`${baseUrl}/referral-sources/${sourceC.id}`, { waitUntil: 'domcontentloaded' })
    await sourceDetailReady(page)
    await page.getByRole('button', { name: '編輯來源', exact: true }).click()
    await page.getByRole('textbox', { name: '顯示名稱', exact: true }).fill('CRM06 Stale UI Draft')
    const staleSeed = await sourcePatch(page, sourceC.id, sourceC.recordVersion, 'CRM06 Server Update', 'active')
    assert.equal(staleSeed.status, 200)
    await page.getByRole('button', { name: '儲存來源', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '資料已有較新版本' }).waitFor({ state: 'visible' })
    evidence.source_stale_recovered = true

    stage = 'source_inactivate'
    await page.goto(`${baseUrl}/referral-sources/${sourceB.id}`, { waitUntil: 'domcontentloaded' })
    await sourceDetailReady(page)
    await page.getByRole('button', { name: '編輯來源', exact: true }).click()
    const inactivateCheckbox = page.getByRole('checkbox', { name: '停用此來源', exact: true })
    const inactivateButton = page.getByRole('button', { name: '儲存來源', exact: true })

    stage = 'source_inactivate_controls_ready'
    evidence.source_inactivate.checkbox_count = await inactivateCheckbox.count()
    evidence.source_inactivate.checkbox_visible = await inactivateCheckbox.isVisible()
    evidence.source_inactivate.submit_button_count = await inactivateButton.count()
    evidence.source_inactivate.submit_button_visible = await inactivateButton.isVisible()
    assert.equal(evidence.source_inactivate.checkbox_count, 1)
    assert.equal(evidence.source_inactivate.checkbox_visible, true)
    assert.equal(evidence.source_inactivate.submit_button_count, 1)
    assert.equal(evidence.source_inactivate.submit_button_visible, true)
    await inactivateCheckbox.check()

    const inactivatePath = `/api/v1/referral-sources/${sourceB.id}`
    const observeInactivateRequest = (request: { method(): string; url(): string }) => {
      if (new URL(request.url()).pathname !== inactivatePath) return
      if (request.method() === 'PATCH') evidence.source_inactivate.patch_request_started = true
      if (request.method() === 'GET') evidence.source_inactivate.get_request_started = true
    }
    page.on('request', observeInactivateRequest)
    const inactivatePatchResponse = page.waitForResponse((response) =>
      response.request().method() === 'PATCH' && new URL(response.url()).pathname === inactivatePath)
    const inactivateGetResponse = page
      .waitForResponse((response) => isGetPath(response, inactivatePath))
      .catch(() => null)

    stage = 'source_inactivate_submit'
    await inactivateButton.click()
    const patchResponse = await inactivatePatchResponse
    evidence.source_inactivate.patch_response_received = true
    evidence.source_inactivate.patch_status = patchResponse.status()
    assert.equal(evidence.source_inactivate.patch_request_started, true)
    assert.equal(evidence.source_inactivate.patch_response_received, true)
    assert.equal(evidence.source_inactivate.patch_status, 200)

    stage = 'source_inactivate_receipt_contract'
    let inactivateReceipt: ReferralSourceReceiptValidation | null = null
    try {
      inactivateReceipt = validateReferralSourceReceiptEnvelope(
        await patchResponse.json(),
        sourceB.id,
        sourceB.recordVersion + 1,
      )
      evidence.source_inactivate.patch_json_parseable = true
      evidence.source_inactivate.receipt_data_object = inactivateReceipt.dataObject
      evidence.source_inactivate.receipt_data_key_count = inactivateReceipt.dataKeyCount
      evidence.source_inactivate.receipt_exact_key_set = inactivateReceipt.exactKeySet
      evidence.source_inactivate.receipt_id_uuid_valid = inactivateReceipt.idUuidValid
      evidence.source_inactivate.receipt_id_matches_target = inactivateReceipt.idMatchesTarget
      evidence.source_inactivate.receipt_record_version_positive = inactivateReceipt.recordVersionPositive
      evidence.source_inactivate.receipt_record_version_matches_expected = inactivateReceipt.recordVersionMatchesExpected
      evidence.source_inactivate.exact_two_key_ack = inactivateReceipt.exact
    } catch {
      evidence.source_inactivate.patch_json_parseable = false
    }
    assert.equal(evidence.source_inactivate.patch_json_parseable, true)
    assert.equal(evidence.source_inactivate.exact_two_key_ack, true)
    assert.notEqual(inactivateReceipt, null)

    stage = 'source_inactivate_authoritative_refresh'
    const sourceResponse = await inactivateGetResponse
    assert.notEqual(sourceResponse, null)
    evidence.source_inactivate.get_response_received = true
    evidence.source_inactivate.get_status = sourceResponse!.status()
    try {
      evidence.source_inactivate.get_json_parseable = true
      evidence.source_inactivate.exact_inactive_source = validateInactiveReferralSourceEnvelope(
        await sourceResponse!.json(),
        sourceB.id,
        inactivateReceipt,
      )
    } catch {
      evidence.source_inactivate.get_json_parseable = false
    }
    assert.equal(evidence.source_inactivate.get_request_started, true)
    assert.equal(evidence.source_inactivate.get_response_received, true)
    assert.equal(evidence.source_inactivate.get_status, 200)
    assert.equal(evidence.source_inactivate.get_json_parseable, true)
    assert.equal(evidence.source_inactivate.exact_inactive_source, true)

    stage = 'source_inactivate_feedback'
    const inactivateFeedback = page.getByRole('status').filter({ hasText: '推薦來源已更新' })
    await inactivateFeedback.waitFor({ state: 'visible' })
    evidence.source_inactivate.feedback_count = await inactivateFeedback.count()
    evidence.source_inactivate.feedback_visible = await inactivateFeedback.isVisible()
    assert.equal(evidence.source_inactivate.feedback_count, 1)
    assert.equal(evidence.source_inactivate.feedback_visible, true)

    stage = 'source_inactivate_inactive_badge'
    page.off('request', observeInactivateRequest)
    const inactiveBadges = page.getByText('已停用', { exact: true })
    evidence.source_inactivate.inactive_badge_count = await inactiveBadges.count()
    evidence.source_inactivate.inactive_badge_visible = evidence.source_inactivate.inactive_badge_count > 0 && await inactiveBadges.first().isVisible()
    evidence.source_inactivated = evidence.source_inactivate.inactive_badge_count >= 1 && evidence.source_inactivate.inactive_badge_visible
    assert.equal(evidence.source_inactivated, true)

    stage = 'case_fixture_first_submit'
    const founderFixture = await createCaseFixture(page, ADVISOR.roleBindingId, 2037)
    evidence.case_fixture_first = founderFixture.evidence
    assert.equal(founderFixture.evidence.request_started, true)
    assert.equal(founderFixture.evidence.response_received, true)
    assert.equal(founderFixture.evidence.status, 200)
    stage = 'case_fixture_first_receipt'
    assert.equal(founderFixture.evidence.json_parseable, true)
    assert.equal(founderFixture.evidence.exact_case_success_dto, true)
    assert.equal(founderFixture.evidence.code, 'NONE')
    assert.notEqual(founderFixture.case, null)
    const founderCase = founderFixture.case!

    stage = 'case_fixture_second_submit'
    const advisorFixture = await createCaseFixture(page, ADVISOR.roleBindingId, 2038)
    evidence.case_fixture_second = advisorFixture.evidence
    assert.equal(advisorFixture.evidence.request_started, true)
    assert.equal(advisorFixture.evidence.response_received, true)
    assert.equal(advisorFixture.evidence.status, 200)
    stage = 'case_fixture_second_receipt'
    assert.equal(advisorFixture.evidence.json_parseable, true)
    assert.equal(advisorFixture.evidence.exact_case_success_dto, true)
    assert.equal(advisorFixture.evidence.code, 'NONE')
    assert.notEqual(advisorFixture.case, null)
    const advisorCase = advisorFixture.case!
    await openCaseReferralPanel(page, baseUrl, founderCase.id)

    stage = 'assignment_validation'
    let assignmentPosts = 0
    const assignmentKeys: string[] = []
    const observeAssignmentPost = (request: { method(): string; url(): string; headers(): Record<string, string> }) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/cases/${founderCase.id}/referral-source-assignments`) {
        assignmentPosts += 1
        assignmentKeys.push(request.headers()['idempotency-key'] ?? '')
      }
    }
    page.on('request', observeAssignmentPost)
    await page.getByRole('button', { name: '儲存來源', exact: true }).click()
    evidence.assignment_validation_zero_post = assignmentPosts === 0
    assert.equal(evidence.assignment_validation_zero_post, true)

    stage = 'assignment_idempotency'
    const assignmentSelect = page.getByRole('combobox', { name: '選擇有效來源', exact: true })
    await assignmentSelect.selectOption(sourceA.id)
    let assignmentIntercepted = 0
    const assignmentPath = `/api/v1/cases/${founderCase.id}/referral-source-assignments`
    await page.route(`**${assignmentPath}`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      assignmentIntercepted += 1
      if (assignmentIntercepted <= 2) return route.abort('timedout')
      return route.continue()
    })
    const assignmentButton = page.getByRole('button', { name: '儲存來源', exact: true })
    let activeAttempt: AssignmentAttemptEvidence | null = null
    const observeAssignmentAttempt = (request: { method(): string; url(): string; headers(): Record<string, string> }) => {
      if (activeAttempt === null || new URL(request.url()).pathname !== assignmentPath) return
      if (request.method() === 'POST') {
        activeAttempt.post_request_started = true
        activeAttempt.key_header_present = (request.headers()['idempotency-key'] ?? '') !== ''
        activeAttempt.post_count += 1
      } else if (request.method() === 'GET') {
        activeAttempt.get_request_started = true
      }
    }
    page.on('request', observeAssignmentAttempt)

    stage = 'retry_first_submit'
    activeAttempt = evidence.assignment_idempotency.retry_first
    const firstTimedOut = page.waitForEvent('requestfailed', (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === assignmentPath)
    await assignmentButton.click()
    await firstTimedOut
    assert.equal(evidence.assignment_idempotency.retry_first.post_request_started, true)
    assert.equal(evidence.assignment_idempotency.retry_first.key_header_present, true)
    assert.equal(evidence.assignment_idempotency.retry_first.post_count, 1)
    assert.equal(evidence.assignment_idempotency.retry_first.post_response_received, false)

    stage = 'retry_first_feedback'
    await assignmentUnavailable(page)
    const firstFeedback = page.getByRole('alert').filter({ hasText: '結果暫時無法確認' })
    evidence.assignment_idempotency.retry_first.feedback_count = await firstFeedback.count()
    evidence.assignment_idempotency.retry_first.feedback_visible = await firstFeedback.isVisible()
    assert.equal(evidence.assignment_idempotency.retry_first.feedback_count, 1)
    assert.equal(evidence.assignment_idempotency.retry_first.feedback_visible, true)

    stage = 'retry_second_submit'
    activeAttempt = evidence.assignment_idempotency.retry_second
    const secondTimedOut = page.waitForEvent('requestfailed', (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === assignmentPath)
    await assignmentButton.click()
    await secondTimedOut
    assert.equal(evidence.assignment_idempotency.retry_second.post_request_started, true)
    assert.equal(evidence.assignment_idempotency.retry_second.key_header_present, true)
    assert.equal(evidence.assignment_idempotency.retry_second.post_count, 1)
    assert.equal(evidence.assignment_idempotency.retry_second.post_response_received, false)

    stage = 'retry_second_feedback'
    await assignmentUnavailable(page)
    const secondFeedback = page.getByRole('alert').filter({ hasText: '結果暫時無法確認' })
    evidence.assignment_idempotency.retry_second.feedback_count = await secondFeedback.count()
    evidence.assignment_idempotency.retry_second.feedback_visible = await secondFeedback.isVisible()
    assert.equal(evidence.assignment_idempotency.retry_second.feedback_count, 1)
    assert.equal(evidence.assignment_idempotency.retry_second.feedback_visible, true)
    evidence.assignment_idempotency.same_key = assignmentKeys.length >= 2 && assignmentKeys[0] !== '' && assignmentKeys[0] === assignmentKeys[1]
    evidence.assignment_retry_same_key = evidence.assignment_idempotency.same_key
    assert.equal(evidence.assignment_retry_same_key, true)

    stage = 'changed_controls_ready'
    await assignmentSelect.selectOption(sourceC.id)
    evidence.assignment_idempotency.select_count = await assignmentSelect.count()
    evidence.assignment_idempotency.select_visible = await assignmentSelect.isVisible()
    evidence.assignment_idempotency.submit_button_count = await assignmentButton.count()
    evidence.assignment_idempotency.submit_button_visible = await assignmentButton.isVisible()
    assert.equal(evidence.assignment_idempotency.select_count, 1)
    assert.equal(evidence.assignment_idempotency.select_visible, true)
    assert.equal(evidence.assignment_idempotency.submit_button_count, 1)
    assert.equal(evidence.assignment_idempotency.submit_button_visible, true)

    const assignmentBeforeDouble = assignmentPosts
    activeAttempt = evidence.assignment_idempotency.changed
    const changedPostResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === assignmentPath)
    const changedGetResponse = page.waitForResponse((response) => isGetPath(response, assignmentPath))

    stage = 'changed_submit'
    await assignmentButton.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click() })
    const changedPost = await changedPostResponse
    evidence.assignment_idempotency.changed.post_response_received = true
    evidence.assignment_idempotency.changed.post_status = changedPost.status()
    assert.equal(evidence.assignment_idempotency.changed.post_request_started, true)
    assert.equal(evidence.assignment_idempotency.changed.key_header_present, true)
    assert.equal(evidence.assignment_idempotency.changed.post_status, 200)

    stage = 'changed_receipt_contract'
    let changedReceipt: AssignmentReceiptValidation | null = null
    try {
      changedReceipt = validateAssignmentReceiptEnvelope(await changedPost.json(), 1)
      evidence.assignment_idempotency.changed.post_json_parseable = true
      evidence.assignment_idempotency.changed.exact_two_key_ack = changedReceipt.exact
    } catch {
      evidence.assignment_idempotency.changed.post_json_parseable = false
    }
    assert.equal(evidence.assignment_idempotency.changed.post_json_parseable, true)
    assert.equal(evidence.assignment_idempotency.changed.exact_two_key_ack, true)
    assert.notEqual(changedReceipt, null)

    stage = 'changed_authoritative_refresh'
    const changedGet = await changedGetResponse
    evidence.assignment_idempotency.changed.get_response_received = true
    evidence.assignment_idempotency.changed.get_status = changedGet.status()
    let changedAuthority: AssignmentAuthorityValidation | null = null
    try {
      changedAuthority = validateAssignmentAuthorityEnvelope(await changedGet.json())
      evidence.assignment_idempotency.changed.get_json_parseable = true
      evidence.assignment_idempotency.changed.exact_current_history = changedAuthority.exact &&
        changedReceipt !== null && changedAuthority.currentId === changedReceipt.id &&
        changedAuthority.currentVersion === changedReceipt.recordVersion
      evidence.assignment_idempotency.changed_current_present = changedAuthority.currentSourceId !== null
      evidence.assignment_idempotency.changed_current_source_matches_source_c = changedAuthority.currentSourceId === sourceC.id
      evidence.assignment_idempotency.target_source_a_differs_current = changedAuthority.currentSourceId !== null && changedAuthority.currentSourceId !== sourceA.id
    } catch {
      evidence.assignment_idempotency.changed.get_json_parseable = false
    }
    assert.equal(evidence.assignment_idempotency.changed.get_request_started, true)
    assert.equal(evidence.assignment_idempotency.changed.get_response_received, true)
    assert.equal(evidence.assignment_idempotency.changed.get_status, 200)
    assert.equal(evidence.assignment_idempotency.changed.get_json_parseable, true)
    assert.equal(evidence.assignment_idempotency.changed.exact_current_history, true)
    assert.equal(evidence.assignment_idempotency.changed_current_present, true)
    assert.equal(evidence.assignment_idempotency.changed_current_source_matches_source_c, true)
    assert.equal(evidence.assignment_idempotency.target_source_a_differs_current, true)

    stage = 'changed_feedback'
    const changedFeedback = page.getByRole('status').filter({ hasText: '案件推薦來源已更新' })
    await changedFeedback.waitFor({ state: 'visible' })
    evidence.assignment_idempotency.changed.feedback_count = await changedFeedback.count()
    evidence.assignment_idempotency.changed.feedback_visible = await changedFeedback.isVisible()
    assert.equal(evidence.assignment_idempotency.changed.feedback_count, 1)
    assert.equal(evidence.assignment_idempotency.changed.feedback_visible, true)

    stage = 'changed_key_assertion'
    evidence.assignment_idempotency.changed_key = assignmentKeys.length >= 3 && assignmentKeys[2] !== '' && assignmentKeys[2] !== assignmentKeys[1]
    evidence.assignment_change_rotates_key = evidence.assignment_idempotency.changed_key
    assert.equal(evidence.assignment_change_rotates_key, true)

    stage = 'changed_double_submit_assertion'
    evidence.assignment_idempotency.changed_post_count = assignmentPosts - assignmentBeforeDouble
    evidence.assignment_double_submit_posts = evidence.assignment_idempotency.changed_post_count
    assert.equal(evidence.assignment_double_submit_posts, 1)
    activeAttempt = null
    page.off('request', observeAssignmentAttempt)
    await page.unroute(`**${assignmentPath}`)

    stage = 'replace_controls_ready'
    await assignmentSelect.selectOption(sourceA.id)
    const replacementConfirmation = page.getByRole('checkbox', { name: '確認更換目前來源', exact: true })
    const replacementButton = page.getByRole('button', { name: '確認更換來源', exact: true })
    const sourceAOption = await assignmentSelect.evaluate((element, sourceId) => {
      const options = [...(element as HTMLSelectElement).options].filter((option) => option.value === sourceId)
      return { count: options.length, disabled: options.length === 1 && options[0]!.disabled }
    }, sourceA.id)
    const assignmentPanel = page.getByRole('heading', { name: '案件推薦來源', exact: true, level: 3 }).locator('xpath=ancestor::section[1]')
    evidence.assignment_replace.source_option_count = sourceAOption.count
    evidence.assignment_replace.source_option_disabled = sourceAOption.disabled
    evidence.assignment_replace.select_value_matches_source_a = await assignmentSelect.inputValue() === sourceA.id
    evidence.assignment_replace.select_enabled = await assignmentSelect.isEnabled()
    evidence.assignment_replace.assign_control_still_visible = await assignmentSelect.isVisible()
    evidence.assignment_replace.native_checkbox_count = await assignmentPanel.locator('input[type="checkbox"]').count()
    evidence.assignment_replace.exact_accessible_checkbox_count = await replacementConfirmation.count()
    await replacementConfirmation.waitFor({ state: 'visible' })
    await replacementButton.waitFor({ state: 'visible' })
    evidence.assignment_replace.source_select_count = await assignmentSelect.count()
    evidence.assignment_replace.source_select_visible = await assignmentSelect.isVisible()
    evidence.assignment_replace.confirmation_count = await replacementConfirmation.count()
    evidence.assignment_replace.confirmation_visible = await replacementConfirmation.isVisible()
    evidence.assignment_replace.submit_button_count = await replacementButton.count()
    evidence.assignment_replace.submit_button_visible = await replacementButton.isVisible()
    assert.equal(evidence.assignment_replace.source_select_count, 1)
    assert.equal(evidence.assignment_replace.source_select_visible, true)
    assert.equal(evidence.assignment_replace.confirmation_count, 1)
    assert.equal(evidence.assignment_replace.confirmation_visible, true)
    assert.equal(evidence.assignment_replace.submit_button_count, 1)
    assert.equal(evidence.assignment_replace.submit_button_visible, true)
    await replacementConfirmation.check()

    const replacementPath = `/api/v1/cases/${founderCase.id}/referral-source-assignments`
    const observeReplacementRequest = (request: { method(): string; url(): string }) => {
      if (new URL(request.url()).pathname !== replacementPath) return
      if (request.method() === 'POST') evidence.assignment_replace.post_request_started = true
      if (request.method() === 'GET') evidence.assignment_replace.get_request_started = true
    }
    page.on('request', observeReplacementRequest)
    const replacementPostResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === replacementPath)
    const replacementGetResponse = page.waitForResponse((response) => isGetPath(response, replacementPath))

    stage = 'replace_submit'
    await replacementButton.click()
    const postResponse = await replacementPostResponse
    evidence.assignment_replace.post_response_received = true
    evidence.assignment_replace.post_status = postResponse.status()
    assert.equal(evidence.assignment_replace.post_request_started, true)
    assert.equal(evidence.assignment_replace.post_response_received, true)
    assert.equal(evidence.assignment_replace.post_status, 200)

    stage = 'replace_receipt_contract'
    let replacementReceipt: AssignmentReceiptValidation | null = null
    try {
      replacementReceipt = validateAssignmentReceiptEnvelope(await postResponse.json(), 2)
      evidence.assignment_replace.post_json_parseable = true
      evidence.assignment_replace.exact_two_key_ack = replacementReceipt.exact
    } catch {
      evidence.assignment_replace.post_json_parseable = false
    }
    assert.equal(evidence.assignment_replace.post_json_parseable, true)
    assert.equal(evidence.assignment_replace.exact_two_key_ack, true)
    assert.notEqual(replacementReceipt, null)

    stage = 'replace_authoritative_refresh'
    const getResponse = await replacementGetResponse
    evidence.assignment_replace.get_response_received = true
    evidence.assignment_replace.get_status = getResponse.status()
    let replacementAuthority: AssignmentAuthorityValidation | null = null
    try {
      replacementAuthority = validateAssignmentAuthorityEnvelope(await getResponse.json())
      evidence.assignment_replace.get_json_parseable = true
      evidence.assignment_replace.exact_current_history = replacementAuthority.exact &&
        replacementReceipt !== null && replacementAuthority.currentId === replacementReceipt.id &&
        replacementAuthority.currentVersion === replacementReceipt.recordVersion
    } catch {
      evidence.assignment_replace.get_json_parseable = false
    }
    assert.equal(evidence.assignment_replace.get_request_started, true)
    assert.equal(evidence.assignment_replace.get_response_received, true)
    assert.equal(evidence.assignment_replace.get_status, 200)
    assert.equal(evidence.assignment_replace.get_json_parseable, true)
    assert.equal(evidence.assignment_replace.exact_current_history, true)

    stage = 'replace_feedback'
    const replacementFeedback = page.getByRole('status').filter({ hasText: '案件推薦來源已更新' })
    await replacementFeedback.waitFor({ state: 'visible' })
    evidence.assignment_replace.feedback_count = await replacementFeedback.count()
    evidence.assignment_replace.feedback_visible = await replacementFeedback.isVisible()
    assert.equal(evidence.assignment_replace.feedback_count, 1)
    assert.equal(evidence.assignment_replace.feedback_visible, true)

    stage = 'replace_history'
    page.off('request', observeReplacementRequest)
    evidence.assignment_replace.history_count = await page.getByText('已結束', { exact: true }).count()
    evidence.assignment_history_preserved = evidence.assignment_replace.history_count >= 1
    assert.equal(evidence.assignment_history_preserved, true)

    stage = 'stale_current_version_read'
    const currentVersion = await currentAssignmentVersion(page, founderCase.id)
    evidence.assignment_stale.current_version_positive = Number.isSafeInteger(currentVersion) && currentVersion > 0
    assert.equal(evidence.assignment_stale.current_version_positive, true)

    const stalePath = `/api/v1/cases/${founderCase.id}/referral-source-assignments`
    let staleRequestPhase: 'seed' | 'ui' = 'seed'
    const observeStaleRequest = (request: { method(): string; url(): string }) => {
      if (new URL(request.url()).pathname !== stalePath) return
      if (request.method() === 'POST') {
        if (staleRequestPhase === 'seed') evidence.assignment_stale.seed_request_started = true
        else evidence.assignment_stale.ui_request_started = true
      } else if (request.method() === 'GET' && staleRequestPhase === 'ui') {
        evidence.assignment_stale.get_request_started = true
      }
    }
    page.on('request', observeStaleRequest)

    stage = 'stale_seed_submit'
    const seedResponsePromise = page
      .waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === stalePath)
      .catch(() => null)
    const staleAssignment = await assignmentPost(page, founderCase.id, sourceC.id, currentVersion)
    const seedResponse = await seedResponsePromise
    assert.notEqual(seedResponse, null)
    evidence.assignment_stale.seed_response_received = true
    evidence.assignment_stale.seed_status = seedResponse!.status()
    assert.equal(evidence.assignment_stale.seed_request_started, true)
    assert.equal(evidence.assignment_stale.seed_response_received, true)
    assert.equal(evidence.assignment_stale.seed_status, 200)
    assert.equal(staleAssignment.status, 200)

    stage = 'stale_seed_receipt'
    let staleSeedReceipt: AssignmentReceiptValidation | null = null
    try {
      staleSeedReceipt = validateAssignmentReceiptEnvelope(await seedResponse!.json(), currentVersion + 1)
      evidence.assignment_stale.seed_json_parseable = true
      evidence.assignment_stale.seed_exact_two_key_ack = staleSeedReceipt.exact
    } catch {
      evidence.assignment_stale.seed_json_parseable = false
    }
    assert.equal(evidence.assignment_stale.seed_json_parseable, true)
    assert.equal(evidence.assignment_stale.seed_exact_two_key_ack, true)
    assert.notEqual(staleSeedReceipt, null)

    stage = 'stale_controls_ready'
    await assignmentSelect.selectOption(sourceC.id)
    const staleConfirmation = page.getByRole('checkbox', { name: '確認更換目前來源', exact: true })
    const staleSubmitButton = page.getByRole('button', { name: '確認更換來源', exact: true })
    await staleConfirmation.waitFor({ state: 'visible' })
    await staleSubmitButton.waitFor({ state: 'visible' })
    evidence.assignment_stale.checkbox_count = await staleConfirmation.count()
    evidence.assignment_stale.checkbox_visible = await staleConfirmation.isVisible()
    evidence.assignment_stale.submit_button_count = await staleSubmitButton.count()
    evidence.assignment_stale.submit_button_visible = await staleSubmitButton.isVisible()
    assert.equal(evidence.assignment_stale.checkbox_count, 1)
    assert.equal(evidence.assignment_stale.checkbox_visible, true)
    assert.equal(evidence.assignment_stale.submit_button_count, 1)
    assert.equal(evidence.assignment_stale.submit_button_visible, true)
    await staleConfirmation.check()

    staleRequestPhase = 'ui'
    const staleUiResponsePromise = page
      .waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === stalePath)
      .catch(() => null)
    const staleGetResponsePromise = page.waitForResponse((response) => isGetPath(response, stalePath)).catch(() => null)

    stage = 'stale_ui_submit'
    await staleSubmitButton.click()
    const staleUiResponse = await staleUiResponsePromise
    assert.notEqual(staleUiResponse, null)
    evidence.assignment_stale.ui_response_received = true
    evidence.assignment_stale.ui_status = staleUiResponse!.status()
    assert.equal(evidence.assignment_stale.ui_request_started, true)
    assert.equal(evidence.assignment_stale.ui_response_received, true)

    stage = 'stale_ui_status'
    try {
      const rawStaleResponse = await staleUiResponse!.text()
      const parsedStaleResponse = JSON.parse(rawStaleResponse) as unknown
      evidence.assignment_stale.ui_json_parseable = true
      const root = browserRecord(parsedStaleResponse)
      const error = root === null ? null : browserRecord(root.error)
      evidence.assignment_stale.ui_stale_version_code = error?.code === 'STALE_VERSION'
      evidence.assignment_stale.ui_private_echo = rawStaleResponse.includes(sourceC.id)
    } catch {
      evidence.assignment_stale.ui_json_parseable = false
    }
    assert.equal(evidence.assignment_stale.ui_status, 409)
    assert.equal(evidence.assignment_stale.ui_json_parseable, true)
    assert.equal(evidence.assignment_stale.ui_stale_version_code, true)
    assert.equal(evidence.assignment_stale.ui_private_echo, false)

    stage = 'stale_authoritative_refresh'
    const staleGetResponse = await staleGetResponsePromise
    assert.notEqual(staleGetResponse, null)
    evidence.assignment_stale.get_response_received = true
    evidence.assignment_stale.get_status = staleGetResponse!.status()
    let staleAuthority: AssignmentAuthorityValidation | null = null
    try {
      staleAuthority = validateAssignmentAuthorityEnvelope(await staleGetResponse!.json())
      evidence.assignment_stale.get_json_parseable = true
      evidence.assignment_stale.get_exact_current_history = staleAuthority.exact &&
        staleSeedReceipt !== null && staleAuthority.currentId === staleSeedReceipt.id &&
        staleAuthority.currentSourceId === sourceC.id &&
        staleAuthority.currentVersion === staleSeedReceipt.recordVersion
    } catch {
      evidence.assignment_stale.get_json_parseable = false
    }
    assert.equal(evidence.assignment_stale.get_request_started, true)
    assert.equal(evidence.assignment_stale.get_response_received, true)
    assert.equal(evidence.assignment_stale.get_status, 200)
    assert.equal(evidence.assignment_stale.get_json_parseable, true)
    assert.equal(evidence.assignment_stale.get_exact_current_history, true)

    stage = 'stale_feedback'
    page.off('request', observeStaleRequest)
    const staleAlert = page.getByRole('alert').filter({ hasText: '案件來源已有較新版本' })
    await staleAlert.waitFor({ state: 'visible' })
    evidence.assignment_stale.alert_count = await staleAlert.count()
    evidence.assignment_stale.alert_visible = await staleAlert.isVisible()
    assert.equal(evidence.assignment_stale.alert_count, 1)
    assert.equal(evidence.assignment_stale.alert_visible, true)
    evidence.assignment_stale_recovered = true

    stage = 'assignment_persistence'
    await openCaseReferralPanel(page, baseUrl, founderCase.id)
    await logout(page)
    await login(page, baseUrl, FOUNDER.email, passwords.get('founder')!)
    await openCaseReferralPanel(page, baseUrl, founderCase.id)
    evidence.relogin_persisted = await page.getByText('目前使用', { exact: true }).count() === 1 && await page.getByText('已結束', { exact: true }).count() >= 2
    assert.equal(evidence.relogin_persisted, true)

    stage = 'advisor_read_assign'
    await logout(page)
    await login(page, baseUrl, ADVISOR.email, passwords.get('advisor')!)
    await page.goto(`${baseUrl}/referral-sources`, { waitUntil: 'domcontentloaded' })
    await openSourceDirectory(page, baseUrl)
    evidence.advisor_read_only_source = await page.getByRole('button', { name: '建立來源', exact: true }).count() === 0
    assert.equal(evidence.advisor_read_only_source, true)
    await openCaseReferralPanel(page, baseUrl, advisorCase.id)
    await page.getByRole('combobox', { name: '選擇有效來源', exact: true }).selectOption(sourceA.id)
    await page.getByRole('button', { name: '儲存來源', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '案件推薦來源已更新' }).waitFor({ state: 'visible' })
    evidence.advisor_assigned_case_write = true

    stage = 'advisor_scope_denied_transport'
    const advisorDenied = await assignmentPost(page, founderCase.id, sourceA.id, null)
    evidence.advisor_scope_denied = {
      fetch_completed: advisorDenied.fetchCompleted,
      json_parseable: advisorDenied.jsonParseable,
      status: advisorDenied.status,
      code: advisorDenied.code,
      private_echo: advisorDenied.privateEcho,
    }
    assert.equal(evidence.advisor_scope_denied.fetch_completed, true)
    assert.equal(evidence.advisor_scope_denied.json_parseable, true)

    stage = 'advisor_scope_denied_status'
    assert.equal(evidence.advisor_scope_denied.status, 404)

    stage = 'advisor_scope_denied_contract'
    assert.equal(evidence.advisor_scope_denied.code, 'NOT_FOUND')

    stage = 'advisor_scope_denied_privacy'
    assert.equal(evidence.advisor_scope_denied.private_echo, false)
    evidence.advisor_unassigned_direct_404 = advisorDenied.status === 404 && advisorDenied.code === 'NOT_FOUND' && !advisorDenied.privateEcho
    assert.equal(evidence.advisor_unassigned_direct_404, true)

    stage = 'admin_manage_no_case'
    await logout(page)
    await login(page, baseUrl, ADMIN.email, passwords.get('admin')!)
    await page.goto(`${baseUrl}/referral-sources`, { waitUntil: 'domcontentloaded' })
    await openSourceDirectory(page, baseUrl)
    evidence.admin_source_manage = await page.getByRole('button', { name: '建立來源', exact: true }).count() === 1
    assert.equal(evidence.admin_source_manage, true)
    await page.goto(`${baseUrl}/cases`, { waitUntil: 'domcontentloaded' })
    await page.getByText('無法查看案件', { exact: true }).waitFor({ state: 'visible' })
    evidence.admin_case_entry_hidden = await page.getByRole('link', { name: '案件', exact: true }).count() === 0
    assert.equal(evidence.admin_case_entry_hidden, true)
    const adminDenied = await assignmentPost(page, founderCase.id, sourceA.id, null)
    assert.equal(adminDenied.status, 403)
    assert.equal(adminDenied.code, 'FORBIDDEN')

    stage = 'denied_roles'
    for (const actor of [DATA_REVIEWER, CONTRACTOR]) {
      await logout(page)
      await login(page, baseUrl, actor.email, passwords.get(actor.role)!)
      await page.goto(`${baseUrl}/referral-sources`, { waitUntil: 'domcontentloaded' })
      await page.getByText('無法查看推薦來源', { exact: true }).waitFor({ state: 'visible' })
      assert.equal(await page.getByRole('button', { name: '建立來源', exact: true }).count(), 0)
      const sourceDenied = await directRequest(page, '/api/v1/referral-sources', 'POST', { display_name: 'CRM06 Denied', source_type: 'bank' })
      const assignmentDenied = await assignmentPost(page, founderCase.id, sourceA.id, null)
      if (sourceDenied.status === 403 && sourceDenied.code === 'FORBIDDEN' && !sourceDenied.privateEcho) evidence.denied_role_source_403 += 1
      if (assignmentDenied.status === 403 && assignmentDenied.code === 'FORBIDDEN' && !assignmentDenied.privateEcho) evidence.denied_role_assignment_403 += 1
    }
    assert.equal(evidence.denied_role_source_403, 2)
    assert.equal(evidence.denied_role_assignment_403, 2)

    stage = 'desktop_viewport'
    await logout(page)
    await login(page, baseUrl, FOUNDER.email, passwords.get('founder')!)
    await page.goto(`${baseUrl}/referral-sources`, { waitUntil: 'domcontentloaded' })
    await openSourceDirectory(page, baseUrl)
    evidence.desktop = await viewportEvidence(page)
    assert.deepEqual(evidence.desktop, zeroViewport())

    stage = 'mobile_viewport'
    await page.setViewportSize({ width: 390, height: 844 })
    await openCaseReferralPanel(page, baseUrl, founderCase.id)
    evidence.mobile = await viewportEvidence(page)
    assert.deepEqual(evidence.mobile, zeroViewport())

    stage = 'browser_log_safety'
    const sensitiveValues = [
      ...NEON_TEST_STUDENTS.flatMap((student) => [student.displayName, student.contactEmail ?? '']),
      ...ACTORS.map(({ email }) => email), ...passwords.values(), applicationPassword,
      'postgresql://', 'tx_session=',
    ].filter(Boolean)
    evidence.sensitive_log_matches = browserMessages.filter((message) => sensitiveValues.some((value) => message.includes(value))).length
    assert.equal(evidence.page_errors, 0)
    assert.equal(evidence.sensitive_log_matches, 0)
    assertNoSensitiveDevLogs(devServer, sensitiveValues)
    stage = 'complete'
  } catch {
    failureStage = stage
  } finally {
    const cleanupStage: Stage = 'cleanup'
    cleanup.context_closed = await closeContext(context)
    cleanup.dev_stopped = await stopNextDev(devServer)
    cleanup.app_removed = await removeDirectory(appDirectory)
    cleanup.profile_removed = await removeDirectory(profileDirectory)
    cleanup.container_removed = !containerStarted || (await runDocker(['rm', '--force', containerName], cleanupStage, undefined, true)).exitCode === 0
    cleanup.volume_removed = !volumeCreated || (await runDocker(['volume', 'rm', '--force', volumeName], cleanupStage, undefined, true)).exitCode === 0
  }

  const cleanupComplete = Object.values(cleanup).every(Boolean)
  process.stdout.write(`${JSON.stringify({
    status: failureStage === null && cleanupComplete ? 'pass' : 'failed',
    stage: failureStage ?? (cleanupComplete ? 'complete' : 'cleanup'),
    evidence,
    cleanup,
    local_dev: failureStage === null && cleanupComplete ? 'pass' : 'failed',
    vercel_test: 'not_run_unverified',
    aws_production: 'not_run_unverified',
  })}\n`)
  if (failureStage !== null || !cleanupComplete) throw new BrowserGateError(failureStage ?? 'cleanup')
})

async function openStudents(page: Page, baseUrl: string): Promise<void> {
  const students = page.waitForResponse((response) => isGetPath(response, '/api/v1/students'))
  const accessResponse = page.waitForResponse((response) => isGetPath(response, '/api/v1/auth/me'))
  assert.equal((await page.goto(`${baseUrl}/students`, { waitUntil: 'domcontentloaded' }))?.status(), 200)
  assert.equal((await students).status(), 200)
  assert.equal((await accessResponse).status(), 200)
  await page.getByRole('heading', { name: '學生與監護人', exact: true, level: 2 }).waitFor({ state: 'visible' })
  await page.getByText(/顯示 \d+ \/ \d+ 位學生/).waitFor({ state: 'visible' })
}

async function openSourceDirectory(page: Page, baseUrl: string): Promise<void> {
  if (new URL(page.url()).pathname !== '/referral-sources') {
    assert.equal((await page.goto(`${baseUrl}/referral-sources`, { waitUntil: 'domcontentloaded' }))?.status(), 200)
  }
  await page.getByRole('heading', { name: '推薦來源', exact: true, level: 2 }).waitFor({ state: 'visible' })
  await page.getByRole('heading', { name: '來源名單', exact: true, level: 3 }).waitFor({ state: 'visible' })
  await page.getByText('正在載入推薦來源', { exact: true }).waitFor({ state: 'hidden' })
}

async function fillSourceCreate(page: Page, name: string, type: 'bank' | 'insurance' | 'other_partner'): Promise<void> {
  await page.getByRole('textbox', { name: '顯示名稱', exact: true }).fill(name)
  await page.getByRole('combobox', { name: '來源類型', exact: true }).selectOption(type)
}

async function unavailableNotice(page: Page): Promise<void> {
  await page.getByRole('alert').filter({ hasText: '結果暫時無法確認' }).waitFor({ state: 'visible' })
}

async function assignmentUnavailable(page: Page): Promise<void> {
  await page.getByRole('alert').filter({ hasText: '結果暫時無法確認' }).waitFor({ state: 'visible' })
}

async function sourceFromDirectory(page: Page, label: string): Promise<CreatedSource> {
  const links = page.getByRole('link', { name: label, exact: true })
  await links.first().waitFor({ state: 'visible' })
  const source = await sourceFromHref(await links.first().getAttribute('href'))
  const secondary = await links.first().locator('xpath=..').getByText(/版本 \d+/).textContent()
  const version = Number(/版本 (\d+)/.exec(secondary ?? '')?.[1])
  assert.equal(Number.isSafeInteger(version) && version > 0, true)
  return { id: source.id, recordVersion: version }
}

async function sourceFromHref(href: string | null): Promise<CreatedSource> {
  const id = /^\/referral-sources\/([0-9a-f-]+)$/i.exec(href ?? '')?.[1] ?? ''
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
  return { id, recordVersion: 1 }
}

async function sourceDetailReady(page: Page): Promise<void> {
  await page.getByRole('heading', { name: '來源資料', exact: true, level: 3 }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '編輯來源', exact: true }).waitFor({ state: 'visible' })
}

async function openCaseReferralPanel(page: Page, baseUrl: string, caseId: string): Promise<void> {
  const assignments = page.waitForResponse((response) => isGetPath(response, `/api/v1/cases/${caseId}/referral-source-assignments`))
  assert.equal((await page.goto(`${baseUrl}/cases/${caseId}`, { waitUntil: 'domcontentloaded' }))?.status(), 200)
  await page.getByRole('heading', { name: '案件推薦來源', exact: true, level: 3 }).waitFor({ state: 'visible' })
  assert.equal((await assignments).status(), 200)
  await page.getByText('正在載入案件推薦來源', { exact: true }).waitFor({ state: 'hidden' })
}

async function createCaseFixture(
  page: Page,
  bindingId: string,
  intakeYear: number,
): Promise<{ readonly case: CreatedCase | null; readonly evidence: CaseFixtureEvidence }> {
  return page.evaluate(async ({ binding, year, manifest, student }) => {
    const emptyEvidence: CaseFixtureEvidence = {
      request_started: true,
      response_received: false,
      status: null,
      json_parseable: false,
      exact_case_success_dto: false,
      code: null,
    }
    try {
      const response = await fetch('/api/v1/cases', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `crm06-case-${crypto.randomUUID()}` },
        body: JSON.stringify({ student_id: student, intake_year: year, admission_type: 'transfer', primary_role_binding_id: binding, manifest_id: manifest }),
      })
      const evidence = { ...emptyEvidence, response_received: true, status: response.status }
      let envelope: unknown
      try {
        envelope = JSON.parse(await response.text())
        evidence.json_parseable = true
      } catch {
        return { case: null, evidence }
      }
      if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
        return { case: null, evidence }
      }
      const root = envelope as Record<string, unknown>
      const error = typeof root.error === 'object' && root.error !== null && !Array.isArray(root.error)
        ? root.error as Record<string, unknown>
        : null
      const rawCode = error?.code
      const safeCodes = [
        'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED',
        'STALE_VERSION', 'CONFLICT', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR',
      ] as const
      evidence.code = response.ok
        ? 'NONE'
        : typeof rawCode === 'string' && (safeCodes as readonly string[]).includes(rawCode)
          ? rawCode as CaseFixtureSafeCode
          : 'OTHER'
      const data = root.data
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return { case: null, evidence }
      }
      const dataRecord = data as Record<string, unknown>
      if (
        Object.keys(dataRecord).length !== 2 ||
        !Object.hasOwn(dataRecord, 'id') ||
        !Object.hasOwn(dataRecord, 'record_version')
      ) {
        return { case: null, evidence }
      }
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      if (typeof dataRecord.id !== 'string' || !uuid.test(dataRecord.id) || dataRecord.record_version !== 2) {
        return { case: null, evidence }
      }
      const caseId = dataRecord.id
      const authorityResponse = await fetch(`/api/v1/cases/${caseId}`)
      const authorityEnvelope = await authorityResponse.json() as unknown
      if (authorityResponse.status !== 200 || typeof authorityEnvelope !== 'object' || authorityEnvelope === null || Array.isArray(authorityEnvelope)) {
        return { case: null, evidence }
      }
      const authorityRoot = authorityEnvelope as Record<string, unknown>
      const authorityData = authorityRoot.data
      if (typeof authorityData !== 'object' || authorityData === null || Array.isArray(authorityData)) {
        return { case: null, evidence }
      }
      const authorityDataRecord = authorityData as Record<string, unknown>
      if (Object.keys(authorityDataRecord).length !== 1 || typeof authorityDataRecord.case !== 'object' ||
          authorityDataRecord.case === null || Array.isArray(authorityDataRecord.case)) {
        return { case: null, evidence }
      }
      const record = authorityDataRecord.case as Record<string, unknown>
      const exactKeys = [
        'id', 'caseNumber', 'studentId', 'studentName', 'intakeYear', 'admissionType',
        'stage', 'workflowStatus', 'recordVersion', 'availableWorkflowActions', 'updatedAt',
        'primaryRole', 'assessmentId', 'assessmentStatus', 'manifestId',
        'primaryBindingLabel', 'primaryUserId',
      ] as const
      evidence.exact_case_success_dto =
        Object.keys(record).length === exactKeys.length &&
        exactKeys.every((key) => Object.hasOwn(record, key)) &&
        record.id === caseId &&
        typeof record.caseNumber === 'string' && record.caseNumber.trim() !== '' &&
        record.studentId === student &&
        typeof record.assessmentId === 'string' && uuid.test(record.assessmentId) &&
        record.intakeYear === year && record.admissionType === 'transfer' &&
        record.stage === 'background_collection' && record.workflowStatus === 'active' &&
        record.manifestId === manifest && record.recordVersion === dataRecord.record_version
      return {
        case: evidence.exact_case_success_dto ? { id: caseId } : null,
        evidence,
      }
    } catch {
      return { case: null, evidence: emptyEvidence }
    }
  }, { binding: bindingId, year: intakeYear, manifest: NEON_TEST_MANIFEST_ID, student: NEON_TEST_STUDENTS[0]!.id })
}

function emptyCaseFixtureEvidence(): CaseFixtureEvidence {
  return {
    request_started: false,
    response_received: false,
    status: null,
    json_parseable: false,
    exact_case_success_dto: false,
    code: null,
  }
}

function emptySourceInactivateEvidence(): SourceInactivateEvidence {
  return {
    checkbox_count: 0,
    checkbox_visible: false,
    submit_button_count: 0,
    submit_button_visible: false,
    patch_request_started: false,
    patch_response_received: false,
    patch_status: null,
    patch_json_parseable: false,
    receipt_data_object: false,
    receipt_data_key_count: 0,
    receipt_exact_key_set: false,
    receipt_id_uuid_valid: false,
    receipt_id_matches_target: false,
    receipt_record_version_positive: false,
    receipt_record_version_matches_expected: false,
    exact_two_key_ack: false,
    get_request_started: false,
    get_response_received: false,
    get_status: null,
    get_json_parseable: false,
    exact_inactive_source: false,
    feedback_count: 0,
    feedback_visible: false,
    inactive_badge_count: 0,
    inactive_badge_visible: false,
  }
}

function validateReferralSourceReceiptEnvelope(
  value: unknown,
  expectedId: string,
  expectedVersion: number,
): ReferralSourceReceiptValidation {
  const root = browserRecord(value)
  const data = root === null ? null : browserRecord(root.data)
  const dataObject = data !== null
  const dataKeyCount = data === null ? 0 : Object.keys(data).length
  const exactKeySet = data !== null && browserExactKeys(data, ['id', 'record_version'])
  const idUuidValid = data !== null && browserUuid(data.id)
  const idMatchesTarget = data !== null && data.id === expectedId
  const recordVersionPositive = data !== null && browserPositiveInteger(data.record_version)
  const recordVersionMatchesExpected = data !== null && data.record_version === expectedVersion
  const exact = dataObject && exactKeySet && idUuidValid && idMatchesTarget &&
    recordVersionPositive && recordVersionMatchesExpected
  return {
    exact,
    dataObject,
    dataKeyCount,
    exactKeySet,
    idUuidValid,
    idMatchesTarget,
    recordVersionPositive,
    recordVersionMatchesExpected,
    id: exact ? data.id as string : null,
    recordVersion: exact ? data.record_version as number : null,
  }
}

function validateInactiveReferralSourceEnvelope(
  value: unknown,
  expectedId: string,
  receipt: ReferralSourceReceiptValidation | null,
): boolean {
  const root = browserRecord(value)
  const data = root === null ? null : browserRecord(root.data)
  return data !== null && browserExactKeys(data, [
    'id', 'display_name', 'source_type', 'status', 'record_version',
  ]) && data.id === expectedId && browserUuid(data.id) &&
    typeof data.display_name === 'string' && data.display_name.trim() === data.display_name &&
    data.display_name !== '' && data.display_name.length <= 200 &&
    ['bank', 'insurance', 'other_partner'].includes(String(data.source_type)) &&
    data.status === 'inactive' && browserPositiveInteger(data.record_version) &&
    receipt !== null && receipt.exact && data.id === receipt.id && data.record_version === receipt.recordVersion
}

function emptyAssignmentAttemptEvidence(): AssignmentAttemptEvidence {
  return {
    post_request_started: false,
    post_response_received: false,
    post_status: null,
    post_json_parseable: false,
    exact_two_key_ack: false,
    get_request_started: false,
    get_response_received: false,
    get_status: null,
    get_json_parseable: false,
    exact_current_history: false,
    key_header_present: false,
    post_count: 0,
    feedback_count: 0,
    feedback_visible: false,
  }
}

function emptyAssignmentIdempotencyEvidence(): AssignmentIdempotencyEvidence {
  return {
    retry_first: emptyAssignmentAttemptEvidence(),
    retry_second: emptyAssignmentAttemptEvidence(),
    changed: emptyAssignmentAttemptEvidence(),
    select_count: 0,
    select_visible: false,
    submit_button_count: 0,
    submit_button_visible: false,
    same_key: false,
    changed_key: false,
    changed_post_count: null,
    changed_current_present: false,
    changed_current_source_matches_source_c: false,
    target_source_a_differs_current: false,
  }
}

function emptyAssignmentStaleEvidence(): AssignmentStaleEvidence {
  return {
    current_version_positive: false,
    seed_request_started: false,
    seed_response_received: false,
    seed_status: null,
    seed_json_parseable: false,
    seed_exact_two_key_ack: false,
    checkbox_count: 0,
    checkbox_visible: false,
    submit_button_count: 0,
    submit_button_visible: false,
    ui_request_started: false,
    ui_response_received: false,
    ui_status: null,
    ui_json_parseable: false,
    ui_stale_version_code: false,
    ui_private_echo: false,
    get_request_started: false,
    get_response_received: false,
    get_status: null,
    get_json_parseable: false,
    get_exact_current_history: false,
    alert_count: 0,
    alert_visible: false,
  }
}

function emptyAssignmentReplaceEvidence(): AssignmentReplaceEvidence {
  return {
    source_option_count: 0,
    source_option_disabled: false,
    select_value_matches_source_a: false,
    select_enabled: false,
    assign_control_still_visible: false,
    native_checkbox_count: 0,
    exact_accessible_checkbox_count: 0,
    source_select_count: 0,
    source_select_visible: false,
    confirmation_count: 0,
    confirmation_visible: false,
    submit_button_count: 0,
    submit_button_visible: false,
    post_request_started: false,
    post_response_received: false,
    post_status: null,
    post_json_parseable: false,
    exact_two_key_ack: false,
    get_request_started: false,
    get_response_received: false,
    get_status: null,
    get_json_parseable: false,
    exact_current_history: false,
    feedback_count: 0,
    feedback_visible: false,
    history_count: 0,
  }
}

function validateAssignmentReceiptEnvelope(value: unknown, expectedVersion: number): AssignmentReceiptValidation {
  const root = browserRecord(value)
  const data = root === null ? null : browserRecord(root.data)
  const exact = data !== null && browserExactKeys(data, ['id', 'record_version']) &&
    browserUuid(data.id) && browserPositiveInteger(data.record_version) && data.record_version === expectedVersion
  return {
    exact,
    id: exact ? data.id as string : null,
    recordVersion: exact ? data.record_version as number : null,
  }
}

function validateAssignmentAuthorityEnvelope(value: unknown): AssignmentAuthorityValidation {
  const root = browserRecord(value)
  const data = root === null ? null : browserRecord(root.data)
  if (data === null || !browserExactKeys(data, ['current', 'history']) || !Array.isArray(data.history)) {
    return { exact: false, currentId: null, currentSourceId: null, currentVersion: null, historyCount: 0 }
  }
  const current = validateAssignmentRecord(data.current, 'current')
  const history = data.history.map((item) => validateAssignmentRecord(item, 'history'))
  let exact = current !== null && history.length <= 100 && history.every((item) => item !== null)
  const validHistory = history.filter((item): item is BrowserAssignmentRecord => item !== null)
  if (exact && current !== null) {
    const ids = new Set(validHistory.map((item) => item.id))
    exact = ids.size === validHistory.length && !ids.has(current.id)
    for (let index = 1; exact && index < validHistory.length; index += 1) {
      const previous = validHistory[index - 1]!
      const next = validHistory[index]!
      const order = previous.endsAt === next.endsAt
        ? previous.id.localeCompare(next.id)
        : previous.endsAt! > next.endsAt! ? -1 : 1
      exact = order <= 0 && previous.recordVersion === next.recordVersion + 1
    }
    if (exact && validHistory.length > 0) {
      exact = validHistory[0]!.recordVersion === current.recordVersion
    }
  }
  return {
    exact,
    currentId: exact && current !== null ? current.id : null,
    currentSourceId: exact && current !== null ? current.referralSourceId : null,
    currentVersion: exact && current !== null ? current.recordVersion : null,
    historyCount: validHistory.length,
  }
}

interface BrowserAssignmentRecord {
  readonly id: string
  readonly referralSourceId: string
  readonly endsAt: string | null
  readonly recordVersion: number
}

function validateAssignmentRecord(value: unknown, state: 'current' | 'history'): BrowserAssignmentRecord | null {
  const record = browserRecord(value)
  if (record === null || !browserExactKeys(record, [
    'id', 'referral_source_id', 'source_display_name', 'source_type',
    'source_record_version', 'starts_at', 'ends_at', 'record_version',
  ])) return null
  const validEndsAt = state === 'current'
    ? record.ends_at === null
    : browserIsoTimestamp(record.ends_at)
  if (
    !browserUuid(record.id) || !browserUuid(record.referral_source_id) ||
    typeof record.source_display_name !== 'string' || record.source_display_name.trim() !== record.source_display_name ||
    record.source_display_name === '' || record.source_display_name.length > 200 ||
    !['bank', 'insurance', 'other_partner'].includes(String(record.source_type)) ||
    !browserPositiveInteger(record.source_record_version) || !browserIsoTimestamp(record.starts_at) ||
    !validEndsAt || !browserPositiveInteger(record.record_version)
  ) return null
  return {
    id: record.id,
    referralSourceId: record.referral_source_id,
    endsAt: record.ends_at as string | null,
    recordVersion: record.record_version,
  }
}

function browserRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function browserExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  const actual = Object.keys(record)
  return actual.length === expected.size && actual.every((key) => expected.has(key))
}

function browserUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function browserPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function browserIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value))
}

async function sourcePatch(page: Page, sourceId: string, version: number, name: string, status: 'active' | 'inactive') {
  return directRequest(page, `/api/v1/referral-sources/${sourceId}`, 'PATCH', { expected_record_version: version, display_name: name, status })
}

async function assignmentPost(page: Page, caseId: string, sourceId: string, expectedVersion: number | null) {
  return directRequest(page, `/api/v1/cases/${caseId}/referral-source-assignments`, 'POST', { referral_source_id: sourceId, expected_current_assignment_record_version: expectedVersion })
}

async function currentAssignmentVersion(page: Page, caseId: string): Promise<number> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { cache: 'no-store' })
    const envelope = await response.json() as { data?: { current?: { record_version?: unknown } } }
    const version = envelope.data?.current?.record_version
    if (response.status !== 200 || typeof version !== 'number') throw new Error('assignment_fixture')
    return version
  }, `/api/v1/cases/${caseId}/referral-source-assignments`)
}

async function directRequest(page: Page, path: string, method: 'POST' | 'PATCH', payload: Record<string, unknown>) {
  return page.evaluate(async ({ requestPath, requestMethod, requestPayload }) => {
    try {
      const response = await fetch(requestPath, {
        method: requestMethod,
        headers: { 'content-type': 'application/json', 'idempotency-key': `crm06-direct-${crypto.randomUUID()}` },
        body: JSON.stringify(requestPayload),
      })
      const text = await response.text()
      let code: DirectRequestSafeCode = response.ok ? 'NONE' : 'OTHER'
      let jsonParseable = false
      try {
        const value = JSON.parse(text) as { error?: { code?: unknown } }
        jsonParseable = true
        if (value.error?.code === 'FORBIDDEN') code = 'FORBIDDEN'
        else if (value.error?.code === 'NOT_FOUND') code = 'NOT_FOUND'
        else if (value.error?.code === 'STALE_VERSION') code = 'STALE_VERSION'
        else if (value.error?.code === 'CONFLICT') code = 'CONFLICT'
      } catch {}
      return {
        fetchCompleted: true,
        jsonParseable,
        status: response.status,
        code,
        privateEcho: Object.values(requestPayload).some((value) => text.includes(String(value))),
      }
    } catch {
      return {
        fetchCompleted: false,
        jsonParseable: false,
        status: 0,
        code: 'OTHER' as const,
        privateEcho: false,
      }
    }
  }, { requestPath: path, requestMethod: method, requestPayload: payload })
}

async function login(page: Page, baseUrl: string, email: string, password: string): Promise<void> {
  const navigation = await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' })
  assert.equal(navigation?.status(), 200)
  const emailField = page.getByRole('textbox', { name: '測試帳號電郵', exact: true })
  const passwordField = page.getByLabel('密碼', { exact: true })
  const submit = page.getByRole('button', { name: '登入測試工作台', exact: true })
  await emailField.waitFor({ state: 'visible' })
  await passwordField.waitFor({ state: 'visible' })
  await emailField.fill(email)
  await passwordField.fill(password)
  const loginResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/auth/login')
  const accessResponse = page.waitForResponse((response) => isGetPath(response, '/api/v1/auth/me'))
  await submit.click()
  assert.equal((await loginResponse).status(), 303)
  await page.waitForURL((url) => url.pathname === '/today')
  assert.equal((await accessResponse).status(), 200)
  await page.getByRole('heading', { name: '今日工作', exact: true, level: 2 }).waitFor({ state: 'visible' })
}

async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: '帳戶選單', exact: true }).click()
  await page.getByRole('menuitem', { name: '登出', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/login')
}

async function viewportEvidence(page: Page): Promise<ViewportEvidence> {
  return page.evaluate(() => {
    const root = document.documentElement
    const visible = [...document.querySelectorAll<HTMLElement>('a,button,input,select')].filter((element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    })
    const outOfBounds = visible.filter((element) => {
      const rect = element.getBoundingClientRect()
      return rect.left < -1 || rect.right > root.clientWidth + 1
    }).length
    let overlapping = 0
    for (let left = 0; left < visible.length; left += 1) {
      for (let right = left + 1; right < visible.length; right += 1) {
        const a = visible[left]!.getBoundingClientRect()
        const b = visible[right]!.getBoundingClientRect()
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4 && !visible[left]!.contains(visible[right]!) && !visible[right]!.contains(visible[left]!)) overlapping += 1
      }
    }
    const clipped = visible.filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1).length
    return { overflow: Math.max(0, root.scrollWidth - root.clientWidth), out_of_bounds: outOfBounds, overlapping, clipped }
  })
}

function zeroViewport(): ViewportEvidence {
  return { overflow: 0, out_of_bounds: 0, overlapping: 0, clipped: 0 }
}

function isGetPath(response: { request(): { method(): string }; url(): string }, pathname: string): boolean {
  return response.request().method() === 'GET' && new URL(response.url()).pathname === pathname
}

async function discoverCanonicalBaseUrl(listenUrl: string, port: number): Promise<string> {
  const response = await fetch(`${listenUrl}/api/auth/login`, { redirect: 'manual' })
  const location = response.headers.get('location')
  assert.equal(response.status, 307)
  assert.notEqual(location, null)
  const target = new URL(location!, listenUrl)
  assert.equal(target.pathname, '/api/v1/auth/login')
  assert.equal(target.protocol, 'http:')
  assert.equal(['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname.toLowerCase()), true)
  assert.equal(target.port, String(port))
  assert.equal(target.username, '')
  assert.equal(target.password, '')
  assert.equal(target.search, '')
  assert.equal(target.hash, '')
  return target.origin
}

async function createIsolatedAppDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tianxing-crm06-browser-next-'))
  const excluded = new Set(['.git', '.next', 'node_modules'])
  try {
    for (const entry of await readdir(process.cwd())) {
      if (excluded.has(entry) || entry.startsWith('.env') || ['.DS_Store', '.idea', '.kition', '.pnpm-store'].includes(entry)) continue
      await cp(resolve(entry), join(directory, entry), { recursive: true })
    }
    await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir')
    return directory
  } catch {
    await rm(directory, { recursive: true, force: true })
    throw new BrowserGateError('next_dev')
  }
}

function startNextDev(directory: string, port: number, connectionString: string): ChildProcess {
  const child = spawn(process.execPath, [resolve('node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: directory,
    env: {
      PATH: `/opt/homebrew/opt/node@22/bin:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      NEXT_TELEMETRY_DISABLED: '1',
      APP_ENV: 'development',
      NODE_ENV: 'development',
      APP_RUNTIME_MODE: 'local-synthetic',
      AUTH_MODE: 'database-test',
      LOCAL_SYNTHETIC_DATABASE_URL: connectionString,
      LOCAL_SYNTHETIC_LOCALSTACK_ENDPOINT: 'http://127.0.0.1:4566',
      LOCAL_SYNTHETIC_AWS_REGION: 'ap-east-1',
      LOCAL_SYNTHETIC_S3_BUCKET: 'tianxing-local-documents',
      LOCAL_SYNTHETIC_SQS_QUEUE: 'tianxing-local-document-scan',
      LOCAL_SYNTHETIC_SQS_DLQ: 'tianxing-local-document-scan-dlq',
      LOCAL_SYNTHETIC_CLAMAV_HOST: '127.0.0.1',
      LOCAL_SYNTHETIC_CLAMAV_PORT: '3310',
      LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = { stdout: '', stderr: '' }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { logs.stdout += chunk })
  child.stderr?.on('data', (chunk: string) => { logs.stderr += chunk })
  DEV_LOGS.set(child, logs)
  return child
}

function assertNoSensitiveDevLogs(child: ChildProcess, forbidden: readonly string[]): void {
  const logs = DEV_LOGS.get(child)
  assert.notEqual(logs, undefined)
  const combined = `${logs!.stdout}\n${logs!.stderr}`
  assert.equal(forbidden.some((value) => value !== '' && combined.includes(value)), false)
}

async function waitForNextDev(baseUrl: string, child: ChildProcess): Promise<void> {
  child.stdout?.resume()
  child.stderr?.resume()
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new BrowserGateError('next_dev')
    try { if ((await fetch(`${baseUrl}/api/v1/auth/me`)).status === 401) return } catch {}
    await delay(500)
  }
  throw new BrowserGateError('next_dev')
}

async function stopNextDev(child: ChildProcess | undefined): Promise<boolean> {
  if (!child || child.exitCode !== null) return true
  child.kill('SIGTERM')
  const stopped = await Promise.race([new Promise<boolean>((resolveStopped) => child.once('close', () => resolveStopped(true))), delay(10_000).then(() => false)])
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise<void>((resolveStopped) => child.once('close', () => resolveStopped()))
  }
  return child.exitCode !== null
}

async function closeContext(context: BrowserContext | undefined): Promise<boolean> {
  if (!context) return true
  try { await context.close(); return true } catch { return false }
}

async function removeDirectory(directory: string): Promise<boolean> {
  if (!directory) return true
  try { await rm(directory, { recursive: true, force: true }); return true } catch { return false }
}

async function provision(target: OneRoleBaselineTarget, email: string, password: string) {
  return runDatabaseTestProvisionCli({ arguments: ['--password-stdin', `--email=${email}`], inputStream: streamOf(Buffer.from(`${password}\n`)), readTarget: () => localProvisionTarget(target) })
}

async function* streamOf(chunk: Buffer): AsyncIterable<Buffer> { yield chunk }

function localProvisionTarget(target: OneRoleBaselineTarget): DatabaseTestProvisionTarget {
  return Object.freeze({ connectionString: target.connectionString, loginUser: target.user, databaseName: target.database, connectionTimeoutMs: 5_000, statementTimeoutMs: 10_000, ssl: false })
}

function baselineDependencies(target: OneRoleBaselineTarget) {
  return {
    inspect: () => inspectBaselineWithNewClient(target),
    openExecutionConnection: async () => {
      const client = new Client(createOneRoleBaselineClientConfig(target))
      await client.connect()
      return Object.freeze({ client, close: () => client.end() })
    },
  }
}

async function inspectBaselineWithNewClient(target: OneRoleBaselineTarget): Promise<OneRoleBaselineDatabaseState> {
  const client = new Client(createOneRoleBaselineClientConfig(target))
  try { await client.connect(); return await inspectOneRoleBaselineDatabase(client) } finally { await client.end().catch(() => {}) }
}

function localTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({ connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`, host: '127.0.0.1', port, database: 'tianxing', user: ONE_ROLE_CANONICAL_ROLE, ssl: false })
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await runDocker(['exec', containerName, '/bin/sh', '/usr/local/bin/tianxing-postgres-healthcheck'], 'postgres_setup', undefined, true)
    if (result.exitCode === 0) return
    await delay(250)
  }
  throw new BrowserGateError('postgres_setup')
}

function readLoopbackPort(output: string): number {
  const port = Number(/^127\.0\.0\.1:([0-9]+)\s*$/.exec(output)?.[1])
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new BrowserGateError('postgres_setup')
  return port
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', () => reject(new BrowserGateError('next_dev')))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(new BrowserGateError('next_dev')) : resolvePort(port))
    })
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function principal(role: ActorName): (typeof NEON_TEST_PRINCIPALS)[number] {
  const value = NEON_TEST_PRINCIPALS.find((item) => item.role === role)
  if (!value) throw new Error('Missing synthetic principal.')
  return value
}

class BrowserGateError extends Error {
  readonly stage: Stage

  constructor(stage: Stage) {
    super(`CRM-06 browser gate failed at ${stage}.`)
    this.name = 'BrowserGateError'
    this.stage = stage
  }
}

async function runDocker(arguments_: readonly string[], stage: Stage, input?: string, allowFailure = false): Promise<Readonly<{ exitCode: number; stdout: string }>> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(DOCKER, arguments_, { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.resume()
    child.once('error', () => reject(new BrowserGateError(stage)))
    child.once('close', (code) => {
      const exitCode = code ?? 1
      if (exitCode !== 0 && !allowFailure) reject(new BrowserGateError(stage))
      else resolveRun(Object.freeze({ exitCode, stdout }))
    })
    child.stdin.end(input)
  })
}
