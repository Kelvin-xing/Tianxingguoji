'use client'

import { useCallback, useEffect, useState } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { ErrorState, LoadingState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError, requestApi } from '@/lib/api/client'

interface EmailSettingsDto {
  readonly configured: boolean
  readonly provider: 'resend' | null
  readonly fromEmail: string | null
  readonly fromName: string | null
  readonly recordVersion: number | null
  readonly updatedAt: string | null
}

export default function EmailSettingsPage() {
  const [settings, setSettings] = useState<EmailSettingsDto | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [fromEmail, setFromEmail] = useState('')
  const [fromName, setFromName] = useState('天星顧問')
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'unavailable' | 'error'>('loading')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(() => {
    setState('loading')
    setMessage(null)
    void requestApi({ path: '/api/v1/email/settings' }, decodeEmailSettings)
      .then((value) => {
        setSettings(value)
        setFromEmail(value.fromEmail ?? '')
        setFromName(value.fromName ?? '天星顧問')
        setApiKey('')
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
    void requestApi({ path: '/api/v1/email/settings', signal: controller.signal }, decodeEmailSettings)
      .then((value) => {
        setSettings(value)
        setFromEmail(value.fromEmail ?? '')
        setFromName(value.fromName ?? '天星顧問')
        setApiKey('')
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
    if (!settings || !/^re_[A-Za-z0-9_-]{8,252}$/.test(apiKey.trim()) || !/^\S+@\S+\.\S+$/.test(fromEmail.trim())) {
      setMessage('請輸入有效的 Resend API 密鑰和發件電郵。')
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      await requestApi({
        path: '/api/v1/email/settings',
        method: 'PUT',
        idempotencyKey: `email-settings-${crypto.randomUUID()}`,
        body: {
          api_key: apiKey.trim(),
          from_email: fromEmail.trim().toLowerCase(),
          from_name: fromName.trim() || null,
          expected_record_version: settings.recordVersion,
        },
      }, decodeMutationReceipt)
      setMessage('Resend 設定已安全儲存。API 密鑰不會再次顯示。')
      const refreshed = await requestApi({ path: '/api/v1/email/settings' }, decodeEmailSettings)
      setSettings(refreshed)
      setFromEmail(refreshed.fromEmail ?? '')
      setFromName(refreshed.fromName ?? '天星顧問')
      setApiKey('')
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setMessage('設定已由其他管理員更新，請重新載入後再試。')
      else if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setMessage('只有 Admin 可以修改郵件設定。')
      else setMessage('郵件設定未能儲存，請稍後重試。')
    } finally {
      setSaving(false)
    }
  }

  return <div className="max-w-3xl mx-auto space-y-6">
    <section>
      <div className="eyebrow">管理 · 郵件設定</div>
      <h2 className="page-title">Resend 郵件設定</h2>
      <p className="page-subtitle">設定內部使用者邀請郵件的發送服務。</p>
    </section>

    {state === 'loading' && <LoadingState title="正在載入郵件設定" detail="請稍候。" />}
    {state === 'denied' && <ErrorState title="無法查看郵件設定" detail="只有 Admin 可以管理此設定。" />}
    {state === 'unavailable' && <UnavailableState title="郵件設定服務暫時不可用" detail="請聯絡系統管理員確認郵件服務設定。" onRetry={load} />}
    {state === 'error' && <ErrorState title="郵件設定讀取失敗" detail="請稍後重試。" onRetry={load} />}

    {state === 'ready' && settings ? <section className="workspace-section space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="section-title">發送服務</h3><p className="section-detail">API 密鑰只會在儲存時傳送，系統不會回顯原文。</p></div>
        <span className={`status-pill ${settings.configured ? 'status-success' : 'status-warning'}`}>{settings.configured ? '已設定' : '未設定'}</span>
      </div>

      <label className="block"><span className="text-sm font-medium">Resend API 密鑰</span><input className="mt-2 w-full" type="password" value={apiKey} autoComplete="new-password" placeholder={settings.configured ? '輸入新密鑰以輪換目前設定' : 're_…'} onChange={(event) => { setApiKey(event.target.value); setMessage(null) }} /><span className="form-help">為安全起見，已儲存的密鑰不會顯示。</span></label>
      <label className="block"><span className="text-sm font-medium">發件電郵</span><input className="mt-2 w-full" type="email" value={fromEmail} placeholder="accounts@example.com" onChange={(event) => { setFromEmail(event.target.value); setMessage(null) }} /><span className="form-help">必須屬於已在 Resend 驗證的域名。</span></label>
      <label className="block"><span className="text-sm font-medium">發件名稱</span><input className="mt-2 w-full" value={fromName} maxLength={100} onChange={(event) => { setFromName(event.target.value); setMessage(null) }} /></label>

      {settings.updatedAt ? <p className="section-detail">最後更新：{formatDateTime(settings.updatedAt)}</p> : null}
      {message ? <div className="form-help" role="status">{message}</div> : null}
      <div className="flex justify-end"><button type="button" className="primary-button" disabled={saving || !apiKey.trim() || !fromEmail.trim()} onClick={() => void save()}><Icon name="check" size={16} />{saving ? '儲存中' : settings.configured ? '輪換並儲存' : '儲存設定'}</button></div>
    </section> : null}
  </div>
}

function decodeEmailSettings(value: unknown): EmailSettingsDto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid email settings response.')
  const row = value as Record<string, unknown>
  if (typeof row.configured !== 'boolean' || (row.provider !== null && row.provider !== 'resend') || (row.from_email !== null && typeof row.from_email !== 'string') || (row.from_name !== null && typeof row.from_name !== 'string') || (row.record_version !== null && (!Number.isSafeInteger(row.record_version) || Number(row.record_version) < 1)) || (row.updated_at !== null && typeof row.updated_at !== 'string')) throw new TypeError('Invalid email settings response.')
  return { configured: row.configured, provider: row.provider as 'resend' | null, fromEmail: row.from_email as string | null, fromName: row.from_name as string | null, recordVersion: row.record_version as number | null, updatedAt: row.updated_at as string | null }
}

function decodeMutationReceipt(value: unknown): { readonly settingsId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as Record<string, unknown>).settings_id !== 'string') throw new TypeError('Invalid email settings receipt.')
  return { settingsId: (value as Record<string, unknown>).settings_id as string }
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' })
}
