'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { getTask, completeTask, taskCommand, type F3Task } from '@/components/tasks/f3-client'
import { ErrorState, LoadingState, StaleState, UnavailableState } from '@/components/states/WorkspaceState'
import { taskStateLabel } from './task-ui'
import { ApiClientError } from '@/lib/api/client'

export function F3TaskWorkspace({ taskId, contractor = false }: { readonly taskId: string; readonly contractor?: boolean }) {
  const [task, setTask] = useState<F3Task | null>(null); const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'unavailable' | 'stale' | 'error'>('loading'); const [notice, setNotice] = useState<string | null>(null)
  const load = useCallback(() => { setState('loading'); void (contractor ? import('@/components/tasks/f3-client').then(({ getContractorTask }) => getContractorTask(taskId)) : getTask(taskId)).then((value) => { setTask(value); setState('ready') }).catch((error: unknown) => { if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setState('denied'); else if (error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE') setState('unavailable'); else if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setState('stale'); else setState('error') }) }, [contractor, taskId])
  useEffect(() => { load() }, [load])
  if (state === 'loading') return <LoadingState title="正在載入任務" />
  if (state === 'denied') return <ErrorState title="無法查看任務" detail={contractor ? '此任務不是有效的面試支援指派。' : '目前帳號沒有此任務的權限。'} action={<Link href="/tasks" className="primary-button">返回任務</Link>} />
  if (state === 'unavailable') return <UnavailableState title="任務服務暫時不可用" detail="請稍後重試。" onRetry={load} />
  if (state === 'stale') return <StaleState title="任務資料已更新" detail="請重新載入後再提交。" onRetry={load} />
  if (state === 'error' || !task) return <ErrorState title="任務讀取失敗" onRetry={load} />
  const canComplete = task.allowed_actions.includes('complete'); const canReject = task.allowed_actions.includes('reject'); const canReassign = task.allowed_actions.includes('reassign'); const canCancel = task.allowed_actions.includes('cancel');
  async function command(kind: 'complete' | 'reject' | 'reassign' | 'cancel') { try { if (kind === 'complete') { if (task!.task_type !== 'interview_support') { setNotice('此任務目前無法完成。'); return } const completion = { completed_at: new Date().toISOString(), interview_method: '未提供', coaching_summary: '已完成支援' }; await completeTask(task!.id, completion, Number(task!.record_version ?? 0)) } else await taskCommand(task!.id, kind, { reason: 'operator decision' }, Number(task!.record_version ?? 0)); setNotice('任務已更新，正在重新載入。'); load() } catch (error) { setNotice(error instanceof ApiClientError && error.code === 'STALE_VERSION' ? '任務資料已更新，請重新載入後再試。' : '任務暫時無法更新，已保留輸入內容。') } }
  return <div className="max-w-4xl mx-auto space-y-6"><Link href="/tasks" className="quiet-link">← 返回任務</Link><section className="workspace-section"><div className="eyebrow">{contractor ? 'Contractor · 面試支援' : '任務詳情'}</div><h2 className="page-title">{taskTitle(task)}</h2><p className="page-subtitle">狀態：{taskStateLabel(task.state)} · 到期：{task.due_at ?? '未設定'}{task.overdue ? ' · 已逾期' : ''}</p>{contractor ? <p className="inline-callout">目前只顯示這項面試支援任務所需的學校、時間、方式、語言和說明。</p> : null}<div className="flex flex-wrap gap-2 mt-5">{canComplete ? <button className="primary-button" onClick={() => void command('complete')}>完成任務</button> : null}{canReject ? <button className="secondary-button" onClick={() => void command('reject')}>拒絕</button> : null}{canReassign ? <button className="secondary-button" onClick={() => void command('reassign')}>重新指派</button> : null}{canCancel ? <button className="secondary-button" onClick={() => void command('cancel')}>取消</button> : null}</div>{notice ? <p className="mt-4" role="status">{notice}</p> : null}</section></div>
}

function taskTitle(task: F3Task): string {
  if (typeof task.title === 'string' && task.title.trim()) return task.title
  const labels: Readonly<Record<string, string>> = {
    application_prepare_submit: '準備並提交申請',
    interview_support: '面試支援',
    manual: '手工任務',
  }
  return labels[task.task_type] ?? '任務詳情'
}
