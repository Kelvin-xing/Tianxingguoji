'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { getGuardianConfirmationOptions, type GuardianConfirmationOption } from '@/components/cases/candidate-list-client'

type ViewState = 'loading' | 'empty' | 'denied' | 'expired' | 'unavailable' | 'ready'
interface Grant { grant_id: string; portal_viewer_id: string; fingerprint: string; expires_at: string; status: string; record_version: number }

export default function CasePortalAccessPage() {
  const { caseId } = useParams<{ caseId: string }>()
  const [state, setState] = useState<ViewState>('loading')
  const [grants, setGrants] = useState<Grant[]>([])
  const [guardians, setGuardians] = useState<readonly GuardianConfirmationOption[]>([])
  const [rawSecretOnce, setRawSecretOnce] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState('loading')
    try {
      const [response, guardianOptions] = await Promise.all([
        fetch(`/api/v1/cases/${caseId}/portal-grants`, { cache: 'no-store', credentials: 'same-origin' }),
        getGuardianConfirmationOptions(caseId),
      ])
      if (response.status === 401 || response.status === 403) return setState('denied')
      if (response.status === 503) return setState('unavailable')
      if (!response.ok) return setState('unavailable')
      const body = await response.json() as { grants: Grant[] }
      setGrants(body.grants)
      setGuardians(guardianOptions)
      setState(body.grants.length === 0 ? 'empty' : 'ready')
    } catch { setState('unavailable') }
  }, [caseId])
  useEffect(() => { void load() }, [load])

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCommandError(null)
    const form = new FormData(event.currentTarget)
    const guardianRelationshipId = String(form.get('guardian_relationship_id') ?? '')
    const viewerResponse = await fetch(`/api/v1/cases/${caseId}/portal-viewers`, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ guardian_relationship_id: guardianRelationshipId }),
    })
    if (viewerResponse.status === 503) return setState('unavailable')
    if (viewerResponse.status === 401 || viewerResponse.status === 403) return setState('denied')
    if (!viewerResponse.ok) return setCommandError('無法建立家長查看者，請重新載入後再試。')
    const viewer = await viewerResponse.json() as { portal_viewer_id: string }
    const response = await fetch(`/api/v1/cases/${caseId}/portal-grants`, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ portal_viewer_id: viewer.portal_viewer_id }),
    })
    if (response.status === 503) return setState('unavailable')
    if (response.status === 401 || response.status === 403) return setState('denied')
    if (!response.ok) return setCommandError('無法建立訪問密鑰；如已有有效密鑰，請使用重新生成。')
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
    const response = await fetch(`/api/v1/cases/${caseId}/portal-grants/${grant.grant_id}/rotate`, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ expected_version: grant.record_version }),
    })
    if (!response.ok) return
    const created = await response.json() as { raw_secret_once: string }
    setRawSecretOnce(created.raw_secret_once)
    await load()
  }

  return (
    <div className="max-w-[1050px] mx-auto space-y-6">
      <header><div className="eyebrow">家長入口</div><h2 className="page-title">案件訪問權</h2><p className="page-subtitle">為已核准的家長或申請者管理單一案件的唯讀訪問。</p></header>
      {rawSecretOnce && <section className="workspace-section" role="status"><h3 className="section-title">訪問密鑰只顯示一次</h3><code className="block my-3 break-all select-all">{rawSecretOnce}</code><button className="btn-secondary" onClick={() => setRawSecretOnce(null)}>我已安全記錄並清除</button></section>}
      <form onSubmit={issue} className="workspace-section grid gap-4">
        <label className="field-label">家長
          <select className="input mt-1" name="guardian_relationship_id" required defaultValue="">
            <option value="" disabled>選擇家長</option>
            {guardians.map((guardian) => <option value={guardian.guardian_relationship_id} key={guardian.guardian_relationship_id}>{guardian.display_name} · {relationshipLabel(guardian)}</option>)}
          </select>
        </label>
        <p className="section-detail">訪問密鑰由系統固定簽發 7 天，只能查看此案件。</p>
        {commandError && <p className="text-sm text-red-700" role="alert">{commandError}</p>}
        <button className="btn-primary" type="submit" disabled={guardians.length === 0}>建立訪問密鑰</button>
      </form>
      {state === 'loading' && <State text="正在載入訪問權…" />}
      {state === 'empty' && <State text="尚未建立任何入口授權。" />}
      {state === 'denied' && <State text="只有 Founder 或本案件的主要顧問可以管理訪問權。" />}
      {state === 'expired' && <State text="此訪問權已失效。" />}
      {state === 'unavailable' && <State text="案件入口服務暫時不可用，請稍後重試。" />}
      {state === 'ready' && <section className="workspace-section"><h3 className="section-title mb-3">現有訪問權</h3><div className="grid gap-3">{grants.map((grant) => <article key={grant.grant_id} className="flex flex-col gap-3 border-b pb-3 sm:flex-row sm:items-center sm:justify-between"><div><strong>{grant.fingerprint}</strong><p className="section-detail">{grantStatusLabel(grant.status)} · {new Date(grant.expires_at).toLocaleString('zh-HK')} · v{grant.record_version}</p></div><div className="flex gap-2"><button className="btn-secondary" disabled={grant.status !== 'active'} onClick={() => rotate(grant)}>重新生成</button><button className="btn-secondary" disabled={grant.status !== 'active'} onClick={() => revoke(grant)}>撤銷</button></div></article>)}</div></section>}
    </div>
  )
}

function State({ text }: { text: string }) { return <section className="workspace-section" aria-live="polite"><p className="section-detail">{text}</p></section> }

function grantStatusLabel(status: string): string {
  if (status === 'active') return '有效';
  if (status === 'revoked') return '已撤銷';
  if (status === 'expired') return '已過期';
  return '待啟用';
}

function relationshipLabel(guardian: GuardianConfirmationOption): string {
  const base = guardian.relationship_description?.trim() || guardian.relationship_type
  return guardian.is_primary_contact ? `${base} · 主要聯絡人` : base
}
