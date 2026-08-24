'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  classifyCaseRequestFailure,
  listCases,
  type CaseWorkflowStatus,
  type CaseWorkspaceListItem,
  type CaseWorkspaceStage,
} from '@/modules/cases/client'

const stageStyles: Record<CaseWorkspaceStage, { background: string; color: string }> = {
  signed: { background: '#f1f5f9', color: '#475569' },
  background_collection: { background: '#fef3c7', color: '#92400e' },
  school_selection_confirmed: { background: '#dbeafe', color: '#1d4ed8' },
  application_in_progress: { background: '#ede9fe', color: '#6d28d9' },
  closed: { background: '#e2e8f0', color: '#475569' },
}

const caseStageLabels: Record<CaseWorkspaceStage, string> = {
  signed: '已簽約',
  background_collection: '背景資料收集',
  school_selection_confirmed: '選校已確認',
  application_in_progress: '申請處理中',
  closed: '已結案',
}

const workflowStatusLabels: Record<CaseWorkflowStatus, string> = {
  active: '進行中',
  paused: '已暫停',
  termination_pending: '待終止結案',
  closed: '已結案',
}

export default function CasesPage() {
  const [search, setSearch] = useState('')
  const [stage, setStage] = useState<CaseWorkspaceStage | 'all'>('all')
  const [caseRecords, setCaseRecords] = useState<readonly CaseWorkspaceListItem[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unauthenticated' | 'denied' | 'error'>('loading')
  const [canCreate, setCanCreate] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    getWorkspaceAccessSnapshot(controller.signal)
      .then(async (access) => {
        if (!access.capabilities.includes('cases.read')) {
          setLoadState('denied')
          return
        }
        const records = await listCases(controller.signal)
        setCaseRecords(records)
        setCanCreate(access.capabilities.some((capability) => String(capability) === 'cases.create'))
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const failure = classifyCaseRequestFailure(error)
        setLoadState(failure === 'unauthenticated' ? 'unauthenticated' : failure === 'forbidden' ? 'denied' : 'error')
      })
    return () => controller.abort()
  }, [reloadToken])

  const filtered = useMemo(() => caseRecords.filter((item) => {
    const query = search.trim().toLowerCase()
    const matchesSearch = !query || `${item.caseNumber} ${item.studentName}`.toLowerCase().includes(query)
    return matchesSearch && (stage === 'all' || item.stage === stage)
  }), [caseRecords, search, stage])

  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div><div className="eyebrow">CaseWorkflow · K12</div><h2 className="page-title">案件</h2><p className="page-subtitle">以 ServiceCase 為中心管理學生、選校、任務與文件。</p></div>
        {loadState === 'ready' && canCreate ? <Link href="/cases/new" className="primary-button"><Icon name="plus" size={16} />建立案件</Link> : null}
      </section>

      <section className="metric-strip">
        <Metric label="全部案件" value={String(caseRecords.length)} tone="blue" />
        <Metric label="進行中" value={String(caseRecords.filter((item) => item.stage !== 'closed').length)} tone="amber" />
        <Metric label="已暫停" value={String(caseRecords.filter((item) => item.workflowStatus === 'paused').length)} tone="green" />
        <Metric label="主要顧問" value={String(caseRecords.length)} tone="violet" />
      </section>

      <section className="workspace-section overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4">
          <div><h3 className="section-title">案件工作表</h3><p className="section-detail">資料只來自目前 session 的 organization scope，不使用本地 fixture fallback。</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="search-field"><Icon name="search" size={15} /><input type="search" placeholder="搜尋案件或學生" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜尋案件" /></label>
            <label className="select-field"><Icon name="filter" size={14} /><select value={stage} onChange={(event) => setStage(event.target.value as CaseWorkspaceStage | 'all')} aria-label="案件階段"><option value="all">全部階段</option>{Object.entries(caseStageLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          </div>
        </div>
        {loadState === 'loading' && <div className="empty-state"><Icon name="clock" size={20} /><strong>正在載入案件</strong><span>請稍候。</span></div>}
        {loadState === 'unauthenticated' && <div className="empty-state"><Icon name="lock" size={20} /><strong>工作階段已失效</strong><span>請重新登入後再查看案件。</span><Link href="/login" className="primary-button mt-3">重新登入</Link></div>}
        {loadState === 'denied' && <div className="empty-state"><Icon name="shield" size={20} /><strong>無法查看案件</strong><span>你的帳號目前沒有查看案件工作區的權限。</span></div>}
        {loadState === 'error' && <div className="empty-state"><Icon name="x" size={20} /><strong>案件服務暫時不可用</strong><span>請稍後重試。</span><button type="button" className="secondary-button mt-3" onClick={() => { setLoadState('loading'); setReloadToken((value) => value + 1) }}>重新載入</button></div>}
        {loadState === 'ready' && <>{filtered.length === 0 ? <div className="empty-state">找不到符合條件的案件。</div> : <><div className="hidden md:block overflow-x-auto -mx-5"><table className="data-table min-w-[820px]"><thead><tr><th>案件</th><th>學生</th><th>階段</th><th>流程狀態</th><th>主要顧問</th><th>更新時間</th><th className="hidden sm:table-cell" /></tr></thead><tbody>{filtered.map((item) => <CaseRow key={item.id} item={item} />)}</tbody></table></div><div className="md:hidden divide-y" role="list">{filtered.map((item) => <CaseMobileItem key={item.id} item={item} />)}</div></>}<div className="pt-4 text-xs" style={{ color: 'var(--text-muted)' }}><span>顯示 {filtered.length} / {caseRecords.length} 案件</span></div></>}
      </section>
    </div>
  )
}

