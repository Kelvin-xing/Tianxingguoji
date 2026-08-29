'use client'

import { useCallback, useEffect, useState } from 'react'

import { ErrorState, LoadingState, UnavailableState } from '@/components/states/WorkspaceState'
import { Icon } from '@/components/workspace/Icon'
import { ApiClientError, requestApi } from '@/lib/api/client'

type EmploymentType = 'FULL_TIME' | 'PART_TIME'
interface OwnProfile { readonly user_id: string; readonly email: string; readonly display_name: string | null; readonly employment_type: EmploymentType | null; readonly profile_record_version: number | null; readonly updated_at: string }

export default function ProfilePage() {
  const [profile, setProfile] = useState<OwnProfile | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'unavailable' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(() => {
    setState('loading')
    setMessage(null)
    void requestApi({ path: '/api/v1/auth/me/profile' }, decodeOwnProfile)
      .then((value) => { setProfile(value); setDisplayName(value.display_name ?? ''); setState('ready') })
      .catch((error) => setState(error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE' ? 'unavailable' : 'error'))
  }, [])
  useEffect(() => {
    void requestApi({ path: '/api/v1/auth/me/profile' }, decodeOwnProfile)
      .then((value) => { setProfile(value); setDisplayName(value.display_name ?? ''); setState('ready') })
      .catch((error) => setState(error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE' ? 'unavailable' : 'error'))
  }, [])

  async function save() {
    if (!profile || displayName.trim().length < 1) { setMessage('請輸入暱稱。'); return }
    setState('saving')
    setMessage(null)
    try {
      await requestApi({ path: '/api/v1/auth/me/profile', method: 'PATCH', idempotencyKey: `own-profile-${crypto.randomUUID()}`, body: { display_name: displayName.trim(), expected_profile_record_version: profile.profile_record_version } }, decodeReceipt)
      const refreshed = await requestApi({ path: '/api/v1/auth/me/profile' }, decodeOwnProfile)
      setProfile(refreshed)
      setDisplayName(refreshed.display_name ?? '')
      setState('saved')
    } catch (error) {
      setState('ready')
      if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setMessage('資料已更新，請重新載入後再修改。')
      else if (error instanceof ApiClientError && error.code === 'CONFLICT') setMessage('員工資料尚未初始化，請由 Founder 或 Admin 先設定員工類型。')
      else setMessage('儲存失敗，請稍後重試。')
    }
  }

  return <div className="max-w-2xl mx-auto space-y-6">
    <section><div className="eyebrow">帳戶 · 個人資料</div><h2 className="page-title">個人資料</h2><p className="page-subtitle">修改工作台暱稱。登入電郵、員工類型和角色不會改變。</p></section>
    <section className="workspace-section">
      {state === 'loading' && <LoadingState title="正在載入個人資料" />}
      {state === 'unavailable' && <UnavailableState title="個人資料暫時不可用" detail="請稍後重試。" onRetry={load} />}
      {state === 'error' && <ErrorState title="個人資料讀取失敗" detail="請重新載入後再試。" onRetry={load} />}
      {profile && ['ready', 'saving', 'saved'].includes(state) && <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2"><Info label="登入電郵" value={profile.email} /><Info label="員工類型" value={employmentLabel(profile.employment_type)} /></div>
        <label className="block"><span className="text-sm font-medium">暱稱</span><input className="mt-2 w-full" value={displayName} maxLength={100} onChange={(event) => { setDisplayName(event.target.value); setMessage(null); if (state === 'saved') setState('ready') }} /></label>
        {message && <div className="form-error" role="alert"><Icon name="shield" size={15} /><span>{message}</span></div>}
        {state === 'saved' && <div className="flex items-center gap-2 text-sm" style={{ color: '#15803d' }} role="status"><Icon name="check-circle" size={16} />暱稱已儲存。</div>}
        <div className="flex justify-end"><button type="button" className="primary-button" disabled={state === 'saving' || displayName.trim().length < 1} onClick={() => void save()}><Icon name="check" size={16} />{state === 'saving' ? '儲存中' : '儲存暱稱'}</button></div>
      </div>}
    </section>
  </div>
}

function Info({ label, value }: { readonly label: string; readonly value: string }) { return <div><div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div><div className="mt-1 text-sm break-words" style={{ color: 'var(--text-primary)' }}>{value}</div></div> }
function employmentLabel(value: EmploymentType | null): string { return value === 'FULL_TIME' ? '正式員工' : value === 'PART_TIME' ? '兼職' : '尚未設定' }
function decodeOwnProfile(value: unknown): OwnProfile { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid profile.'); const row = value as Record<string, unknown>; if (typeof row.user_id !== 'string' || typeof row.email !== 'string' || (row.display_name !== null && typeof row.display_name !== 'string') || (row.employment_type !== null && row.employment_type !== 'FULL_TIME' && row.employment_type !== 'PART_TIME') || (row.profile_record_version !== null && (!Number.isSafeInteger(row.profile_record_version) || Number(row.profile_record_version) < 1)) || typeof row.updated_at !== 'string') throw new TypeError('Invalid profile.'); return row as unknown as OwnProfile }
function decodeReceipt(value: unknown) { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid receipt.'); const row = value as Record<string, unknown>; if (typeof row.user_id !== 'string' || typeof row.receipt_id !== 'string' || typeof row.replayed !== 'boolean') throw new TypeError('Invalid receipt.'); return row }
