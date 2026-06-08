'use client'

import i18n from 'i18next'
import { initReactI18next, I18nextProvider } from 'react-i18next'
import { useEffect, useState } from 'react'
import zhTW from '@/i18n/zh-TW.json'
import en from '@/i18n/en.json'

const STORAGE_KEY = 'erp_lang'

if (!i18n.isInitialized) {
  i18n.use(initReactI18next).init({
    resources: {
      'zh-TW': { translation: zhTW },
      en: { translation: en },
    },
    lng: 'zh-TW',
    fallbackLng: 'zh-TW',
    interpolation: { escapeValue: false },
  })
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && saved !== i18n.language) {
      i18n.changeLanguage(saved)
    }
    setReady(true)
  }, [])

  if (!ready) return null

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}

export function useLangToggle() {
  const toggle = () => {
    const next = i18n.language === 'zh-TW' ? 'en' : 'zh-TW'
    i18n.changeLanguage(next)
    localStorage.setItem(STORAGE_KEY, next)
  }
  return toggle
}

export { i18n }
