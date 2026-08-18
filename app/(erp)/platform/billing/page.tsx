'use client'

import { useEffect, useState } from 'react'

type ViewState = 'loading' | 'empty' | 'denied' | 'unavailable' | 'error' | 'ready'

interface OverviewOrganization {
  organizationId: string
  organizationName: string
  lifecycleStatus: 'active' | 'inactive'
  subscription: { status: 'active' | 'past_due'; aggregateException: 'past_due' | null }
  advancingCaseSnapshot: {
    billingMonth: string
    sourceCutoffAt: string
    countPolicyVersion: 'advancing_case_count_v1'
    advancingCaseCount: number
    revision: number
    generatedAt: string
  } | null
  contract: { reference: string; status: 'draft' | 'active' | 'superseded' } | null
}

interface OverviewResponse {
  generatedAt: string
  organizations: OverviewOrganization[]
}

export default function PlatformBillingPage() {
  const [state, setState] = useState<ViewState>('loading')
  const [overview, setOverview] = useState<OverviewResponse | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    async function load() {
      try {
        const response = await fetch('/api/v1/platform/billing/overview', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (response.status === 401 || response.status === 403) return setState('denied')
        if (response.status === 503) return setState('unavailable')
        if (!response.ok) return setState('error')

        const nextOverview = await response.json() as OverviewResponse
        setOverview(nextOverview)
        setState(nextOverview.organizations.length === 0 ? 'empty' : 'ready')
      } catch (caught) {
        if (!controller.signal.aborted) setState('error')
      }
    }

    void load()
    return () => controller.abort()
  }, [])

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <section>
        <div className="eyebrow">Platform operations</div>
        <h2 className="page-title">Billing overview</h2>
        <p className="page-subtitle">組織生命週期、訂閱狀態與月度案件數快照。</p>
      </section>

      {state === 'loading' && <StatePanel title="載入平台彙總資料" detail="正在取得最新的月度快照。" busy />}
      {state === 'empty' && <StatePanel title="尚無彙總資料" detail="目前沒有可供平台角色查看的組織快照。" />}
      {state === 'denied' && <StatePanel title="沒有檢視權限" detail="需要有效的獨立平台操作員身份與核准角色。" />}
      {state === 'unavailable' && <StatePanel title="服務尚未接通" detail="PlatformBilling 讀取服務目前不可用。" />}
      {state === 'error' && <StatePanel title="無法載入資料" detail="請稍後重新整理頁面。" />}
      {state === 'ready' && overview && <OverviewTable overview={overview} />}
    </div>
  )
}

function StatePanel({ title, detail, busy = false }: { title: string; detail: string; busy?: boolean }) {
  return (
    <section className="workspace-section" aria-live="polite" aria-busy={busy}>
      <h3 className="section-title">{title}</h3>
      <p className="section-detail mt-1">{detail}</p>
    </section>
  )
}

function OverviewTable({ overview }: { overview: OverviewResponse }) {
  return (
    <section className="workspace-section">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h3 className="section-title">組織彙總</h3>
          <p className="section-detail">更新時間：{formatDateTime(overview.generatedAt)}</p>
        </div>
        <span className="status-pill">{overview.organizations.length} 個組織</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
              <th className="py-2 pr-4 font-medium">組織</th>
              <th className="py-2 pr-4 font-medium">狀態</th>
              <th className="py-2 pr-4 font-medium">訂閱</th>
              <th className="py-2 pr-4 font-medium">推進案件</th>
              <th className="py-2 pr-4 font-medium">快照月份</th>
              <th className="py-2 font-medium">合同參考</th>
            </tr>
          </thead>
          <tbody>
            {overview.organizations.map((organization) => (
              <tr key={organization.organizationId} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <td className="py-3 pr-4">
                  <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{organization.organizationName}</div>
                  <div className="text-xs mt-1 font-mono" style={{ color: 'var(--text-muted)' }}>{organization.organizationId}</div>
                </td>
                <td className="py-3 pr-4">{organization.lifecycleStatus}</td>
                <td className="py-3 pr-4">
                  <span className={`status-pill ${organization.subscription.status === 'past_due' ? 'status-warning' : 'status-success'}`}>
                    {organization.subscription.status}
                  </span>
                </td>
                <td className="py-3 pr-4 font-semibold">{organization.advancingCaseSnapshot?.advancingCaseCount ?? '—'}</td>
                <td className="py-3 pr-4">{organization.advancingCaseSnapshot?.billingMonth ?? '—'}</td>
                <td className="py-3">
                  {organization.contract ? (
                    <><div>{organization.contract.reference}</div><div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{organization.contract.status}</div></>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-HK', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Hong_Kong',
  }).format(new Date(value))
}
