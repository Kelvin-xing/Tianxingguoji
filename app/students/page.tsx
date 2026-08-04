'use client'

import { useTranslation } from 'react-i18next'
import { mockStudents } from '@/lib/mock/students'
import type { Student } from '@/types'
import Link from 'next/link'
import { useState } from 'react'
import { Icon } from '@/components/workspace/Icon'

const STATUS_STYLES: Record<Student['status'], { bg: string; color: string }> = {
  collecting: { bg: '#f3f4f6', color: '#374151' },
  applying:   { bg: '#eff6ff', color: '#1d4ed8' },
  interview:  { bg: '#fffbeb', color: '#b45309' },
  admitted:   { bg: '#f0fdf4', color: '#15803d' },
  rejected:   { bg: '#fef2f2', color: '#dc2626' },
}

export default function StudentsPage() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')

  const filtered = mockStudents.filter(
    (s) =>
      s.name_zh.includes(search) ||
      s.name_en.toLowerCase().includes(search.toLowerCase()) ||
      s.consultant.includes(search),
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
            style={{ color: 'var(--text-muted)' }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder={`${t('common.search')}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 w-56"
            style={{ paddingLeft: '2rem' }}
          />
        </div>
        <Link href="/cases/new" className="primary-button"><Icon name="plus" size={15} />建立案件</Link>
      </div>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {filtered.length} 位學生
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
                t('students.name'),
                t('students.grade'),
                t('students.status'),
                '目標院校',
                '計劃入學',
                t('students.consultant'),
                t('students.deadline'),
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
            {filtered.map((s) => (
              <tr
                key={s.id}
                className="transition-colors"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = 'var(--bg)')
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = 'transparent')
                }
              >
                <td className="px-4 py-3">
                  <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {s.name_zh}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {s.name_en}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {s.current_grade} → {s.target_grade}
                </td>
                <td className="px-4 py-3">
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full"
                    style={STATUS_STYLES[s.status]}
                  >
                    {t(`students.status_${s.status}`)}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {s.application_assessment.target_institutions || '—'}
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {s.application_assessment.planned_enrollment_time || '—'}
                </td>
                <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {s.consultant}
                </td>
                <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {s.deadline}
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/students/${s.id}`}
                    className="text-xs font-medium transition-colors"
                    style={{ color: 'var(--accent)' }}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.color = 'var(--accent-hover)')
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.color = 'var(--accent)')
                    }
                  >
                    {t('students.view')} →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
