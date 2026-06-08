'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslation } from 'react-i18next'

const navItems = [
  {
    key: 'dashboard',
    href: '/dashboard',
    icon: (
      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    key: 'students',
    href: '/students',
    icon: (
      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    key: 'schools',
    href: '/schools',
    icon: (
      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    key: 'selector',
    href: '/selector',
    icon: (
      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
  {
    key: 'ai',
    href: '/ai',
    icon: (
      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
        <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73A2 2 0 0 1 10 4a2 2 0 0 1 2-2z" />
        <circle cx="8.5" cy="13.5" r="1.5" />
        <circle cx="15.5" cy="13.5" r="1.5" />
      </svg>
    ),
  },
] as const

export function Sidebar() {
  const pathname = usePathname()
  const { t } = useTranslation()

  return (
    <aside
      className="w-52 min-h-screen flex flex-col shrink-0"
      style={{ background: 'var(--sidebar-bg)' }}
    >
      <div className="px-4 py-5" style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}>
        <div className="text-sm font-semibold leading-tight" style={{ color: '#e8ecf4' }}>
          天星顧問
        </div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--sidebar-text-muted)' }}>
          教育 ERP 系統
        </div>
      </div>

      <nav className="flex-1 px-2.5 py-3 space-y-0.5">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href)
          return (
            <Link
              key={item.key}
              href={item.href}
              className="flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-colors"
              style={{
                background: active ? 'var(--sidebar-active)' : 'transparent',
                color: active ? '#ffffff' : 'var(--sidebar-text)',
              }}
              onMouseEnter={(e) => {
                if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--sidebar-hover)'
              }}
              onMouseLeave={(e) => {
                if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'
              }}
            >
              <span className="opacity-90">{item.icon}</span>
              <span>{t(`nav.${item.key}`)}</span>
            </Link>
          )
        })}
      </nav>

      <div
        className="px-4 py-3 text-xs"
        style={{ borderTop: '1px solid rgba(255,255,255,.07)', color: 'var(--sidebar-text-muted)' }}
      >
        v0.1 · Mock Mode
      </div>
    </aside>
  )
}
