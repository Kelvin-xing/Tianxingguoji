'use client'

import Link from 'next/link'

import { useCallback, useEffect, useRef, useState } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { ErrorState, LoadingState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError, requestApi } from '@/lib/api/client'

type InvitationModel = 'trial' | 'legacy'
type Category = 'international_school' | 'local_school'
type Role = 'founder' | 'admin' | 'advisor' | 'contractor' | 'l1' | 'l2' | 'l3'
type UserStatus = 'invited' | 'active' | 'disabled'
type MembershipStatus = 'invited' | 'active' | 'disabled'
type EmploymentType = 'FULL_TIME' | 'PART_TIME'

interface UserDirectoryRole {
  readonly role: Role
  readonly status: 'active'
}

interface UserDirectoryEntry {
  readonly user_id: string
  readonly trial_level: 'founder' | 'l1' | 'l2' | 'l3' | null
  readonly email: string
  readonly user_status: UserStatus
  readonly membership_status: MembershipStatus
  readonly display_name: string | null
  readonly employment_type: EmploymentType | null
  readonly profile_record_version: number | null
  readonly access_version: string
  readonly pending_invite_id: string | null
  readonly pending_invite_expires_at: string | null
  readonly roles: readonly UserDirectoryRole[]
  readonly updated_at: string
}

const EDITABLE_ROLES: readonly Role[] = ['founder', 'admin', 'advisor', 'contractor']

