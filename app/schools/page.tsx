'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TicketModal } from '@/components/crawler/TicketModal'
import { crawlerApi } from '@/lib/crawler/client'
import type { AdmissionRecord } from '@/types'

const CONFIDENCE_STYLES: Record<string, { bg: string; color: string }> = {
  high: { bg: '#f0fdf4', color: '#15803d' },
  medium: { bg: '#fffbeb', color: '#b45309' },
  low: { bg: '#fef2f2', color: '#dc2626' },
  missing: { bg: '#f1f5f9', color: '#64748b' },
}

const REVIEW_STYLES: Record<string, { bg: string; color: string }> = {
  auto_selected: { bg: '#eff6ff', color: '#2563eb' },
  approved: { bg: '#f0fdf4', color: '#15803d' },
  needs_review: { bg: '#fffbeb', color: '#b45309' },
  rejected: { bg: '#fef2f2', color: '#dc2626' },
  unknown: { bg: '#f1f5f9', color: '#64748b' },
}

export default function SchoolsPage() {
  const { t } = useTranslation()
  const [schools, setSchools] = useState<AdmissionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [confidenceFilter, setConfidenceFilter] = useState('all')
  const [reviewFilter, setReviewFilter] = useState('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [ticketSchool, setTicketSchool] = useState<AdmissionRecord | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    crawlerApi
      .schools()
      .then(setSchools)
      .catch((err) => setError(err instanceof Error ? err.message : '載入學校資料失敗'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(
    () =>
      schools.filter((school) => {
        const term = search.trim().toLowerCase()
        if (typeFilter !== 'all' && school.admission_type !== typeFilter) return false
        if (confidenceFilter !== 'all' && school.confidence !== confidenceFilter) return false
        if (reviewFilter !== 'all' && school.review_status !== reviewFilter) return false
        if (term && !`${school.school_name_zh} ${school.school_name_en} ${school.district} ${school.school_type}`.toLowerCase().includes(term)) return false
        return true
      }),
    [confidenceFilter, reviewFilter, schools, search, typeFilter],
  )

  async function submitTicket(input: { field: string; description: string; reporter: string }) {
    if (!ticketSchool) return
    await crawlerApi.createTicket({ school_key: ticketSchool.school_key, school_name_zh: ticketSchool.school_name_zh, ...input })
  }

  if (loading) return <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('common.loading')}</div>
  if (error) return <div className="text-sm" style={{ color: '#dc2626' }}>{error}</div>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center p-3 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <input type="text" placeholder={`${t('common.search')}…`} value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" />
        <FilterSelect label={t('schools.admission_type')} value={typeFilter} onChange={setTypeFilter} options={[{ value: 'all', label: t('schools.filter_all') }, { value: 'transfer', label: t('schools.type_transfer') }, { value: 's1_admission', label: t('schools.type_s1') }, { value: 'unknown', label: t('schools.type_unknown') }]} />
        <FilterSelect label={t('schools.confidence')} value={confidenceFilter} onChange={setConfidenceFilter} options={[{ value: 'all', label: t('schools.filter_all') }, { value: 'high', label: t('schools.confidence_high') }, { value: 'medium', label: t('schools.confidence_medium') }, { value: 'low', label: t('schools.confidence_low') }, { value: 'missing', label: 'Missing' }]} />
        <FilterSelect label={t('schools.review_status')} value={reviewFilter} onChange={setReviewFilter} options={[{ value: 'all', label: t('schools.filter_all') }, { value: 'auto_selected', label: '自動通過' }, { value: 'needs_review', label: t('schools.status_needs_review') }, { value: 'approved', label: t('schools.status_approved') }, { value: 'rejected', label: t('schools.status_rejected') }]} />
        <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>{filtered.length} / {schools.length} 所</span>
      </div>

      <div className="overflow-auto" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
        <table className="w-full min-w-[1100px] text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
              {['學校', '地區/類型', '招生', '信心', '審核', '申請日期', '操作'].map((h) => <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.map((school) => (
              <FragmentRow key={school.school_key} school={school} expanded={expanded === school.school_key} onToggle={() => setExpanded(expanded === school.school_key ? null : school.school_key)} onTicket={() => setTicketSchool(school)} />
            ))}
          </tbody>
        </table>
      </div>
      {ticketSchool && <TicketModal school={ticketSchool} onClose={() => setTicketSchool(null)} onSubmit={submitTicket} />}
    </div>
  )
}

function FragmentRow({ school, expanded, onToggle, onTicket }: { school: AdmissionRecord; expanded: boolean; onToggle: () => void; onTicket: () => void }) {
  return (
    <>
      <tr className="transition-colors cursor-pointer" style={{ borderBottom: '1px solid var(--border-subtle)' }} onClick={onToggle}>
        <td className="px-4 py-3"><div className="font-medium" style={{ color: 'var(--text-primary)' }}>{school.school_name_zh}</div><div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{school.school_name_en}</div></td>
        <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{school.district || '—'}<br />{school.school_type || school.finance_type || '—'}</td>
        <td className="px-4 py-3"><span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#f1f5f9', color: '#475569' }}>{school.admission_type}</span></td>
        <td className="px-4 py-3"><Badge value={school.confidence} styles={CONFIDENCE_STYLES} /></td>
        <td className="px-4 py-3"><Badge value={school.review_status} styles={REVIEW_STYLES} /></td>
        <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{school.application_dates || school.submission_deadline || '—'}</td>
        <td className="px-4 py-3 text-xs"><button onClick={(event) => { event.stopPropagation(); onTicket() }} className="px-2 py-1 rounded-md" style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>報錯</button></td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="px-4 py-4" style={{ background: 'var(--accent-subtle)', borderBottom: '1px solid var(--border)' }}>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
              <Detail label="所需文件" value={school.required_materials} />
              <Detail label="學費" value={school.tuition_info} />
              <Detail label="宿舍" value={school.dormitory_info} />
              <div><div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>連結</div><a href={school.final_admission_url || school.website} target="_blank" rel="noopener noreferrer" className="text-xs break-all" style={{ color: 'var(--accent)' }}>{school.final_admission_url || school.website || '—'}</a></div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Badge({ value, styles }: { value: string; styles: Record<string, { bg: string; color: string }> }) {
  const style = styles[value] || styles.unknown || { bg: '#f1f5f9', color: '#64748b' }
  return <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: style.bg, color: style.color }}>{value}</span>
}

function Detail({ label, value }: { label: string; value?: string }) {
  return <div><div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>{label}</div><div style={{ color: 'var(--text-primary)' }}>{value || '—'}</div></div>
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return <div className="flex items-center gap-1.5"><span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}:</span><select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
}
