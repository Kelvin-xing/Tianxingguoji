'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLangToggle } from '@/lib/i18n-provider'
import { Icon } from '@/components/workspace/Icon'

const PAGE_TITLES: Array<{ prefix: string; labelKey: string }> = [
  { prefix: '/today', labelKey: 'nav.today' },
  { prefix: '/cases', labelKey: 'nav.cases' },
  { prefix: '/students', labelKey: 'nav.studentsAndGuardians' },
  { prefix: '/schools', labelKey: 'nav.schoolData' },
  { prefix: '/tasks', labelKey: 'nav.tasks' },
  { prefix: '/documents', labelKey: 'nav.documents' },
  { prefix: '/admin/access', labelKey: 'nav.access' },
  { prefix: '/admin/schools', labelKey: 'nav.schoolGovernance' },
  { prefix: '/admin/crawler', labelKey: 'nav.dataReview' },
  { prefix: '/admin/knowledge', labelKey: 'nav.knowledge' },
  { prefix: '/ai', labelKey: 'nav.ai' },
]

export function TopBar({
  desktopNavigationOpen = true,
  onOpenDesktopNavigation,
  onOpenMobileNavigation,
}: {
  readonly desktopNavigationOpen?: boolean;
  readonly onOpenDesktopNavigation?: () => void;
  readonly onOpenMobileNavigation?: () => void;
}) {
  const { t } = useTranslation()
  const toggleLang = useLangToggle()
  const pathname = usePathname()
  const [email, setEmail] = useState('')
  const [openMenu, setOpenMenu] = useState<'notifications' | 'account' | null>(null)
  const menuRootRef = useRef<HTMLDivElement>(null)
  const notificationButtonRef = useRef<HTMLButtonElement>(null)
  const notificationPanelRef = useRef<HTMLElement>(null)
  const accountButtonRef = useRef<HTMLButtonElement>(null)
  const logoutLinkRef = useRef<HTMLAnchorElement>(null)
  const titleKey = PAGE_TITLES.find((item) => pathname.startsWith(item.prefix))?.labelKey
  const title = titleKey ? t(titleKey) : t('layout.erp_title')

  function openVisibleNavigation() {
    if (window.matchMedia('(min-width: 768px)').matches) {
      onOpenDesktopNavigation?.()
      return
    }
    onOpenMobileNavigation?.()
  }

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return
        const payload = await response.json() as { data?: { email?: string } }
        if (payload.data?.email) setEmail(payload.data.email)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (openMenu === 'notifications') notificationPanelRef.current?.focus()
    if (openMenu === 'account') logoutLinkRef.current?.focus()

    function closeMenus(event: PointerEvent) {
      if (event.target instanceof Node && !menuRootRef.current?.contains(event.target)) setOpenMenu(null)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || openMenu === null) return
      const trigger = openMenu === 'notifications' ? notificationButtonRef.current : accountButtonRef.current
      setOpenMenu(null)
      requestAnimationFrame(() => trigger?.focus())
    }
    document.addEventListener('pointerdown', closeMenus)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeMenus)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [openMenu])

  return (
    <header className="min-h-16 flex items-center justify-between gap-4 px-4 sm:px-6 shrink-0" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
      <div className="flex items-center gap-3 min-w-0">
        <button type="button" className="icon-button navigation-button desktop-navigation-button mobile-navigation-button" data-desktop-navigation-open={desktopNavigationOpen} style={{ height: '2.75rem', width: '2.75rem' }} onClick={openVisibleNavigation} title={t('layout.open_navigation')} aria-label={t('layout.open_navigation')} aria-controls="workspace-navigation"><Icon name="menu" size={19} /></button>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{title}</h1>
          <div className="hidden sm:flex items-center gap-1.5 mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>香港組織</span><span>/</span><span>Release 1</span>
          </div>
        </div>
      </div>
      <div ref={menuRootRef} className="relative flex items-center gap-2 shrink-0">
        <label className="hidden md:flex items-center gap-2 h-9 w-60 px-3 rounded-md" style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          <Icon name="search" size={15} />
          <input className="bg-transparent border-0 outline-none p-0 text-xs w-full" placeholder="搜尋學生、案件或學校" aria-label="全域搜尋" />
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>⌘K</span>
        </label>
        <button ref={notificationButtonRef} type="button" className="icon-button" title={t('layout.notifications')} aria-label={t('layout.notifications')} aria-expanded={openMenu === 'notifications'} aria-controls="workspace-notifications" onClick={() => setOpenMenu((current) => current === 'notifications' ? null : 'notifications')}><Icon name="activity" size={17} /></button>
        <button type="button" onClick={() => { toggleLang(); setOpenMenu(null) }} className="text-xs px-2.5 h-9 rounded-md" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)', background: 'var(--surface)' }}>{t('common.lang_toggle')}</button>
        <button ref={accountButtonRef} type="button" className="account-menu-button inline-flex items-center justify-center w-9 h-9 rounded-full text-xs font-semibold" title={t('layout.account_menu')} aria-label={t('layout.account_menu')} aria-expanded={openMenu === 'account'} aria-controls="workspace-account-menu" onClick={() => setOpenMenu((current) => current === 'account' ? null : 'account')} style={{ background: '#dbeafe', color: '#1d4ed8' }}>{email ? email.slice(0, 2).toUpperCase() : <Icon name="user" size={16} />}</button>
        {openMenu === 'notifications' ? <section ref={notificationPanelRef} id="workspace-notifications" className="workspace-popover" aria-label={t('layout.notifications')} tabIndex={-1}><strong>{t('layout.notifications')}</strong><p>{t('layout.notifications_unavailable')}</p></section> : null}
        {openMenu === 'account' ? <div id="workspace-account-menu" className="workspace-popover" role="menu" aria-label={t('layout.account_menu')}><strong>{t('layout.account_menu')}</strong>{email ? <p className="break-all">{email}</p> : null}<a ref={logoutLinkRef} id="workspace-logout" href="/api/auth/logout" role="menuitem"><Icon name="log-out" size={14} />{t('layout.logout')}</a></div> : null}
      </div>
    </header>
  )
}
