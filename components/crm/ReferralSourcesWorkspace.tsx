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
  return <div className="max-w-6xl mx-auto space-y-6"><section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4"><div><div className="eyebrow">CRM · 推薦來源</div><h2 className="page-title">推薦來源</h2><p className="page-subtitle">Founder 可管理；Advisor 只能查看啟用中的來源。</p></div><label className="search-field"><span className="sr-only">搜尋來源</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋來源名稱" /></label></section><section className="workspace-section">{state === 'loading' && <LoadingState title="正在載入推薦來源" detail="請稍候。" />}{state === 'empty' && <EmptyState title="目前沒有啟用中的推薦來源" detail="請先建立或啟用推薦來源。" />}{state === 'denied' && <ErrorState title="無法查看推薦來源" detail="目前帳號沒有查看推薦來源的權限。" />}{state === 'unavailable' && <UnavailableState title="推薦來源服務暫時不可用" detail="請稍後重試。" onRetry={load} />}{state === 'error' && <ErrorState title="推薦來源讀取失敗" detail="請保留搜尋條件後重試。" onRetry={load} />}{state === 'ready' && <div className="space-y-2">{items.map((item) => <Link key={item.id} href={`/referral-sources/${item.id}`} className="selection-card block"><span className="min-w-0"><strong>{item.display_name}</strong><small>{sourceTypeLabel(item.source_type)} · {item.description ?? '未提供說明'}</small></span><span className="status-pill status-success">啟用</span></Link>)}</div>}</section></div>
}

function sourceTypeLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = { website: '網站', school: '學校', partner: '合作夥伴', event: '活動', social: '社交平台', other: '其他' };
  return labels[value] ?? '其他來源';
}
