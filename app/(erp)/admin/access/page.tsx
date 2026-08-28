'use client'

import { useCallback, useEffect, useState } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { ErrorState, LoadingState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError, requestApi } from '@/lib/api/client'

type Role = 'founder' | 'admin' | 'advisor' | 'contractor' | 'data_reviewer'
type UserStatus = 'invited' | 'active' | 'disabled'
type MembershipStatus = 'invited' | 'active' | 'disabled'
type RoleStatus = 'active' | 'revoked'
type EmploymentType = 'FULL_TIME' | 'PART_TIME'

interface UserDirectoryRole {
  readonly role: Role
  readonly status: RoleStatus
}

interface UserDirectoryEntry {
  readonly user_id: string
  readonly email: string
  readonly user_status: UserStatus
  readonly membership_status: MembershipStatus
  readonly display_name: string | null
  readonly employment_type: EmploymentType | null
  readonly roles: readonly UserDirectoryRole[]
  readonly updated_at: string
}

const roles = [
  { name: 'Founder / Admin', scope: '全組織案件、學生、使用者與設定', tone: 'blue' },
  { name: 'Advisor', scope: '被分派案件、Student 360、任務與文件', tone: 'success' },
]

export default function AccessPage() {
  const [users, setUsers] = useState<readonly UserDirectoryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'denied' | 'unavailable' | 'error'>('loading')

  const handleUsers = useCallback((result: { readonly total: number; readonly users: readonly UserDirectoryEntry[] }) => {
    setUsers(result.users)
    setTotal(result.total)
    setState(result.users.length > 0 ? 'ready' : 'empty')
  }, [])

  const handleUsersError = useCallback((error: unknown) => {
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

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <section>
        <div className="eyebrow">Administration · Identity</div>
        <h2 className="page-title">Access</h2>
        <p className="page-subtitle">查看目前組織使用者與角色狀態。</p>
      </section>

      <section className="workspace-section">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="section-title">使用者列表</h3>
            <p className="section-detail">僅 Founder 和 Admin 可查看；本頁目前為只讀。</p>
          </div>
          <button type="button" className="secondary-button" onClick={loadUsers} disabled={state === 'loading'}>
            <Icon name="rotate-ccw" size={15} />重新載入
          </button>
        </div>
        {state === 'loading' && <LoadingState title="正在载入使用者" />}
        {state === 'denied' && <ErrorState title="无法查看使用者" detail="当前身份没有 access.manage 权限。" />}
        {state === 'unavailable' && <UnavailableState title="使用者服务暂时不可用" detail="请确认当前运行环境和数据库连接后重试。" onRetry={loadUsers} />}
        {state === 'error' && <ErrorState title="使用者读取失败" detail="请保留当前页面后重试。" onRetry={loadUsers} />}
        {state === 'empty' && <div className="empty-state">目前组织没有可显示的使用者。</div>}
        {state === 'ready' && <UserTable users={users} total={total} />}
      </section>

      <section className="workspace-section">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="section-title">角色模型</h3>
            <p className="section-detail">角色只是显示信息；实际权限仍由 server 端 request-time Access 决定。</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {roles.map((role) => (
            <div key={role.name} className="selection-card selected">
              <span className={`work-icon ${role.tone}`}><Icon name={role.name.startsWith('Founder') ? 'shield' : 'user'} size={15} /></span>
              <span><strong>{role.name}</strong><small>{role.scope}</small></span>
              <Icon name="check-circle" size={16} className="ml-auto" style={{ color: '#15803d' }} />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function UserTable({ users, total }: { readonly users: readonly UserDirectoryEntry[]; readonly total: number }) {
  return (
    <div>
      <div className="section-detail mb-3">共 {total} 位使用者</div>
      <div className="overflow-x-auto -mx-5">
        <table className="data-table min-w-[860px]">
          <thead><tr><th>使用者</th><th>使用者状态</th><th>雇佣类型</th><th>角色</th><th>更新时间</th></tr></thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.user_id} className="data-row">
                <td><div className="table-primary">{user.display_name ?? '未设置姓名'}</div><div className="table-secondary">{user.email}</div></td>
                <td><StatusPill value={user.user_status} /></td>
                <td className="table-muted">{employmentLabel(user.employment_type)}</td>
                <td><div className="flex flex-wrap gap-1">{user.roles.length > 0 ? user.roles.map((role, index) => <RolePill key={`${role.role}-${role.status}-${index}`} role={role} />) : <span className="table-muted">未分配角色</span>}</div></td>
                <td className="table-muted">{formatDate(user.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatusPill({ value }: { readonly value: UserStatus | MembershipStatus }) {
  const label = value === 'active' ? 'Active' : value === 'invited' ? 'Invited' : 'Disabled'
  return <span className={`status-pill ${value === 'active' ? 'status-success' : 'status-warning'}`}>{label}</span>
}

function RolePill({ role }: { readonly role: UserDirectoryRole }) {
  const label = roleLabel(role.role)
  return <span className={`status-pill ${role.status === 'active' ? 'status-success' : 'status-warning'}`}>{role.status === 'active' ? label : `${label}（已撤销）`}</span>
}

function roleLabel(role: Role): string {
  if (role === 'founder') return 'Founder'
  if (role === 'admin') return 'Admin'
  if (role === 'advisor') return 'Advisor'
  if (role === 'contractor') return 'Contractor'
  return 'Data Reviewer'
}

function employmentLabel(value: EmploymentType | null): string {
  if (value === 'FULL_TIME') return '正式员工'
  if (value === 'PART_TIME') return '兼职'
  return '未设置'
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-HK')
}

function decodeUserDirectory(value: unknown): { readonly total: number; readonly users: readonly UserDirectoryEntry[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid user directory response.')
  const root = value as Record<string, unknown>
  if (!Number.isSafeInteger(root.total) || (root.total as number) < 0 || !Array.isArray(root.users)) throw new TypeError('Invalid user directory response.')
  return { total: root.total as number, users: Object.freeze(root.users.map(decodeUser)) }
}

function decodeUser(value: unknown): UserDirectoryEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid user directory entry.')
  const row = value as Record<string, unknown>
  if (typeof row.user_id !== 'string' || typeof row.email !== 'string' || !isUserStatus(row.user_status) || !isMembershipStatus(row.membership_status) || (row.display_name !== null && typeof row.display_name !== 'string') || (row.employment_type !== null && !isEmploymentType(row.employment_type)) || typeof row.updated_at !== 'string' || !Array.isArray(row.roles)) throw new TypeError('Invalid user directory entry.')
  return { user_id: row.user_id, email: row.email, user_status: row.user_status, membership_status: row.membership_status, display_name: row.display_name, employment_type: row.employment_type, roles: Object.freeze(row.roles.map(decodeRole)), updated_at: row.updated_at }
}

function decodeRole(value: unknown): UserDirectoryRole {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid user directory role.')
  const row = value as Record<string, unknown>
  if (!isRole(row.role) || !isRoleStatus(row.status)) throw new TypeError('Invalid user directory role.')
  return { role: row.role, status: row.status }
}

function isRole(value: unknown): value is Role { return value === 'founder' || value === 'admin' || value === 'advisor' || value === 'contractor' || value === 'data_reviewer' }
function isRoleStatus(value: unknown): value is RoleStatus { return value === 'active' || value === 'revoked' }
function isUserStatus(value: unknown): value is UserStatus { return value === 'invited' || value === 'active' || value === 'disabled' }
function isMembershipStatus(value: unknown): value is MembershipStatus { return value === 'invited' || value === 'active' || value === 'disabled' }
function isEmploymentType(value: unknown): value is EmploymentType { return value === 'FULL_TIME' || value === 'PART_TIME' }
