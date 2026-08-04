'use client'

import { use } from 'react'
import { useTranslation } from 'react-i18next'
import { mockStudents } from '@/lib/mock/students'
import type { Student, StudyApplicationAssessment } from '@/types'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Icon } from '@/components/workspace/Icon'

const STATUS_STYLES: Record<Student['status'], { bg: string; color: string }> = {
  collecting: { bg: '#f3f4f6', color: '#374151' },
  applying: { bg: '#eff6ff', color: '#1d4ed8' },
  interview: { bg: '#fffbeb', color: '#b45309' },
  admitted: { bg: '#f0fdf4', color: '#15803d' },
  rejected: { bg: '#fef2f2', color: '#dc2626' },
}

const STATUS_FLOW: Student['status'][] = ['collecting', 'applying', 'interview', 'admitted']

const ASSESSMENT_FIELDS: Array<{ key: keyof StudyApplicationAssessment; label: string }> = [
  { key: 'applicant_name', label: '申請人姓名' },
  { key: 'age', label: '年齡' },
  { key: 'highest_education_institution', label: '最高學歷（院校）' },
  { key: 'prior_education', label: '前置學歷' },
  { key: 'major', label: '專業' },
  { key: 'gpa', label: '在校均分（GPA）' },
  { key: 'english_level', label: '英文水平' },
  { key: 'english_test_score', label: '英文標準化考試分數（若有）' },
  { key: 'work_experience', label: '工作經驗' },
  { key: 'industry', label: '所屬行業' },
  { key: 'awards_or_experiences', label: '特別獎項或經歷' },
  { key: 'study_abroad_purpose', label: '留學目的' },
  { key: 'target_institutions', label: '目標院校' },
  { key: 'preferred_major', label: '心儀專業' },
  { key: 'other_requirements', label: '其他需求' },
  { key: 'planned_enrollment_time', label: '計劃入學時間' },
]

export default function StudentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { t } = useTranslation()

  const student = mockStudents.find((s) => s.id === id)
  if (!student) notFound()

  const currentStatusIdx = STATUS_FLOW.indexOf(student.status as Student['status'])

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
        <Link href="/students" style={{ color: 'var(--accent)' }}>{t('nav.students')}</Link>
        <span>/</span>
        <span style={{ color: 'var(--text-secondary)' }}>{student.name_zh}</span>
      </div>

      <div className="p-5 rounded-lg flex items-start justify-between" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{student.name_zh}</h2>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{student.name_en} · {student.id}</div>
          <div className="mt-2.5 flex gap-2 flex-wrap">
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#f1f5f9', color: '#475569' }}>{student.current_grade} → {student.target_grade}</span>
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#f5f3ff', color: '#6d28d9' }}>{student.consultant}</span>
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#ecfeff', color: '#0e7490' }}>{student.application_assessment.planned_enrollment_time}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0"><Link href={`/cases/new?student=${student.id}`} className="secondary-button"><Icon name="plus" size={14} />建立案件</Link><span className="text-xs font-medium px-2.5 py-1 rounded-full" style={STATUS_STYLES[student.status]}>{t(`students.status_${student.status}`)}</span></div>
      </div>

      <div className="p-5 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <h3 className="text-xs font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>申請進度</h3>
        <div className="flex gap-0">
          {STATUS_FLOW.map((step, i) => {
            const past = i < currentStatusIdx
            const active = i === currentStatusIdx
            return (
              <div key={step} className="flex-1 flex items-center">
                <div className="flex flex-col items-center flex-1">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: active ? 'var(--accent)' : past ? '#10b981' : '#e5e7eb', color: active || past ? '#fff' : 'var(--text-muted)' }}>{past ? '✓' : i + 1}</div>
                  <div className="text-xs mt-1.5" style={{ color: 'var(--text-secondary)' }}>{t(`students.status_${step}`)}</div>
                </div>
                {i < STATUS_FLOW.length - 1 && <div className="h-0.5 flex-1 -mt-5" style={{ background: i < currentStatusIdx ? '#10b981' : '#e5e7eb' }} />}
              </div>
            )
          })}
        </div>
      </div>

      <section className="p-5 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>留學申請資料評估</h3>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>16 項必填資料</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {ASSESSMENT_FIELDS.map((field) => (
            <AssessmentField key={field.key} label={field.label} value={student.application_assessment[field.key]} />
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="p-5 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h3 className="text-xs font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>{t('students.documents')}</h3>
          <ul className="space-y-2">
            {student.documents.map((doc) => (
              <li key={doc.name} className="flex items-center justify-between text-sm py-1.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{doc.name}</span>
                <span className="text-xs font-medium" style={{ color: doc.uploaded ? '#15803d' : '#dc2626' }}>{doc.uploaded ? `✓ ${t('students.uploaded')}` : `✗ ${t('students.not_uploaded')}`}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="p-5 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h3 className="text-xs font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>{t('students.notes')}</h3>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{student.notes}</p>
          <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>更新：{new Date(student.updated_at).toLocaleDateString('zh-TW')}</div>
        </div>
      </div>

      <div className="p-5 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <h3 className="text-xs font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>{t('students.target_schools')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {student.application_assessment.target_institutions.split('、').filter(Boolean).map((school) => (
            <div key={school} className="text-sm p-3 rounded-md" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg)', color: 'var(--text-primary)' }}>{school}</div>
          ))}
        </div>
      </div>
    </div>
  )
}

function AssessmentField({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded-md min-h-20" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg)' }}>
      <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-sm leading-relaxed" style={{ color: 'var(--text-primary)' }}>{value || '—'}</div>
    </div>
  )
}
