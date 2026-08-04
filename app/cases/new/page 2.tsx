'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/workspace/Icon'
import { mockStudents } from '@/lib/mock/students'

const steps = [
  { id: 1, label: '選擇 Student' },
  { id: 2, label: '案件身份' },
  { id: 3, label: 'Assessment manifest' },
  { id: 4, label: '檢查並建立' },
]

export default function NewCasePage() {
  const [step, setStep] = useState(1)
  const [studentId, setStudentId] = useState('')
  const [intakeYear, setIntakeYear] = useState('2026')
  const [admissionType, setAdmissionType] = useState('transfer')
  const [advisor, setAdvisor] = useState('李顧問')
  const [manifest, setManifest] = useState('k12-structural-v1')
  const [error, setError] = useState('')
  const [previewComplete, setPreviewComplete] = useState(false)
  const student = useMemo(() => mockStudents.find((item) => item.id === studentId && item.status !== 'rejected'), [studentId])

  useEffect(() => {
    const preselectedStudent = new URLSearchParams(window.location.search).get('student')
    if (preselectedStudent) setStudentId(preselectedStudent)
  }, [])

  function next() {
    setError('')
    if (step === 1 && !student) return setError('請先選擇一名 active Student。案件不能以自由輸入的姓名建立。')
    if (step === 2 && (!intakeYear || !admissionType || !advisor)) return setError('請完成案件身份和 primary Advisor。')
    if (step === 3 && !manifest) return setError('請選擇 approved manifest。')
    setStep((current) => Math.min(current + 1, 4))
  }

  function back() {
    setError('')
    setStep((current) => Math.max(current - 1, 1))
  }

  function submitPreview() {
    setError('')
    setPreviewComplete(true)
  }

  if (previewComplete) {
    return <PreviewComplete studentName={student?.name_zh || ''} intakeYear={intakeYear} admissionType={admissionType} />
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/cases" className="quiet-link">案件</Link><Icon name="chevron-right" size={14} /><span>建立案件</span></div>
      <section><div className="eyebrow">CaseWorkflow · New ServiceCase</div><h2 className="page-title">建立案件</h2><p className="page-subtitle">從既有 Student 建立一個 K12 ServiceCase，保留 identity 和 case 的邊界。</p></section>

      <div className="preview-notice"><Icon name="shield" size={15} /><span>Preview adapter · 這個 wizard 目前只驗證 UI 與 P0 invariant，尚未建立 Neon authoritative row。</span></div>

      <section className="workspace-section">
        <div className="wizard-steps">{steps.map((item) => { const active = item.id === step; const complete = item.id < step; return <div key={item.id} className={`wizard-step ${active ? 'active' : ''} ${complete ? 'complete' : ''}`}><div className="wizard-number">{complete ? <Icon name="check" size={14} /> : item.id}</div><span>{item.label}</span></div> })}</div>
        <div className="wizard-body">
          {step === 1 && <StudentStep studentId={studentId} onSelect={setStudentId} />}
          {step === 2 && <IdentityStep intakeYear={intakeYear} admissionType={admissionType} advisor={advisor} onIntakeYear={setIntakeYear} onAdmissionType={setAdmissionType} onAdvisor={setAdvisor} />}
          {step === 3 && <ManifestStep manifest={manifest} onChange={setManifest} />}
          {step === 4 && <ReviewStep student={student} intakeYear={intakeYear} admissionType={admissionType} advisor={advisor} manifest={manifest} />}
          {error && <div className="form-error" role="alert"><Icon name="x" size={15} />{error}</div>}
        </div>
        <div className="wizard-footer"><Link href="/cases" className="secondary-button">取消</Link><div className="flex items-center gap-2">{step > 1 && <button type="button" className="secondary-button" onClick={back}>上一步</button>}{step < 4 ? <button type="button" className="primary-button" onClick={next}>下一步<Icon name="arrow-right" size={15} /></button> : <button type="button" className="primary-button" onClick={submitPreview}>建立案件<Icon name="check" size={15} /></button>}</div></div>
      </section>
    </div>
  )
}

function StudentStep({ studentId, onSelect }: { studentId: string; onSelect: (id: string) => void }) {
  return <div className="space-y-5"><div><h3 className="section-title">先選擇既有 Student</h3><p className="section-detail">Student 和 ServiceCase 是兩個獨立 UUID identity。這裡不允許直接輸入新姓名。</p></div><div className="grid grid-cols-1 md:grid-cols-2 gap-3">{mockStudents.filter((item) => item.status !== 'rejected').map((item) => <label key={item.id} className={`selection-card ${studentId === item.id ? 'selected' : ''}`}><input type="radio" name="student" value={item.id} checked={studentId === item.id} onChange={() => onSelect(item.id)} /><span className="selection-mark">{studentId === item.id && <Icon name="check" size={13} />}</span><span className="min-w-0"><strong>{item.name_zh}</strong><small>{item.name_en} · {item.id}</small><small>{item.current_grade} → {item.target_grade} · {item.consultant}</small></span></label>)}</div><Link href="/students" className="quiet-link">找不到 Student？先到學生頁建立 identity <Icon name="arrow-right" size={14} /></Link></div>
}

