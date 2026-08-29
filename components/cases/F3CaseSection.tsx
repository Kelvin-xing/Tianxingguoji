'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { getCaseF3, completeCaseAction } from '@/components/tasks/f3-client'
import { EmptyState, ErrorState, LoadingState, UnavailableState } from '@/components/states/WorkspaceState'

export function F3CaseSection({ caseId, section }: { readonly caseId: string; readonly section: 'applications' | 'interviews' | 'close' }) { const [data, setData] = useState<Record<string, unknown> | null>(null); const [state, setState] = useState<'loading'|'ready'|'empty'|'unavailable'|'error'>('loading'); const load = useCallback(() => { if (section === 'close') { setState('ready'); return } setState('loading'); void getCaseF3(caseId, section).then((value) => { setData(value); setState(Array.isArray(value.items) && value.items.length ? 'ready' : 'empty') }).catch(() => setState('unavailable')) }, [caseId, section]); useEffect(() => { load() }, [load]); if (state === 'loading') return <LoadingState title="正在載入案件資料" />; if (state === 'unavailable') return <UnavailableState title="案件資料暫時不可用" detail="請稍後重試。" onRetry={load} />; if (state === 'error') return <ErrorState title="案件資料讀取失敗" onRetry={load} />; if (section === 'close') return <ClosePanel caseId={caseId} />; if (state === 'empty') return <EmptyState title={section === 'interviews' ? '目前沒有需要面試的學校' : '目前沒有可顯示的申請目標'} detail="完成選校確認後，申請目標會顯示在這裡。" />; return <div className="workspace-section"><div className="space-y-2">{(data?.items as readonly Record<string, unknown>[]).map((item, index) => <div className="selection-card" key={String(item.id ?? index)}><span className="min-w-0"><strong>{String(item.school_name ?? item.schoolName ?? '學校')}</strong><small>狀態：{itemStateLabel(String(item.state ?? ''))} · 任務：{itemStateLabel(String(item.task_state ?? ''))}</small></span><span className="status-pill">{Array.isArray(item.allowed_actions) ? item.allowed_actions.map((action) => actionLabel(String(action))).join(' · ') : '唯讀'}</span></div>)}</div></div> }

function ClosePanel({ caseId }: { readonly caseId: string }) { const [notice, setNotice] = useState<string | null>(null); return <section className="workspace-section"><h3 className="section-title">Founder 結案</h3><p className="section-detail">即使所有學校拒絕，也需要 Founder 明確確認結案。</p><button className="primary-button mt-4" onClick={() => void completeCaseAction(caseId, 'close', { reason: 'founder_case_close' }).then(() => setNotice('案件已結案。')).catch(() => setNotice('案件目前無法結案。'))}>Founder 結案</button>{notice ? <p className="mt-3" role="status">{notice}</p> : null}<Link className="secondary-button mt-4" href={`/cases/${caseId}`}>返回案件</Link></section> }

function itemStateLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = { pending: '待處理', in_progress: '處理中', completed: '已完成', rejected: '已拒絕', cancelled: '已取消', not_started: '未開始', created: '已建立', assigned: '已指派' };
  return labels[value] ?? (/[㐀-鿿]/.test(value) ? value : '未提供');
}

function actionLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = { view: '查看', complete: '完成', accept: '接受', reject: '拒絕', reassign: '重新指派', cancel: '取消' };
  return labels[value] ?? '查看';
}
