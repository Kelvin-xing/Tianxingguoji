import { expectArray, expectRecord, expectString, requestApi, expectReceipt, type ApiRequestBody } from '@/lib/api/client'

export type F3Task = Readonly<Record<string, unknown>> & { readonly id: string; readonly task_type: string; readonly state: string; readonly due_at: string | null; readonly allowed_actions: readonly string[] }
export type CompletionRecord = { readonly submitted_at: string; readonly submission_channel: string; readonly submitter_user_id: string; readonly checklist_snapshot: Readonly<Record<string, ApiRequestBody>>; readonly official_submission_reference: string | null; readonly no_reference_declared: boolean }
  | { readonly completed_at: string; readonly interview_method: string; readonly coaching_summary: string }

function decodeTask(value: unknown): F3Task { const row = expectRecord(value); return { ...row, id: expectString(row.id), task_type: expectString(row.task_type ?? row.taskType), state: expectString(row.state), due_at: typeof row.due_at === 'string' ? row.due_at : null, allowed_actions: Array.isArray(row.allowed_actions) ? row.allowed_actions.filter((item): item is string => typeof item === 'string') : [] } }
function decodeTasks(value: unknown): readonly F3Task[] { const root = expectRecord(value); return expectArray(root.items ?? root.tasks, decodeTask) }

export function listAssignedTasks() { return requestApi({ path: '/api/v1/tasks/assigned' }, decodeTasks) }
export function getTask(taskId: string) { return requestApi({ path: `/api/v1/tasks/${encodeURIComponent(taskId)}` as `/${string}` }, decodeTask) }
export function getContractorTask(taskId: string) { return requestApi({ path: `/api/v1/contractor/tasks/${encodeURIComponent(taskId)}/workspace` as `/${string}` }, decodeTask) }
export type F3TransitionAction = 'complete' | 'accept' | 'reject' | 'reassign' | 'cancel'
export function taskTransition(taskId: string, action: F3TransitionAction, body: ApiRequestBody = {}, expectedRecordVersion: number, completionRecord?: CompletionRecord) {
  const transitionBody = action === 'complete'
    ? completionRecord ? { ...body as Record<string, ApiRequestBody>, action, completion_record: completionRecord, evidence_reference: null } : (() => { throw new Error('COMPLETION_RECORD_REQUIRED') })()
    : { ...body as Record<string, ApiRequestBody>, action }
  return requestApi({ path: `/api/v1/tasks/${encodeURIComponent(taskId)}/p3-transitions` as `/${string}`, method: 'POST', body: transitionBody, idempotencyKey: crypto.randomUUID(), expectedRecordVersion }, expectReceipt)
}
export function completeTask(taskId: string, completionRecord: CompletionRecord, expectedRecordVersion: number) { return taskTransition(taskId, 'complete', {}, expectedRecordVersion, completionRecord) }
export function taskCommand(taskId: string, action: Exclude<F3TransitionAction, 'complete'>, body: ApiRequestBody, expectedRecordVersion: number) { return taskTransition(taskId, action, body, expectedRecordVersion) }
export function getCaseF3(caseId: string, section: 'applications' | 'interviews') { return requestApi({ path: `/api/v1/cases/${encodeURIComponent(caseId)}/school-targets` as `/${string}` }, (value) => { const root = expectRecord(value); return { ...root, items: Array.isArray(root.items) ? root.items : [] } }) }
export function completeCaseAction(caseId: string, action: 'close', body: ApiRequestBody) { return requestApi({ path: `/api/v1/cases/${encodeURIComponent(caseId)}/${action}` as `/${string}`, method: 'POST', body, idempotencyKey: crypto.randomUUID() }, expectReceipt) }
