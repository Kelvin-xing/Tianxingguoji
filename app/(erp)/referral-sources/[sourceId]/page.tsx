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
  if (state === 'loading') return <LoadingState title="正在載入推薦來源" />
  if (state === 'denied') return <DeniedState title="無法查看此來源" detail="目前帳號沒有查看此推薦來源的權限。" action={<Link className="primary-button" href="/referral-sources">返回推薦來源</Link>} />
  if (state === 'unavailable' || !source) return <UnavailableState title="推薦來源詳情暫不可用" detail="請返回列表後重試。" onRetry={() => window.location.reload()} />
  return <div className="max-w-3xl mx-auto space-y-6"><Link href="/referral-sources" className="quiet-link">← 推薦來源</Link><section className="workspace-section"><div className="eyebrow">推薦來源 · {sourceTypeLabel(source.source_type)}</div><h2 className="page-title">{source.display_name}</h2><p className="page-subtitle">{source.description ?? '未提供說明'}</p><div className="grid grid-cols-2 gap-4 mt-5"><Info label="狀態" value={statusLabel(source.status)} /><Info label="資料版本" value={String(source.record_version)} /><Info label="更新時間" value={source.updated_at} /></div></section></div>
}

function Info({ label, value }: { label: string; value: string }) { return <div><div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div><div className="mt-1 font-semibold">{value}</div></div> }

function sourceTypeLabel(type: string): string {
  const labels: Readonly<Record<string, string>> = {
    customer_referral: '客戶推薦', employee_referral: '員工推薦', school_referral: '學校推薦',
    partner_referral: '合作夥伴推薦', website: '網站', social_media: '社交媒體', paid_advertising: '付費廣告',
    event: '活動', walk_in: '直接查詢', other: '其他', unknown: '未知',
  }
  return labels[type] ?? type
}

function statusLabel(status: string): string {
  return status === 'active' ? '有效' : '已停用'
}
