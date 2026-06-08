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
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Filter panel */}
        <div className="lg:col-span-1 bg-white rounded-xl border border-gray-200 p-5 space-y-5 h-fit">
          <h2 className="font-semibold text-gray-800">{t('selector.filters')}</h2>

          <div>
            <label className="text-xs text-gray-500 block mb-2">{t('selector.district')}</label>
            <div className="flex flex-wrap gap-1.5">
              {DISTRICTS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDistrict(d)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    district === d
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'text-gray-600 border-gray-300 hover:border-blue-400'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-500 block mb-2">{t('selector.admission_type')}</label>
            {[
              { value: 'all', label: t('selector.all') },
              { value: 'transfer', label: t('schools.type_transfer') },
              { value: 's1_admission', label: t('schools.type_s1') },
            ].map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700 mb-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="type"
                  value={opt.value}
                  checked={admissionType === opt.value}
                  onChange={() => setAdmissionType(opt.value)}
                  className="accent-blue-600"
                />
                {opt.label}
              </label>
            ))}
          </div>

          <div>
            <label className="text-xs text-gray-500 block mb-2">{t('selector.confidence')}</label>
            {[
              { value: 'all', label: t('selector.all') },
              { value: 'high', label: t('schools.confidence_high') },
              { value: 'medium', label: t('schools.confidence_medium') },
              { value: 'low', label: t('schools.confidence_low') },
            ].map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700 mb-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="conf"
                  value={opt.value}
                  checked={confidence === opt.value}
                  onChange={() => setConfidence(opt.value)}
                  className="accent-blue-600"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">
              {t('selector.match_count', { count: filtered.length })}
            </span>
            <button
              onClick={() => setShowReport(true)}
              disabled={filtered.length === 0}
              className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              📄 {t('selector.generate_pdf')}
            </button>
          </div>

          {filtered.length === 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400 text-sm">
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

      {/* PDF Modal */}
      {showReport && (
        <ReportModal schools={filtered} onClose={() => setShowReport(false)} />
      )}
    </div>
  )
}

function SchoolCard({ school }: { school: AdmissionRecord }) {
  const confidenceColor =
    school.confidence === 'high'
      ? 'text-green-600'
      : school.confidence === 'medium'
        ? 'text-yellow-600'
        : 'text-red-500'

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-start justify-between">
      <div className="space-y-1">
        <div className="font-medium text-gray-900">{school.school_name_zh}</div>
        <div className="text-xs text-gray-400">{school.school_name_en} · {school.district}</div>
        <div className="text-xs text-gray-500">{school.application_dates}</div>
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <span className={`text-xs font-bold ${confidenceColor}`}>
          {school.confidence.toUpperCase()}
        </span>
        <a
          href={school.final_admission_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >
          招生頁面 →
        </a>
      </div>
    </div>
  )
}

function ReportModal({
  schools,
  onClose,
}: {
  schools: AdmissionRecord[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const today = new Date().toLocaleDateString('zh-TW')

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 print:hidden">
          <span className="font-semibold text-gray-800">{t('selector.report_title')}</span>
          <div className="flex gap-2">
            <button
              onClick={() => window.print()}
              className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-blue-700"
            >
              {t('common.print')} / PDF
            </button>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700 text-sm px-3 py-1.5 border border-gray-300 rounded-lg"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
        <div id="print-area" className="overflow-auto p-8 flex-1">
          <h1 className="text-xl font-bold text-gray-900 mb-1">天星顧問 — {t('selector.report_title')}</h1>
          <p className="text-sm text-gray-400 mb-6">
            {t('selector.generated_on')}：{today}
          </p>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-300">
                <th className="text-left py-2 pr-4 font-semibold">#</th>
                <th className="text-left py-2 pr-4 font-semibold">{t('schools.school_name')}</th>
                <th className="text-left py-2 pr-4 font-semibold">{t('schools.district')}</th>
                <th className="text-left py-2 pr-4 font-semibold">{t('schools.admission_type')}</th>
                <th className="text-left py-2 font-semibold">{t('schools.application_dates')}</th>
              </tr>
            </thead>
            <tbody>
              {schools.map((s, i) => (
                <tr key={s.school_key} className="border-b border-gray-100">
                  <td className="py-2 pr-4 text-gray-400">{i + 1}</td>
                  <td className="py-2 pr-4 font-medium">{s.school_name_zh}</td>
                  <td className="py-2 pr-4 text-gray-600">{s.district}</td>
                  <td className="py-2 pr-4 text-gray-600">
                    {s.admission_type === 'transfer' ? '插班/轉校' : 'S1 統一派位'}
                  </td>
                  <td className="py-2 text-gray-600">{s.application_dates}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-400 mt-8">
            本報告由天星顧問 ERP 系統自動生成，數據來源：香港教育局及各校官方網站。
          </p>
        </div>
      </div>

      {/* Print-only full-page styles */}
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
