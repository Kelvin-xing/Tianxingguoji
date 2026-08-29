'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '@/components/workspace/Icon'
import { requestApi } from '@/lib/api/client'
import { unreadCount } from '@/components/notifications/f4-client'
import { decodeWorkspaceAuth, nicknameInitial, type WorkspaceAuthDto } from '@/components/layout/workspace-navigation'
import { useLangToggle } from '@/lib/i18n-provider'

const PAGE_TITLE_KEYS: Array<{ prefix: string; titleKey: string }> = [
  { prefix: '/today', titleKey: 'nav.today' },
  { prefix: '/cases', titleKey: 'nav.cases' },
  { prefix: '/students', titleKey: 'nav.studentsAndGuardians' },
  { prefix: '/schools', titleKey: 'nav.schoolData' },
  { prefix: '/tasks', titleKey: 'nav.tasks' },
  { prefix: '/documents', titleKey: 'nav.documents' },
  { prefix: '/admin/access', titleKey: 'nav.access' },
  { prefix: '/profile', titleKey: 'layout.profile' },
]

export function TopBar({
  auth,
  desktopNavigationOpen = true,
  onOpenNavigation,
}: {
  readonly auth?: WorkspaceAuthDto | null
  readonly desktopNavigationOpen?: boolean
  readonly onOpenNavigation?: () => void
}) {
  const { t } = useTranslation()
  const toggleLang = useLangToggle()
  const pathname = usePathname()
  const [loadedAuth, setLoadedAuth] = useState<WorkspaceAuthDto | null>(null)
  const [notificationCount, setNotificationCount] = useState<number | null>(null)
  const effectiveAuth = auth === undefined ? loadedAuth : auth
  const titleKey = PAGE_TITLE_KEYS.find((item) => pathname.startsWith(item.prefix))?.titleKey

  useEffect(() => {
    if (auth !== undefined) return
    const controller = new AbortController()
    requestApi({ path: '/api/v1/auth/me', signal: controller.signal }, decodeWorkspaceAuth)
      .then(setLoadedAuth)
      .catch(() => undefined)
    return () => controller.abort()
  }, [auth])

  useEffect(() => {
    if (effectiveAuth === null) return
    const controller = new AbortController()
    unreadCount().then((count) => { if (!controller.signal.aborted) setNotificationCount(count) }).catch(() => { if (!controller.signal.aborted) setNotificationCount(null) })
    return () => controller.abort()
  }, [effectiveAuth])

  return (
    <header className="min-h-16 flex items-center justify-between gap-4 px-4 sm:px-6 shrink-0" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
      <div className="flex items-center gap-3 min-w-0">
        <button type="button" className="icon-button" aria-controls="workspace-navigation" aria-expanded={desktopNavigationOpen} onClick={onOpenNavigation} title={t('layout.open_navigation')} aria-label={t('layout.open_navigation')}><Icon name="menu" size={19} /></button>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{titleKey ? t(titleKey) : t('layout.erp_title')}</h1>
          <div className="hidden sm:flex items-center gap-1.5 mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>{t('layout.organization')}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <label className="hidden md:flex items-center gap-2 h-9 w-60 px-3 rounded-md" style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          <Icon name="search" size={15} />
          <input className="bg-transparent border-0 outline-none p-0 text-xs w-full" placeholder={t('layout.search_placeholder')} aria-label={t('layout.search_label')} />
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>⌘K</span>
        </label>
        <a href="/notifications" className="icon-button relative" title="通知" aria-label="通知"><Icon name="activity" size={17} />{notificationCount !== null && notificationCount > 0 ? <span className="absolute -right-1 -top-1 min-w-4 h-4 px-1 rounded-full text-[10px] leading-4 text-center" style={{ background: '#dc2626', color: '#fff' }}>{notificationCount > 99 ? '99+' : notificationCount}</span> : null}</a>
        <button type="button" onClick={toggleLang} className="text-xs px-2.5 h-9 rounded-md" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)', background: 'var(--surface)' }}>{t('common.lang_toggle')}</button>
        <Link href="/profile" className="hidden sm:flex items-center justify-center w-9 h-9 rounded-full text-xs font-semibold" title="個人資料" aria-label="個人資料" style={{ background: '#dbeafe', color: '#1d4ed8' }}>{effectiveAuth ? nicknameInitial(effectiveAuth.nickname) : '…'}</Link>
      </div>
    </header>
  )
}
