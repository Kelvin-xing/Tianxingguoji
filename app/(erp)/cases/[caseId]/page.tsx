import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { AssessmentEditor, type AssessmentEditorView } from '@/components/cases/AssessmentEditor'
import { CandidateListWorkspace } from '@/components/cases/CandidateListWorkspace'
import { CaseWorkflowControls } from '@/components/cases/CaseStageControls'
import { CaseStageTimeline } from '@/components/cases/CaseStageTimeline'
import { CaseWorkflowProvider } from '@/components/cases/CaseWorkflowContext'
import { CaseTasksPanel } from '@/components/tasks/CaseTasksPanel'
import { Icon } from '@/components/workspace/Icon'
import {
  AssessmentServiceError,
  CaseWorkspaceError,
  getCaseWorkspaceRuntime,
  type AssessmentView,
  type CaseWorkspaceStage,
} from '@/modules/cases/server'
import { requireApiRequestAccessContext } from '@/app/api/v1/request-access'
import { ApiContractError } from '@/modules/shared/public'

export const dynamic = 'force-dynamic'

export default async function CaseDetailPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params
  let record
  let assessment
  let actor
  try {
    actor = await requireApiRequestAccessContext()
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
  const { roles: actorRoles } = actor
  const canOpenPortalAccess = actorRoles.includes('founder') || actor.userId === record.primaryUserId

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/cases" className="quiet-link">案件</Link><Icon name="chevron-right" size={14} /><span>{record.caseNumber}</span></div>
      <section className="flex flex-col lg:flex-row lg:items-start justify-between gap-4"><div><div className="eyebrow">案件</div><h2 className="page-title">{record.studentName}<span className="font-normal" style={{ color: 'var(--text-muted)' }}> · {record.caseNumber}</span></h2><p className="page-subtitle">K12 · {record.intakeYear} · {admissionLabel(record.admissionType)} · {record.primaryBindingLabel}</p></div><div className="flex flex-wrap gap-2"><Link href={`/students/${record.studentId}`} className="secondary-button"><Icon name="user" size={15} />查看學生</Link>{canOpenPortalAccess && <Link href={`/cases/${caseId}/access`} className="secondary-button"><Icon name="lock" size={15} />家長入口</Link>}</div></section>

      <CaseStageTimeline caseId={caseId} stage={record.stage} primaryOwnerLabel={record.primaryBindingLabel} />

      <CaseWorkflowProvider initialWorkflowStatus={record.workflowStatus}>
        <CaseWorkflowControls
          key={`${record.id}-${record.stage}-${record.workflowStatus}-${record.recordVersion}`}
          caseId={caseId}
          initialStage={record.stage}
          initialWorkflowStatus={record.workflowStatus}
          initialRecordVersion={record.recordVersion}
          initialAvailableWorkflowActions={record.availableWorkflowActions}
        />
        <CaseTasksPanel key={`${record.id}-${record.recordVersion}`} caseId={caseId} />
      </CaseWorkflowProvider>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="workspace-section"><div className="mb-4"><h3 className="section-title">案件資料</h3><p className="section-detail">顯示本案的基本資料。</p></div><div className="grid grid-cols-2 gap-4"><Info label="案件編號" value={record.caseNumber} /><Info label="學生" value={record.studentName} /><Info label="入學年度" value={String(record.intakeYear)} /><Info label="申請類型" value={admissionLabel(record.admissionType)} /><Info label="主要顧問" value={record.primaryBindingLabel} /><Info label="資料版本" value={String(record.recordVersion)} /></div></section>
        <section className="workspace-section"><div className="mb-4"><h3 className="section-title">評估設定</h3><p className="section-detail">評估會沿用案件建立時核准的版本。</p></div><div className="grid grid-cols-1 gap-3"><Info label="評估編號" value={record.assessmentId} /><Info label="版本編號" value={record.manifestId} /><Info label="狀態" value={assessmentStatusLabel(assessment.status)} /></div></section>
      </div>

      <AssessmentEditor
        endpoint={`/api/v1/cases/${caseId}/assessment`}
        initialView={serializeAssessmentView(assessment)}
      />

      <CandidateListWorkspace
        caseId={caseId}
        initialCaseRecordVersion={record.recordVersion}
        initialCaseStage={record.stage}
        initialWorkflowStatus={record.workflowStatus}
        selectionReady={assessment.status === 'background_complete' || assessment.status === 'selection_ready'}
        canManageCandidateLists={actorRoles.includes('advisor')}
        canReviewCandidateLists={actorRoles.includes('founder')}
      />

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
    access: {
      mode: view.access.mode,
      can_edit: view.access.canEdit,
      editable_field_ids: [...view.access.editableFieldIds],
      can_complete_background: view.access.canCompleteBackground,
    },
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
