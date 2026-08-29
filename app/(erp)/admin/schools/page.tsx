'use client'

import { useState, type FormEvent } from 'react'
import { Icon } from '@/components/workspace/Icon'

type ApiOutcome = { ok: true; summary: string } | { ok: false; summary: string }

export default function SchoolGovernancePage() {
  const [outcome, setOutcome] = useState<ApiOutcome | null>(null)
  const [busy, setBusy] = useState<'review' | 'reconcile' | null>(null)

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const changeRequestId = String(form.get('change_request_id') || '')
    setBusy('review')
    setOutcome(null)
    const response = await fetch(`/api/v1/admin/schools/change-requests/${encodeURIComponent(changeRequestId)}/reviews`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        decision: form.get('decision'),
        expected_record_version: Number(form.get('expected_record_version')),
        reason: form.get('reason'),
      }),
    }).catch(() => null)
    setBusy(null)
    setOutcome(await responseOutcome(response, '審核決定已記錄'))
  }

  async function submitReconciliation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const schoolId = String(form.get('school_id') || '')
    const overlayRevisionId = String(form.get('overlay_revision_id') || '')
    setBusy('reconcile')
    setOutcome(null)
    const response = await fetch(`/api/v1/admin/schools/${encodeURIComponent(schoolId)}/overlays/${encodeURIComponent(overlayRevisionId)}/reconciliations`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        snapshot_id: form.get('snapshot_id'),
        expected_overlay_record_version: Number(form.get('expected_overlay_record_version')),
      }),
    }).catch(() => null)
    setBusy(null)
    setOutcome(await responseOutcome(response, '資料對帳已記錄'))
  }

  return (
    <div className="max-w-[1100px] mx-auto space-y-6">
      <section>
        <div className="eyebrow">管理 · 學校資料</div>
        <h2 className="page-title">學校治理</h2>
        <p className="page-subtitle">審核欄位修訂與處理資料差異。</p>
      </section>

      {outcome && <div role="status" className={outcome.ok ? 'preview-notice' : 'form-error'}><Icon name={outcome.ok ? 'check-circle' : 'x'} size={15} /><span>{outcome.summary}</span></div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form onSubmit={submitReview} className="workspace-section space-y-4">
          <div><h3 className="section-title">欄位審核</h3><p className="section-detail">一般欄位由 Admin 審核；身份欄位由 Founder 審核。</p></div>
          <Field label="修改申請編號" name="change_request_id" />
          <label className="block text-xs font-medium">決定<select name="decision" className="w-full mt-1" defaultValue="approve"><option value="approve">批准</option><option value="reject">拒絕</option></select></label>
          <Field label="目前版本" name="expected_record_version" type="number" defaultValue="1" />
          <label className="block text-xs font-medium">理由<textarea name="reason" required maxLength={1024} className="w-full mt-1 min-h-24" /></label>
          <button type="submit" className="primary-button" disabled={busy !== null}><Icon name="check" size={15} />{busy === 'review' ? '處理中' : '提交決定'}</button>
        </form>

        <form onSubmit={submitReconciliation} className="workspace-section space-y-4">
          <div><h3 className="section-title">資料對帳</h3><p className="section-detail">檢查已核准的學校資料差異。</p></div>
          <Field label="學校編號" name="school_id" />
          <Field label="資料修訂編號" name="overlay_revision_id" />
          <Field label="資料版本編號" name="snapshot_id" />
          <Field label="修訂目前版本" name="expected_overlay_record_version" type="number" defaultValue="1" />
          <button type="submit" className="primary-button" disabled={busy !== null}><Icon name="activity" size={15} />{busy === 'reconcile' ? '處理中' : '執行對賬'}</button>
        </form>
      </div>
    </div>
  )
}

function Field({ label, name, type = 'text', defaultValue }: { label: string; name: string; type?: string; defaultValue?: string }) {
  return <label className="block text-xs font-medium">{label}<input name={name} type={type} defaultValue={defaultValue} required min={type === 'number' ? 1 : undefined} className="w-full mt-1" /></label>
}

async function responseOutcome(response: Response | null, success: string): Promise<ApiOutcome> {
  if (!response) return { ok: false, summary: '服務暫時無法連線' }
  if (response.ok) return { ok: true, summary: success }
  return { ok: false, summary: response.status === 403 ? '目前帳號沒有執行此操作的權限。' : '操作未完成，請稍後重試。' }
}
