'use client'

import { useTranslation } from 'react-i18next'
import { mockSchools } from '@/lib/mock/schools'
import type { AdmissionRecord } from '@/types'
import { useState } from 'react'

const DISTRICTS = ['全部', '中西區', '油尖旺區', '九龍城區', '觀塘區', '深水埗區', '荃灣區', '葵青區', '沙田區', '元朗區']

export default function SelectorPage() {
  const { t } = useTranslation()
  const [district, setDistrict] = useState('全部')
  const [admissionType, setAdmissionType] = useState('all')
  const [confidence, setConfidence] = useState('all')
  const [showReport, setShowReport] = useState(false)

  const filtered = mockSchools.filter((s) => {
    if (district !== '全部' && s.district !== district) return false
    if (admissionType !== 'all' && s.admission_type !== admissionType) return false
    if (confidence !== 'all' && s.confidence !== confidence) return false
    return true
  })

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        {/* Filter panel */}
        <div
          className="lg:col-span-1 p-4 space-y-5 h-fit rounded-lg"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('selector.filters')}
          </h2>

          <div>
            <label className="text-xs font-medium block mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('selector.district')}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {DISTRICTS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDistrict(d)}
                  className="text-xs px-2 py-0.5 rounded-full border transition-colors"
                  style={{
                    background: district === d ? 'var(--accent)' : 'transparent',
                    color: district === d ? '#fff' : 'var(--text-secondary)',
                    borderColor: district === d ? 'var(--accent)' : 'var(--border)',
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium block mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('selector.admission_type')}
            </label>
            {[
              { value: 'all', label: t('selector.all') },
              { value: 'transfer', label: t('schools.type_transfer') },
              { value: 's1_admission', label: t('schools.type_s1') },
            ].map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 text-sm mb-1.5 cursor-pointer"
                style={{ color: 'var(--text-secondary)' }}
              >
                <input
                  type="radio"
                  name="type"
                  value={opt.value}
                  checked={admissionType === opt.value}
                  onChange={() => setAdmissionType(opt.value)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {opt.label}
              </label>
            ))}
          </div>

          <div>
            <label className="text-xs font-medium block mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('selector.confidence')}
            </label>
            {[
              { value: 'all', label: t('selector.all') },
              { value: 'high', label: t('schools.confidence_high') },
              { value: 'medium', label: t('schools.confidence_medium') },
              { value: 'low', label: t('schools.confidence_low') },
            ].map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 text-sm mb-1.5 cursor-pointer"
                style={{ color: 'var(--text-secondary)' }}
              >
                <input
                  type="radio"
                  name="conf"
                  value={opt.value}
                  checked={confidence === opt.value}
                  onChange={() => setConfidence(opt.value)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {t('selector.match_count', { count: filtered.length })}
            </span>
            <button
              onClick={() => setShowReport(true)}
              disabled={filtered.length === 0}
              className="text-sm px-4 py-1.5 rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              {t('selector.generate_pdf')}
            </button>
          </div>

          {filtered.length === 0 && (
            <div
              className="p-10 text-center text-sm rounded-lg"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                color: 'var(--text-muted)',
              }}
            >
              {t('selector.no_results')}
            </div>
          )}

          <div className="space-y-2">
            {filtered.map((s) => (
              <SchoolCard key={s.school_key} school={s} />
            ))}
          </div>
        </div>
      </div>

      {showReport && <ReportModal schools={filtered} onClose={() => setShowReport(false)} />}
    </div>
  )
}

function SchoolCard({ school }: { school: AdmissionRecord }) {
  const confStyle =
    school.confidence === 'high'
      ? { color: '#15803d' }
      : school.confidence === 'medium'
        ? { color: '#b45309' }
        : { color: '#dc2626' }

  return (
    <div
      className="flex items-start justify-between p-3.5 rounded-lg"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="space-y-0.5">
        <div className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
          {school.school_name_zh}
        </div>
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {school.school_name_en} · {school.district}
        </div>
        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {school.application_dates}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1.5 ml-4 shrink-0">
        <span className="text-xs font-bold" style={confStyle}>
          {school.confidence.toUpperCase()}
        </span>
        <a
          href={school.final_admission_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs"
          style={{ color: 'var(--accent)' }}
        >
          招生頁面 →
        </a>
      </div>
    </div>
  )
}

function ReportModal({ schools, onClose }: { schools: AdmissionRecord[]; onClose: () => void }) {
  const { t } = useTranslation()
  const today = new Date().toLocaleDateString('zh-TW')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.45)' }}>
      <div
        className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-lg"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <div
          className="flex items-center justify-between p-4 print:hidden"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('selector.report_title')}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => window.print()}
              className="text-sm px-3 py-1.5 rounded-md font-medium"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              {t('common.print')} / PDF
            </button>
            <button
              onClick={onClose}
              className="text-sm px-3 py-1.5 rounded-md"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              {t('common.close')}
            </button>
          </div>
        </div>
        <div id="print-area" className="overflow-auto p-8 flex-1">
          <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
            天星顧問 — {t('selector.report_title')}
          </h1>
          <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
            {t('selector.generated_on')}：{today}
          </p>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                {['#', t('schools.school_name'), t('schools.district'), t('schools.admission_type'), t('schools.application_dates')].map((h) => (
                  <th key={h} className="text-left py-2 pr-4 font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schools.map((s, i) => (
                <tr key={s.school_key} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td className="py-2 pr-4" style={{ color: 'var(--text-muted)' }}>{i + 1}</td>
                  <td className="py-2 pr-4 font-medium" style={{ color: 'var(--text-primary)' }}>{s.school_name_zh}</td>
                  <td className="py-2 pr-4" style={{ color: 'var(--text-secondary)' }}>{s.district}</td>
                  <td className="py-2 pr-4" style={{ color: 'var(--text-secondary)' }}>
                    {s.admission_type === 'transfer' ? '插班/轉校' : 'S1 統一派位'}
                  </td>
                  <td className="py-2" style={{ color: 'var(--text-secondary)' }}>{s.application_dates}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs mt-8" style={{ color: 'var(--text-muted)' }}>
            本報告由天星顧問 ERP 系統自動生成，數據來源：香港教育局及各校官方網站。
          </p>
        </div>
      </div>

      <style>{`
        @media print {
          body > * { display: none !important; }
          #print-area { display: block !important; position: fixed; inset: 0; background: white; padding: 2cm; }
          @page { size: A4; margin: 2cm; }
        }
      `}</style>
    </div>
  )
}
