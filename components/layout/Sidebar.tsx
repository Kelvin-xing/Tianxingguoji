'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NAVIGATION_REGISTRY, type NavigationRegistryItem } from '@/components/layout/navigation-registry'
import { Icon, type IconName } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot, type WorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  RELEASE_ONE_NAVIGATION_PLACEHOLDERS,
  type ReleaseOneNavigationPlaceholder,
} from '@/modules/future/public'

export function Sidebar({
  desktopOpen = true,
  mobileOpen = false,
  onCloseDesktop,
  onCloseMobile,
}: {
  readonly desktopOpen?: boolean;
  readonly mobileOpen?: boolean;
  readonly onCloseDesktop?: () => void;
  readonly onCloseMobile?: () => void;
}) {
  const { t } = useTranslation()
  const pathname = usePathname()
  const [accessSnapshot, setAccessSnapshot] = useState<WorkspaceAccessSnapshot | null>(null)
  const [accessState, setAccessState] = useState<'loading' | 'ready' | 'unavailable'>('loading')

  useEffect(() => {
    const controller = new AbortController()
    let current = true

    getWorkspaceAccessSnapshot(controller.signal)
      .then((snapshot) => {
        if (!current) return
        setAccessSnapshot(snapshot)
        setAccessState('ready')
      })
      .catch(() => {
        if (!current) return
        setAccessSnapshot(null)
        setAccessState('unavailable')
      })

    return () => {
      current = false
      controller.abort()
    }
  }, [])

  const visibleNavigationItems = accessState === 'ready' && accessSnapshot
    ? NAVIGATION_REGISTRY.filter((item) => accessSnapshot.capabilities.includes(item.requiredCapability))
    : []
  const workspaceItems = visibleNavigationItems.filter((item) => item.audience === 'workspace')
  const administrationItems = visibleNavigationItems.filter((item) => item.audience === 'administration')

  function isActive(item: NavigationRegistryItem) {
    return item.activeMatch === 'exact'
      ? pathname === item.route
      : pathname === item.route || pathname.startsWith(`${item.route}/`)
  }

  function closeVisibleNavigation() {
    if (window.matchMedia('(min-width: 768px)').matches) {
      onCloseDesktop?.()
      return
    }
    onCloseMobile?.()
  }

  return (
    <>
      {mobileOpen ? <button type="button" aria-label={t('layout.close_navigation')} className="fixed inset-0 z-40 bg-slate-950/40 md:hidden" onClick={onCloseMobile} /> : null}
      <aside id="workspace-navigation" className={`app-sidebar w-64 min-h-screen flex-col shrink-0 ${mobileOpen ? 'fixed inset-y-0 left-0 z-50 flex md:static' : 'hidden'} ${desktopOpen ? 'md:flex' : 'md:hidden'}`} style={{ background: 'var(--sidebar-bg)' }}>
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
          <button type="button" className="icon-button" style={{ color: 'var(--sidebar-text)', height: '2.75rem', width: '2.75rem' }} title={t('layout.close_navigation')} aria-label={t('layout.close_navigation')} onClick={closeVisibleNavigation}><Icon name="x" size={18} /></button>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1" aria-label="主要導航">
        {workspaceItems.length > 0 ? <>
          <div className="sidebar-section-label px-2 pb-2 text-[10px] uppercase tracking-[0.12em] font-semibold" style={{ color: 'var(--sidebar-text-muted)' }}>Workspace</div>
          {workspaceItems.map((item) => <NavItem key={item.route} item={{ ...item, label: t(item.labelKey) }} active={isActive(item)} onNavigate={mobileOpen ? onCloseMobile : undefined} />)}
        </> : null}
        {administrationItems.length > 0 ? <>
          <div className="sidebar-section-label px-2 pt-6 pb-2 text-[10px] uppercase tracking-[0.12em] font-semibold" style={{ color: 'var(--sidebar-text-muted)' }}>Administration</div>
          {administrationItems.map((item) => <NavItem key={item.route} item={{ ...item, label: t(item.labelKey) }} active={isActive(item)} onNavigate={mobileOpen ? onCloseMobile : undefined} />)}
        </> : null}
        <div className="sidebar-section-label px-2 pt-6 pb-2 text-[10px] uppercase tracking-[0.12em] font-semibold" style={{ color: 'var(--sidebar-text-muted)' }}>Future</div>
        {RELEASE_ONE_NAVIGATION_PLACEHOLDERS.map((placeholder) => <FuturePlaceholder key={placeholder.featureId} placeholder={placeholder} />)}
      </nav>

      <div className="px-3 pb-3">
        <div className="p-3 rounded-lg" style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.08)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold" style={{ background: '#dbeafe', color: '#1d4ed8' }}>{accessSnapshot ? roleInitials(accessSnapshot.role) : '…'}</div>
            <div className="sidebar-user-copy min-w-0">
              <div className="text-xs font-medium truncate" style={{ color: '#f4f7fb' }}>{accessSnapshot ? roleLabel(accessSnapshot.role) : accessState === 'unavailable' ? '身份暫時不可用' : '確認身份中'}</div>
              <div className="text-[11px] truncate" style={{ color: 'var(--sidebar-text-muted)' }}>香港組織</div>
            </div>
          </div>
          <a href="/api/auth/logout" className="flex items-center gap-2 mt-3 px-2 py-1.5 text-[11px] rounded" style={{ color: 'var(--sidebar-text)' }}>
            <Icon name="log-out" size={13} />
            <span>{t('layout.logout')}</span>
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

function roleLabel(role: WorkspaceAccessSnapshot['role']): string {
  if (role === 'founder') return 'Founder'
  if (role === 'admin') return 'Admin'
  if (role === 'advisor') return 'Advisor'
  if (role === 'data_reviewer') return 'Data Reviewer'
  return 'Contractor'
}

function roleInitials(role: WorkspaceAccessSnapshot['role']): string {
  return roleLabel(role).slice(0, 2).toUpperCase()
}

function NavItem({ item, active, onNavigate }: { item: NavigationRegistryItem & { label: string }; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={item.route}
      aria-label={item.label}
      title={item.label}
      className="flex items-center gap-3 px-3 py-2.5 rounded-md text-[13px] transition-colors"
      style={{ background: active ? 'var(--sidebar-active)' : 'transparent', color: active ? '#fff' : 'var(--sidebar-text)' }}
      onClick={onNavigate}
    >
      <Icon name={item.iconKey} size={16} />
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
