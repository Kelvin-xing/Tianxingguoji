'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { decodeWorkspaceAuth, type WorkspaceAuthDto } from '@/components/layout/workspace-navigation'
import { ErrorState, EmptyState, LoadingState, UnavailableState } from '@/components/states/WorkspaceState'
import { Icon } from '@/components/workspace/Icon'
import { ApiClientError, requestApi } from '@/lib/api/client'
import { listAuditEvents, type AuditEventDto, type AuditScope } from './f7-client'

type ViewState = 'loading' | 'ready' | 'empty' | 'denied' | 'unavailable' | 'error'
const PAGE_SIZE = 50

export function AuditWorkspace() {
  const [scope, setScope] = useState<AuditScope>('business')
  const [items, setItems] = useState<readonly AuditEventDto[]>([])
  const [before, setBefore] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [state, setState] = useState<ViewState>('loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [auth, setAuth] = useState<WorkspaceAuthDto | null>(null)
  const itemsRef = useRef<readonly AuditEventDto[]>([])

  useEffect(() => {
    const controller = new AbortController()
    requestApi({ path: '/api/v1/auth/me', signal: controller.signal }, decodeWorkspaceAuth)
      .then(setAuth)
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  const load = useCallback(async (nextScope: AuditScope, cursor: string | null, append: boolean) => {
    if (append) setLoadingMore(true)
    else setState('loading')
    setRequestId(null)
    try {
      const result = await listAuditEvents(nextScope, cursor)
      const nextItems = append ? [...itemsRef.current, ...result.items] : [...result.items]
      itemsRef.current = nextItems
      setItems(nextItems)
      const nextCursor = result.items.at(-1)?.occurred_at ?? null
      setBefore(nextCursor)
      setHasMore(result.items.length === PAGE_SIZE)
      setState(nextItems.length === 0 ? 'empty' : 'ready')
    } catch (error: unknown) {
      const apiError = error instanceof ApiClientError ? error : null
      setRequestId(apiError?.requestId ?? null)
      if (apiError?.status === 401 || apiError?.status === 403) setState('denied')
      else if (apiError?.status === 503 || apiError?.code === 'SERVICE_UNAVAILABLE') setState('unavailable')
      else setState('error')
    } finally {
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => {
    const task = Promise.resolve().then(() => load(scope, null, false))
    return () => { void task.catch(() => undefined) }
  }, [scope, load])

  function changeScope(nextScope: AuditScope) {
    if (nextScope === scope || loadingMore) return
    itemsRef.current = []
    setItems([])
    setBefore(null)
    setHasMore(false)
    setScope(nextScope)
  }

  function retry() {
    void load(scope, null, false)
  }

  if (state === 'loading') return <LoadingState title="正在載入審計記錄" detail="只讀取目前身份獲授權的事件摘要。" />
  if (state === 'denied') return <ErrorState title="無法查看審計記錄" detail="目前身份沒有查看這個範圍的審計權限。" requestId={requestId} onRetry={retry} />
  if (state === 'unavailable') return <UnavailableState title="審計服務暫時不可用" detail="請稍後重試。" requestId={requestId} onRetry={retry} />
  if (state === 'error') return <ErrorState title="審計記錄讀取失敗" detail="請保留目前範圍後重試。" requestId={requestId} onRetry={retry} />

  const canReadSecurity = auth?.role === 'founder'
  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div><div className="eyebrow">操作記錄</div><h2 className="page-title">審計記錄</h2><p className="page-subtitle">顯示目前身份可查看的追加式操作摘要。</p></div>
        <div className="inline-flex rounded-md border p-1" role="tablist" aria-label="審計範圍">
          <ScopeButton scope="business" selected={scope === 'business'} onSelect={changeScope} label="業務操作" />
          {canReadSecurity ? <ScopeButton scope="security" selected={scope === 'security'} onSelect={changeScope} label="安全與帳號" /> : null}
        </div>
      </section>
      {state === 'empty' ? <EmptyState title="目前沒有審計記錄" detail="符合目前授權範圍的事件會顯示在這裡。" /> : <AuditTable items={items} />}
      {hasMore ? <div className="flex justify-center"><button type="button" className="secondary-button" onClick={() => void load(scope, before, true)} disabled={loadingMore}><Icon name="rotate-ccw" size={15} />{loadingMore ? '正在載入' : '載入更早記錄'}</button></div> : null}
    </div>
  )
}

function ScopeButton({ scope, selected, onSelect, label }: { readonly scope: AuditScope; readonly selected: boolean; readonly onSelect: (scope: AuditScope) => void; readonly label: string }) {
  return <button type="button" role="tab" aria-selected={selected} className={`px-3 py-1.5 text-xs rounded ${selected ? 'bg-slate-900 text-white' : 'text-slate-600'}`} onClick={() => onSelect(scope)}>{label}</button>
}

function AuditTable({ items }: { readonly items: readonly AuditEventDto[] }) {
  return <section className="workspace-section overflow-hidden" aria-label="審計事件列表"><div className="overflow-x-auto"><table className="data-table min-w-[980px]"><thead><tr><th>發生時間</th><th>事件</th><th>動作</th><th>資源</th><th>結果</th><th>操作人</th><th>請求編號</th><th>附加摘要</th></tr></thead><tbody>{items.map((item) => <AuditRow key={item.id} item={item} />)}</tbody></table></div></section>
}

function AuditRow({ item }: { readonly item: AuditEventDto }) {
  return <tr><td className="table-muted whitespace-nowrap">{formatDate(item.occurred_at)}</td><td className="table-primary break-words">{item.event_type}</td><td className="table-muted break-words">{item.action}</td><td><div className="table-primary">{item.resource_type}</div><div className="table-secondary break-all">{item.resource_id}</div></td><td><span className={`status-pill ${item.outcome === 'succeeded' ? 'status-success' : item.outcome === 'denied' ? 'status-warning' : 'status-error'}`}>{outcomeLabel(item.outcome)}</span></td><td className="table-secondary break-all">{item.actor_user_id ?? '系統'}</td><td className="table-secondary break-all">{item.request_id}</td><td className="table-secondary break-all">{formatMetadata(item.metadata)}</td></tr>
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-HK') : value
}

function formatMetadata(value: Readonly<Record<string, string | number | boolean | null>>): string {
  const entries = Object.entries(value)
  return entries.length === 0 ? '—' : entries.map(([key, item]) => `${key}: ${item === null ? '—' : String(item)}`).join(' · ')
}

function outcomeLabel(value: AuditEventDto['outcome']): string {
  if (value === 'succeeded') return '成功'
  if (value === 'denied') return '拒絕'
  return '失敗'
}
