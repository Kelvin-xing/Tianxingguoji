'use client'

import { useTranslation } from 'react-i18next'
import { useLangToggle } from '@/lib/i18n-provider'
import { usePathname } from 'next/navigation'

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'nav.dashboard',
  '/students': 'nav.students',
  '/schools': 'nav.schools',
  '/selector': 'nav.selector',
  '/ai': 'nav.ai',
}

export function TopBar() {
  const { t } = useTranslation()
  const toggleLang = useLangToggle()
  const pathname = usePathname()

  const titleKey = Object.keys(PAGE_TITLES).find((p) => pathname.startsWith(p))
  const title = titleKey ? t(PAGE_TITLES[titleKey]) : ''

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6">
      <h1 className="text-base font-semibold text-gray-800">{title}</h1>
      <button
        onClick={toggleLang}
        className="text-sm text-gray-500 hover:text-gray-900 border border-gray-300 rounded px-3 py-1 transition-colors"
      >
        {t('common.lang_toggle')}
      </button>
    </header>
  )
}
