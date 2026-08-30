'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

import { ErrorState, EmptyState, DeniedState, StaleState, UnavailableState, LoadingState } from '@/components/states/WorkspaceState'
import { Icon } from '@/components/workspace/Icon'
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

  if (state.status === 'loading') return <LoadingState title="正在載入今日工作" detail="讀取目前授權範圍內的工作摘要。" />
  if (state.status === 'denied') return <DeniedState title="無法查看今日工作" detail="目前身份沒有今日工作台的授權。" action={<Link className="primary-button" href="/tasks">返回我的任務</Link>} />
  if (state.status === 'stale') return <StaleState title="今日摘要需要更新" detail="看板版本已變更，請重新載入最新的授權摘要。" onRetry={load} />
  if (state.status === 'unavailable') return <UnavailableState title="今日工作暫時無法使用" detail="請稍後重試。" requestId={state.requestId} onRetry={load} />
  if (state.status === 'error') return <ErrorState title="今日工作載入失敗" detail="請稍後重試；系統沒有顯示未授權資料。" requestId={state.requestId} onRetry={load} />
  if (state.status === 'empty') return <EmptyState title="目前沒有可處理的工作" detail="新的授權案件或任務出現後會顯示在這裡。" action={<Link className="secondary-button" href="/tasks">查看任務</Link>} />

  return <TodayReady data={state.data} onRefresh={load} focus={focus} onFocus={setFocus} />
}

function TodayReady({ data, onRefresh, focus, onFocus }: { readonly data: DashboardData; readonly onRefresh: () => void; readonly focus: TodayFocus; readonly onFocus: (focus: TodayFocus) => void }) {
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
  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div><div className="eyebrow">今日工作</div><h1 className="page-title">今日工作</h1><p className="page-subtitle">顯示目前可查看的案件摘要和下一步。</p></div>
        <button type="button" className="secondary-button" onClick={onRefresh}><Icon name="rotate-ccw" size={15} />重新載入</button>
      </section>
      <section className="metric-strip" role="tablist" aria-label="工作摘要">
        <Metric focus="cases" selected={focus === 'cases'} onSelect={onFocus} label="可查看案件" value={data.cases.length} tone="blue" />
        <Metric focus="blockers" selected={focus === 'blockers'} onSelect={onFocus} label="待處理阻礙" value={blockers} tone="amber" />
        <Metric focus="tasks" selected={focus === 'tasks'} onSelect={onFocus} label="未完成任務" value={tasks} tone="violet" />
        <Metric focus="notifications" selected={focus === 'notifications'} onSelect={onFocus} label="未讀通知" value={unread} tone="green" />
      </section>
      <section id="today-results" role="tabpanel" aria-labelledby={`today-focus-${focus}`} className="workspace-section">
        <div className="flex items-start justify-between gap-4 pb-4"><div><h2 className="section-title">{view.title}</h2><p className="section-detail">{view.detail}</p></div><Link href={view.href} className="quiet-link">查看全部<Icon name="arrow-right" size={14} /></Link></div>
        <div className="divide-y" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {visibleCases.map((item) => <CaseRow key={item.case_id} item={item} focus={focus} />)}
        </div>
        {visibleCases.length === 0 ? <div className="empty-state">{view.empty}</div> : null}
        <p className="mt-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>資料時間：{formatDate(data.source_captured_at_ms)}</p>
      </section>
    </div>
  )
}

function CaseRow({ item, focus }: { readonly item: DashboardCase; readonly focus: TodayFocus }) {
  const summary = item.summary
  const detail = focus === 'blockers'
    ? `${summary?.blocker_count ?? 0} 項待處理阻礙`
    : focus === 'tasks'
      ? `${item.tasks?.open_count ?? 0} 項未完成任務`
      : focus === 'notifications'
        ? `${item.communications?.unread_count ?? 0} 項未讀通知`
        : summary?.next_action ? actionLabel(summary.next_action) : '暫無下一步'
  const icon = focus === 'blockers' ? 'clock' : focus === 'tasks' ? 'clipboard' : focus === 'notifications' ? 'activity' : 'briefcase'
  return <Link href={`/cases/${item.case_id}`} className="work-row group"><div className="flex items-start gap-3 min-w-0"><div className={`work-icon ${focus === 'blockers' ? 'warning' : 'blue'}`}><Icon name={icon} size={16} /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>{summary?.case_number ?? '獲授權案件'}</span><span className="text-xs" style={{ color: 'var(--text-muted)' }}>{summary ? stageLabel(summary.stage) : '摘要'}</span></div><div className="mt-1 text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{summary?.student_display_name ?? '案件摘要'}</div><div className="mt-1 text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{detail}</div></div></div><Icon name="chevron-right" size={15} className="shrink-0" style={{ color: 'var(--text-muted)' }} /></Link>
}

function stageLabel(value: string): string {
  return STAGE_LABELS[value] ?? (/[\u3400-\u9fff]/.test(value) ? value : '目前階段')
}

function actionLabel(value: string): string {
  return ACTION_LABELS[value] ?? (/[\u3400-\u9fff]/.test(value) ? value : '待處理事項')
}

function Metric({ focus, selected, onSelect, label, value, tone }: { readonly focus: TodayFocus; readonly selected: boolean; readonly onSelect: (focus: TodayFocus) => void; readonly label: string; readonly value: number; readonly tone: 'blue' | 'amber' | 'violet' | 'green' }) {
  return <button type="button" role="tab" id={`today-focus-${focus}`} aria-controls="today-results" aria-selected={selected} className={`metric metric-button metric-${tone}`} onClick={() => onSelect(focus)}><span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</span><strong className="mt-1 block text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</strong></button>
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
