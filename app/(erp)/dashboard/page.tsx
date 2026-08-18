'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

type DashboardCase = {
  case_id: string
  summary?: {
    case_number: string
    student_display_name: string
    stage: string
    blocker_count: number
    next_action: string | null
    next_action_due_at_ms: number | null
  }
  education_profile?: { completeness_percent: number }
  school_targets?: { count: number }
  tasks?: { open_count: number }
  communications?: { unread_count: number }
}

type DashboardData = {
  projection_version: 'case_dashboard_projection_v1'
  source_snapshot_id: string
  source_captured_at_ms: number
  projection_hash: string
  stale: boolean
  cases: DashboardCase[]
}

type DashboardState =
  | { status: 'loading' }
  | { status: 'ready'; data: DashboardData }
  | { status: 'denied' }
  | { status: 'error'; requestId: string | null }

const STAGE_LABELS: Readonly<Record<string, string>> = {
  signed: '已簽約',
  background_collection: '背景收集',
  school_selection_confirmed: '選校確認',
  interview_preparation: '面試準備',
  application_submitted: '已提交申請',
  awaiting_result: '等待結果',
  offer_confirmed: '錄取確認',
  closed: '已結案',
}

export default function DashboardPage() {
  const [state, setState] = useState<DashboardState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  const load = useCallback(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    fetch('/api/v1/dashboard/cases', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (response.status === 401 || response.status === 403) {
          setState({ status: 'denied' })
          return
        }
        if (!response.ok || !isDashboardData(body?.data)) {
          setState({
            status: 'error',
            requestId: typeof body?.error?.request_id === 'string' ? body.error.request_id : null,
          })
          return
        }
        setState({ status: 'ready', data: body.data })
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return
        setState({ status: 'error', requestId: null })
      })
    return () => controller.abort()
  }, [])

  useEffect(() => load(), [attempt, load])

  if (state.status === 'loading') return <DashboardLoading />
  if (state.status === 'denied') return <DashboardDenied />
  if (state.status === 'error') {
    return (
      <DashboardMessage
        title="暫時無法載入案件看板"
        detail={state.requestId ? `請稍後再試。參考編號：${state.requestId}` : '請稍後再試。'}
        action={<button type="button" className="rounded-md px-3 py-2 text-sm font-medium" style={primaryButtonStyle} onClick={() => setAttempt((value) => value + 1)}>重新載入</button>}
      />
    )
  }
  if (state.data.cases.length === 0) {
    return <DashboardMessage title="目前沒有可查看的案件" detail="新分派或有效協作範圍會顯示在這裡。" />
  }

  return <DashboardReady data={state.data} />
}

function DashboardReady({ data }: { data: DashboardData }) {
  const totals = useMemo(() => data.cases.reduce(
    (result, item) => ({
      blockers: result.blockers + (item.summary?.blocker_count ?? 0),
      tasks: result.tasks + (item.tasks?.open_count ?? 0),
      messages: result.messages + (item.communications?.unread_count ?? 0),
    }),
    { blockers: 0, tasks: 0, messages: 0 },
  ), [data.cases])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>案件營運看板</h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>只顯示目前獲授權的案件與工作範圍</p>
        </div>
        <time className="text-xs" style={{ color: 'var(--text-muted)' }} dateTime={new Date(data.source_captured_at_ms).toISOString()}>
          資料時間 {new Intl.DateTimeFormat('zh-HK', { dateStyle: 'medium', timeStyle: 'short' }).format(data.source_captured_at_ms)}
        </time>
      </div>

      {data.stale && (
        <div role="status" className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: '#d97706', background: '#fffbeb', color: '#92400e' }}>
          看板資料正在更新，案件權限仍以目前系統記錄為準。
        </div>
      )}

      <section aria-label="案件摘要" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="可查看案件" value={data.cases.length} />
        <Metric label="待處理阻礙" value={totals.blockers} />
        <Metric label="未完成任務" value={totals.tasks} />
        <Metric label="未讀溝通" value={totals.messages} />
      </section>

      <section aria-labelledby="case-list-heading" className="overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          <h2 id="case-list-heading" className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>目前案件</h2>
        </div>
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {data.cases.map((item) => <CaseRow key={item.case_id} item={item} />)}
        </div>
      </section>
    </div>
  )
}

function CaseRow({ item }: { item: DashboardCase }) {
  const label = item.summary?.student_display_name ?? '獲授權案件'
  const caseNumber = item.summary?.case_number ?? item.case_id.slice(0, 8).toUpperCase()
  return (
    <article className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(12rem,1.2fr)_minmax(9rem,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{label}</div>
        <div className="mt-0.5 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{caseNumber}</div>
      </div>
      <div className="min-w-0">
        {item.summary ? (
          <>
            <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{STAGE_LABELS[item.summary.stage] ?? item.summary.stage}</div>
            <div className="mt-0.5 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{item.summary.next_action ?? '暫無下一步'}</div>
          </>
        ) : <span className="text-xs" style={{ color: 'var(--text-muted)' }}>僅顯示獲授權範圍</span>}
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs sm:justify-end">
        {item.school_targets && <Count label="選校" value={item.school_targets.count} />}
        {item.tasks && <Count label="任務" value={item.tasks.open_count} />}
        {item.education_profile && <Count label="資料" value={`${item.education_profile.completeness_percent}%`} />}
        {item.communications && <Count label="未讀" value={item.communications.unread_count} />}
      </dl>
    </article>
  )
}

function Count({ label, value }: { label: string; value: number | string }) {
  return <div><dt style={{ color: 'var(--text-muted)' }}>{label}</dt><dd className="mt-0.5 font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</dd></div>
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-h-20 rounded-lg border p-3" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
      <div className="text-xl font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{value}</div>
      <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </div>
  )
}

function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="正在載入案件看板" className="space-y-4">
      <div className="h-12 w-full max-w-sm animate-pulse rounded-md" style={{ background: 'var(--border-subtle)' }} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-lg" style={{ background: 'var(--surface)' }} />)}
      </div>
      <div className="h-56 animate-pulse rounded-lg" style={{ background: 'var(--surface)' }} />
    </div>
  )
}

function DashboardDenied() {
  return <DashboardMessage title="無法查看案件看板" detail="你的工作階段或目前職責沒有這個看板的存取權。" />
}

function DashboardMessage({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return (
    <section className="flex min-h-64 items-center justify-center rounded-lg border px-5 py-10 text-center" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
      <div className="max-w-md">
        <h1 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>{detail}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </section>
  )
}

function isDashboardData(value: unknown): value is DashboardData {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DashboardData>
  return candidate.projection_version === 'case_dashboard_projection_v1' &&
    typeof candidate.source_snapshot_id === 'string' &&
    typeof candidate.source_captured_at_ms === 'number' &&
    typeof candidate.projection_hash === 'string' &&
    typeof candidate.stale === 'boolean' &&
    Array.isArray(candidate.cases)
}

const primaryButtonStyle = {
  background: 'var(--accent)',
  color: '#fff',
} as const