export default function AccessPage() {
  const [users, setUsers] = useState<readonly UserDirectoryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<UserDirectoryEntry | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [invitationModel, setInvitationModel] = useState<InvitationModel>('legacy')
  const [canInviteUsers, setCanInviteUsers] = useState(false)
  const resendKeys = useRef(new Map<string,string>())
  const [uncertainResends, setUncertainResends] = useState<readonly string[]>([])
  const [resendingInviteId, setResendingInviteId] = useState<string | null>(null)
  const [inviteMessage, setInviteMessage] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'denied' | 'unavailable' | 'error'>('loading')

  const handleUsers = useCallback((result: { readonly invitation_model: InvitationModel; readonly can_invite_users: boolean; readonly total: number; readonly users: readonly UserDirectoryEntry[] }) => {
    setUsers(result.users)
    setTotal(result.total)
    setCanInviteUsers(result.can_invite_users)
    setInvitationModel(result.invitation_model)
    setState(result.users.length > 0 ? 'ready' : 'empty')
  }, [])

  const handleUsersError = useCallback((error: unknown) => {
    setUsers([]); setSelected(null); setInviteOpen(false); setCanInviteUsers(false)
    if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setState('denied')
    else if (error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE') setState('unavailable')
    else setState('error')
  }, [])

  const loadUsers = useCallback(() => {
    setState('loading')
    void requestApi({ path: '/api/v1/auth/users' }, decodeUserDirectory)
      .then(handleUsers)
      .catch(handleUsersError)
  }, [handleUsers, handleUsersError])

  useEffect(() => {
    void requestApi({ path: '/api/v1/auth/users' }, decodeUserDirectory)
      .then(handleUsers)
      .catch(handleUsersError)
  }, [handleUsers, handleUsersError])

  async function resendInvite(inviteId: string) {
    setResendingInviteId(inviteId); setInviteMessage(null)
    try {
      const key = resendKeys.current.get(inviteId) ?? `invite-resend-${crypto.randomUUID()}`
      resendKeys.current.set(inviteId,key)
      const receipt = await requestApi({ path: `/api/v1/auth/invites/${inviteId}/resend`, method: 'POST', idempotencyKey:key }, decodeInviteReceipt)
      resendKeys.current.delete(inviteId); setUncertainResends(current=>current.filter(id=>id!==inviteId))
      setInviteMessage(receipt.delivery_status === 'sent' ? '邀請郵件已重新發送；先前的確認連結已失效。' : '重發操作已記錄，但尚未確認郵件投遞。若同事未收到郵件，可再次選擇重發邀請；舊連結將失效。')
      loadUsers()
    } catch (error) {
      if (error instanceof ApiClientError && (error.code === 'FORBIDDEN' || error.code === 'UNAUTHENTICATED')) { resendKeys.current.delete(inviteId); handleUsersError(error) }
      else if (error instanceof ApiClientError && error.code === 'CONFLICT') setInviteMessage('此邀請已啟用、過期或失效，請重新載入。')
      else { setUncertainResends(current=>[...new Set([...current,inviteId])]); setInviteMessage('暫時無法確認重發結果。請使用「確認重發結果」查詢原操作，不會重複發送郵件。') }
    } finally { setResendingInviteId(null) }
  }

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <section>
        <div className="eyebrow">管理 · 身份與權限</div>
        <h2 className="page-title">身份與權限</h2>
        <p className="page-subtitle">查看使用者，維護員工資料與目前基礎角色。</p>
      </section>

      {canInviteUsers && <section className="workspace-section"><h3 className="section-title">員工等級與業務分類</h3><p className="section-detail mt-2">設定創始人、L1、L2、L3，以及 L2 可負責的國際學校或本地學校業務。</p><Link className="primary-button mt-3 inline-flex" href="/admin/access/levels">管理員工等級</Link></section>}

      <section className="workspace-section">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="section-title">使用者列表</h3>
            <p className="section-detail">{invitationModel === 'trial' ? '只有創始人可以邀請同事及管理員工等級。' : 'Founder 和 Admin 可以管理歷史使用者角色。'}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canInviteUsers && <button type="button" className="secondary-button" onClick={() => setInviteOpen(true)}><Icon name="user" size={15} />邀請使用者</button>}
            <button type="button" className="secondary-button" onClick={loadUsers} disabled={state === 'loading'}><Icon name="rotate-ccw" size={15} />重新載入</button>
          </div>
        </div>
        {inviteMessage && <div className="mb-4 form-help" role="status">{inviteMessage}</div>}
        {state === 'loading' && <LoadingState title="正在載入使用者" detail="請稍候。" />}
        {state === 'denied' && <ErrorState title="無法查看使用者" detail="目前帳號沒有管理使用者的權限。" />}
        {state === 'unavailable' && <UnavailableState title="使用者服務暫時不可用" detail="請稍後重試。" onRetry={loadUsers} />}
        {state === 'error' && <ErrorState title="使用者讀取失敗" detail="請保留目前頁面後重試。" onRetry={loadUsers} />}
        {state === 'empty' && <div className="empty-state">目前組織沒有可顯示的使用者。</div>}
        {state === 'ready' && <UserTable uncertainResends={uncertainResends} users={users} total={total} onEdit={setSelected} canInviteUsers={canInviteUsers} resendingInviteId={resendingInviteId} onResend={(inviteId) => void resendInvite(inviteId)} />}
      </section>

      <section className="workspace-section">
        <h3 className="section-title">{invitationModel === 'trial' ? '等級規則' : '角色規則'}</h3>
        <div className="mt-3 grid gap-3 md:grid-cols-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {invitationModel === 'trial' ? <><p>創始人管理全部業務及員工；L1 管理業務，不能管理員工。</p><p>L2 負責已授權業務分類；L3 只處理指派任務。員工類型不限制等級。</p></> : <><p><strong style={{ color: 'var(--text-primary)' }}>正式員工</strong><br />可擔任 Founder、Admin、Advisor。</p>
          <p><strong style={{ color: 'var(--text-primary)' }}>兼職</strong><br />Contractor 必須單獨存在；Admin 不受員工類型限制。</p></>}
        </div>
      </section>

      {selected && selected.trial_level === null && <MemberEditor user={selected} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); loadUsers() }} />}
      {inviteOpen && <InviteUserEditor model={invitationModel} onClose={() => setInviteOpen(false)} onSaved={(status) => { setInviteOpen(false); setInviteMessage(status === 'sent' ? '邀請郵件已發送。' : '邀請已建立，但尚未確認郵件投遞。若同事未收到郵件，可在列表重發邀請；舊連結將失效。'); loadUsers() }} />}
    </div>
  )
}

