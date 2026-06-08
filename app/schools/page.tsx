'use client'

import { useTranslation } from 'react-i18next'
import { mockSchools } from '@/lib/mock/schools'
import type { AdmissionRecord } from '@/types'
import { useState } from 'react'

const CONFIDENCE_STYLES: Record<AdmissionRecord['confidence'], string> = {
  high: 'bg-green-100 text-green-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-red-100 text-red-700',
}

const REVIEW_STYLES: Record<AdmissionRecord['review_status'], string> = {
  approved: 'bg-green-100 text-green-700',
  needs_review: 'bg-amber-100 text-amber-700',
  rejected: 'bg-red-100 text-red-700',
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
    if (search && !s.school_name_zh.includes(search) && !s.school_name_en.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 bg-white rounded-xl border border-gray-200 p-4">
        <input
          type="text"
          placeholder={`${t('common.search')}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
        <span className="text-sm text-gray-500 self-center ml-auto">{filtered.length} 所</span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-5 py-3 font-medium text-gray-600">{t('schools.school_name')}</th>
              <th className="text-left px-5 py-3 font-medium text-gray-600">{t('schools.admission_type')}</th>
              <th className="text-left px-5 py-3 font-medium text-gray-600">{t('schools.confidence')}</th>
              <th className="text-left px-5 py-3 font-medium text-gray-600">{t('schools.review_status')}</th>
              <th className="text-left px-5 py-3 font-medium text-gray-600">{t('schools.application_dates')}</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((school) => (
              <>
                <tr
                  key={school.school_key}
                  className="hover:bg-gray-50 transition-colors cursor-pointer"
                  onClick={() => setExpanded(expanded === school.school_key ? null : school.school_key)}
                >
                  <td className="px-5 py-3.5">
                    <div className="font-medium text-gray-900">{school.school_name_zh}</div>
                    <div className="text-gray-400 text-xs">{school.district}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full">
                      {t(`schools.type_${school.admission_type === 's1_admission' ? 's1' : school.admission_type}`)}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${CONFIDENCE_STYLES[school.confidence]}`}>
                      {t(`schools.confidence_${school.confidence}`)}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${REVIEW_STYLES[school.review_status]}`}>
                      {t(`schools.status_${school.review_status}`)}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-gray-600 text-xs">{school.application_dates}</td>
                  <td className="px-5 py-3.5 text-gray-400 text-xs">
                    {expanded === school.school_key ? '▲' : '▼'}
                  </td>
                </tr>
                {expanded === school.school_key && (
                  <tr key={`${school.school_key}-detail`}>
                    <td colSpan={6} className="px-5 py-4 bg-blue-50 border-b border-blue-100">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                        <div>
                          <div className="text-xs text-gray-500 mb-1">{t('schools.required_materials')}</div>
                          <div className="text-gray-800">{school.required_materials}</div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500 mb-1">{t('schools.admission_url')}</div>
                          <a href={school.final_admission_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all text-xs">
                            {school.final_admission_url}
                          </a>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500 mb-1">{t('schools.notes')}</div>
                          <div className="text-gray-700">{school.notes || '—'}</div>
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
      <span className="text-xs text-gray-500">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
