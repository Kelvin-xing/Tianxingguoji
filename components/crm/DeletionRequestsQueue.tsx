'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  classifyPendingDeletionFailure,
  listPendingDeletionRequests,
  type DeletionEntityType,
  type PendingDeletionSummary,
} from '@/modules/crm/client'

type QueueFilter = 'all' | DeletionEntityType
type QueueState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly items: readonly PendingDeletionSummary[] }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' }

export function DeletionRequestsQueue() {
  const [filter, setFilter] = useState<QueueFilter>('all')
  const [state, setState] = useState<QueueState>({ kind: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const access = await getWorkspaceAccessSnapshot(controller.signal)
        if (!hasCapability(access.capabilities, 'students.deletion.review')) {
          setState({ kind: 'denied' })
          return
        }
        const items = await listPendingDeletionRequests(
          filter === 'all' ? undefined : filter,
          controller.signal,
        )
        setState({ kind: 'ready', items })
      } catch (error) {
        if (controller.signal.aborted) return
        const failure = classifyPendingDeletionFailure(error)
        setState({ kind: failure === 'unauthenticated' ? 'unauthenticated' : failure === 'forbidden' ? 'denied' : 'unavailable' })
      }
    })()
    return () => controller.abort()
  }, [filter, reloadToken])

  if (state.kind === 'loading') return <QueueMessage icon="clock" title="正在載入待刪除審查" detail="請稍候。" busy />
  if (state.kind === 'unauthenticated') return <QueueMessage icon="lock" title="工作階段已失效" detail="請重新登入後再查看待刪除審查。" href="/login" action="重新登入" />
  if (state.kind === 'denied') return <QueueMessage icon="shield" title="無法查看待刪除審查" detail="你的帳號目前沒有查看這個清單的權限。" href="/students" action="返回學生名單" />
  if (state.kind === 'unavailable') return <QueueMessage icon="x" title="待刪除審查服務暫時不可用" detail="請稍後重試。" onRetry={() => { setState({ kind: 'loading' }); setReloadToken((value) => value + 1) }} />

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <div className="eyebrow">資料治理</div>
        <h2 className="page-title">待刪除審查</h2>
        <p className="page-subtitle">查看已限制修改的學生與監護人資料；本頁不提供刪除或復原操作。</p>
      </header>

      <section className="workspace-section" aria-labelledby="deletion-request-queue-heading">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-5">
          <div>
            <h3 id="deletion-request-queue-heading" className="section-title">審查清單</h3>
            <p className="section-detail">只顯示資料類型、安全標籤、申請時間、狀態與版本。</p>
          </div>
          <label className="field-label sm:w-52" htmlFor="deletion-request-filter">
            <span>資料類型</span>
            <select id="deletion-request-filter" value={filter} onChange={(event) => { setState({ kind: 'loading' }); setFilter(event.target.value as QueueFilter) }}>
              <option value="all">全部</option>
              <option value="student">學生</option>
              <option value="guardian">監護人</option>
            </select>
          </label>
        </div>

        {state.items.length === 0
          ? <div className="empty-state"><Icon name="check-circle" size={20} /><strong>目前沒有待刪除審查</strong><span>可切換資料類型查看其他清單。</span></div>
          : <div className="divide-y" style={{ borderColor: 'var(--border)' }}>{state.items.map((item) => <DeletionRequestRow key={`${item.entity_type}:${item.entity_id}`} item={item} />)}</div>}
        <div className="pt-4 text-xs" style={{ color: 'var(--text-muted)' }} aria-live="polite">共 {state.items.length} 筆</div>
      </section>
    </div>
  )
}

function DeletionRequestRow({ item }: { readonly item: PendingDeletionSummary }) {
  const detailHref = item.entity_type === 'student' ? `/students/${item.entity_id}` : null
  return (
    <article className="py-4 first:pt-0 last:pb-0 flex flex-col md:flex-row md:items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="status-pill status-warning">{item.entity_type === 'student' ? '學生' : '監護人'}</span>
          <span className="status-pill status-warning">{item.status === 'pending_delete' ? '待刪除審查' : '狀態不可用'}</span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>版本 {item.record_version}</span>
        </div>
        <h4 className="mt-2 text-sm font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{item.display_label}</h4>
        <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          <div><dt className="font-medium">資料編號</dt><dd><code className="break-all">{item.entity_id}</code></dd></div>
          <div><dt className="font-medium">申請時間</dt><dd>{formatDateTime(item.deletion_requested_at)}</dd></div>
        </dl>
      </div>
      {detailHref ? <Link href={detailHref} className="secondary-button justify-center shrink-0">查看學生資料<Icon name="chevron-right" size={15} /></Link> : null}
    </article>
  )
}

function QueueMessage({ icon, title, detail, busy, href, action, onRetry }: { readonly icon: 'clock' | 'lock' | 'shield' | 'x'; readonly title: string; readonly detail: string; readonly busy?: boolean; readonly href?: string; readonly action?: string; readonly onRetry?: () => void }) {
  return <div className="max-w-3xl mx-auto"><section className="workspace-section" aria-busy={busy}><div className="empty-state"><Icon name={icon} size={20} /><strong>{title}</strong><span>{detail}</span>{href && action ? <Link href={href} className="primary-button mt-3">{action}</Link> : null}{onRetry ? <button type="button" className="secondary-button mt-3" onClick={onRetry}>重新載入</button> : null}</div></section></div>
}

function hasCapability(capabilities: readonly unknown[], expected: string): boolean {
  return capabilities.some((capability) => String(capability) === expected)
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '不可用' : date.toLocaleString('zh-HK')
}
