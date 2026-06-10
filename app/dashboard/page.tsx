'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { mockStudents } from '@/lib/mock/students'
import { crawlerApi } from '@/lib/crawler/client'
import type { CrawlerSummary } from '@/types'

function StatCard({ label, value, accentColor = 'var(--accent)', icon }: { label: string; value: number; accentColor?: string; icon: ReactNode }) {
  return (
    <div className="flex items-center gap-4 p-4 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `3px solid ${accentColor}` }}>
      <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--bg)', color: accentColor }}>{icon}</div>
      <div><div className="text-xl font-bold leading-none" style={{ color: 'var(--text-primary)' }}>{value}</div><div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{label}</div></div>
    </div>
  )
}

export default function DashboardPage() {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<CrawlerSummary | null>(null)

  useEffect(() => {
    crawlerApi.summary().then(setSummary).catch(() => setSummary(null))
  }, [])

  const activeStudents = mockStudents.filter((s) => s.status !== 'admitted' && s.status !== 'rejected').length
  const now = new Date()
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  const pendingDeadlines = mockStudents.filter((s) => { const d = new Date(s.deadline); return d >= now && d <= in30Days }).length
  const upcomingList = mockStudents.filter((s) => new Date(s.deadline) >= now).sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime()).slice(0, 5)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label={t('dashboard.active_students')} value={activeStudents} accentColor="#2563eb" icon={<svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></svg>} />
        <StatCard label={t('dashboard.pending_deadlines')} value={pendingDeadlines} accentColor="#f59e0b" icon={<svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>} />
        <StatCard label={t('dashboard.school_db')} value={summary?.total_records || 0} accentColor="#10b981" icon={<svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>} />
        <StatCard label="待人工驗證" value={summary?.needs_review || 0} accentColor="#8b5cf6" icon={<svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg p-5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>{t('dashboard.upcoming_deadlines')}</h2>
          <div className="space-y-2.5">{upcomingList.map((s) => { const daysLeft = Math.ceil((new Date(s.deadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)); const urgent = daysLeft <= 7; return <div key={s.id} className="flex items-center justify-between text-sm py-1.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}><div className="flex items-center gap-2"><span className="font-medium" style={{ color: 'var(--text-primary)' }}>{s.name_zh}</span><span className="text-xs" style={{ color: 'var(--text-muted)' }}>{s.consultant}</span></div><span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: urgent ? '#fef2f2' : 'var(--accent-subtle)', color: urgent ? '#dc2626' : 'var(--accent)' }}>{daysLeft} {t('dashboard.days_left')}</span></div> })}</div>
        </div>
        <div className="rounded-lg p-5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>{t('dashboard.crawler_status')}</h2>
          <div className="space-y-3 text-sm">
            {[{ label: t('dashboard.crawler_last_run'), value: summary?.published_at || summary?.generated_at || '—', color: 'var(--text-primary)' }, { label: '發布狀態', value: summary?.health || '—', color: summary?.health === 'ok' ? '#16a34a' : '#d97706' }, { label: '高信心資料', value: `${summary?.high_confidence || 0} 所`, color: '#16a34a' }, { label: '待人工驗證', value: `${summary?.needs_review || 0} 所`, color: '#d97706' }].map((row) => <div key={row.label} className="flex justify-between items-center py-1.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}><span style={{ color: 'var(--text-secondary)' }}>{row.label}</span><span className="font-medium" style={{ color: row.color }}>{row.value}</span></div>)}
          </div>
        </div>
      </div>
    </div>
  )
}
