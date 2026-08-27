'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { decodeReferralSource } from '@/components/crm/f2-contract'
import { DeniedState, LoadingState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError, requestApi } from '@/lib/api/client'

export default function ReferralSourceDetailPage({ params }: { params: { sourceId: string } }) {
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'unavailable'>('loading')
  const [source, setSource] = useState<ReturnType<typeof decodeReferralSource> | null>(null)
  useEffect(() => { void requestApi({ path: `/api/v1/referral-sources/${encodeURIComponent(params.sourceId)}` as `/${string}` }, decodeReferralSource).then((value) => { setSource(value); setState('ready') }).catch((error: unknown) => { setState(error instanceof ApiClientError && error.code === 'FORBIDDEN' ? 'denied' : 'unavailable') }) }, [params.sourceId])
  if (state === 'loading') return <LoadingState title="正在载入 Referral Source" />
  if (state === 'denied') return <DeniedState title="无法访问此来源" detail="当前身份没有该 Referral Source 权限。" action={<Link className="primary-button" href="/referral-sources">返回来源</Link>} />
  if (state === 'unavailable' || !source) return <UnavailableState title="Referral Source 详情暂不可用" detail="Advisor 访问 inactive 来源时不泄露对象状态；请返回列表重试。" onRetry={() => window.location.reload()} />
  return <div className="max-w-3xl mx-auto space-y-6"><Link href="/referral-sources" className="quiet-link">← Referral Sources</Link><section className="workspace-section"><div className="eyebrow">ReferralSource · {source.source_type}</div><h2 className="page-title">{source.display_name}</h2><p className="page-subtitle">{source.description ?? '没有说明'}</p><div className="grid grid-cols-2 gap-4 mt-5"><Info label="Status" value={source.status} /><Info label="Record version" value={String(source.record_version)} /><Info label="Updated" value={source.updated_at} /></div></section></div>
}

function Info({ label, value }: { label: string; value: string }) { return <div><div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div><div className="mt-1 font-semibold">{value}</div></div> }
