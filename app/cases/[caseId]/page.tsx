import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Icon } from '@/components/workspace/Icon'
import { requireActor } from '@/modules/identity/web'
import { getCaseDetail } from '@/modules/cases/server'
import { ApiContractError } from '@/modules/shared/public'
import type { CaseRecord } from '@/types'

const stageSequence: Array<{ key: CaseRecord['stage']; label: string }> = [
  { key: 'signed', label: '已簽約' },
  { key: 'background_collection', label: '背景資料' },
  { key: 'school_selection_confirmed', label: '已確認選校' },
  { key: 'interview_preparation', label: '面試準備' },
  { key: 'application_submitted', label: '已提交申請' },
  { key: 'awaiting_result', label: '等待結果' },
  { key: 'offer_confirmed', label: 'Offer 已確認' },
  { key: 'closed', label: '已結案' },
]

export default async function CaseDetailPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params
  let record: CaseRecord | undefined
  try {
    record = await getCaseDetail(await requireActor(), caseId)
  } catch (error) {
    if (error instanceof ApiContractError && error.code === 'UNAUTHENTICATED') redirect('/login')
    throw error
  }
  if (!record) notFound()
  const currentStage = stageSequence.findIndex((item) => item.key === record.stage)

  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/cases" className="quiet-link">案件</Link><Icon name="chevron-right" size={14} /><span>{record.case_number}</span></div>
      <section className="flex flex-col xl:flex-row xl:items-start justify-between gap-5"><div><div className="flex items-center gap-2"><span className="status-pill" style={{ background: '#dbeafe', color: '#1e40af' }}>{record.stage_label}</span><span className="text-xs" style={{ color: 'var(--text-muted)' }}>Updated {formatDate(record.updated_at)}</span></div><h2 className="page-title mt-3">{record.student_name}<span className="font-normal" style={{ color: 'var(--text-muted)' }}> · {record.case_number}</span></h2><p className="page-subtitle">{record.student_name_en} · {record.intake_year} · {record.admission_type === 's1_admission' ? 'S1 入學' : '插班'} · {record.advisor}</p></div><div className="flex gap-2"><Link href={`/students/${record.student_id}`} className="secondary-button"><Icon name="user" size={15} />Student 360</Link><button type="button" className="secondary-button" disabled title="Mutation API 尚未接通"><Icon name="settings" size={15} />更新階段</button></div></section>

      <section className="workspace-section"><div className="flex items-center justify-between gap-4 mb-5"><div><h3 className="section-title">案件階段</h3><p className="section-detail">Stage mutation 需要 P1 route policy、receipt 和 optimistic version。</p></div><span className="inline-status" style={{ color: record.blockers.length ? '#b45309' : '#15803d' }}><span className="status-dot" />{record.blockers.length ? `${record.blockers.length} 個 blocker` : '無 blocker'}</span></div><div className="overflow-x-auto"><div className="stage-track">{stageSequence.map((stage, index) => { const done = index < currentStage; const active = index === currentStage; return <div className="stage-node" key={stage.key}><div className={`stage-dot ${done ? 'done' : ''} ${active ? 'active' : ''}`}>{done ? <Icon name="check" size={13} /> : index + 1}</div><span className={active ? 'active-label' : ''}>{stage.label}</span>{index < stageSequence.length - 1 && <div className={`stage-line ${done ? 'done' : ''}`} />}</div> })}</div></div></section>

      {record.blockers.length > 0 && <section className="blocker-banner"><Icon name="clock" size={17} /><div><strong>需要處理</strong><div>{record.blockers.join(' · ')}</div></div><Link href="#tasks" className="quiet-link ml-auto">查看任務<Icon name="arrow-right" size={14} /></Link></section>}

      <nav className="detail-tabs" aria-label="案件分頁"><a href="#overview" className="active">概覽</a><a href="#assessment">Assessment</a><a href="#schools">學校目標 <span>{record.school_targets.length}</span></a><a href="#tasks">任務 <span>{record.tasks.length}</span></a><a href="#documents">文件 <span>{record.documents.length}</span></a><a href="#activity">Activity</a></nav>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,.65fr)] gap-5">
        <div className="space-y-5">
          <section id="overview" className="workspace-section"><SectionTitle title="案件概覽" detail="Case identity 與目前可執行的下一步" /><div className="grid grid-cols-2 md:grid-cols-4 gap-4"><Info label="Case number" value={record.case_number} /><Info label="Application" value="K12" /><Info label="Primary Advisor" value={record.advisor} /><Info label="Manifest" value={record.manifest_status === 'approved' ? 'Approved' : record.manifest_status} /></div><div className="next-action"><div className="work-icon blue"><Icon name="arrow-right" size={16} /></div><div><div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--accent)' }}>Next action</div><div className="mt-1 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{record.next_action}</div><div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Due {record.next_action_date}</div></div></div></section>
          <section id="assessment" className="workspace-section"><SectionTitle title="Assessment" detail="四層 manifest 的填寫狀態，不用空字串代替 semantic state" /><div className="assessment-grid"><Assessment label="基本身份" status="complete" detail="provided" /><Assessment label="教育階段" status="complete" detail="provided" /><Assessment label="學校系統" status={record.assessment_status === 'draft' ? 'blocked' : 'complete'} detail={record.assessment_status === 'draft' ? '待補資料' : 'provided'} /><Assessment label="Admission route" status="pending" detail="待確認" /></div></section>
          <section id="schools" className="workspace-section"><SectionTitle title="學校目標" detail="每個 SchoolTarget 有獨立狀態和 evidence provenance" /><div className="divide-y" style={{ borderTop: '1px solid var(--border-subtle)' }}>{record.school_targets.map((target) => <div key={target.id} className="target-row"><div className="work-icon blue"><Icon name="book-open" size={15} /></div><div className="min-w-0 flex-1"><div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{target.school_name}</div><div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{target.next_action} · {target.next_action_date}</div></div><div className="text-right"><span className="status-pill" style={targetStateStyle(target.state)}>{target.state}</span><div className="mt-1 text-[11px]" style={{ color: target.evidence_status === 'complete' ? '#15803d' : '#b45309' }}>evidence {target.evidence_status}</div></div></div>)}</div></section>
        </div>
        <div className="space-y-5">
          <section id="tasks" className="workspace-section"><SectionTitle title="任務" detail="需要 receipt 的狀態轉移由 owning service 執行" />{record.tasks.map((task) => <div key={task.id} className="compact-row"><div className={`work-icon ${task.status === 'blocked' ? 'warning' : 'blue'}`}><Icon name={task.status === 'done' ? 'check-circle' : 'clipboard'} size={15} /></div><div className="min-w-0"><div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{task.title}</div><div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{task.owner} · {task.due_date}</div></div><span className="text-[11px]" style={{ color: task.status === 'blocked' ? '#b45309' : 'var(--text-muted)' }}>{task.status}</span></div>)}</section>
          <section id="documents" className="workspace-section"><SectionTitle title="文件" detail="版本、掃描和 quarantine 狀態" />{record.documents.map((document) => <div key={document.id} className="compact-row"><div className="work-icon blue"><Icon name="file-text" size={15} /></div><div className="min-w-0 flex-1"><div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{document.name}</div><div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{document.updated_at}</div></div><span className="text-[11px] font-medium" style={{ color: document.status === 'clean' ? '#15803d' : document.status === 'missing' ? '#b45309' : 'var(--text-muted)' }}>{document.status}</span></div>)}</section>
          <section id="activity" className="workspace-section"><SectionTitle title="Activity" detail="Append-only activity preview" />{record.activity.map((activity) => <div key={activity.id} className="activity-row"><div className={`activity-dot ${activity.tone}`} /><div><div className="text-sm" style={{ color: 'var(--text-primary)' }}>{activity.label}</div><div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{activity.actor} · {formatDate(activity.created_at)}</div></div></div>)}</section>
        </div>
      </div>
      <div className="preview-notice"><Icon name="shield" size={15} /><span>Neon authoritative read · Case identity 和 assessment manifest 已按 organization/session scope 載入；tasks/documents/activity 會在各自 owning API 接通後顯示。</span></div>
    </div>
  )
}

