'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TicketModal } from '@/components/crawler/TicketModal'
import { crawlerApi } from '@/modules/schools/client'
import type { AdmissionRecord } from '@/types'

const ALL = 'all'

function uniqueOptions(schools: AdmissionRecord[], key: keyof AdmissionRecord) {
  return Array.from(new Set(schools.map((school) => String(school[key] || '').trim()).filter(Boolean))).sort()
}

function containsDormitory(value?: string) {
  const normalized = (value || '').toLowerCase()
  return Boolean(value && !normalized.includes('not provided') && !normalized.includes('沒有') && !normalized.includes('不適用'))
}

export default function SelectorPage() {
  const { t } = useTranslation()
  const [schools, setSchools] = useState<AdmissionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ticketSchool, setTicketSchool] = useState<AdmissionRecord | null>(null)
  const [search, setSearch] = useState('')
  const [district, setDistrict] = useState(ALL)
  const [schoolLevel, setSchoolLevel] = useState(ALL)
  const [schoolType, setSchoolType] = useState(ALL)
  const [financeType, setFinanceType] = useState(ALL)
  const [admissionType, setAdmissionType] = useState(ALL)
  const [confidence, setConfidence] = useState(ALL)
  const [reviewStatus, setReviewStatus] = useState(ALL)
  const [dormitory, setDormitory] = useState(ALL)
  const [showReport, setShowReport] = useState(false)

  useEffect(() => {
    crawlerApi
      .schools()
      .then(setSchools)
      .catch((err) => setError(err instanceof Error ? err.message : '載入學校資料失敗'))
      .finally(() => setLoading(false))
  }, [])

  const options = useMemo(
    () => ({
      districts: uniqueOptions(schools, 'district'),
      schoolLevels: uniqueOptions(schools, 'school_level'),
      schoolTypes: uniqueOptions(schools, 'school_type'),
      financeTypes: uniqueOptions(schools, 'finance_type'),
    }),
    [schools],
  )

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return schools.filter((school) => {
      if (term && !`${school.school_name_zh} ${school.school_name_en} ${school.district}`.toLowerCase().includes(term)) return false
      if (district !== ALL && school.district !== district) return false
      if (schoolLevel !== ALL && school.school_level !== schoolLevel) return false
      if (schoolType !== ALL && school.school_type !== schoolType) return false
      if (financeType !== ALL && school.finance_type !== financeType) return false
      if (admissionType !== ALL && school.admission_type !== admissionType) return false
      if (confidence !== ALL && school.confidence !== confidence) return false
      if (reviewStatus !== ALL && school.review_status !== reviewStatus) return false
      if (dormitory === 'yes' && !containsDormitory(school.dormitory_info)) return false
      if (dormitory === 'no' && containsDormitory(school.dormitory_info)) return false
      return true
    })
  }, [admissionType, confidence, district, dormitory, financeType, reviewStatus, schoolLevel, schoolType, schools, search])

  async function submitTicket(input: { field: string; description: string; reporter: string }) {
    if (!ticketSchool) return
    await crawlerApi.createTicket({
      school_key: ticketSchool.school_key,
      school_name_zh: ticketSchool.school_name_zh,
      ...input,
    })
  }

  if (loading) return <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('common.loading')}</div>
  if (error) return <div className="text-sm" style={{ color: '#dc2626' }}>{error}</div>

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-[280px_1fr] gap-5">
        <div className="p-4 space-y-4 h-fit rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('selector.filters')}</h2>
          <FilterInput label={t('common.search')} value={search} onChange={setSearch} />
          <FilterSelect label="地區" value={district} onChange={setDistrict} options={options.districts} />
          <FilterSelect label="學校層次" value={schoolLevel} onChange={setSchoolLevel} options={options.schoolLevels} />
          <FilterSelect label="學校類型" value={schoolType} onChange={setSchoolType} options={options.schoolTypes} />
          <FilterSelect label="資助類型" value={financeType} onChange={setFinanceType} options={options.financeTypes} />
          <FilterSelect label={t('selector.admission_type')} value={admissionType} onChange={setAdmissionType} options={[{ value: 'transfer', label: t('schools.type_transfer') }, { value: 's1_admission', label: t('schools.type_s1') }, { value: 'unknown', label: t('schools.type_unknown') }]} />
          <FilterSelect label={t('selector.confidence')} value={confidence} onChange={setConfidence} options={[{ value: 'high', label: t('schools.confidence_high') }, { value: 'medium', label: t('schools.confidence_medium') }, { value: 'low', label: t('schools.confidence_low') }, { value: 'missing', label: 'Missing' }]} />
          <FilterSelect label="審核狀態" value={reviewStatus} onChange={setReviewStatus} options={[{ value: 'auto_selected', label: '自動通過' }, { value: 'needs_review', label: t('schools.status_needs_review') }, { value: 'approved', label: t('schools.status_approved') }, { value: 'rejected', label: t('schools.status_rejected') }]} />
          <FilterSelect label="宿舍" value={dormitory} onChange={setDormitory} options={[{ value: 'yes', label: '有資料' }, { value: 'no', label: '無資料' }]} />
        </div>

        <div className="space-y-3 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {filtered.length} / {schools.length} 間學校
            </span>
            <button onClick={() => setShowReport(true)} disabled={filtered.length === 0} className="text-sm px-4 py-1.5 rounded-md font-medium disabled:opacity-40" style={{ background: 'var(--accent)', color: '#fff' }}>
              {t('selector.generate_pdf')}
            </button>
          </div>
          {filtered.length === 0 ? (
            <div className="p-10 text-center text-sm rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>{t('selector.no_results')}</div>
          ) : (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-2">
              {filtered.map((school) => <SchoolCard key={school.school_key} school={school} onTicket={() => setTicketSchool(school)} />)}
            </div>
          )}
        </div>
      </div>
      {ticketSchool && <TicketModal school={ticketSchool} onClose={() => setTicketSchool(null)} onSubmit={submitTicket} />}
      {showReport && <ReportModal schools={filtered} onClose={() => setShowReport(false)} />}
    </div>
  )
}

function FilterInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
      {label}
      <input className="mt-1 w-full" type="search" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<string | { value: string; label: string }> }) {
  return (
    <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
      {label}
      <select className="mt-1 w-full" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={ALL}>全部</option>
        {options.map((option) => {
          const value = typeof option === 'string' ? option : option.value
          const label = typeof option === 'string' ? option : option.label
          return <option key={value} value={value}>{label}</option>
        })}
      </select>
    </label>
  )
}

function SchoolCard({ school, onTicket }: { school: AdmissionRecord; onTicket: () => void }) {
  const confStyle = school.confidence === 'high' ? '#15803d' : school.confidence === 'medium' ? '#b45309' : '#dc2626'
  return (
    <div className="p-3.5 rounded-lg space-y-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{school.school_name_zh}</div>
          <div className="text-xs mt-0.5 break-words" style={{ color: 'var(--text-muted)' }}>{school.school_name_en}</div>
        </div>
        <span className="text-xs font-bold shrink-0" style={{ color: confStyle }}>{school.confidence.toUpperCase()}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
        <Meta label="地區" value={school.district} />
        <Meta label="層次" value={school.school_level} />
        <Meta label="類型" value={school.school_type} />
        <Meta label="資助" value={school.finance_type} />
        <Meta label="申請" value={school.application_dates || school.application_period || school.submission_deadline} />
        <Meta label="審核" value={school.review_status} />
      </div>
      <div className="text-xs line-clamp-2" style={{ color: 'var(--text-muted)' }}>學費：{school.tuition_info || '未列明'}</div>
      <div className="text-xs line-clamp-2" style={{ color: 'var(--text-muted)' }}>宿舍：{school.dormitory_info || '未列明'}</div>
      <div className="flex items-center justify-between gap-3">
        <a href={school.final_admission_url || school.website} target="_blank" rel="noopener noreferrer" className="text-xs break-all" style={{ color: 'var(--accent)' }}>招生/學校頁面</a>
        <button onClick={onTicket} className="text-xs px-2.5 py-1 rounded-md shrink-0" style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>報錯</button>
      </div>
    </div>
  )
}

function Meta({ label, value }: { label: string; value?: string }) {
  return <div><span style={{ color: 'var(--text-muted)' }}>{label}：</span>{value || '—'}</div>
}

function ReportModal({ schools, onClose }: { schools: AdmissionRecord[]; onClose: () => void }) {
  const today = new Date().toLocaleDateString('zh-TW')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.45)' }}>
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between p-4 print:hidden" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>選校報告</span>
          <div className="flex gap-2">
            <button onClick={() => window.print()} className="text-sm px-3 py-1.5 rounded-md font-medium" style={{ background: 'var(--accent)', color: '#fff' }}>列印 / PDF</button>
            <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-md" style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>關閉</button>
          </div>
        </div>
        <div id="print-area" className="overflow-auto p-8 flex-1">
          <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>天星顧問 — 選校報告</h1>
          <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>生成日期：{today}</p>
          <table className="w-full text-sm border-collapse">
            <thead><tr style={{ borderBottom: '2px solid var(--border)' }}>{['#', '學校', '地區', '類型', '申請日期'].map((h) => <th key={h} className="text-left py-2 pr-4 font-semibold">{h}</th>)}</tr></thead>
            <tbody>{schools.map((school, index) => <tr key={school.school_key} style={{ borderBottom: '1px solid var(--border-subtle)' }}><td className="py-2 pr-4">{index + 1}</td><td className="py-2 pr-4 font-medium">{school.school_name_zh}</td><td className="py-2 pr-4">{school.district}</td><td className="py-2 pr-4">{school.school_type || school.admission_type}</td><td className="py-2">{school.application_dates || '—'}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
      <style>{`@media print { body > * { display: none !important; } #print-area { display: block !important; position: fixed; inset: 0; background: white; padding: 2cm; } @page { size: A4; margin: 2cm; } }`}</style>
    </div>
  )
}
