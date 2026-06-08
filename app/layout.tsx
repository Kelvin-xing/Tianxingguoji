import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'
import { I18nProvider } from '@/lib/i18n-provider'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' })

export const metadata: Metadata = {
  title: '天星顧問 ERP',
  description: '香港教育仲介內部管理系統',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW" className={`${geist.variable} h-full antialiased`}>
      <body className="h-full">
        <I18nProvider>
          <div className="flex h-full">
            <Sidebar />
            <div className="flex-1 flex flex-col min-w-0 bg-gray-50">
              <TopBar />
              <main className="flex-1 overflow-auto p-6">{children}</main>
            </div>
          </div>
        </I18nProvider>
      </body>
    </html>
  )
}
