'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/workspace/Icon'
import { caseStageLabels } from '@/lib/mock/cases'
import { previewCaseWorkspaceAdapter } from '@/lib/case-workspace/adapter'
import type { CaseRecord } from '@/types'

const caseRecords = previewCaseWorkspaceAdapter.listCases()

const stageStyles: Record<CaseRecord['stage'], { background: string; color: string }> = {
  signed: { background: '#f1f5f9', color: '#475569' },
  background_collection: { background: '#fef3c7', color: '#92400e' },
  school_selection_confirmed: { background: '#dbeafe', color: '#1d4ed8' },
  interview_preparation: { background: '#ede9fe', color: '#6d28d9' },
  application_submitted: { background: '#dbeafe', color: '#1e40af' },
  awaiting_result: { background: '#fef3c7', color: '#92400e' },
  offer_confirmed: { background: '#dcfce7', color: '#166534' },
  closed: { background: '#e2e8f0', color: '#475569' },
}

export default function CasesPage() {
  const [search, setSearch] = useState('')
  const [stage, setStage] = useState<CaseRecord['stage'] | 'all'>('all')
  const filtered = useMemo(() => caseRecords.filter((item) => {
    const query = search.trim().toLowerCase()
    const matchesSearch = !query || `${item.case_number} ${item.student_name} ${item.student_name_en} ${item.advisor}`.toLowerCase().includes(query)
    return matchesSearch && (stage === 'all' || item.stage === stage)
  }), [search, stage])

  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div><div className="eyebrow">CaseWorkflow · K12</div><h2 className="page-title">案件</h2><p className="page-subtitle">以 ServiceCase 為中心管理學生、選校、任務與文件。</p></div>
        <Link href="/cases/new" className="primary-button"><Icon name="plus" size={16} />建立案件</Link>
      </section>

      <section className="metric-strip">
        <Metric label="全部案件" value={String(caseRecords.length)} tone="blue" />
        <Metric label="需要處理" value={String(caseRecords.filter((item) => item.blockers.length).length)} tone="amber" />
        <Metric label="已確認 Offer" value={String(caseRecords.filter((item) => item.stage === 'offer_confirmed').length)} tone="green" />
        <Metric label="我的案件" value={String(caseRecords.filter((item) => item.advisor_role === 'advisor').length)} tone="violet" />
      </section>

      <section className="workspace-section overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4">
          <div><h3 className="section-title">案件工作表</h3><p className="section-detail">每個案件都是獨立身份，不與 Student 混用。</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="search-field"><Icon name="search" size={15} /><input type="search" placeholder="搜尋案件、學生或 Advisor" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜尋案件" /></label>
            <label className="select-field"><Icon name="filter" size={14} /><select value={stage} onChange={(event) => setStage(event.target.value as CaseRecord['stage'] | 'all')} aria-label="案件階段"><option value="all">全部階段</option>{Object.entries(caseStageLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          </div>
        </div>
        <div className="overflow-x-auto -mx-5">
          <table className="data-table min-w-[980px]"><thead><tr><th>案件</th><th>學生</th><th>階段</th><th>Advisor</th><th>Assessment</th><th>學校目標</th><th>下一步</th><th /></tr></thead><tbody>
            {filtered.map((item) => <CaseRow key={item.id} item={item} />)}
          </tbody></table>
          {filtered.length === 0 && <div className="empty-state">找不到符合條件的案件。</div>}
        </div>
        <div className="pt-4 flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}><span>顯示 {filtered.length} / {caseRecords.length} 案件</span><span>Preview adapter</span></div>
      </section>
    </div>
  )
}

function CaseRow({ item }: { item: CaseRecord }) {
  const stageStyle = stageStyles[item.stage]
  return <tr className="data-row"><td><Link href={`/cases/${item.id}`} className="table-primary">{item.case_number}</Link><div className="table-secondary">{item.intake_year} · {item.admission_type === 's1_admission' ? 'S1 入學' : '插班'}</div></td><td><Link href={`/students/${item.student_id}`} className="table-primary">{item.student_name}</Link><div className="table-secondary">{item.student_name_en}</div></td><td><span className="status-pill" style={stageStyle}>{item.stage_label}</span></td><td className="table-muted">{item.advisor}</td><td><span className="inline-status" style={{ color: item.assessment_status === 'selection_ready' ? '#15803d' : '#b45309' }}><span className="status-dot" />{item.assessment_status === 'selection_ready' ? 'Ready' : '需補資料'}</span></td><td className="table-muted">{item.school_targets.length} 所<span className="table-secondary block">{item.school_targets.filter((target) => target.state === 'accepted').length} accepted</span></td><td><div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{item.next_action}</div><div className="table-secondary">{item.next_action_date}</div></td><td><Link href={`/cases/${item.id}`} className="icon-button" title="查看案件" aria-label="查看案件"><Icon name="chevron-right" size={16} /></Link></td></tr>
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'blue' | 'amber' | 'violet' | 'green' }) { return <div className={`metric metric-${tone}`}><div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div><div className="mt-1 text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div></div> }
