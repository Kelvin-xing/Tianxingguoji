import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { AssessmentEditor, type AssessmentEditorView } from '@/components/cases/AssessmentEditor'
import { CaseStageControls } from '@/components/cases/CaseStageControls'
import { Icon } from '@/components/workspace/Icon'
import {
  AssessmentServiceError,
  CaseWorkspaceError,
  getCaseWorkspaceRuntime,
  type AssessmentView,
  type CaseWorkspaceStage,
} from '@/modules/cases/server'
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
  let assessment
  let actor
  try {
    actor = await requireIdentityActor()
    const runtime = getCaseWorkspaceRuntime()
    record = await runtime.service.findCase(actor, caseId)
    if (record) assessment = await runtime.assessmentService.getCaseAssessment({ actor, caseId })
  } catch (error) {
    if (error instanceof ApiContractError && error.code === 'UNAUTHENTICATED') redirect('/login')
    if (error instanceof CaseWorkspaceError && error.code === 'CASE_WORKSPACE_INVALID') notFound()
    if (error instanceof AssessmentServiceError && error.code === 'ASSESSMENT_CASE_NOT_FOUND') notFound()
    throw error
  }
  if (!record || !assessment) notFound()
  const stageIndex = stages.findIndex(({ key }) => key === record.stage)

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/cases" className="quiet-link">案件</Link><Icon name="chevron-right" size={14} /><span>{record.caseNumber}</span></div>
      <section className="flex flex-col lg:flex-row lg:items-start justify-between gap-4"><div><div className="eyebrow">CaseWorkflow · ServiceCase</div><h2 className="page-title">{record.studentName}<span className="font-normal" style={{ color: 'var(--text-muted)' }}> · {record.caseNumber}</span></h2><p className="page-subtitle">K12 · {record.intakeYear} · {admissionLabel(record.admissionType)} · {record.primaryBindingLabel}</p></div><Link href={`/students/${record.studentId}`} className="secondary-button"><Icon name="user" size={15} />Student 360</Link></section>

      <section className="workspace-section"><div className="mb-5"><h3 className="section-title">案件階段</h3><p className="section-detail">Assessment 完成後仍由獨立的案件階段命令推進，不會由頁面自動跳階段。</p></div><div className="overflow-x-auto"><div className="stage-track">{stages.map((stage, index) => { const done = index < stageIndex; const active = index === stageIndex; return <div className="stage-node" key={stage.key}><div className={`stage-dot ${done ? 'done' : ''} ${active ? 'active' : ''}`}>{done ? <Icon name="check" size={13} /> : index + 1}</div><span className={active ? 'active-label' : ''}>{stage.label}</span>{index < stages.length - 1 && <div className={`stage-line ${done ? 'done' : ''}`} />}</div> })}</div></div></section>

      <CaseStageControls
        key={`${record.id}-${record.stage}-${record.recordVersion}`}
        endpoint={`/api/v1/cases/${caseId}/transitions`}
        initialStage={record.stage}
        initialRecordVersion={record.recordVersion}
        assessmentStatus={assessment.status}
        canAdvance={actor.userId === record.primaryUserId && (actor.role === 'advisor' || actor.role === 'founder')}
        canRollback={actor.role === 'founder'}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="workspace-section"><div className="mb-4"><h3 className="section-title">案件身份</h3><p className="section-detail">這些欄位屬於 ServiceCase，不複製 Student 身份資料。</p></div><div className="grid grid-cols-2 gap-4"><Info label="Case number" value={record.caseNumber} /><Info label="Student" value={record.studentName} /><Info label="Intake year" value={String(record.intakeYear)} /><Info label="Admission type" value={admissionLabel(record.admissionType)} /><Info label="Primary" value={record.primaryBindingLabel} /><Info label="Record version" value={String(record.recordVersion)} /></div></section>
        <section className="workspace-section"><div className="mb-4"><h3 className="section-title">Assessment 綁定</h3><p className="section-detail">評估固定使用建案時批准的 15 字段 Manifest，之後不會靜默換版本。</p></div><div className="grid grid-cols-1 gap-3"><Info label="Assessment ID" value={record.assessmentId} /><Info label="Manifest ID" value={record.manifestId} /><Info label="Status" value={assessmentStatusLabel(assessment.status)} /></div></section>
      </div>

      <AssessmentEditor
        endpoint={`/api/v1/cases/${caseId}/assessment`}
        initialView={serializeAssessmentView(assessment)}
      />

      <div className="preview-notice"><Icon name="shield" size={15} /><span>PostgreSQL authoritative read/write · 每個答案獨立版本控制，完成背景收集時再次驗證權限、阻塞項、評估版本與冪等憑據。</span></div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div><div className="mt-1 text-sm font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{value}</div></div>
}

function admissionLabel(value: string): string {
  return value === 's1_admission' ? 'S1 入學' : value === 'transfer' ? '插班' : value
}

function assessmentStatusLabel(value: AssessmentView['status']): string {
  if (value === 'draft') return '草稿，待補資料'
  if (value === 'background_complete') return '背景資料已完成'
  return '可進入選校'
}

function serializeAssessmentView(view: AssessmentView): AssessmentEditorView {
  return {
    assessment_id: view.assessmentId,
    manifest_id: view.manifestId,
    record_version: view.recordVersion,
    status: view.status,
    schema: {
      manifest_id: view.schema.manifestId,
      composition_version: view.schema.compositionVersion,
      fields: view.schema.fields.map((field) => ({
        field_id: field.fieldId,
        ...(field.label ? { label: field.label } : {}),
        layer: field.layer,
        ...(field.moduleId ? { module_id: field.moduleId } : {}),
        ...(field.moduleVersion ? { module_version: field.moduleVersion } : {}),
        value_type: field.valueType,
        ...(field.enumValues ? { enum_values: [...field.enumValues] } : {}),
        visibility: field.visibility,
        blocking_stages: [...field.blockingStages],
      })),
    },
    answers: view.answers.map((answer) => ({
      field_id: answer.fieldId,
      semantic_state: answer.semanticState,
      value: toEditorValue(answer.value),
      value_type: answer.valueType,
      record_version: answer.recordVersion,
    })),
  }
}

function toEditorValue(value: AssessmentView['answers'][number]['value']): AssessmentEditorView['answers'][number]['value'] {
  if (value === null) return null
  if (!Array.isArray(value) && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>
    if (typeof record.type === 'string' && Object.hasOwn(record, 'value')) {
      return { type: record.type, value: record.value }
    }
  }
  throw new Error('Assessment answer projection is invalid.')
}