function InviteUserEditor({ model, onClose, onSaved }: { readonly model: InvitationModel; readonly onClose: () => void; readonly onSaved: (status:'sent'|'unconfirmed') => void }) {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<Role>(model === 'trial' ? 'l3' : 'advisor')
  const [categories, setCategories] = useState<readonly Category[]>([])
  const [employmentType, setEmploymentType] = useState<EmploymentType>('FULL_TIME')
  const operation = useRef<{key:string;body:Record<string,string|readonly Category[]>}|null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [denied, setDenied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const invalid = !/^\S+@\S+\.\S+$/.test(email.trim()) || (model === 'legacy' && ((employmentType === 'FULL_TIME' && role === 'contractor') || (employmentType === 'PART_TIME' && (role === 'founder' || role === 'advisor'))))

  async function save() {
    if(saving || denied)return
    if (invalid && !operation.current) { setMessage('請檢查電郵、員工類型和角色組合。'); return }
    setSaving(true); setMessage(null)
    try {
      const body: Record<string, string | readonly Category[]> = { normalized_email: email.trim().toLowerCase(), role, employment_type: employmentType }
      if (model === 'trial') body.trial_categories = role === 'l2' ? [...categories].sort() : []
      if (displayName.trim()) body.display_name = displayName.trim()
      operation.current ??= {key:`invite-${crypto.randomUUID()}`,body}
      const receipt=await requestApi({ path: '/api/v1/auth/invites', method: 'POST', idempotencyKey:operation.current.key, body:operation.current.body }, decodeInviteReceipt)
      onSaved(receipt.delivery_status)
    } catch (error) {
      if (error instanceof ApiClientError && ['FORBIDDEN','UNAUTHENTICATED'].includes(error.code)) {
        operation.current=null;setUncertain(false);setDenied(true);setEmail('');setDisplayName('');setCategories([]);setMessage('目前帳號無法邀請同事，請關閉視窗並重新登入。')
      } else if(error instanceof ApiClientError && ['CONFLICT','VALIDATION_FAILED','INVALID_REQUEST'].includes(error.code)) {
        operation.current=null;setUncertain(false);setMessage(error.code==='CONFLICT'?'此電郵已存在邀請或帳戶，或操作內容有衝突。請重新載入列表。':'請檢查邀請資料。')
      } else {setUncertain(true);setMessage('暫時無法確認結果。請確認原邀請結果，不會重複建立帳戶或發送郵件。')}
    } finally { setSaving(false) }
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="invite-user-title">
    <button type="button" className="absolute inset-0 bg-slate-950/45" aria-label="關閉邀請視窗" onClick={onClose} />
    <div className="relative w-full max-w-xl max-h-[90dvh] overflow-y-auto rounded-lg p-5 sm:p-6 shadow-xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex items-start justify-between gap-4"><div><div className="eyebrow">使用者邀請</div><h3 id="invite-user-title" className="section-title mt-1">邀請使用者</h3><p className="section-detail">對方會收到一次性確認連結，再設定密碼和暱稱。</p></div><button type="button" className="icon-button" aria-label="關閉" onClick={onClose}><Icon name="x" size={18} /></button></div>
      <fieldset disabled={saving || uncertain || denied} className="mt-5 space-y-4"><label className="block"><span className="text-sm font-medium">公司電郵</span><input className="mt-2 w-full" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label className="block"><span className="text-sm font-medium">暱稱（可稍後由對方設定）</span><input className="mt-2 w-full" value={displayName} maxLength={100} onChange={(event) => setDisplayName(event.target.value)} /></label><label className="block"><span className="text-sm font-medium">{model === 'trial' ? '員工等級' : '角色'}</span><select aria-label={model === 'trial' ? '員工等級' : '角色'} className="mt-2 w-full" value={role} onChange={(event) => { setRole(event.target.value as Role); setCategories([]) }}>{(model === 'trial' ? ['founder','l1','l2','l3'] as const : EDITABLE_ROLES).map((item) => <option key={item} value={item}>{roleLabel(item)}</option>)}</select></label>{model === 'trial' && role === 'l2' && <fieldset><legend className="text-sm font-medium">業務分類</legend><div className="mt-2 grid gap-2">{(['international_school','local_school'] as const).map(category => <label key={category} className="selection-card"><input type="checkbox" checked={categories.includes(category)} onChange={() => setCategories(current => current.includes(category) ? current.filter(item => item !== category) : [...current,category])} /><span>{category === 'international_school' ? '國際學校' : '本地學校'}</span></label>)}</div><p className="form-help mt-2">可選多項；未選分類時，L2 無法查看任何案件。</p></fieldset>}<fieldset><legend className="text-sm font-medium">員工類型</legend><div className="mt-2 grid grid-cols-2 gap-2">{(['FULL_TIME', 'PART_TIME'] as const).map((value) => <label key={value} className={`selection-card ${employmentType === value ? 'selected' : ''}`}><input type="radio" name="invite-employment-type" checked={employmentType === value} onChange={() => setEmploymentType(value)} /><span className="selection-mark" aria-hidden="true" /><span><strong>{value === 'FULL_TIME' ? '正式員工' : '兼職'}</strong></span></label>)}</div></fieldset>{message && <div className="form-error" role="alert"><Icon name="shield" size={15} /><span>{message}</span></div>}</fieldset>
      <div className="mt-6 flex justify-end gap-2"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button type="button" className="primary-button" onClick={() => void save()} disabled={saving || denied || (!uncertain && invalid)}><Icon name="mail" size={16} />{saving ? '處理中' : uncertain ? '確認邀請結果' : '發送邀請'}</button></div>
    </div>
  </div>
}

function UserTable({ uncertainResends, users, total, onEdit, canInviteUsers, resendingInviteId, onResend }: { readonly uncertainResends: readonly string[]; readonly users: readonly UserDirectoryEntry[]; readonly total: number; readonly onEdit: (user: UserDirectoryEntry) => void; readonly canInviteUsers: boolean; readonly resendingInviteId: string | null; readonly onResend: (inviteId: string) => void }) {
  return (
    <div>
      <div className="section-detail mb-3">共 {total} 位使用者</div>
      <div className="relative overflow-x-auto -mx-5">
        <table className="data-table min-w-[900px]">
        <thead><tr><th>使用者</th><th>狀態</th><th>員工類型</th><th>目前角色</th><th>更新</th><th><span className="sr-only">操作</span></th></tr></thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.user_id} className="data-row">
                <td><div className="table-primary">{user.display_name ?? '未設定暱稱'}</div><div className="table-secondary">{user.email}</div></td>
                <td><StatusPill value={user.user_status} /></td>
                <td className="table-muted">{employmentLabel(user.employment_type)}</td>
                <td><div className="flex flex-wrap gap-1">{user.roles.length > 0 ? user.roles.map((role) => <RolePill key={role.role} role={role.role} />) : <span className="table-muted">未分配角色</span>}</div></td>
                <td className="table-muted">{formatDate(user.updated_at)}</td>
        <td><div className="flex items-center justify-end gap-2">{canInviteUsers && user.pending_invite_id ? <button type="button" className="secondary-button" onClick={() => onResend(user.pending_invite_id!)} disabled={resendingInviteId === user.pending_invite_id}><Icon name="mail" size={15} />{resendingInviteId === user.pending_invite_id ? '發送中' : uncertainResends.includes(user.pending_invite_id!) ? '確認重發結果' : '重發邀請'}</button> : null}<button type="button" className="icon-button" title="編輯員工資料與角色" aria-label={`編輯 ${user.display_name ?? user.email}`} disabled={user.trial_level !== null} onClick={() => onEdit(user)}><Icon name="settings" size={16} /></button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function MemberEditor({ user, onClose, onSaved }: { readonly user: UserDirectoryEntry; readonly onClose: () => void; readonly onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(user.display_name ?? '')
  const [employmentType, setEmploymentType] = useState<EmploymentType>(() => user.employment_type ?? inferredEmploymentType(user.roles.map((item) => item.role)))
  const [roles, setRoles] = useState<readonly Role[]>(() => user.roles.map((item) => item.role))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const validation = validateMemberSelection(displayName, employmentType, roles)

  function toggleRole(role: Role) {
    setMessage(null)
    setRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role])
  }

  async function save() {
    if (validation) { setMessage(validation); return }
    setSaving(true)
    setMessage(null)
    try {
      await requestApi({
        path: `/api/v1/auth/users/${user.user_id}/access`,
        method: 'PATCH',
        idempotencyKey: `member-access-${crypto.randomUUID()}`,
        body: { display_name: displayName.trim(), employment_type: employmentType, expected_access_version: user.access_version, roles },
      }, decodeMutationReceipt)
      onSaved()
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setMessage('資料已被其他操作更新，請關閉後重新載入。')
      else if (error instanceof ApiClientError && error.code === 'CONFLICT') setMessage('無法儲存。請保留至少一位 Founder，並檢查員工類型與角色組合。')
      else if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setMessage('目前帳號沒有管理角色的權限。')
      else setMessage('儲存失敗，請稍後重試。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="member-editor-title">
      <button type="button" className="absolute inset-0 bg-slate-950/45" aria-label="關閉編輯視窗" onClick={onClose} />
      <div className="relative w-full max-w-xl rounded-lg p-5 sm:p-6 shadow-xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0"><div className="eyebrow">使用者權限</div><h3 id="member-editor-title" className="section-title mt-1 truncate">{user.display_name ?? user.email}</h3><p className="section-detail truncate">{user.email}</p></div>
          <button type="button" className="icon-button" title="關閉" aria-label="關閉" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>

        <div className="mt-5 space-y-5">
          <label className="block"><span className="text-sm font-medium">暱稱</span><input className="mt-2 w-full" value={displayName} maxLength={100} onChange={(event) => { setDisplayName(event.target.value); setMessage(null) }} /></label>

          <fieldset><legend className="text-sm font-medium">員工類型</legend><div className="mt-2 grid grid-cols-2 gap-2">
            {(['FULL_TIME', 'PART_TIME'] as const).map((value) => <label key={value} className={`selection-card ${employmentType === value ? 'selected' : ''}`}><input type="radio" name="employment-type" checked={employmentType === value} onChange={() => { setEmploymentType(value); setMessage(null) }} /><span className="selection-mark" aria-hidden="true" /><span><strong>{value === 'FULL_TIME' ? '正式員工' : '兼職'}</strong></span></label>)}
          </div></fieldset>

          <fieldset><legend className="text-sm font-medium">目前角色</legend><div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {EDITABLE_ROLES.map((role) => <label key={role} className={`selection-card min-w-0 ${roles.includes(role) ? 'selected' : ''}`}><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={roles.includes(role)} onChange={() => toggleRole(role)} /><span className="min-w-0"><strong className="break-words">{roleLabel(role)}</strong></span></label>)}
          </div></fieldset>

          {(message || validation) && <div className="form-error" role="alert"><Icon name="shield" size={15} /><span>{message ?? validation}</span></div>}
        </div>

        <div className="mt-6 flex justify-end gap-2"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button type="button" className="primary-button" onClick={() => void save()} disabled={saving || validation !== null}><Icon name="check" size={16} />{saving ? '儲存中' : '儲存變更'}</button></div>
      </div>
    </div>
  )
}

function StatusPill({ value }: { readonly value: UserStatus | MembershipStatus }) { const label = value === 'active' ? '啟用' : value === 'invited' ? '已邀請' : '已停用'; return <span className={`status-pill ${value === 'active' ? 'status-success' : 'status-warning'}`}>{label}</span> }
function RolePill({ role }: { readonly role: Role }) { return <span className="status-pill status-success">{roleLabel(role)}</span> }
function roleLabel(role: Role): string { if (role === 'l1' || role === 'l2' || role === 'l3') return role.toUpperCase(); return role === 'founder' ? 'Founder' : role === 'admin' ? 'Admin' : role === 'advisor' ? 'Advisor' : 'Contractor' }
function employmentLabel(value: EmploymentType | null): string { return value === 'FULL_TIME' ? '正式員工' : value === 'PART_TIME' ? '兼職' : '未設定' }
function inferredEmploymentType(roles: readonly Role[]): EmploymentType { return roles.includes('contractor') ? 'PART_TIME' : 'FULL_TIME' }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-HK') }

function validateMemberSelection(displayName: string, employmentType: EmploymentType, roles: readonly Role[]): string | null {
  if (displayName.trim().length < 1) return '請輸入暱稱。'
  if (roles.includes('contractor') && roles.length > 1) return 'Contractor 必須是唯一角色。'
  if (employmentType === 'FULL_TIME' && roles.includes('contractor')) return '正式員工不能分配 Contractor。'
  if (employmentType === 'PART_TIME' && (roles.includes('founder') || roles.includes('advisor'))) return '兼職不能分配 Founder 或 Advisor。'
  return null
}

function decodeUserDirectory(value: unknown): { readonly invitation_model: InvitationModel; readonly can_invite_users: boolean; readonly total: number; readonly users: readonly UserDirectoryEntry[] } { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid user directory response.'); const root = value as Record<string, unknown>; if ((root.invitation_model !== 'trial' && root.invitation_model !== 'legacy') || typeof root.can_invite_users !== 'boolean' || !Number.isSafeInteger(root.total) || (root.total as number) < 0 || !Array.isArray(root.users)) throw new TypeError('Invalid user directory response.'); return { invitation_model: root.invitation_model, can_invite_users: root.can_invite_users, total: root.total as number, users: Object.freeze(root.users.map(decodeUser)) } }
function decodeUser(value: unknown): UserDirectoryEntry { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid user directory entry.'); const row = value as Record<string, unknown>; if ((row.trial_level !== null && !['founder','l1','l2','l3'].includes(String(row.trial_level))) || typeof row.user_id !== 'string' || typeof row.email !== 'string' || !isUserStatus(row.user_status) || !isMembershipStatus(row.membership_status) || (row.display_name !== null && typeof row.display_name !== 'string') || (row.employment_type !== null && !isEmploymentType(row.employment_type)) || (row.profile_record_version !== null && (!Number.isSafeInteger(row.profile_record_version) || Number(row.profile_record_version) < 1)) || typeof row.access_version !== 'string' || (row.pending_invite_id !== null && typeof row.pending_invite_id !== 'string') || (row.pending_invite_expires_at !== null && typeof row.pending_invite_expires_at !== 'string') || typeof row.updated_at !== 'string' || !Array.isArray(row.roles)) throw new TypeError('Invalid user directory entry.'); return { user_id: row.user_id, trial_level: row.trial_level as UserDirectoryEntry['trial_level'], email: row.email, user_status: row.user_status, membership_status: row.membership_status, display_name: row.display_name, employment_type: row.employment_type, profile_record_version: row.profile_record_version as number | null, access_version: row.access_version, pending_invite_id: row.pending_invite_id as string | null, pending_invite_expires_at: row.pending_invite_expires_at as string | null, roles: Object.freeze(row.roles.map(decodeRole)), updated_at: row.updated_at } }
function decodeRole(value: unknown): UserDirectoryRole { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid user directory role.'); const row = value as Record<string, unknown>; if (!isRole(row.role) || row.status !== 'active') throw new TypeError('Invalid user directory role.'); return { role: row.role, status: 'active' } }
function decodeMutationReceipt(value: unknown): { readonly user_id: string; readonly receipt_id: string; readonly replayed: boolean } { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid mutation receipt.'); const row = value as Record<string, unknown>; if (typeof row.user_id !== 'string' || typeof row.receipt_id !== 'string' || typeof row.replayed !== 'boolean') throw new TypeError('Invalid mutation receipt.'); return { user_id: row.user_id, receipt_id: row.receipt_id, replayed: row.replayed } }
function decodeInviteReceipt(value: unknown): { readonly invite_id: string; readonly target_user_id: string; readonly delivery_status:'sent'|'unconfirmed' } { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid invite receipt.'); const row = value as Record<string, unknown>; if ((row.delivery_status !== 'sent' && row.delivery_status !== 'unconfirmed') || typeof row.invite_id !== 'string' || typeof row.target_user_id !== 'string') throw new TypeError('Invalid invite receipt.'); return { invite_id: row.invite_id, target_user_id: row.target_user_id, delivery_status:row.delivery_status } }
function isRole(value: unknown): value is Role { return value === 'founder' || value === 'admin' || value === 'advisor' || value === 'contractor' || value === 'l1' || value === 'l2' || value === 'l3' }
function isUserStatus(value: unknown): value is UserStatus { return value === 'invited' || value === 'active' || value === 'disabled' }
function isMembershipStatus(value: unknown): value is MembershipStatus { return value === 'invited' || value === 'active' || value === 'disabled' }
function isEmploymentType(value: unknown): value is EmploymentType { return value === 'FULL_TIME' || value === 'PART_TIME' }
