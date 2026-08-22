'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '@/components/workspace/Icon'
import {
  RELEASE_ONE_NAVIGATION_PLACEHOLDERS,
  type ReleaseOneNavigationPlaceholder,
} from '@/modules/future/public'

const navItems: Array<{ href: string; labelKey: string; icon: IconName; exact?: boolean }> = [
  { href: '/today', labelKey: 'nav.today', icon: 'layout-dashboard', exact: true },
  { href: '/cases', labelKey: 'nav.cases', icon: 'briefcase' },
  { href: '/students', labelKey: 'nav.studentsAndGuardians', icon: 'users' },
  { href: '/schools', labelKey: 'nav.schoolData', icon: 'book-open' },
  { href: '/tasks', labelKey: 'nav.tasks', icon: 'clipboard' },
  { href: '/documents', labelKey: 'nav.documents', icon: 'file-text' },
]

const adminItems: Array<{ href: string; labelKey: string; icon: IconName }> = [
  { href: '/admin/access', labelKey: 'nav.access', icon: 'shield' },
  { href: '/admin/schools', labelKey: 'nav.schoolGovernance', icon: 'book-open' },
  { href: '/admin/crawler', labelKey: 'nav.dataReview', icon: 'settings' },
  { href: '/admin/knowledge', labelKey: 'nav.knowledge', icon: 'book-open' },
]

export function Sidebar({
  desktopOpen = true,
  mobileOpen = false,
  onClose,
}: {
  readonly desktopOpen?: boolean;
  readonly mobileOpen?: boolean;
  readonly onClose?: () => void;
}) {
  const { t } = useTranslation()
  const pathname = usePathname()
  const [profile, setProfile] = useState<{ email: string; role: string } | null>(null)

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return
        const payload = await response.json() as { data?: { email?: string; role?: string } }
        if (payload.data?.email && payload.data.role) {
          setProfile({ email: payload.data.email, role: roleLabel(payload.data.role) })
        }
      })
      .catch(() => undefined)
  }, [])

  function isActive(item: { href: string; exact?: boolean }) {
    return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)
  }

  return (
    <>
      {mobileOpen ? <button type="button" aria-label={t('layout.close_navigation')} className="fixed inset-0 z-40 bg-slate-950/40 md:hidden" onClick={onClose} /> : null}
      <aside className={`app-sidebar w-64 min-h-screen flex-col shrink-0 ${mobileOpen ? 'fixed inset-y-0 left-0 z-50 flex md:static' : 'hidden'} ${desktopOpen ? 'md:flex' : 'md:hidden'}`} style={{ background: 'var(--sidebar-bg)' }}>
      <div className="px-5 py-5" style={{ borderBottom: '1px solid rgba(255,255,255,.08)' }}>
        <div className="flex items-center gap-2.5 justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-md flex items-center justify-center" style={{ background: 'var(--sidebar-active)', color: '#fff' }}>
            <Icon name="sparkles" size={16} />
          </div>
          <div className="sidebar-brand-copy">
            <div className="text-sm font-semibold leading-tight" style={{ color: '#f4f7fb' }}>天星顧問</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--sidebar-text-muted)' }}>Case workspace</div>
          </div>
          </div>
          <button type="button" className="icon-button" style={{ color: 'var(--sidebar-text)', height: '2.75rem', width: '2.75rem' }} title={t('layout.close_navigation')} aria-label={t('layout.close_navigation')} onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1" aria-label="主要導航">
        <div className="sidebar-section-label px-2 pb-2 text-[10px] uppercase tracking-[0.12em] font-semibold" style={{ color: 'var(--sidebar-text-muted)' }}>Workspace</div>
        {navItems.map((item) => <NavItem key={item.href} item={{ ...item, label: t(item.labelKey) }} active={isActive(item)} onNavigate={mobileOpen ? onClose : undefined} />)}
        <div className="sidebar-section-label px-2 pt-6 pb-2 text-[10px] uppercase tracking-[0.12em] font-semibold" style={{ color: 'var(--sidebar-text-muted)' }}>Administration</div>
        {adminItems.map((item) => <NavItem key={item.href} item={{ ...item, label: t(item.labelKey) }} active={isActive(item)} onNavigate={mobileOpen ? onClose : undefined} />)}
        <div className="sidebar-section-label px-2 pt-6 pb-2 text-[10px] uppercase tracking-[0.12em] font-semibold" style={{ color: 'var(--sidebar-text-muted)' }}>Future</div>
        {RELEASE_ONE_NAVIGATION_PLACEHOLDERS.map((placeholder) => <FuturePlaceholder key={placeholder.featureId} placeholder={placeholder} />)}
      </nav>

      <div className="px-3 pb-3">
        <div className="p-3 rounded-lg" style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.08)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold" style={{ background: '#dbeafe', color: '#1d4ed8' }}>{profile ? initials(profile.email) : '…'}</div>
            <div className="sidebar-user-copy min-w-0">
              <div className="text-xs font-medium truncate" style={{ color: '#f4f7fb' }}>{profile?.role || '確認身份中'}</div>
              <div className="text-[11px] truncate" style={{ color: 'var(--sidebar-text-muted)' }}>{profile?.email || '香港組織'}</div>
            </div>
          </div>
          <a href="/api/auth/logout" className="flex items-center gap-2 mt-3 px-2 py-1.5 text-[11px] rounded" style={{ color: 'var(--sidebar-text)' }}>
            <Icon name="log-out" size={13} />
            <span>登出</span>
          </a>
          <div className="flex items-center gap-1.5 mt-3 text-[10px]" style={{ color: '#86efac' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#4ade80' }} />
            <span className="sidebar-session-label">Session boundary ready</span>
          </div>
        </div>
        <div className="sidebar-release px-2 pt-3 text-[10px]" style={{ color: 'var(--sidebar-text-muted)' }}>Release 1 · P1 UI slice</div>
      </div>
      </aside>
    </>
  )
}

