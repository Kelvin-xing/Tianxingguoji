'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

import { listReferralSources, type ReferralSourceDto } from '@/components/crm/f2-contract'
import { EmptyState, ErrorState, LoadingState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError } from '@/lib/api/client'

export function ReferralSourcesWorkspace() {
  const [items, setItems] = useState<readonly ReferralSourceDto[]>([])
  const [query, setQuery] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'denied' | 'unavailable' | 'error'>('loading')
  const load = useCallback(() => { setState('loading'); void listReferralSources({ q: query, status: 'active' }).then((value) => { setItems(value); setState(value.length ? 'ready' : 'empty') }).catch((error: unknown) => { if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setState('denied'); else if (error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE') setState('unavailable'); else setState('error') }) }, [query])
  useEffect(() => { load() }, [load])
  return <div className="max-w-6xl mx-auto space-y-6"><section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4"><div><div className="eyebrow">CRM · ReferralSource</div><h2 className="page-title">Referral Sources</h2><p className="page-subtitle">Founder 可管理；Advisor 只读 active；Admin 与 Contractor 不进入客户资料入口。</p></div><label className="search-field"><span className="sr-only">搜尋來源</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋來源名称" /></label></section><section className="workspace-section">{state === 'loading' && <LoadingState title="正在载入 Referral Sources" detail="只请求 active 来源。" />}{state === 'empty' && <EmptyState title="没有 active Referral Source" detail="Advisor 只能看到 active 来源；inactive 不会进入选择器。" />}{state === 'denied' && <ErrorState title="无法访问 Referral Sources" detail="服务端未授予当前身份来源权限。" />}{state === 'unavailable' && <UnavailableState title="Referral Source 服务尚未可用" detail="此页面不会使用旧 Admin 规则或 mock 数据。" onRetry={load} />}{state === 'error' && <ErrorState title="来源读取失败" detail="请保留筛选条件后重试。" onRetry={load} />}{state === 'ready' && <div className="space-y-2">{items.map((item) => <Link key={item.id} href={`/referral-sources/${item.id}`} className="selection-card block"><span className="min-w-0"><strong>{item.display_name}</strong><small>{item.source_type} · {item.description ?? '无说明'}</small></span><span className="status-pill status-success">Active</span></Link>)}</div>}</section></div>
}
