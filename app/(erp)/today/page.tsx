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

type TodayState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: DashboardData }
  | { readonly status: 'empty' }
  | { readonly status: 'denied' }
  | { readonly status: 'stale' }
  | { readonly status: 'unavailable'; readonly requestId: string | null }
  | { readonly status: 'error'; readonly requestId: string | null }

export default function TodayPage() {
  const [state, setState] = useState<TodayState>({ status: 'loading' })
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
  if (state.status === 'unavailable') return <UnavailableState title="今日工作暫時無法使用" detail="目前無法讀取工作摘要，沒有切換到本地或預覽資料。" requestId={state.requestId} onRetry={load} />
  if (state.status === 'error') return <ErrorState title="今日工作載入失敗" detail="請稍後重試；系統沒有顯示未授權資料。" requestId={state.requestId} onRetry={load} />
  if (state.status === 'empty') return <EmptyState title="目前沒有可處理的工作" detail="新的授權案件或任務出現後會顯示在這裡。" action={<Link className="secondary-button" href="/tasks">查看任務</Link>} />

  return <TodayReady data={state.data} onRefresh={load} />
}

function TodayReady({ data, onRefresh }: { readonly data: DashboardData; readonly onRefresh: () => void }) {
  const blockers = data.cases.reduce((total, item) => total + (item.summary?.blocker_count ?? 0), 0)
  const tasks = data.cases.reduce((total, item) => total + (item.tasks?.open_count ?? 0), 0)
  const unread = data.cases.reduce((total, item) => total + (item.communications?.unread_count ?? 0), 0)
  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div><div className="eyebrow">Today · 授權工作摘要</div><h1 className="page-title">今日工作</h1><p className="page-subtitle">只顯示目前工作階段可查看的案件摘要和下一步。</p></div>
        <div className="flex items-center gap-2"><Link href="/notifications" className="secondary-button"><Icon name="activity" size={15} />通知</Link><button type="button" className="secondary-button" onClick={onRefresh}><Icon name="rotate-ccw" size={15} />重新載入</button></div>
      </section>
      <section className="metric-strip" aria-label="工作摘要">
        <Metric label="可查看案件" value={data.cases.length} tone="blue" />
        <Metric label="待處理阻礙" value={blockers} tone="amber" />
        <Metric label="未完成任務" value={tasks} tone="violet" />
        <Metric label="未讀通知" value={unread} tone="green" />
      </section>
      <section className="workspace-section" aria-labelledby="today-cases-title">
        <div className="flex items-start justify-between gap-4 pb-4"><div><h2 id="today-cases-title" className="section-title">需要你判斷的案件</h2><p className="section-detail">下一步和阻礙由 Cases projection 提供。</p></div><Link href="/cases" className="quiet-link">查看全部<Icon name="arrow-right" size={14} /></Link></div>
        <div className="divide-y" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {data.cases.map((item) => <CaseRow key={item.case_id} item={item} />)}
        </div>
        <p className="mt-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>資料時間：{formatDate(data.source_captured_at_ms)}</p>
      </section>
    </div>
  )
}

function CaseRow({ item }: { readonly item: DashboardCase }) {
  const summary = item.summary
  return <Link href={`/cases/${item.case_id}`} className="work-row group"><div className="flex items-start gap-3 min-w-0"><div className={`work-icon ${summary?.blocker_count ? 'warning' : 'blue'}`}><Icon name={summary?.blocker_count ? 'clock' : 'briefcase'} size={16} /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>{summary?.case_number ?? '獲授權案件'}</span><span className="text-xs" style={{ color: 'var(--text-muted)' }}>{summary?.stage ?? '摘要'}</span></div><div className="mt-1 text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{summary?.student_display_name ?? '案件摘要'}</div><div className="mt-1 text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{summary?.next_action ?? '暫無下一步'}</div></div></div><Icon name="chevron-right" size={15} className="shrink-0" style={{ color: 'var(--text-muted)' }} /></Link>
}

function Metric({ label, value, tone }: { readonly label: string; readonly value: number; readonly tone: 'blue' | 'amber' | 'violet' | 'green' }) {
  return <div className={`metric metric-${tone}`}><div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div><div className="mt-1 text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div></div>
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
