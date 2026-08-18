import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { Icon } from '@/components/workspace/Icon'
import { CaseWorkspaceError, getCaseWorkspaceRuntime, type CaseWorkspaceStage } from '@/modules/cases/server'
import { requireIdentityActor } from '@/modules/identity/web'
import { ApiContractError } from '@/modules/shared/public'

export const dynamic = 'force-dynamic'

const stages: ReadonlyArray<{ key: CaseWorkspaceStage; label: string }> = [
  { key: 'signed', label: '已簽約' },
  { key: 'background_collection', label: '背景資料' },
  { key: 'school_selection_confirmed', label: '選校確認' },
  { key: 'interview_preparation', label: '面試準備' },
  { key: 'application_submitted', label: '已提交' },
  { key: 'awaiting_result', label: '等待結果' },
  { key: 'offer_confirmed', label: 'Offer 確認' },
  { key: 'closed', label: '已結案' },
]

export default async function CaseDetailPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params
  let record
  try {
    record = await getCaseWorkspaceRuntime().service.findCase(await requireIdentityActor(), caseId)
  } catch (error) {
    if (error instanceof ApiContractError && error.code === 'UNAUTHENTICATED') redirect('/login')
    if (error instanceof CaseWorkspaceError && error.code === 'CASE_WORKSPACE_INVALID') notFound()
    throw error
  }
  if (!record) notFound()
  const stageIndex = stages.findIndex(({ key }) => key === record.stage)

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/cases" className="quiet-link">案件</Link><Icon name="chevron-right" size={14} /><span>{record.caseNumber}</span></div>
      <section className="flex flex-col lg:flex-row lg:items-start justify-between gap-4"><div><div className="eyebrow">CaseWorkflow · ServiceCase</div><h2 className="page-title">{record.studentName}<span className="font-normal" style={{ color: 'var(--text-muted)' }}> · {record.caseNumber}</span></h2><p className="page-subtitle">K12 · {record.intakeYear} · {admissionLabel(record.admissionType)} · {record.primaryBindingLabel}</p></div><Link href={`/students/${record.studentId}`} className="secondary-button"><Icon name="user" size={15} />Student 360</Link></section>

      <section className="workspace-section"><div className="mb-5"><h3 className="section-title">案件階段</h3><p className="section-detail">本階段只接通建立與讀取；階段變更仍保持關閉。</p></div><div className="overflow-x-auto"><div className="stage-track">{stages.map((stage, index) => { const done = index < stageIndex; const active = index === stageIndex; return <div className="stage-node" key={stage.key}><div className={`stage-dot ${done ? 'done' : ''} ${active ? 'active' : ''}`}>{done ? <Icon name="check" size={13} /> : index + 1}</div><span className={active ? 'active-label' : ''}>{stage.label}</span>{index < stages.length - 1 && <div className={`stage-line ${done ? 'done' : ''}`} />}</div> })}</div></div></section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="workspace-section"><div className="mb-4"><h3 className="section-title">案件身份</h3><p className="section-detail">這些欄位屬於 ServiceCase，不複製 Student 身份資料。</p></div><div className="grid grid-cols-2 gap-4"><Info label="Case number" value={record.caseNumber} /><Info label="Student" value={record.studentName} /><Info label="Intake year" value={String(record.intakeYear)} /><Info label="Admission type" value={admissionLabel(record.admissionType)} /><Info label="Primary" value={record.primaryBindingLabel} /><Info label="Record version" value={String(record.recordVersion)} /></div></section>
        <section className="workspace-section"><div className="mb-4"><h3 className="section-title">Assessment 綁定</h3><p className="section-detail">建案時只建立空白 draft；本階段不錄入評估答案。</p></div><div className="grid grid-cols-1 gap-3"><Info label="Assessment ID" value={record.assessmentId} /><Info label="Manifest ID" value={record.manifestId} /><Info label="Status" value={record.assessmentStatus === 'draft' ? '草稿，待補資料' : record.assessmentStatus} /></div></section>
      </div>

      <div className="preview-notice"><Icon name="shield" size={15} /><span>PostgreSQL authoritative read · 案件、Assessment、審計和冪等憑據已持久化；學校、任務和文件不在本切片偽造展示。</span></div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div><div className="mt-1 text-sm font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{value}</div></div>
}

function admissionLabel(value: string): string {
  return value === 's1_admission' ? 'S1 入學' : value === 'transfer' ? '插班' : value
}