function roleLabel(role: string): string {
  if (role === 'founder') return 'Founder'
  if (role === 'admin') return 'Admin'
  if (role === 'advisor') return 'Advisor'
  if (role === 'data_reviewer') return 'Data Reviewer'
  return 'Contractor'
}

function initials(email: string): string {
  const localPart = email.split('@')[0] || email
  return localPart.slice(0, 2).toUpperCase()
}

function NavItem({ item, active, onNavigate }: { item: { href: string; label: string; icon: IconName }; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={item.href}
      aria-label={item.label}
      title={item.label}
      className="flex items-center gap-3 px-3 py-2.5 rounded-md text-[13px] transition-colors"
      style={{ background: active ? 'var(--sidebar-active)' : 'transparent', color: active ? '#fff' : 'var(--sidebar-text)' }}
      onClick={onNavigate}
    >
      <Icon name={item.icon} size={16} />
      <span className="sidebar-item-label">{item.label}</span>
      {active && <span className="ml-auto w-1.5 h-1.5 rounded-full" style={{ background: '#bfdbfe' }} />}
    </Link>
  )
}

function FuturePlaceholder({ placeholder }: { placeholder: ReleaseOneNavigationPlaceholder }) {
  return (
    <div
      aria-disabled="true"
      className="flex items-center gap-3 px-3 py-2.5 text-[13px] opacity-60 cursor-not-allowed"
      title={`${placeholder.label} - ${placeholder.statusLabel}`}
      style={{ color: 'var(--sidebar-text-muted)' }}
    >
      <Icon name={futurePlaceholderIcon(placeholder.featureId)} size={16} />
      <span className="sidebar-item-label">{placeholder.label}</span>
      <span className="ml-auto text-[10px] whitespace-nowrap">{placeholder.statusLabel}</span>
    </div>
  )
}

function futurePlaceholderIcon(featureId: ReleaseOneNavigationPlaceholder['featureId']): IconName {
  if (featureId === 'ai_reports') return 'sparkles'
  if (featureId === 'data_import') return 'file-text'
  if (featureId === 'multi_tenant') return 'users'
  return 'book-open'
}
