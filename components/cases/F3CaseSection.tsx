'use client'

import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { Button, Card, Empty, Notice, Table, Tag } from '@/components/ui/standard'
import { useCallback, useEffect, useState } from 'react'
import { getCaseF3, completeCaseAction } from '@/components/tasks/f3-client'
import { LoadingState } from '@/components/states/WorkspaceState'

export function F3CaseSection({ caseId, section }: { readonly caseId: string; readonly section: 'applications' | 'interviews' | 'close' }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [state, setState] = useState<'loading'|'ready'|'empty'|'unavailable'|'error'>('loading');
  const load = useCallback(() => {
    if (section === 'close') { setState('ready'); return; }
    setState('loading');
    void getCaseF3(caseId, section).then(value => {
      setData(value);
      setState(Array.isArray(value.items) && value.items.length ? 'ready' : 'empty');
    }).catch(() => setState('unavailable'));
  }, [caseId, section]);
  useEffect(() => { queueMicrotask(load); }, [load]);
  if (section === 'close') {
    if (state === 'loading') return <LoadingState title="正在載入案件資料" />;
    return <ClosePanel caseId={caseId} />;
  }
  return <Card title={section === 'interviews' ? '面試' : '逐校申請'}>
    {state === 'loading' ? <Notice>正在載入案件資料</Notice> : null}
    {state === 'unavailable' || state === 'error' ? <Notice warning>
      {state === 'error' ? '案件資料讀取失敗' : '案件資料暫時不可用'}
      <Button className="ui-fit" onClick={load}>重新載入</Button>
    </Notice> : null}
    {state === 'empty' ? <Empty title={section === 'interviews' ? '目前沒有需要面試的學校' : '目前沒有可顯示的申請目標'} detail="完成選校確認後，申請目標會顯示在這裡。" /> : null}
    {state === 'ready' ? <Table headings={[t('caseUi.schoolColumn'), t('caseUi.statusColumn'), t('caseUi.taskColumn'), t('caseUi.actionsColumn')]}>
      {(data?.items as readonly Record<string, unknown>[]).map((item, index) => <tr key={String(item.id ?? index)}>
        <td><strong>{String(item.school_name ?? item.schoolName ?? '學校')}</strong></td>
        <td><Tag>{itemStateLabel(String(item.state ?? ''))}</Tag></td>
        <td>{itemStateLabel(String(item.task_state ?? ''))}</td>
        <td>{Array.isArray(item.allowed_actions) ? item.allowed_actions.map(action => actionLabel(String(action))).join(' · ') : '唯讀'}</td>
      </tr>)}
    </Table> : null}
  </Card>;
}

function ClosePanel({ caseId }: { readonly caseId: string }) { const [notice, setNotice] = useState<string | null>(null); return <section className="workspace-section"><h3 className="section-title">Founder 結案</h3><p className="section-detail">即使所有學校拒絕，也需要 Founder 明確確認結案。</p><button className="primary-button mt-4" onClick={() => void completeCaseAction(caseId, 'close', { reason: 'founder_case_close' }).then(() => setNotice('案件已結案。')).catch(() => setNotice('案件目前無法結案。'))}>Founder 結案</button>{notice ? <p className="mt-3" role="status">{notice}</p> : null}<Link className="secondary-button mt-4" href={`/cases/${caseId}`}>返回案件</Link></section> }

function itemStateLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = { pending: '待處理', in_progress: '處理中', completed: '已完成', rejected: '已拒絕', cancelled: '已取消', not_started: '未開始', created: '已建立', assigned: '已指派' };
  return labels[value] ?? (/[㐀-鿿]/.test(value) ? value : '未提供');
}

function actionLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = { view: '查看', complete: '完成', accept: '接受', reject: '拒絕', reassign: '重新指派', cancel: '取消' };
  return labels[value] ?? '查看';
}
