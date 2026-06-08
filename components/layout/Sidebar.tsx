'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslation } from 'react-i18next'

const navItems = [
  { key: 'dashboard', href: '/dashboard', icon: '📊' },
  { key: 'students', href: '/students', icon: '🎓' },
  { key: 'schools', href: '/schools', icon: '🏫' },
  { key: 'selector', href: '/selector', icon: '📋' },
  { key: 'ai', href: '/ai', icon: '🤖' },
] as const

export function Sidebar() {
  const pathname = usePathname()
  const { t } = useTranslation()

  return (
    <aside className="w-56 min-h-screen bg-slate-900 text-white flex flex-col shrink-0">
      <div className="px-5 py-6 border-b border-slate-700">
        <div className="text-lg font-bold leading-tight">天星顧問</div>
        <div className="text-xs text-slate-400 mt-0.5">教育 ERP 系統</div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href)
          return (
            <Link
              key={item.key}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                active
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              <span>{t(`nav.${item.key}`)}</span>
            </Link>
          )
        })}
      </nav>

      <div className="px-5 py-4 border-t border-slate-700 text-xs text-slate-500">
        v0.1 · Mock Mode
      </div>
    </aside>
  )
}
