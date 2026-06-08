'use client'

import { use } from 'react'
import { useTranslation } from 'react-i18next'
import { mockStudents } from '@/lib/mock/students'
import { mockSchools } from '@/lib/mock/schools'
import type { Student } from '@/types'
import Link from 'next/link'
import { notFound } from 'next/navigation'

const STATUS_STYLES: Record<Student['status'], string> = {
  collecting: 'bg-gray-100 text-gray-700',
  applying: 'bg-blue-100 text-blue-700',
  interview: 'bg-yellow-100 text-yellow-700',
  admitted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

const STATUS_FLOW: Student['status'][] = [
  'collecting',
  'applying',
  'interview',
  'admitted',
]

export default function StudentProfilePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const { t } = useTranslation()

  const student = mockStudents.find((s) => s.id === id)
  if (!student) notFound()

  const targetSchoolData = student.target_schools
    .map((key) => mockSchools.find((s) => s.school_key === key))
    .filter(Boolean)

  const currentStatusIdx = STATUS_FLOW.indexOf(student.status as Student['status'])

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link href="/students" className="hover:text-blue-600">
          {t('nav.students')}
        </Link>
        <span>/</span>
        <span className="text-gray-800">{student.name_zh}</span>
      </div>

      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">{student.name_zh}</h2>
          <div className="text-gray-400 text-sm mt-0.5">{student.name_en} · {student.id}</div>
          <div className="mt-2 flex gap-2 flex-wrap">
            <span className="text-xs bg-slate-100 text-slate-700 px-2.5 py-1 rounded-full">
              {student.current_grade} → {student.target_grade}
            </span>
            <span className="text-xs bg-purple-100 text-purple-700 px-2.5 py-1 rounded-full">
              {student.consultant}
            </span>
          </div>
        </div>
        <span className={`text-sm font-medium px-3 py-1.5 rounded-full ${STATUS_STYLES[student.status]}`}>
          {t(`students.status_${student.status}`)}
        </span>
      </div>

      {/* Progress flow */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">申請進度</h3>
        <div className="flex gap-0">
          {STATUS_FLOW.map((step, i) => {
            const past = i < currentStatusIdx
            const active = i === currentStatusIdx
            return (
              <div key={step} className="flex-1 flex items-center">
                <div className="flex flex-col items-center flex-1">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                      active
                        ? 'bg-blue-600 text-white'
                        : past
                          ? 'bg-green-500 text-white'
                          : 'bg-gray-200 text-gray-400'
                    }`}
                  >
                    {past ? '✓' : i + 1}
                  </div>
                  <div className="text-xs mt-1.5 text-gray-600">{t(`students.status_${step}`)}</div>
                </div>
                {i < STATUS_FLOW.length - 1 && (
                  <div className={`h-0.5 flex-1 -mt-5 ${i < currentStatusIdx ? 'bg-green-400' : 'bg-gray-200'}`} />
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Documents */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">{t('students.documents')}</h3>
          <ul className="space-y-2">
            {student.documents.map((doc) => (
              <li key={doc.name} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">{doc.name}</span>
                <span className={`text-xs font-medium ${doc.uploaded ? 'text-green-600' : 'text-red-500'}`}>
                  {doc.uploaded ? `✓ ${t('students.uploaded')}` : `✗ ${t('students.not_uploaded')}`}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Notes */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">{t('students.notes')}</h3>
          <p className="text-sm text-gray-700 leading-relaxed">{student.notes}</p>
          <div className="mt-3 text-xs text-gray-400">
            更新：{new Date(student.updated_at).toLocaleDateString('zh-TW')}
          </div>
        </div>
      </div>

      {/* Target schools */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">{t('students.target_schools')}</h3>
        <div className="space-y-3">
          {targetSchoolData.map((school) => {
            if (!school) return null
            return (
              <div key={school.school_key} className="flex items-center justify-between text-sm border border-gray-100 rounded-lg p-3">
                <div>
                  <div className="font-medium text-gray-800">{school.school_name_zh}</div>
                  <div className="text-gray-400 text-xs">{school.application_dates}</div>
                </div>
                <a
                  href={school.final_admission_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline text-xs"
                >
                  招生頁面 →
                </a>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
