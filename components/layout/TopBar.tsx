'use client'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Input } from '@/components/ui/standard'
import { Icon } from '@/components/workspace/Icon'
import { requestApi } from '@/lib/api/client'
import { unreadCount } from '@/components/notifications/f4-client'
import { decodeWorkspaceAuth, nicknameInitial, visibleWorkspaceNavigation, type WorkspaceAuthDto } from '@/components/layout/workspace-navigation'
import { useLangToggle } from '@/lib/i18n-provider'
export function TopBar({ auth }: { readonly auth?: WorkspaceAuthDto | null }) {
  const { t } = useTranslation()
  const toggleLang = useLangToggle()
  const pathname = usePathname()
  const [loadedAuth, setLoadedAuth] = useState<WorkspaceAuthDto | null>(null)
  const [notificationCount, setNotificationCount] = useState<number | null>(null)
  const effectiveAuth = auth === undefined ? loadedAuth : auth
  const items = visibleWorkspaceNavigation(effectiveAuth?.capabilities ?? [])
  const regular = items.filter(item => !item.href.startsWith('/admin/'))
  const admin = items.filter(item => item.href.startsWith('/admin/'))
  const active = (item: { href: string; exact?: boolean }) => item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)
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
    unreadCount().then((count) => {
      if (!controller.signal.aborted) setNotificationCount(count)
    }).catch(() => {
      if (!controller.signal.aborted) setNotificationCount(null)
    })
    return () => controller.abort()
  }, [effectiveAuth])
  return (
    <header className="ui-topbar">
      <span className="ui-brand">{t('ui.brand')}</span>
      <nav className="ui-nav" aria-label={t('layout.workspace_navigation')}>
        {regular.map(item => <Link key={item.href} href={item.href} aria-current={active(item) ? 'page' : undefined}>{t(item.labelKey)}</Link>)}
        {admin.length > 0 && <details className="ui-admin">
          <summary aria-current={admin.some(active) ? 'page' : undefined}>{t('ui.management')}</summary>
          <div>{admin.map(item => <Link key={item.href} href={item.href} aria-current={active(item) ? 'page' : undefined}>{t(item.labelKey)}</Link>)}</div>
        </details>}
      </nav>
      <div className="ui-top-actions">
        <Input label="" className="ui-top-search" type="search" disabled aria-label={t('ui.searchUnavailable')} placeholder={t('ui.searchUnavailable')} />
        <a href="/notifications" className="ui-button ui-weak" title="通知" aria-label="通知"><Icon name="activity" size={17} />{notificationCount !== null && notificationCount > 0 ? notificationCount : null}</a>
        <Button onClick={toggleLang}>{t('common.lang_toggle')}</Button>
        <Link href="/profile" className="ui-avatar" title="個人資料" aria-label="個人資料">{effectiveAuth ? nicknameInitial(effectiveAuth.nickname) : '…'}</Link>
      </div>
    </header>
  )
}
