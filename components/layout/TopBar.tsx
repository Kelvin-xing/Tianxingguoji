'use client'

import { useTranslation } from 'react-i18next'
import { useLangToggle } from '@/lib/i18n-provider'
import { usePathname } from 'next/navigation'

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'nav.dashboard',
  '/students': 'nav.students',
  '/schools': 'nav.schools',
  '/selector': 'nav.selector',
  '/admin/crawler': 'nav.adminCrawler',
  '/ai': 'nav.ai',
}

export function TopBar() {
  const { t } = useTranslation()
  const toggleLang = useLangToggle()
  const pathname = usePathname()

  const titleKey = Object.keys(PAGE_TITLES).find((p) => pathname.startsWith(p))
  const title = titleKey ? t(PAGE_TITLES[titleKey]) : ''

  return (
    <header
      className="h-12 flex items-center justify-between px-5 shrink-0"
      style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
    >
      <h1 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
        {title}
      </h1>
      <button
        onClick={toggleLang}
        className="text-xs px-2.5 py-1 rounded transition-colors"
        style={{
          color: 'var(--text-secondary)',
          border: '1px solid var(--border)',
          background: 'transparent',
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLElement).style.background = 'var(--bg)'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLElement).style.background = 'transparent'
        }}
      >
        {t('common.lang_toggle')}
      </button>
    </header>
  )
}
