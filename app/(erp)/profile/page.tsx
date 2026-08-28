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
    if (!profile || displayName.trim().length < 1) { setMessage('请输入昵称。'); return }
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
      if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setMessage('资料已更新，请重新载入后再修改。')
      else if (error instanceof ApiClientError && error.code === 'CONFLICT') setMessage('员工资料尚未初始化，请由 Founder 或 Admin 先设置员工类型。')
      else setMessage('保存失败，请稍后重试。')
    }
  }

  return <div className="max-w-2xl mx-auto space-y-6">
    <section><div className="eyebrow">Account · Profile</div><h2 className="page-title">个人资料</h2><p className="page-subtitle">修改工作台昵称。登录邮箱、员工类型和角色不会改变。</p></section>
    <section className="workspace-section">
      {state === 'loading' && <LoadingState title="正在载入个人资料" />}
      {state === 'unavailable' && <UnavailableState title="个人资料暂时不可用" detail="请稍后重试。" onRetry={load} />}
      {state === 'error' && <ErrorState title="个人资料读取失败" detail="请重新载入后再试。" onRetry={load} />}
      {profile && ['ready', 'saving', 'saved'].includes(state) && <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2"><Info label="登录邮箱" value={profile.email} /><Info label="员工类型" value={employmentLabel(profile.employment_type)} /></div>
        <label className="block"><span className="text-sm font-medium">昵称</span><input className="mt-2 w-full" value={displayName} maxLength={100} onChange={(event) => { setDisplayName(event.target.value); setMessage(null); if (state === 'saved') setState('ready') }} /></label>
        {message && <div className="form-error" role="alert"><Icon name="shield" size={15} /><span>{message}</span></div>}
        {state === 'saved' && <div className="flex items-center gap-2 text-sm" style={{ color: '#15803d' }} role="status"><Icon name="check-circle" size={16} />昵称已保存。</div>}
        <div className="flex justify-end"><button type="button" className="primary-button" disabled={state === 'saving' || displayName.trim().length < 1} onClick={() => void save()}><Icon name="check" size={16} />{state === 'saving' ? '保存中' : '保存昵称'}</button></div>
      </div>}
    </section>
  </div>
}

function Info({ label, value }: { readonly label: string; readonly value: string }) { return <div><div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div><div className="mt-1 text-sm break-words" style={{ color: 'var(--text-primary)' }}>{value}</div></div> }
function employmentLabel(value: EmploymentType | null): string { return value === 'FULL_TIME' ? '正式员工' : value === 'PART_TIME' ? '兼职' : '尚未设置' }
function decodeOwnProfile(value: unknown): OwnProfile { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid profile.'); const row = value as Record<string, unknown>; if (typeof row.user_id !== 'string' || typeof row.email !== 'string' || (row.display_name !== null && typeof row.display_name !== 'string') || (row.employment_type !== null && row.employment_type !== 'FULL_TIME' && row.employment_type !== 'PART_TIME') || (row.profile_record_version !== null && (!Number.isSafeInteger(row.profile_record_version) || Number(row.profile_record_version) < 1)) || typeof row.updated_at !== 'string') throw new TypeError('Invalid profile.'); return row as unknown as OwnProfile }
function decodeReceipt(value: unknown) { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid receipt.'); const row = value as Record<string, unknown>; if (typeof row.user_id !== 'string' || typeof row.receipt_id !== 'string' || typeof row.replayed !== 'boolean') throw new TypeError('Invalid receipt.'); return row }
