'use client'
import Link from 'next/link'
import { decodeWorkspaceAuth } from '@/components/layout/workspace-navigation'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Page, PageHeader, Card, Hero, Button, Tag, Chips, Empty, Notice } from '@/components/ui/standard'
import { ApiClientError, expectRecord, expectString, requestApi } from '@/lib/api/client'
interface DashboardCase {
  readonly case_id: string
  readonly summary?: {
    readonly case_number: string
    readonly student_display_name: string
    readonly stage: string
    readonly blocker_count: number
    readonly next_action: string | null
    readonly next_action_due_at_ms: number | null
  }
  readonly tasks?: { readonly open_count: number }
  readonly communications?: { readonly unread_count: number }
}
interface DashboardData {
  readonly source_captured_at_ms: number
  readonly stale: boolean
  readonly cases: readonly DashboardCase[]
}
const STAGE_LABELS: Readonly<Record<string, string>> = {
  signed: '已簽約',
  background_collection: '背景資料收集',
  school_selection_confirmed: '選校已確認',
  interview_preparation: '面試準備',
  application_in_progress: '申請處理中',
  application_submitted: '已提交申請',
  awaiting_result: '等待結果',
  offer_confirmed: '錄取已確認',
  closed: '已結案',
}
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'Review assessment': '查看評估',
  'Complete assessment': '完成評估',
  'Confirm shortlist': '確認選校名單',
  'Prepare application': '準備申請',
  'Submit application': '提交申請',
  'Prepare interview': '準備面試',
}
type TodayState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: DashboardData }
  | { readonly status: 'empty' }
  | { readonly status: 'denied' }
  | { readonly status: 'stale' }
  | { readonly status: 'unavailable'; readonly requestId: string | null }
  | { readonly status: 'error'; readonly requestId: string | null }