function CaseRow({ item }: { item: CaseWorkspaceListItem }) {
  const stageStyle = stageStyles[item.stage]
  return <tr className="data-row"><td><Link href={`/cases/${item.id}`} className="table-primary">{item.caseNumber}</Link><div className="table-secondary">{item.intakeYear} · {item.admissionType === 's1_admission' ? '中一入學' : '插班'}</div></td><td><Link href={`/students/${item.studentId}`} className="table-primary">{item.studentName}</Link></td><td><span className="status-pill" style={stageStyle}>{caseStageLabels[item.stage]}</span></td><td className="table-muted">{workflowStatusLabels[item.workflowStatus]}</td><td className="table-muted">顧問</td><td className="table-muted">{formatDate(item.updatedAt)}</td><td className="hidden sm:table-cell"><Link href={`/cases/${item.id}`} className="icon-button" title="查看案件" aria-label={`查看案件 ${item.caseNumber}`}><Icon name="chevron-right" size={16} /></Link></td></tr>
}

function CaseMobileItem({ item }: { item: CaseWorkspaceListItem }) {
  const stageStyle = stageStyles[item.stage]
  return <article role="listitem" className="min-w-0 py-4 first:pt-0 last:pb-0"><div className="min-w-0"><Link href={`/cases/${item.id}`} className="table-primary break-words">{item.caseNumber}</Link><div className="table-secondary break-words">{item.intakeYear} · {item.admissionType === 's1_admission' ? '中一入學' : '插班'}</div></div><dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-3 text-sm"><div className="min-w-0 col-span-2"><dt className="text-xs" style={{ color: 'var(--text-muted)' }}>學生</dt><dd className="mt-1 min-w-0"><Link href={`/students/${item.studentId}`} className="table-primary break-words">{item.studentName}</Link></dd></div><div className="min-w-0"><dt className="text-xs" style={{ color: 'var(--text-muted)' }}>階段</dt><dd className="mt-1"><span className="status-pill" style={stageStyle}>{caseStageLabels[item.stage]}</span></dd></div><div className="min-w-0"><dt className="text-xs" style={{ color: 'var(--text-muted)' }}>流程狀態</dt><dd className="mt-1 table-muted break-words">{workflowStatusLabels[item.workflowStatus]}</dd></div><div className="min-w-0"><dt className="text-xs" style={{ color: 'var(--text-muted)' }}>主要顧問</dt><dd className="mt-1 table-muted break-words">顧問</dd></div><div className="min-w-0"><dt className="text-xs" style={{ color: 'var(--text-muted)' }}>更新時間</dt><dd className="mt-1 table-muted break-words">{formatDate(item.updatedAt)}</dd></div></dl></article>
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'blue' | 'amber' | 'violet' | 'green' }) { return <div className={`metric metric-${tone}`}><div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div><div className="mt-1 text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div></div> }

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-HK')
}
