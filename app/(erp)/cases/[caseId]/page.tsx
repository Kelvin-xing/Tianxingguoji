import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { AssessmentEditor, type AssessmentEditorView } from '@/components/cases/AssessmentEditor'
import { CandidateListWorkspace } from '@/components/cases/CandidateListWorkspace'
import { CaseWorkflowControls } from '@/components/cases/CaseStageControls'
import { CaseStageTimeline } from '@/components/cases/CaseStageTimeline'
import { CaseReferralSourcePanel } from '@/components/cases/CaseReferralSourcePanel'
import { CaseWorkflowProvider } from '@/components/cases/CaseWorkflowContext'
import { CaseTasksPanel } from '@/components/tasks/CaseTasksPanel'
import { Page, PageHeader, Card, DataList, Tag } from '@/components/ui/standard'
import {
  AssessmentServiceError,
  CaseWorkspaceError,
  getCaseWorkspaceRuntime,
  type AssessmentView,
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
  const trialLevel = actor.trialPrincipal?.level
  const canManageCandidateLists = trialLevel ? ['founder','l1','l2'].includes(trialLevel) : actorRoles.includes('advisor')
  const canReviewCandidateLists = trialLevel ? ['founder','l1'].includes(trialLevel) : actorRoles.includes('founder')
  const canOpenPortalAccess = actorRoles.includes('founder') || actor.userId === record.primaryUserId

  return (
    <Page>
      <Link href="/cases" className="ui-link">案件</Link>
      <PageHeader title={`${record.studentName} · ${record.caseNumber}`}
        description={`K12 · ${record.intakeYear} · ${admissionLabel(record.admissionType)} · ${record.primaryBindingLabel}`}>
        <Tag tone={record.stage === 'closed' ? 'neutral' : 'primary'}>{caseStageLabel(record.stage)}</Tag>
      </PageHeader>
      <div className="ui-actions">
        <Link href={`/students/${record.studentId}`} className="ui-button ui-secondary">查看學生</Link>
        {canOpenPortalAccess && <Link href={`/cases/${caseId}/access`} className="ui-button ui-secondary">家長入口</Link>}
      </div>

      <CaseStageTimeline caseId={caseId} stage={record.stage} primaryOwnerLabel={record.primaryBindingLabel} />

      <div className="ui-columns">
      <div className="ui-stack">
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



      {canManageCandidateLists && <Link className="ui-button ui-secondary" href={`/cases/${caseId}/interviews`}>登記及查看面試邀請</Link>}



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
        canManageCandidateLists={canManageCandidateLists}
        canReviewCandidateLists={canReviewCandidateLists}
      />

      </div>
      <aside className="ui-stack">
      <div className="ui-stack">
        <Card title="案件資料">
          <p className="ui-muted">顯示本案的基本資料。</p>
          <DataList items={[
            { label: '案件編號', value: record.caseNumber },
            { label: '學生', value: record.studentName },
            { label: '入學年度', value: String(record.intakeYear) },
            { label: '申請類型', value: admissionLabel(record.admissionType) },
            { label: '主要顧問', value: record.primaryBindingLabel },
            { label: '資料版本', value: String(record.recordVersion) },
          ].filter(item => item.value !== '')} />
        </Card>
        <Card title="評估設定">
          <p className="ui-muted">評估會沿用案件建立時核准的版本。</p>
          <DataList items={[
            { label: '評估編號', value: record.assessmentId },
            { label: '版本編號', value: record.manifestId },
            { label: '狀態', value: assessmentStatusLabel(assessment.status) },
          ].filter(item => item.value !== '')} />
        </Card>
      </div>
      <CaseReferralSourcePanel caseId={caseId} />
      </aside>
      </div>
    </Page>
  )
}

function caseStageLabel(value: string): string {
  const labels: Record<string, string> = { signed: '已簽約', background_collection: '背景資料', school_selection_confirmed: '選校確認', application_in_progress: '申請處理', closed: '已結案' };
  return labels[value] ?? value;
}

function admissionLabel(value: string): string {
  return value === 'entry' ? '首次入學' : value === 's1_admission' ? 'S1 入學' : value === 'transfer' ? '插班' : value
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
