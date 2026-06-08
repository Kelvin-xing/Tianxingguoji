'use client'

import { useTranslation } from 'react-i18next'
import { mockStudents } from '@/lib/mock/students'
import type { Student } from '@/types'
import Link from 'next/link'
import { useState } from 'react'

const STATUS_STYLES: Record<Student['status'], string> = {
  collecting: 'bg-gray-100 text-gray-700',
  applying: 'bg-blue-100 text-blue-700',
  interview: 'bg-yellow-100 text-yellow-700',
  admitted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
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
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder={`${t('common.search')}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-500">{filtered.length} 位學生</span>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-5 py-3 font-medium text-gray-600">
                {t('students.name')}
              </th>
              <th className="text-left px-5 py-3 font-medium text-gray-600">
                {t('students.grade')}
              </th>
              <th className="text-left px-5 py-3 font-medium text-gray-600">
                {t('students.status')}
              </th>
              <th className="text-left px-5 py-3 font-medium text-gray-600">
                {t('students.consultant')}
              </th>
              <th className="text-left px-5 py-3 font-medium text-gray-600">
                {t('students.deadline')}
              </th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-5 py-3.5">
                  <div className="font-medium text-gray-900">{s.name_zh}</div>
                  <div className="text-gray-400 text-xs">{s.name_en}</div>
                </td>
                <td className="px-5 py-3.5 text-gray-700">
                  {s.current_grade} → {s.target_grade}
                </td>
                <td className="px-5 py-3.5">
                  <span
                    className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_STYLES[s.status]}`}
                  >
                    {t(`students.status_${s.status}`)}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-gray-700">{s.consultant}</td>
                <td className="px-5 py-3.5 text-gray-700">{s.deadline}</td>
                <td className="px-5 py-3.5">
                  <Link
                    href={`/students/${s.id}`}
                    className="text-blue-600 hover:text-blue-800 font-medium"
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
