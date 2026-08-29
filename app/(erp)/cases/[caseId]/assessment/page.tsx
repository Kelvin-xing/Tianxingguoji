import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { AssessmentEditor, type AssessmentEditorView } from '@/components/cases/AssessmentEditor'
import { Icon } from '@/components/workspace/Icon'
import {
  AssessmentServiceError,
  CaseWorkspaceError,
  getCaseWorkspaceRuntime,
  type AssessmentView,
} from '@/modules/cases/server'
import { requireApiRequestAccessContext } from '@/app/api/v1/request-access'
import { ApiContractError } from '@/modules/shared/public'

export const dynamic = 'force-dynamic'

export default async function CaseAssessmentPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params
  let record
  let assessment
  try {
    const actor = await requireApiRequestAccessContext()
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

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <Link href={`/cases/${caseId}`} className="quiet-link">案件</Link>
        <Icon name="chevron-right" size={14} />
        <span>評估</span>
      </div>
      <section>
        <div className="eyebrow">案件 · 評估</div>
        <h2 className="page-title">{record.studentName}<span className="font-normal" style={{ color: 'var(--text-muted)' }}> · {record.caseNumber}</span></h2>
        <p className="page-subtitle">K12 · {record.intakeYear} · {record.primaryBindingLabel}</p>
      </section>
      <section className="workspace-section">
        <div className="mb-4">
          <h3 className="section-title">評估</h3>
          <p className="section-detail">評估內容會沿用案件建立時核准的版本。</p>
        </div>
        <AssessmentEditor endpoint={`/api/v1/cases/${caseId}/assessment`} initialView={serializeAssessmentView(assessment)} />
      </section>
      <Link href={`/cases/${caseId}`} className="secondary-button">返回案件</Link>
    </div>
  )
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
