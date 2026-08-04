'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/workspace/Icon'

const steps = [
  { id: 1, label: '選擇 Student' },
  { id: 2, label: '案件身份' },
  { id: 3, label: 'Assessment manifest' },
  { id: 4, label: '檢查並建立' },
]

interface CaseOptions {
  students: Array<{ id: string; displayName: string }>
  primaryBindings: Array<{ id: string; role: 'founder' | 'advisor'; label: string }>
  manifests: Array<{ id: string; compositionVersion: string; label: string }>
}

interface CreatedCase {
  id: string
  caseNumber: string
  studentId: string
  intakeYear: number
  admissionType: string
  stage: 'signed'
  manifestId: string
}

export default function NewCasePage() {
  const [step, setStep] = useState(1)
  const [studentId, setStudentId] = useState('')
  const [intakeYear, setIntakeYear] = useState('2026')
  const [admissionType, setAdmissionType] = useState('transfer')
  const [primaryRoleBindingId, setPrimaryRoleBindingId] = useState('')
  const [manifestId, setManifestId] = useState('')
  const [options, setOptions] = useState<CaseOptions | null>(null)
  const [optionsError, setOptionsError] = useState('')
  const [error, setError] = useState('')
  const [isLoadingOptions, setIsLoadingOptions] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [createdCase, setCreatedCase] = useState<CreatedCase | null>(null)

  const student = useMemo(
    () => options?.students.find((item) => item.id === studentId),
    [options, studentId],
  )
  const primaryBinding = useMemo(
    () => options?.primaryBindings.find((item) => item.id === primaryRoleBindingId),
    [options, primaryRoleBindingId],
  )
  const manifest = useMemo(
    () => options?.manifests.find((item) => item.id === manifestId),
    [manifestId, options],
  )

  useEffect(() => {
    const preselectedStudent = new URLSearchParams(window.location.search).get('student')
    if (preselectedStudent) setStudentId(preselectedStudent)

    let cancelled = false
    fetch('/api/cases/options', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as {
          data?: { options?: CaseOptions }
          error?: { code?: string }
        }
        if (!response.ok || !payload.data?.options) {
          throw new Error(payload.error?.code || 'OPTIONS_UNAVAILABLE')
        }
        if (!cancelled) {
          setOptions(payload.data.options)
          setPrimaryRoleBindingId(payload.data.options.primaryBindings[0]?.id || '')
          setManifestId(payload.data.options.manifests[0]?.id || '')
        }
      })
      .catch(() => {
        if (!cancelled) setOptionsError('目前無法載入 organization 的 Student、角色或 approved manifest。請重新登入或稍後再試。')
      })
      .finally(() => {
        if (!cancelled) setIsLoadingOptions(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  function next() {
    setError('')
    if (!options) return setError('organization options 尚未載入，不能建立案件。')
    if (step === 1 && !student) return setError('請先選擇一名 active Student。案件不能以自由輸入的姓名建立。')
    if (step === 2 && (!intakeYear || !admissionType || !primaryBinding)) return setError('請完成案件身份和 primary Founder / Advisor。')
    if (step === 3 && !manifest) return setError('目前沒有可用的 approved manifest。')
    setStep((current) => Math.min(current + 1, 4))
  }

  function back() {
    setError('')
    setStep((current) => Math.max(current - 1, 1))
  }

  async function submitCase() {
    setError('')
    if (!student || !primaryBinding || !manifest || !Number.isSafeInteger(Number(intakeYear))) {
      setError('請完成所有必要欄位後再建立案件。')
      return
    }

    setIsSubmitting(true)
    try {
      const response = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          student_id: student.id,
          intake_year: Number(intakeYear),
          admission_type: admissionType,
          primary_role_binding_id: primaryBinding.id,
          manifest_id: manifest.id,
        }),
      })
      const payload = await response.json() as {
        data?: { case?: CreatedCase }
        error?: { code?: string }
      }
      if (!response.ok || !payload.data?.case) {
        throw new Error(payload.error?.code || 'CREATE_FAILED')
      }
      setCreatedCase(payload.data.case)
    } catch (submitError) {
      setError(caseErrorMessage(submitError instanceof Error ? submitError.message : 'CREATE_FAILED'))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (createdCase) {
    return <CreateComplete createdCase={createdCase} studentName={student?.displayName || ''} />
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/cases" className="quiet-link">案件</Link><Icon name="chevron-right" size={14} /><span>建立案件</span></div>
      <section><div className="eyebrow">CaseWorkflow · New ServiceCase</div><h2 className="page-title">建立案件</h2><p className="page-subtitle">從既有 Student 建立一個 K12 ServiceCase，保留 identity 和 case 的邊界。</p></section>

      <div className="preview-notice"><Icon name="shield" size={15} /><span>Neon authoritative command · Student、角色 binding、approved manifest 和 duplicate constraint 會由 server 再次驗證。</span></div>
      {isLoadingOptions && <div className="inline-callout"><Icon name="clock" size={15} /><span>正在載入 organization-scoped options…</span></div>}
      {optionsError && <div className="form-error" role="alert"><Icon name="x" size={15} />{optionsError}</div>}

      <section className="workspace-section">
        <div className="wizard-steps">{steps.map((item) => { const active = item.id === step; const complete = item.id < step; return <div key={item.id} className={`wizard-step ${active ? 'active' : ''} ${complete ? 'complete' : ''}`}><div className="wizard-number">{complete ? <Icon name="check" size={14} /> : item.id}</div><span>{item.label}</span></div> })}</div>
        <div className="wizard-body">
          {step === 1 && <StudentStep students={options?.students || []} studentId={studentId} onSelect={setStudentId} />}
          {step === 2 && <IdentityStep intakeYear={intakeYear} admissionType={admissionType} primaryBindingId={primaryRoleBindingId} primaryBindings={options?.primaryBindings || []} onIntakeYear={setIntakeYear} onAdmissionType={setAdmissionType} onPrimaryBinding={setPrimaryRoleBindingId} />}
          {step === 3 && <ManifestStep manifestId={manifestId} manifests={options?.manifests || []} onChange={setManifestId} />}
          {step === 4 && <ReviewStep student={student} intakeYear={intakeYear} admissionType={admissionType} primaryBinding={primaryBinding} manifest={manifest} />}
          {error && <div className="form-error" role="alert"><Icon name="x" size={15} />{error}</div>}
        </div>
        <div className="wizard-footer"><Link href="/cases" className="secondary-button">取消</Link><div className="flex items-center gap-2">{step > 1 && <button type="button" className="secondary-button" onClick={back}>上一步</button>}{step < 4 ? <button type="button" className="primary-button" onClick={next} disabled={isLoadingOptions || Boolean(optionsError)}>下一步<Icon name="arrow-right" size={15} /></button> : <button type="button" className="primary-button" onClick={submitCase} disabled={isSubmitting || !options}><Icon name={isSubmitting ? 'clock' : 'check'} size={15} />{isSubmitting ? '建立中…' : '建立案件'}</button>}</div></div>
      </section>
    </div>
  )
}

function StudentStep({ students, studentId, onSelect }: { students: CaseOptions['students']; studentId: string; onSelect: (id: string) => void }) {
  return <div className="space-y-5"><div><h3 className="section-title">先選擇既有 Student</h3><p className="section-detail">Student 和 ServiceCase 是兩個獨立 UUID identity。這裡不允許直接輸入新姓名。</p></div>{students.length > 0 ? <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{students.map((item) => <label key={item.id} className={`selection-card ${studentId === item.id ? 'selected' : ''}`}><input type="radio" name="student" value={item.id} checked={studentId === item.id} onChange={() => onSelect(item.id)} /><span className="selection-mark">{studentId === item.id && <Icon name="check" size={13} />}</span><span className="min-w-0"><strong>{item.displayName}</strong><small>{item.id}</small><small>active · organization-scoped Student</small></span></label>)}</div> : <div className="empty-state"><Icon name="users" size={20} /><strong>沒有可用的 active Student</strong><span>請先在 Student 360 建立或啟用 Student identity。</span></div>}<Link href="/students" className="quiet-link">找不到 Student？先到學生頁建立 identity <Icon name="arrow-right" size={14} /></Link></div>
}

function IdentityStep({ intakeYear, admissionType, primaryBindingId, primaryBindings, onIntakeYear, onAdmissionType, onPrimaryBinding }: { intakeYear: string; admissionType: string; primaryBindingId: string; primaryBindings: CaseOptions['primaryBindings']; onIntakeYear: (value: string) => void; onAdmissionType: (value: string) => void; onPrimaryBinding: (value: string) => void }) {
  return <div className="space-y-5"><div><h3 className="section-title">案件身份</h3><p className="section-detail">這些欄位決定 ServiceCase 的 business identity，建立後不可靜默修改。</p></div><div className="grid grid-cols-1 md:grid-cols-3 gap-4"><Field label="Application type"><div className="locked-field"><Icon name="lock" size={14} />K12</div></Field><Field label="Intake year"><input value={intakeYear} onChange={(event) => onIntakeYear(event.target.value)} inputMode="numeric" /></Field><Field label="Admission type"><select value={admissionType} onChange={(event) => onAdmissionType(event.target.value)}><option value="s1_admission">S1 入學</option><option value="transfer">插班</option></select></Field></div><Field label="Primary Founder / Advisor"><select value={primaryBindingId} onChange={(event) => onPrimaryBinding(event.target.value)} disabled={primaryBindings.length === 0}><option value="">選擇 active binding</option>{primaryBindings.map((binding) => <option key={binding.id} value={binding.id}>{binding.label}</option>)}</select></Field><div className="inline-callout"><Icon name="shield" size={15} /><span>建立時會由 server 驗證 Student、primary binding 和 organization 的 composite identity；前端選項不是 authorization。</span></div></div>
}

function ManifestStep({ manifestId, manifests, onChange }: { manifestId: string; manifests: CaseOptions['manifests']; onChange: (value: string) => void }) {
  return <div className="space-y-5"><div><h3 className="section-title">選擇 approved manifest</h3><p className="section-detail">Assessment form 必須與 approved 的四層 K12 manifest 綁定，不能由頁面自行發明欄位。</p></div>{manifests.length > 0 ? manifests.map((item) => <label key={item.id} className={`selection-card ${manifestId === item.id ? 'selected' : ''}`}><input type="radio" name="manifest" checked={manifestId === item.id} onChange={() => onChange(item.id)} /><span className="selection-mark">{manifestId === item.id && <Icon name="check" size={13} />}</span><span><strong>{item.label}</strong><small>{item.id}</small><small className="text-green-700">approved · production catalogue</small></span></label>) : <div className="empty-state"><Icon name="clock" size={20} /><strong>沒有 approved manifest</strong><span>案件建立會停在這裡，直到 Founder/Admin 發布 approved manifest。</span></div>}<div className="inline-callout warning"><Icon name="clock" size={15} /><span>只有 Neon 中的 approved manifest 可以進入建立 transaction；synthetic UI schema 不會被默默 promote。</span></div></div>
}

function ReviewStep({ student, intakeYear, admissionType, primaryBinding, manifest }: { student: CaseOptions['students'][number] | undefined; intakeYear: string; admissionType: string; primaryBinding: CaseOptions['primaryBindings'][number] | undefined; manifest: CaseOptions['manifests'][number] | undefined }) {
  return <div className="space-y-5"><div><h3 className="section-title">檢查並建立</h3><p className="section-detail">送出前確認 case identity。API 會在 transaction 中再次驗證所有條件，並以 database constraint 處理並發 duplicate。</p></div><div className="review-list"><ReviewLine label="Student" value={`${student?.displayName || '—'} · ${student?.id || '—'}`} /><ReviewLine label="Application type" value="K12" /><ReviewLine label="Intake / admission" value={`${intakeYear} · ${admissionType === 's1_admission' ? 'S1 入學' : '插班'}`} /><ReviewLine label="Primary binding" value={primaryBinding?.label || '—'} /><ReviewLine label="Manifest" value={manifest?.label || '—'} /></div><div className="inline-callout"><Icon name="check-circle" size={15} /><span>Payload preflight passed：Student、K12、primary binding、approved manifest 均已選取。</span></div></div>
}

function CreateComplete({ createdCase, studentName }: { createdCase: CreatedCase; studentName: string }) {
  return <div className="max-w-2xl mx-auto pt-8"><section className="workspace-section text-center"><div className="success-mark"><Icon name="check" size={24} /></div><div className="eyebrow mt-5">Authoritative command completed</div><h2 className="page-title mt-1">案件已建立</h2><p className="page-subtitle mx-auto">{studentName} 的 ServiceCase 已由 Neon transaction 建立，後續 assessment 可以在案件 workspace 繼續。</p><div className="preview-result"><div><span>Case number</span><strong>{createdCase.caseNumber}</strong></div><div><span>Write status</span><strong className="text-green-700">persisted</strong></div></div><div className="flex justify-center gap-2 mt-6"><Link href={`/cases/${createdCase.id}`} className="primary-button">開啟案件<Icon name="arrow-right" size={15} /></Link><Link href="/cases" className="secondary-button">返回案件</Link></div></section></div>
}

function caseErrorMessage(code: string): string {
  if (code === 'UNAUTHENTICATED') return '登入已失效，請重新登入後再試。'
  if (code === 'FORBIDDEN') return '目前角色不能使用這個 primary binding 或建立此案件。'
  if (code === 'NOT_FOUND') return 'Student 不存在、已停用，或不在目前 organization。'
  if (code === 'CONFLICT') return '同一 Student、入學年度和 admission type 已有未結案案件，請先開啟現有案件。'
  if (code === 'VALIDATION_FAILED') return '案件欄位未通過驗證，請檢查年度和必填選項。'
  if (code === 'SERVICE_UNAVAILABLE') return '案件服務暫時不可用，請稍後再試。'
  return '案件建立失敗，請稍後再試。'
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field-label"><span>{label}</span>{children}</label> }
function ReviewLine({ label, value }: { label: string; value: string }) { return <div className="review-line"><span>{label}</span><strong>{value}</strong></div> }
