'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLangToggle } from '@/lib/i18n-provider'
import { Icon } from '@/components/workspace/Icon'

const PAGE_TITLES: Array<{ prefix: string; title: string }> = [
  { prefix: '/today', title: '今日工作' },
  { prefix: '/cases', title: '案件' },
  { prefix: '/students', title: '學生與監護人' },
  { prefix: '/schools', title: '學校資料' },
  { prefix: '/tasks', title: '任務' },
  { prefix: '/documents', title: '文件' },
  { prefix: '/admin/access', title: '身份與權限' },
  { prefix: '/admin/crawler', title: '資料審核' },
  { prefix: '/admin/knowledge', title: '知識庫' },
  { prefix: '/ai', title: 'AI 助理' },
]

export function TopBar() {
  const { t } = useTranslation()
  const toggleLang = useLangToggle()
  const pathname = usePathname()
  const [email, setEmail] = useState('')
  const title = PAGE_TITLES.find((item) => pathname.startsWith(item.prefix))?.title || '天星顧問 ERP'

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return
        const payload = await response.json() as { data?: { email?: string } }
        if (payload.data?.email) setEmail(payload.data.email)
      })
      .catch(() => undefined)
  }, [])

  return (
    <header className="min-h-16 flex items-center justify-between gap-4 px-4 sm:px-6 shrink-0" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{title}</h1>
          <div className="hidden sm:flex items-center gap-1.5 mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>香港組織</span><span>/</span><span>Release 1</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <label className="hidden md:flex items-center gap-2 h-9 w-60 px-3 rounded-md" style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          <Icon name="search" size={15} />
          <input className="bg-transparent border-0 outline-none p-0 text-xs w-full" placeholder="搜尋學生、案件或學校" aria-label="全域搜尋" />
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>⌘K</span>
        </label>
        <button type="button" className="icon-button" title="通知" aria-label="通知"><Icon name="activity" size={17} /></button>
        <button type="button" onClick={toggleLang} className="text-xs px-2.5 h-9 rounded-md" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)', background: 'var(--surface)' }}>{t('common.lang_toggle')}</button>
        <div className="hidden sm:flex items-center justify-center w-9 h-9 rounded-full text-xs font-semibold" title={email || '使用者'} aria-label={email || '使用者'} style={{ background: '#dbeafe', color: '#1d4ed8' }}>{email ? email.slice(0, 2).toUpperCase() : '…'}</div>
      </div>
    </header>
  )
}
