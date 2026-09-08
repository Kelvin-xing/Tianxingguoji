'use client'

import { useCallback, useEffect, useState } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { ErrorState, LoadingState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError, requestApi } from '@/lib/api/client'

interface EmailTemplateDto {
  readonly templateKind: 'internal_user_invitation'
  readonly templateName: string
  readonly subject: string
  readonly bodyText: string
  readonly customized: boolean
  readonly recordVersion: number | null
  readonly updatedAt: string | null
  readonly defaultSubject: string
  readonly defaultBodyText: string
}

export default function EmailTemplatesPage() {
  const [template, setTemplate] = useState<EmailTemplateDto | null>(null)
  const [subject, setSubject] = useState('')
  const [bodyText, setBodyText] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'unavailable' | 'error'>('loading')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(() => {
    setState('loading')
    setMessage(null)
    void requestApi({ path: '/api/v1/email/templates/internal-user-invitation' }, decodeEmailTemplate)
      .then((value) => {
        setTemplate(value)
        setSubject(value.subject)
        setBodyText(value.bodyText)
        setState('ready')
      })
      .catch((error) => {
        if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setState('denied')
        else if (error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE') setState('unavailable')
        else setState('error')
      })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void requestApi({ path: '/api/v1/email/templates/internal-user-invitation', signal: controller.signal }, decodeEmailTemplate)
      .then((value) => {
        setTemplate(value)
        setSubject(value.subject)
        setBodyText(value.bodyText)
        setState('ready')
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setState('denied')
        else if (error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE') setState('unavailable')
        else setState('error')
      })
    return () => controller.abort()
  }, [])

  async function save() {
    if (!template || !subject.trim() || subject.trim().length > 160 || !bodyText.trim() || bodyText.trim().length > 4_000) {
      setMessage('請填寫有效的郵件主旨和正文說明。')
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      await requestApi({
        path: '/api/v1/email/templates/internal-user-invitation',
        method: 'PUT',
        idempotencyKey: `email-template-${crypto.randomUUID()}`,
        body: {
          subject: subject.trim(),
          body_text: bodyText.trim(),
          expected_record_version: template.recordVersion,
        },
      }, decodeMutationReceipt)
      const refreshed = await requestApi({ path: '/api/v1/email/templates/internal-user-invitation' }, decodeEmailTemplate)
      setTemplate(refreshed)
      setSubject(refreshed.subject)
      setBodyText(refreshed.bodyText)
      setMessage('郵件範本已儲存。')
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setMessage('範本已由其他管理員更新，請重新載入後再試。')
      else if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setMessage('只有 Admin 可以修改郵件範本。')
      else setMessage('郵件範本未能儲存，請稍後重試。')
    } finally {
      setSaving(false)
    }
  }

  return <div className="max-w-5xl mx-auto space-y-6">
    <section>
      <div className="eyebrow">管理 · 郵件範本</div>
      <h2 className="page-title">使用者註冊邀請</h2>
      <p className="page-subtitle">管理邀請郵件的主旨和正文說明。</p>
    </section>

    {state === 'loading' && <LoadingState title="正在載入郵件範本" detail="請稍候。" />}
    {state === 'denied' && <ErrorState title="無法查看郵件範本" detail="只有 Admin 可以管理此範本。" />}
    {state === 'unavailable' && <UnavailableState title="郵件範本服務暫時不可用" detail="請聯絡系統管理員確認郵件服務設定。" onRetry={load} />}
    {state === 'error' && <ErrorState title="郵件範本讀取失敗" detail="請稍後重試。" onRetry={load} />}

    {state === 'ready' && template ? <div className="grid gap-6 lg:grid-cols-[1.1fr_.9fr]">
      <section className="workspace-section space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h3 className="section-title">範本內容</h3><p className="section-detail">確認連結、有效期和按鈕由系統自動加入。</p></div>
          <span className={`status-pill ${template.customized ? 'status-success' : 'status-warning'}`}>{template.customized ? `自訂版本 ${template.recordVersion}` : '系統預設'}</span>
        </div>

        <label className="block"><span className="text-sm font-medium">郵件主旨</span><input className="mt-2 w-full" value={subject} maxLength={160} onChange={(event) => { setSubject(event.target.value); setMessage(null) }} /><span className="form-help">最多 160 個字元。</span></label>
        <label className="block"><span className="text-sm font-medium">正文說明</span><textarea className="mt-2 w-full min-h-44" value={bodyText} maxLength={4_000} onChange={(event) => { setBodyText(event.target.value); setMessage(null) }} /><span className="form-help">只接受純文字；系統會安全處理換行和特殊字元。</span></label>

        {template.updatedAt ? <p className="section-detail">最後更新：{formatDateTime(template.updatedAt)}</p> : null}
        {message ? <div className="form-help" role="status">{message}</div> : null}
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" className="secondary-button" disabled={saving} onClick={() => { setSubject(template.defaultSubject); setBodyText(template.defaultBodyText); setMessage('已還原為系統預設內容；儲存後才會生效。') }}>還原預設內容</button>
          <button type="button" className="primary-button" disabled={saving || !subject.trim() || !bodyText.trim()} onClick={() => void save()}><Icon name="check" size={16} />{saving ? '儲存中' : '儲存範本'}</button>
        </div>
      </section>

      <section className="workspace-section space-y-4" aria-label="郵件預覽">
        <div><h3 className="section-title">郵件預覽</h3><p className="section-detail">收件人看到的內容會包含以下固定安全資訊。</p></div>
        <div className="rounded-xl border p-5 space-y-4" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>主旨</div>
          <div className="font-semibold break-words">{subject.trim() || '尚未填寫郵件主旨'}</div>
          <div className="border-t pt-4 whitespace-pre-wrap break-words" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>{bodyText.trim() || '尚未填寫正文說明'}</div>
          <p className="text-sm">請在邀請有效期前完成帳戶設定。</p>
          <span className="primary-button inline-flex pointer-events-none">確認並設定帳戶</span>
        </div>
      </section>
    </div> : null}
  </div>
}

function decodeEmailTemplate(value: unknown): EmailTemplateDto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid email template response.')
  const row = value as Record<string, unknown>
  if (row.template_kind !== 'internal_user_invitation' || typeof row.template_name !== 'string' || typeof row.subject !== 'string' || typeof row.body_text !== 'string' || typeof row.customized !== 'boolean' || (row.record_version !== null && (!Number.isSafeInteger(row.record_version) || Number(row.record_version) < 1)) || (row.updated_at !== null && typeof row.updated_at !== 'string') || typeof row.default_subject !== 'string' || typeof row.default_body_text !== 'string') throw new TypeError('Invalid email template response.')
  return { templateKind: row.template_kind, templateName: row.template_name, subject: row.subject, bodyText: row.body_text, customized: row.customized, recordVersion: row.record_version as number | null, updatedAt: row.updated_at as string | null, defaultSubject: row.default_subject, defaultBodyText: row.default_body_text }
}

function decodeMutationReceipt(value: unknown): { readonly templateKind: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as Record<string, unknown>).template_kind !== 'string') throw new TypeError('Invalid email template receipt.')
  return { templateKind: (value as Record<string, unknown>).template_kind as string }
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' })
}
