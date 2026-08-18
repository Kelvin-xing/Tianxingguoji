'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

type ViewState = 'loading' | 'empty' | 'denied' | 'expired' | 'unavailable' | 'ready'
interface Grant { grant_id: string; portal_viewer_id: string; fingerprint: string; expires_at: string; status: string; record_version: number }

export default function CasePortalAccessPage() {
  const { caseId } = useParams<{ caseId: string }>()
  const [state, setState] = useState<ViewState>('loading')
  const [grants, setGrants] = useState<Grant[]>([])
  const [rawSecretOnce, setRawSecretOnce] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState('loading')
    try {
      const response = await fetch(`/api/v1/cases/${caseId}/portal-grants`, { cache: 'no-store', credentials: 'same-origin' })
      if (response.status === 401 || response.status === 403) return setState('denied')
      if (response.status === 503) return setState('unavailable')
      if (!response.ok) return setState('unavailable')
      const body = await response.json() as { grants: Grant[] }
      setGrants(body.grants)
      setState(body.grants.length === 0 ? 'empty' : 'ready')
    } catch { setState('unavailable') }
  }, [caseId])
  useEffect(() => { void load() }, [load])

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const response = await fetch(`/api/v1/cases/${caseId}/portal-grants`, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ portal_viewer_id: form.get('viewer'), expires_at: new Date(String(form.get('expires'))).toISOString() }),
    })
    if (response.status === 503) return setState('unavailable')
    if (response.status === 401 || response.status === 403) return setState('denied')
    if (!response.ok) return
    const created = await response.json() as { raw_secret_once: string }
    setRawSecretOnce(created.raw_secret_once)
    await load()
  }

  async function revoke(grant: Grant) {
    const response = await fetch(`/api/v1/cases/${caseId}/portal-grants/${grant.grant_id}`, {
      method: 'DELETE', cache: 'no-store', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ expected_version: grant.record_version, reason_code: 'manual_revoke' }),
    })
    if (response.ok) await load()
  }

  async function rotate(grant: Grant) {
    const expiresAt = new Date(Math.min(Date.now() + 7 * 86400000, Date.parse(grant.expires_at))).toISOString()
    const response = await fetch(`/api/v1/cases/${caseId}/portal-grants/${grant.grant_id}/rotate`, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ expected_version: grant.record_version, expires_at: expiresAt }),
    })
    if (!response.ok) return
    const created = await response.json() as { raw_secret_once: string }
    setRawSecretOnce(created.raw_secret_once)
    await load()
  }

  return (
    <div className="max-w-[1050px] mx-auto space-y-6">
      <header><div className="eyebrow">External portal</div><h2 className="page-title">案件訪問權</h2><p className="page-subtitle">為已核准的家長或申請者管理單一案件的只讀訪問。</p></header>
      {rawSecretOnce && <section className="workspace-section" role="status"><h3 className="section-title">訪問密鑰只顯示一次</h3><code className="block my-3 break-all select-all">{rawSecretOnce}</code><button className="btn-secondary" onClick={() => setRawSecretOnce(null)}>我已安全記錄並清除</button></section>}
      <form onSubmit={issue} className="workspace-section grid gap-4 sm:grid-cols-2">
        <label className="field-label">Portal viewer ID<input className="input mt-1" name="viewer" required pattern="[0-9a-fA-F-]{36}" /></label>
        <label className="field-label">到期時間（最長 7 天）<input className="input mt-1" name="expires" type="datetime-local" required /></label>
        <button className="btn-primary sm:col-span-2" type="submit">生成訪問密鑰</button>
      </form>
      {state === 'loading' && <State text="正在載入訪問權…" />}
      {state === 'empty' && <State text="尚未建立任何 Portal grant。" />}
      {state === 'denied' && <State text="只有 Founder 或此案件目前的 Primary Advisor 可以管理訪問權。" />}
      {state === 'expired' && <State text="此訪問權已失效。" />}
      {state === 'unavailable' && <State text="Portal runtime 尚未接通，暫時無法管理訪問權。" />}
      {state === 'ready' && <section className="workspace-section"><h3 className="section-title mb-3">現有訪問權</h3><div className="grid gap-3">{grants.map((grant) => <article key={grant.grant_id} className="flex flex-col gap-3 border-b pb-3 sm:flex-row sm:items-center sm:justify-between"><div><strong>{grant.fingerprint}</strong><p className="section-detail">{grant.status} · {new Date(grant.expires_at).toLocaleString('zh-HK')} · v{grant.record_version}</p></div><div className="flex gap-2"><button className="btn-secondary" disabled={grant.status !== 'active'} onClick={() => rotate(grant)}>輪換</button><button className="btn-secondary" disabled={grant.status !== 'active'} onClick={() => revoke(grant)}>撤銷</button></div></article>)}</div></section>}
    </div>
  )
}

function State({ text }: { text: string }) { return <section className="workspace-section" aria-live="polite"><p className="section-detail">{text}</p></section> }