type TodayFocus = 'cases' | 'blockers' | 'tasks' | 'notifications'
const FOCUS_VIEW: Readonly<Record<TodayFocus, Readonly<{
  title: string
  detail: string
  empty: string
  href: '/cases' | '/tasks' | '/notifications'
}>>> = {
  cases: {
    title: '可查看案件',
    detail: '顯示目前授權範圍內的案件與下一步。',
    empty: '目前沒有可查看的案件。',
    href: '/cases',
  },
  blockers: {
    title: '待處理阻礙案件',
    detail: '只顯示目前有待處理阻礙的案件。',
    empty: '目前沒有待處理阻礙案件。',
    href: '/cases',
  },
  tasks: {
    title: '有未完成任務的案件',
    detail: '只顯示目前仍有未完成任務的案件。',
    empty: '目前沒有未完成任務。',
    href: '/tasks',
  },
  notifications: {
    title: '有未讀通知的案件',
    detail: '只顯示目前仍有未讀通知的案件。',
    empty: '目前沒有未讀通知。',
    href: '/notifications',
  },
}
export default function TodayPage() {
  return <TodayContent />
}
function TodayContent() {
  const [state, setState] = useState<TodayState>({ status: 'loading' })
  const [displayName, setDisplayName] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    requestApi({ path: '/api/v1/auth/me', signal: controller.signal }, decodeWorkspaceAuth)
      .then(auth => { if (!controller.signal.aborted) setDisplayName(auth.nickname ?? '') })
      .catch(() => { /* Keep the existing generic greeting when profile data is unavailable. */ })
    return () => controller.abort()
  }, [])
  const [focus, setFocus] = useState<TodayFocus>('cases')
  const load = useCallback(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    requestApi({ path: '/api/v1/dashboard/cases', signal: controller.signal }, decodeDashboardData)
      .then((data) => setState(data.cases.length === 0 ? { status: 'empty' } : data.stale ? { status: 'stale' } : { status: 'ready', data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const apiError = error instanceof ApiClientError ? error : null
        if (apiError?.status === 401 || apiError?.status === 403) return setState({ status: 'denied' })
        if (apiError?.status === 503 || apiError?.code === 'SERVICE_UNAVAILABLE') return setState({ status: 'unavailable', requestId: apiError.requestId })
        if (apiError?.code === 'STALE_VERSION' || apiError?.code === 'CONFLICT') return setState({ status: 'stale' })
        setState({ status: 'error', requestId: apiError?.requestId ?? null })
      })
    return () => controller.abort()
  }, [])
  useEffect(() => load(), [load])
  if (state.status !== 'ready') {
    const views = {
      loading: ['正在載入今日工作', '讀取目前授權範圍內的工作摘要。'],
      denied: ['無法查看今日工作', '目前身份沒有今日工作台的授權。'],
      stale: ['今日摘要需要更新', '看板版本已變更，請重新載入最新的授權摘要。'],
      unavailable: ['今日工作暫時無法使用', '請稍後重試。'],
      error: ['今日工作載入失敗', '請稍後重試；系統沒有顯示未授權資料。'],
      empty: ['目前沒有可處理的工作', '新的授權案件或任務出現後會顯示在這裡。'],
    }
    const [title, description] = views[state.status]
    return <Page>
      <PageHeader title="今日工作" />
      <Card>
        <Notice warning={['denied', 'stale', 'unavailable', 'error'].includes(state.status)}><strong>{title}</strong><p>{description}</p></Notice>
        {['stale', 'unavailable', 'error'].includes(state.status) && <Button onClick={load}>重新載入</Button>}
        {['denied', 'empty'].includes(state.status) && <Link className="ui-button ui-secondary" href="/tasks">查看任務</Link>}
        {'requestId' in state && state.requestId && <p className="ui-muted">{state.requestId}</p>}
      </Card>
    </Page>
  }
  return <TodayReady displayName={displayName} data={state.data} onRefresh={load} focus={focus} onFocus={setFocus} />
}
function TodayReady({ displayName, data, onRefresh, focus, onFocus }: { readonly displayName: string; readonly data: DashboardData; readonly onRefresh: () => void; readonly focus: TodayFocus; readonly onFocus: (focus: TodayFocus) => void }) {
  const blockers = data.cases.reduce((total, item) => total + (item.summary?.blocker_count ?? 0), 0)
  const tasks = data.cases.reduce((total, item) => total + (item.tasks?.open_count ?? 0), 0)
  const unread = data.cases.reduce((total, item) => total + (item.communications?.unread_count ?? 0), 0)
  const visibleCases = data.cases.filter((item) => {
    if (focus === 'blockers') return (item.summary?.blocker_count ?? 0) > 0
    if (focus === 'tasks') return (item.tasks?.open_count ?? 0) > 0
    if (focus === 'notifications') return (item.communications?.unread_count ?? 0) > 0
    return true
  })
  const view = FOCUS_VIEW[focus]
  const { t } = useTranslation()
  const next = visibleCases.filter(item => item.summary?.next_action).sort((a, b) => (a.summary?.next_action_due_at_ms ?? Infinity) - (b.summary?.next_action_due_at_ms ?? Infinity))
  return <Page>
    <Hero>
      <div><p>{new Intl.DateTimeFormat('zh-HK', { dateStyle: 'full', timeZone: 'Asia/Hong_Kong' }).format(new Date())}</p><h1>{displayName ? t('ui.todayGreetingNamed', { name: displayName }) : t('ui.todayGreeting')}</h1><p>{t('ui.todaySummary')}</p></div>
      <div className="ui-metrics">
        {[['cases', '可查看案件', data.cases.length], ['tasks', '未完成任務', tasks], ['blockers', '待處理阻礙', blockers]].map(([key, label, count]) => <button className="ui-metric" key={String(key)} onClick={() => onFocus(key as TodayFocus)}><strong>{count}</strong><span>{label}</span></button>)}
      </div>
    </Hero>
    <div className="ui-actions"><Button onClick={onRefresh}>重新載入</Button></div>
    <Chips
      label="工作摘要"
      value={focus}
      onChange={v => onFocus(v as TodayFocus)}
      items={Object.entries(FOCUS_VIEW).map(([value, v]) => ({ value, label: v.title }))} />
    <div className="ui-columns">
      <Card title={t('ui.todayNext')}>
        {next.length ? <><div className="ui-next">
          <span className="ui-tag primary">{t('ui.nextUp')}</span>
          <h2>{next[0].summary?.next_action_due_at_ms ? formatDate(next[0].summary.next_action_due_at_ms) : t('ui.noDueTime')}</h2>
          <h2>{actionLabel(next[0].summary!.next_action!)}</h2>
          <p>{next[0].summary?.student_display_name}</p>
          <Link className="ui-button ui-secondary" href={`/cases/${next[0].case_id}`}>{t('ui.openCase')}</Link>
        </div>{next.slice(1).map(item => <div className="ui-task-row" key={item.case_id}>
          <div>
            <strong>{actionLabel(item.summary!.next_action!)}</strong>
            <p className="ui-muted">{item.summary?.student_display_name}{item.summary?.next_action_due_at_ms ? ` · ${formatDate(item.summary.next_action_due_at_ms)}` : ''}</p>
          </div>
          <Link className="ui-link" href={`/cases/${item.case_id}`}>{t('ui.openCase')}</Link>
        </div>)}</> : <Empty title={t('ui.noNextAction')} />}
        <p className="ui-muted">資料時間：{formatDate(data.source_captured_at_ms)}</p>
      </Card>
      <div className="ui-stack">
        <div className="ui-row"><h2>{view.title}</h2><Tag>{unread} 未讀通知</Tag><Link href={view.href} className="ui-link">查看全部</Link></div>
        {visibleCases.map(item => <Link href={`/cases/${item.case_id}`} key={item.case_id}>
          <Card>
            <div className="ui-row">
              <strong>{item.summary?.student_display_name ?? '案件摘要'}</strong>
              <Tag tone={item.summary?.blocker_count ? 'warning' : 'primary'}>{item.summary ? stageLabel(item.summary.stage) : '摘要'}</Tag>
            </div>
            <span className="ui-muted">{item.summary?.case_number ?? '獲授權案件'}</span>
            {!!item.summary?.blocker_count && <p>{item.summary.blocker_count} 項待處理阻礙</p>}
          </Card>
        </Link>)}
        {!visibleCases.length && <Empty title={view.empty} />}
      </div>
    </div>
  </Page>
}
function stageLabel(value: string): string {
  return STAGE_LABELS[value] ?? (/[\u3400-\u9fff]/.test(value) ? value : '目前階段')
}
function actionLabel(value: string): string {
  return ACTION_LABELS[value] ?? (/[\u3400-\u9fff]/.test(value) ? value : '待處理事項')
}
function decodeDashboardData(value: unknown): DashboardData {
  const record = expectRecord(value)
  if (typeof record.source_captured_at_ms !== 'number' || !Number.isFinite(record.source_captured_at_ms) || typeof record.stale !== 'boolean' || !Array.isArray(record.cases)) throw new TypeError('Invalid dashboard projection.')
  const cases = record.cases.map((item) => {
    const candidate = expectRecord(item)
    const caseId = expectString(candidate.case_id)
    const summary = candidate.summary === undefined ? undefined : decodeSummary(candidate.summary)
    const tasks = candidate.tasks === undefined ? undefined : { open_count: decodeCount(candidate.tasks, 'open_count') }
    const communications = candidate.communications === undefined ? undefined : { unread_count: decodeCount(candidate.communications, 'unread_count') }
    return { case_id: caseId, summary, tasks, communications }
  })
  return { source_captured_at_ms: record.source_captured_at_ms, stale: record.stale, cases }
}
function decodeSummary(value: unknown): DashboardCase['summary'] {
  const record = expectRecord(value)
  if (typeof record.case_number !== 'string' || typeof record.student_display_name !== 'string' || typeof record.stage !== 'string' || typeof record.blocker_count !== 'number' || !Number.isSafeInteger(record.blocker_count) || (record.next_action !== null && typeof record.next_action !== 'string')) throw new TypeError('Invalid dashboard summary.')
  return { case_number: record.case_number, student_display_name: record.student_display_name, stage: record.stage, blocker_count: record.blocker_count, next_action: record.next_action, next_action_due_at_ms: typeof record.next_action_due_at_ms === 'number' ? record.next_action_due_at_ms : null }
}
function decodeCount(value: unknown, field: 'open_count' | 'unread_count'): number {
  const record = expectRecord(value)
  if (typeof record[field] !== 'number' || !Number.isSafeInteger(record[field]) || record[field] < 0) throw new TypeError('Invalid dashboard count.')
  return record[field]
}
function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-HK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hong_Kong' }).format(value)
}
