'use client'

import i18n from 'i18next'
import { initReactI18next, I18nextProvider } from 'react-i18next'
import { useEffect } from 'react'
import zhTW from '@/i18n/zh-TW.json'
import en from '@/i18n/en.json'

const STORAGE_KEY = 'erp_lang'
const DEFAULT_LANGUAGE = 'zh-TW'

function applyDocumentLanguage(language: string) {
  document.documentElement.lang = language === 'en' ? 'en' : DEFAULT_LANGUAGE
}

function readStoredLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

if (!i18n.isInitialized) {
  i18n.use(initReactI18next).init({
    resources: {
      'zh-TW': { translation: zhTW },
      en: { translation: en },
    },
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    interpolation: { escapeValue: false },
  })
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const saved = readStoredLanguage()
    const language = saved === 'en' ? 'en' : DEFAULT_LANGUAGE
    if (language !== i18n.language) {
      void i18n.changeLanguage(language)
    }
    applyDocumentLanguage(language)
  }, [])

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}

export function useLangToggle() {
  const toggle = () => {
    const next = i18n.language === DEFAULT_LANGUAGE ? 'en' : DEFAULT_LANGUAGE
    void i18n.changeLanguage(next)
    applyDocumentLanguage(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Language switching remains available when browser storage is blocked.
    }
  }
  return toggle
}

export { i18n }