function SectionTitle({ title, detail }: { title: string; detail: string }) { return <div className="mb-4"><h3 className="section-title">{title}</h3><p className="section-detail">{detail}</p></div> }
function Info({ label, value }: { label: string; value: string }) { return <div><div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div><div className="mt-1 text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{value}</div></div> }
function Assessment({ label, status, detail }: { label: string; status: 'complete' | 'pending' | 'blocked'; detail: string }) { const color = status === 'complete' ? '#15803d' : status === 'blocked' ? '#b45309' : 'var(--text-muted)'; return <div className="assessment-cell"><div className="flex items-center justify-between"><span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{label}</span><Icon name={status === 'complete' ? 'check-circle' : status === 'blocked' ? 'clock' : 'activity'} size={15} style={{ color }} /></div><div className="mt-3 text-xs" style={{ color }}>{detail}</div></div> }
function targetStateStyle(state: string) { if (state === 'accepted') return { background: '#dcfce7', color: '#166534' }; if (state === 'rejected' || state === 'withdrawn') return { background: '#fee2e2', color: '#991b1b' }; if (state === 'interview') return { background: '#ede9fe', color: '#6d28d9' }; return { background: '#dbeafe', color: '#1e40af' } }
function formatDate(value: string) { return new Date(value).toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' }) }
