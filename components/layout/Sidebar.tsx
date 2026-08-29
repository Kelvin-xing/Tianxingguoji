'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '@/components/workspace/Icon'
import {
  decodeWorkspaceAuth,
  nicknameInitial,
  visibleWorkspaceNavigation,
  type WorkspaceAuthDto,
  type WorkspaceNavigationItem,
} from '@/components/layout/workspace-navigation'
import { requestApi } from '@/lib/api/client'

export function Sidebar({
  auth,
  desktopOpen = true,
  mobileOpen = false,
  onClose,
  onCloseMobile,
}: {
  readonly auth?: WorkspaceAuthDto | null
  readonly desktopOpen?: boolean
  readonly mobileOpen?: boolean
  readonly onClose?: () => void
  readonly onCloseMobile?: () => void
}) {
  const { t } = useTranslation()
  const pathname = usePathname()
  const [loadedAuth, setLoadedAuth] = useState<WorkspaceAuthDto | null>(null)
  const effectiveAuth = auth === undefined ? loadedAuth : auth
  const navItems = useMemo(
    () => visibleWorkspaceNavigation(effectiveAuth?.capabilities ?? []),
    [effectiveAuth?.capabilities],
  )

  useEffect(() => {
    if (auth !== undefined) return
    const controller = new AbortController()
    requestApi({ path: '/api/v1/auth/me', signal: controller.signal }, decodeWorkspaceAuth)
      .then(setLoadedAuth)
      .catch(() => undefined)
    return () => controller.abort()
  }, [auth])

  function isActive(item: { href: string; exact?: boolean }) {
    return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)
  }

  return (
    <>
      {mobileOpen ? <button type="button" aria-label={t('layout.close_navigation')} className="fixed inset-0 z-40 bg-slate-950/40 md:hidden" onClick={onCloseMobile ?? onClose} /> : null}
      <aside id="workspace-navigation" aria-label={t('layout.workspace_navigation')} className={`app-sidebar w-64 min-h-screen flex-col shrink-0 ${mobileOpen ? 'fixed inset-y-0 left-0 z-50 flex md:static' : 'hidden'} ${desktopOpen ? 'md:flex' : 'md:hidden'}`} style={{ background: 'var(--sidebar-bg)' }}>
        <div className="px-5 py-5" style={{ borderBottom: '1px solid rgba(255,255,255,.08)' }}>
          <div className="flex items-center gap-2.5 justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-md flex items-center justify-center" style={{ background: 'var(--sidebar-active)', color: '#fff' }}>
                <Icon name="sparkles" size={16} />
              </div>
              <div className="sidebar-brand-copy">
                <div className="text-sm font-semibold leading-tight" style={{ color: '#f4f7fb' }}>天星顧問</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--sidebar-text-muted)' }}>案件工作區</div>
              </div>
            </div>
            <button type="button" className="icon-button" style={{ color: 'var(--sidebar-text)', height: '2.75rem', width: '2.75rem' }} title={t('layout.close_navigation')} aria-label={t('layout.close_navigation')} onClick={onClose}><Icon name="x" size={18} /></button>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1" aria-label={t('layout.workspace_navigation')}>
          <div className="sidebar-section-label px-2 pb-2 text-[10px] uppercase tracking-[0.12em] font-semibold" style={{ color: 'var(--sidebar-text-muted)' }}>{t('layout.workspace_section')}</div>
          {navItems.filter((item) => item.href !== '/admin/access').map((item) => <NavItem key={item.href} item={item} label={t(item.labelKey)} active={isActive(item)} onNavigate={mobileOpen ? (onCloseMobile ?? onClose) : undefined} />)}
          {navItems.some((item) => item.href === '/admin/access') ? <>
            <div className="sidebar-section-label px-2 pt-6 pb-2 text-[10px] uppercase tracking-[0.12em] font-semibold" style={{ color: 'var(--sidebar-text-muted)' }}>{t('layout.administration_section')}</div>
            {navItems.filter((item) => item.href === '/admin/access').map((item) => <NavItem key={item.href} item={item} label={t(item.labelKey)} active={isActive(item)} onNavigate={mobileOpen ? (onCloseMobile ?? onClose) : undefined} />)}
          </> : null}
        </nav>

        <div className="px-3 pb-3">
          <div className="p-3 rounded-lg" style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.08)' }}>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold" style={{ background: '#dbeafe', color: '#1d4ed8' }}>{effectiveAuth ? nicknameInitial(effectiveAuth.nickname) : '…'}</div>
              <div className="sidebar-user-copy min-w-0">
                <div className="text-xs font-medium truncate" style={{ color: '#f4f7fb' }}>{effectiveAuth ? roleLabel(effectiveAuth.role) : t('layout.checking_identity')}</div>
                <div className="text-[11px] truncate" style={{ color: 'var(--sidebar-text-muted)' }}>{t('layout.organization')}</div>
              </div>
            </div>
            <a href="/api/v1/auth/logout" className="flex items-center gap-2 mt-3 px-2 py-1.5 text-[11px] rounded" style={{ color: 'var(--sidebar-text)' }}>
              <Icon name="log-out" size={13} />
              <span>{t('common.sign_out')}</span>
            </a>
            <Link href="/profile" className="flex items-center gap-2 mt-1 px-2 py-1.5 text-[11px] rounded" style={{ color: 'var(--sidebar-text)' }} onClick={mobileOpen ? (onCloseMobile ?? onClose) : undefined}>
              <Icon name="user" size={13} />
              <span>個人資料</span>
            </Link>
            <div className="flex items-center gap-1.5 mt-3 text-[10px]" style={{ color: '#86efac' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#4ade80' }} />
              <span className="sidebar-session-label">{t('layout.session_ready')}</span>
            </div>
          </div>
          <div className="sidebar-release px-2 pt-3 text-[10px]" style={{ color: 'var(--sidebar-text-muted)' }}>工作區</div>
        </div>
      </aside>
    </>
  )
}

function roleLabel(role: WorkspaceAuthDto['role']): string {
  if (role === 'founder') return 'Founder'
  if (role === 'admin') return 'Admin'
  if (role === 'advisor') return 'Advisor'
  if (role === 'contractor') return 'Contractor'
  return '其他角色'
}

function NavItem({ item, label, active, onNavigate }: { readonly item: WorkspaceNavigationItem; readonly label: string; readonly active: boolean; readonly onNavigate?: () => void }) {
  return (
    <Link
      href={item.href}
      aria-label={label}
      title={label}
      className="flex items-center gap-3 px-3 py-2.5 rounded-md text-[13px] transition-colors"
      style={{ background: active ? 'var(--sidebar-active)' : 'transparent', color: active ? '#fff' : 'var(--sidebar-text)' }}
      onClick={onNavigate}
    >
      <Icon name={item.icon} size={16} />
      <span className="sidebar-item-label">{label}</span>
      {active && <span className="ml-auto w-1.5 h-1.5 rounded-full" style={{ background: '#bfdbfe' }} />}
    </Link>
  )
}
