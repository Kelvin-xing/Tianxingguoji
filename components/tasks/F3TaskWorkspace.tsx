'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { getTask, completeTask, taskCommand, type F3Task } from '@/components/tasks/f3-client'
import { ErrorState, LoadingState, StaleState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError } from '@/lib/api/client'

export function F3TaskWorkspace({ taskId, contractor = false }: { readonly taskId: string; readonly contractor?: boolean }) {
  const [task, setTask] = useState<F3Task | null>(null); const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'unavailable' | 'stale' | 'error'>('loading'); const [notice, setNotice] = useState<string | null>(null)
  const load = useCallback(() => { setState('loading'); void (contractor ? import('@/components/tasks/f3-client').then(({ getContractorTask }) => getContractorTask(taskId)) : getTask(taskId)).then((value) => { setTask(value); setState('ready') }).catch((error: unknown) => { if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setState('denied'); else if (error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE') setState('unavailable'); else if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setState('stale'); else setState('error') }) }, [contractor, taskId])
  useEffect(() => { load() }, [load])
  if (state === 'loading') return <LoadingState title="正在载入 Task" />
  if (state === 'denied') return <ErrorState title="Task 不可用" detail={contractor ? '当前 Task 不是有效的 interview_support assignment。' : '当前身份没有此 Task 权限。'} action={<Link href="/tasks" className="primary-button">返回 Tasks</Link>} />
  if (state === 'unavailable') return <UnavailableState title="Task 服务暂时不可用" detail="不会降级到 preview/mock Task。" onRetry={load} />
  if (state === 'stale') return <StaleState title="Task 版本已变化" detail="请重新载入后再提交。" onRetry={load} />
  if (state === 'error' || !task) return <ErrorState title="Task 读取失败" onRetry={load} />
  const canComplete = task.allowed_actions.includes('complete'); const canReject = task.allowed_actions.includes('reject'); const canReassign = task.allowed_actions.includes('reassign'); const canCancel = task.allowed_actions.includes('cancel');
  async function command(kind: 'complete' | 'reject' | 'reassign' | 'cancel') { try { if (kind === 'complete') { if (task!.task_type !== 'interview_support') { setNotice('当前 Task 完成表单尚未可用；不会发送必拒 payload。'); return } const completion = { completed_at: new Date().toISOString(), interview_method: '未提供', coaching_summary: '已完成辅助' }; await completeTask(task!.id, completion, Number(task!.record_version ?? 0)) } else await taskCommand(task!.id, kind, { reason: 'operator decision' }, Number(task!.record_version ?? 0)); setNotice('命令已返回 receipt，正在重新载入服务端状态。'); load() } catch (error) { setNotice(error instanceof ApiClientError && error.code === 'STALE_VERSION' ? 'Task 已更新，请刷新后再试。' : '命令暂时不可用，输入已保留。') } }
  return <div className="max-w-4xl mx-auto space-y-6"><Link href="/tasks" className="quiet-link">← Tasks</Link><section className="workspace-section"><div className="eyebrow">{contractor ? 'Contractor · interview_support' : 'Task workspace'}</div><h2 className="page-title">{String(task.title ?? task.task_type)}</h2><p className="page-subtitle">状态：{task.state} · Due：{task.due_at ?? '未设置'}{task.overdue ? ' · Overdue' : ''}</p>{contractor ? <p className="inline-callout">Contractor 脱敏视图：仅显示当前 interview_support Task 的学校/时间/方式/语言/brief，不显示 Case、Student、Guardian、文件或其他 Task。</p> : null}<div className="flex flex-wrap gap-2 mt-5">{canComplete ? <button className="primary-button" onClick={() => void command('complete')}>完成 Task</button> : null}{canReject ? <button className="secondary-button" onClick={() => void command('reject')}>拒绝</button> : null}{canReassign ? <button className="secondary-button" onClick={() => void command('reassign')}>重派</button> : null}{canCancel ? <button className="secondary-button" onClick={() => void command('cancel')}>取消</button> : null}</div>{notice ? <p className="mt-4" role="status">{notice}</p> : null}</section></div>
}
