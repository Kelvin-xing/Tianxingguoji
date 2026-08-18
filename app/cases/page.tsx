'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/workspace/Icon'
import type { CaseStage } from '@/types'

interface CaseListItem {
  id: string
  caseNumber: string
  studentId: string
  studentName: string
  intakeYear: number
  admissionType: string
  stage: CaseStage
  updatedAt: string
  primaryRole: 'founder' | 'advisor'
}

const stageStyles: Record<CaseStage, { background: string; color: string }> = {
  signed: { background: '#f1f5f9', color: '#475569' },
  background_collection: { background: '#fef3c7', color: '#92400e' },
  school_selection_confirmed: { background: '#dbeafe', color: '#1d4ed8' },
  interview_preparation: { background: '#ede9fe', color: '#6d28d9' },
  application_submitted: { background: '#dbeafe', color: '#1e40af' },
  awaiting_result: { background: '#fef3c7', color: '#92400e' },
  offer_confirmed: { background: '#dcfce7', color: '#166534' },
  closed: { background: '#e2e8f0', color: '#475569' },
}

const caseStageLabels: Record<CaseStage, string> = {
  signed: '已簽約',
  background_collection: '背景資料收集',
  school_selection_confirmed: '選校已確認',
  interview_preparation: '面試準備',
  application_submitted: '已遞交申請',
  awaiting_result: '等待結果',
  offer_confirmed: 'Offer 已確認',
  closed: '已結案',
}

export default function CasesPage() {
  const [search, setSearch] = useState('')
  const [stage, setStage] = useState<CaseStage | 'all'>('all')
  const [caseRecords, setCaseRecords] = useState<CaseListItem[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')

  function loadCases() {
    setLoadState('loading')
    fetch('/api/v1/cases', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as { data?: { cases?: CaseListItem[] } }
        if (!response.ok || !payload.data?.cases) throw new Error('CASES_UNAVAILABLE')
        setCaseRecords(payload.data.cases)
        setLoadState('ready')
      })
      .catch(() => setLoadState('error'))
  }

  useEffect(() => {
    loadCases()
  }, [])

  const filtered = useMemo(() => caseRecords.filter((item) => {
    const query = search.trim().toLowerCase()
    const matchesSearch = !query || `${item.caseNumber} ${item.studentName} ${item.studentId}`.toLowerCase().includes(query)
    return matchesSearch && (stage === 'all' || item.stage === stage)
  }), [caseRecords, search, stage])

  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div><div className="eyebrow">CaseWorkflow · K12</div><h2 className="page-title">案件</h2><p className="page-subtitle">以 ServiceCase 為中心管理學生、選校、任務與文件。</p></div>
        <Link href="/cases/new" className="primary-button"><Icon name="plus" size={16} />建立案件</Link>
      </section>

      <section className="metric-strip">
        <Metric label="全部案件" value={String(caseRecords.length)} tone="blue" />
        <Metric label="進行中" value={String(caseRecords.filter((item) => item.stage !== 'closed').length)} tone="amber" />
        <Metric label="已確認 Offer" value={String(caseRecords.filter((item) => item.stage === 'offer_confirmed').length)} tone="green" />
        <Metric label="Advisor primary" value={String(caseRecords.filter((item) => item.primaryRole === 'advisor').length)} tone="violet" />
      </section>

      <section className="workspace-section overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4">
          <div><h3 className="section-title">案件工作表</h3><p className="section-detail">資料只來自目前 session 的 organization scope，不使用本地 fixture fallback。</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="search-field"><Icon name="search" size={15} /><input type="search" placeholder="搜尋案件或學生" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜尋案件" /></label>
            <label className="select-field"><Icon name="filter" size={14} /><select value={stage} onChange={(event) => setStage(event.target.value as CaseStage | 'all')} aria-label="案件階段"><option value="all">全部階段</option>{Object.entries(caseStageLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          </div>
        </div>
        {loadState === 'loading' && <div className="empty-state"><Icon name="clock" size={20} /><strong>正在載入案件</strong><span>確認 organization-scoped case data…</span></div>}
        {loadState === 'error' && <div className="empty-state"><Icon name="x" size={20} /><strong>案件服務暫時不可用</strong><span>請確認登入工作階段和本地 PostgreSQL runtime。</span><button type="button" className="secondary-button mt-3" onClick={loadCases}>重新載入</button></div>}
        {loadState === 'ready' && <><div className="overflow-x-auto -mx-5"><table className="data-table min-w-[760px]"><thead><tr><th>案件</th><th>學生</th><th>階段</th><th>Primary role</th><th>更新時間</th><th /></tr></thead><tbody>{filtered.map((item) => <CaseRow key={item.id} item={item} />)}</tbody></table>{filtered.length === 0 && <div className="empty-state">找不到符合條件的案件。</div>}</div><div className="pt-4 flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}><span>顯示 {filtered.length} / {caseRecords.length} 案件</span><span>PostgreSQL authoritative read</span></div></>}
      </section>
    </div>
  )
}

function CaseRow({ item }: { item: CaseListItem }) {
  const stageStyle = stageStyles[item.stage]
  return <tr className="data-row"><td><Link href={`/cases/${item.id}`} className="table-primary">{item.caseNumber}</Link><div className="table-secondary">{item.intakeYear} · {item.admissionType === 's1_admission' ? 'S1 入學' : '插班'}</div></td><td><Link href={`/students/${item.studentId}`} className="table-primary">{item.studentName || '未命名 Student'}</Link><div className="table-secondary">{item.studentId}</div></td><td><span className="status-pill" style={stageStyle}>{caseStageLabels[item.stage]}</span></td><td className="table-muted">{item.primaryRole === 'advisor' ? 'Advisor' : 'Founder'}</td><td className="table-muted">{formatDate(item.updatedAt)}</td><td><Link href={`/cases/${item.id}`} className="icon-button" title="查看案件" aria-label="查看案件"><Icon name="chevron-right" size={16} /></Link></td></tr>
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'blue' | 'amber' | 'violet' | 'green' }) { return <div className={`metric metric-${tone}`}><div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div><div className="mt-1 text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div></div> }

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-HK')
}
