import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Geist } from 'next/font/google'
import './globals.css'
import { I18nProvider } from '@/lib/i18n-provider'
import { AppFrame } from '@/components/layout/AppFrame'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' })

export const metadata: Metadata = {
  title: '天星顧問 ERP',
  description: '香港教育仲介內部管理系統',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-TW" className={`${geist.variable} h-full antialiased`}>
      <body className="h-full">
        <I18nProvider>
          <AppFrame>{children}</AppFrame>
        </I18nProvider>
      </body>
    </html>
  )
}
