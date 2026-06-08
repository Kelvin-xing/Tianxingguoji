'use client'

import { useTranslation } from 'react-i18next'
import { mockSchools } from '@/lib/mock/schools'
import type { AdmissionRecord } from '@/types'
import { useState } from 'react'

const CONFIDENCE_STYLES: Record<AdmissionRecord['confidence'], { bg: string; color: string }> = {
  high:   { bg: '#f0fdf4', color: '#15803d' },
  medium: { bg: '#fffbeb', color: '#b45309' },
  low:    { bg: '#fef2f2', color: '#dc2626' },
}

const REVIEW_STYLES: Record<AdmissionRecord['review_status'], { bg: string; color: string }> = {
  approved:     { bg: '#f0fdf4', color: '#15803d' },
  needs_review: { bg: '#fffbeb', color: '#b45309' },
  rejected:     { bg: '#fef2f2', color: '#dc2626' },
}

export default function SchoolsPage() {
  const { t } = useTranslation()
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [confidenceFilter, setConfidenceFilter] = useState<string>('all')
  const [reviewFilter, setReviewFilter] = useState<string>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const filtered = mockSchools.filter((s) => {
    if (typeFilter !== 'all' && s.admission_type !== typeFilter) return false
    if (confidenceFilter !== 'all' && s.confidence !== confidenceFilter) return false
    if (reviewFilter !== 'all' && s.review_status !== reviewFilter) return false
    if (
      search &&
      !s.school_name_zh.includes(search) &&
      !s.school_name_en.toLowerCase().includes(search.toLowerCase())
    )
      return false
    return true
  })

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap gap-3 items-center p-3 rounded-lg"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <input
          type="text"
          placeholder={`${t('common.search')}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-44"
        />
        <FilterSelect
          label={t('schools.admission_type')}
          value={typeFilter}
          onChange={setTypeFilter}
          options={[
            { value: 'all', label: t('schools.filter_all') },
            { value: 'transfer', label: t('schools.type_transfer') },
            { value: 's1_admission', label: t('schools.type_s1') },
            { value: 'unknown', label: t('schools.type_unknown') },
          ]}
        />
        <FilterSelect
          label={t('schools.confidence')}
          value={confidenceFilter}
          onChange={setConfidenceFilter}
          options={[
            { value: 'all', label: t('schools.filter_all') },
            { value: 'high', label: t('schools.confidence_high') },
            { value: 'medium', label: t('schools.confidence_medium') },
            { value: 'low', label: t('schools.confidence_low') },
          ]}
        />
        <FilterSelect
          label={t('schools.review_status')}
          value={reviewFilter}
          onChange={setReviewFilter}
          options={[
            { value: 'all', label: t('schools.filter_all') },
            { value: 'approved', label: t('schools.status_approved') },
            { value: 'needs_review', label: t('schools.status_needs_review') },
            { value: 'rejected', label: t('schools.status_rejected') },
          ]}
        />
        <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
          {filtered.length} 所
        </span>
      </div>

      <div
        className="overflow-hidden"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
        }}
      >
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
              {[
                t('schools.school_name'),
                t('schools.admission_type'),
                t('schools.confidence'),
                t('schools.review_status'),
                t('schools.application_dates'),
                '',
              ].map((h, i) => (
                <th
                  key={i}
                  className="text-left px-4 py-2.5 text-xs font-semibold"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((school) => (
              <>
                <tr
                  key={school.school_key}
                  className="transition-colors cursor-pointer"
                  style={{ borderBottom: '1px solid var(--border-subtle)' }}
                  onClick={() =>
                    setExpanded(expanded === school.school_key ? null : school.school_key)
                  }
                  onMouseEnter={(e) => {
                    if (expanded !== school.school_key)
                      (e.currentTarget as HTMLElement).style.background = 'var(--bg)'
                  }}
                  onMouseLeave={(e) => {
                    if (expanded !== school.school_key)
                      (e.currentTarget as HTMLElement).style.background = 'transparent'
                  }}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {school.school_name_zh}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {school.district}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{ background: '#f1f5f9', color: '#475569' }}
                    >
                      {t(
                        `schools.type_${school.admission_type === 's1_admission' ? 's1' : school.admission_type}`,
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="text-xs font-medium px-2 py-0.5 rounded-full"
                      style={CONFIDENCE_STYLES[school.confidence]}
                    >
                      {t(`schools.confidence_${school.confidence}`)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="text-xs font-medium px-2 py-0.5 rounded-full"
                      style={REVIEW_STYLES[school.review_status]}
                    >
                      {t(`schools.status_${school.review_status}`)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {school.application_dates}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {expanded === school.school_key ? '▲' : '▼'}
                  </td>
                </tr>
                {expanded === school.school_key && (
                  <tr key={`${school.school_key}-detail`}>
                    <td
                      colSpan={6}
                      className="px-4 py-4"
                      style={{
                        background: 'var(--accent-subtle)',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                        <div>
                          <div
                            className="text-xs font-semibold mb-1"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {t('schools.required_materials')}
                          </div>
                          <div style={{ color: 'var(--text-primary)' }}>
                            {school.required_materials}
                          </div>
                        </div>
                        <div>
                          <div
                            className="text-xs font-semibold mb-1"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {t('schools.admission_url')}
                          </div>
                          <a
                            href={school.final_admission_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs break-all"
                            style={{ color: 'var(--accent)' }}
                          >
                            {school.final_admission_url}
                          </a>
                        </div>
                        <div>
                          <div
                            className="text-xs font-semibold mb-1"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {t('schools.notes')}
                          </div>
                          <div style={{ color: 'var(--text-secondary)' }}>
                            {school.notes || '—'}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {label}:
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