function IdentityStep({ intakeYear, admissionType, advisor, onIntakeYear, onAdmissionType, onAdvisor }: { intakeYear: string; admissionType: string; advisor: string; onIntakeYear: (value: string) => void; onAdmissionType: (value: string) => void; onAdvisor: (value: string) => void }) {
  return <div className="space-y-5"><div><h3 className="section-title">案件身份</h3><p className="section-detail">這些欄位決定 ServiceCase 的 business identity，建立後不可靜默修改。</p></div><div className="grid grid-cols-1 md:grid-cols-3 gap-4"><Field label="Application type"><div className="locked-field"><Icon name="lock" size={14} />K12</div></Field><Field label="Intake year"><input value={intakeYear} onChange={(event) => onIntakeYear(event.target.value)} inputMode="numeric" /></Field><Field label="Admission type"><select value={admissionType} onChange={(event) => onAdmissionType(event.target.value)}><option value="s1_admission">S1 入學</option><option value="transfer">插班</option></select></Field></div><Field label="Primary Founder / Advisor"><select value={advisor} onChange={(event) => onAdvisor(event.target.value)}><option value="李顧問">李顧問 · Advisor</option><option value="王顧問">王顧問 · Advisor</option></select></Field><div className="inline-callout"><Icon name="shield" size={15} /><span>建立時會由 server 驗證 Student、Advisor 和 organization 的 composite identity；前端選項不是 authorization。</span></div></div>
}

function ManifestStep({ manifest, onChange }: { manifest: string; onChange: (value: string) => void }) {
  return <div className="space-y-5"><div><h3 className="section-title">選擇 approved manifest</h3><p className="section-detail">Assessment form 必須與 approved 的四層 K12 manifest 綁定，不能由頁面自行發明欄位。</p></div><label className={`selection-card selected`}><input type="radio" name="manifest" checked={manifest === 'k12-structural-v1'} onChange={() => onChange('k12-structural-v1')} /><span className="selection-mark"><Icon name="check" size={13} /></span><span><strong>K12 structural v1</strong><small>base · education stage · school system · admission route</small><small className="text-green-700">approved · production catalogue gate pending</small></span></label><label className="selection-card disabled"><input type="radio" disabled /><span className="selection-mark" /><span><strong>Future production catalogue</strong><small>尚未發布 approved manifest</small></span></label><div className="inline-callout warning"><Icon name="clock" size={15} /><span>synthetic manifest 只用於驗證組合與 UI 狀態，不能被靜默 promote 成 production catalogue。</span></div></div>
}

function ReviewStep({ student, intakeYear, admissionType, advisor, manifest }: { student: typeof mockStudents[number] | undefined; intakeYear: string; admissionType: string; advisor: string; manifest: string }) {
  return <div className="space-y-5"><div><h3 className="section-title">檢查並建立</h3><p className="section-detail">送出前確認 case identity。真實 API 會在 transaction 中再次驗證所有條件。</p></div><div className="review-list"><ReviewLine label="Student" value={`${student?.name_zh || '—'} · ${student?.id || '—'}`} /><ReviewLine label="Application type" value="K12" /><ReviewLine label="Intake / admission" value={`${intakeYear} · ${admissionType === 's1_admission' ? 'S1 入學' : '插班'}`} /><ReviewLine label="Primary Advisor" value={`${advisor} · active advisor binding`} /><ReviewLine label="Manifest" value={`${manifest} · approved`} /></div><div className="inline-callout"><Icon name="check-circle" size={15} /><span>UI preflight passed：Student、K12、Advisor、approved manifest 均已選取。</span></div></div>
}

function PreviewComplete({ studentName, intakeYear, admissionType }: { studentName: string; intakeYear: string; admissionType: string }) {
  return <div className="max-w-2xl mx-auto pt-8"><section className="workspace-section text-center"><div className="success-mark"><Icon name="check" size={24} /></div><div className="eyebrow mt-5">Preview command completed</div><h2 className="page-title mt-1">案件建立流程完成</h2><p className="page-subtitle mx-auto">已驗證 {studentName} 的 {intakeYear} {admissionType === 's1_admission' ? 'S1 入學' : '插班'} case payload。</p><div className="preview-result"><div><span>Case number preview</span><strong>HK26-PREVIEW</strong></div><div><span>Write status</span><strong className="text-amber-700">API 尚未接通</strong></div></div><div className="flex justify-center gap-2 mt-6"><Link href="/cases" className="secondary-button">返回案件</Link><Link href="/today" className="primary-button">今日工作<Icon name="arrow-right" size={15} /></Link></div></section></div>
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field-label"><span>{label}</span>{children}</label> }
function ReviewLine({ label, value }: { label: string; value: string }) { return <div className="review-line"><span>{label}</span><strong>{value}</strong></div> }
