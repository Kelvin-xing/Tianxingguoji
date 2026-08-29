'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  CaseCreateIdempotencyAttempt,
  classifyCaseRequestFailure,
  createExistingStudentCase,
  getCase,
  listCaseWorkspaceOptions,
  type CaseAdmissionType,
  type CaseWorkspaceOptions,
} from '@/modules/cases/client'

const STEPS = Object.freeze([
  { id: 1, label: '選擇學生' },
  { id: 2, label: '案件設定' },
  { id: 3, label: '評估表版本' },
  { id: 4, label: '檢查並建立' },
] as const)

type AccessState = 'loading' | 'allowed' | 'unauthenticated' | 'denied' | 'unavailable'
type SubmitState =
  | { readonly kind: 'idle' | 'submitting' | 'success' }
  | { readonly kind: 'validation' | 'conflict' | 'denied' | 'unavailable'; readonly requestId: string | null }

export function CaseCreateForm({ preselectedStudentId }: { readonly preselectedStudentId?: string }) {
  const router = useRouter()
  const [accessState, setAccessState] = useState<AccessState>('loading')
  const [reloadToken, setReloadToken] = useState(0)
  const [options, setOptions] = useState<CaseWorkspaceOptions | null>(null)
  const [step, setStep] = useState(1)
  const [studentId, setStudentId] = useState('')
  const [intakeYear, setIntakeYear] = useState('')
  const [admissionType, setAdmissionType] = useState<CaseAdmissionType>('transfer')
  const [primaryRoleBindingId, setPrimaryRoleBindingId] = useState('')
  const [manifestId, setManifestId] = useState('')
  const [validationMessage, setValidationMessage] = useState('')
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' })
  const attempt = useRef(new CaseCreateIdempotencyAttempt())
  const submissionLocked = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    getWorkspaceAccessSnapshot(controller.signal)
      .then(async (access) => {
        const canRead = access.capabilities.includes('cases.read')
        const canCreate = access.capabilities.some((capability) => String(capability) === 'cases.create')
        if (!canRead || !canCreate) {
          setAccessState('denied')
          return
        }
        const loadedOptions = await listCaseWorkspaceOptions(controller.signal)
        setOptions(loadedOptions)
        setStudentId(loadedOptions.students.some(({ id }) => id === preselectedStudentId)
          ? preselectedStudentId ?? ''
          : '')
        setPrimaryRoleBindingId(loadedOptions.primaryBindings[0]?.id ?? '')
        setManifestId(loadedOptions.manifests[0]?.id ?? '')
        setAccessState('allowed')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const failure = classifyCaseRequestFailure(error)
        setAccessState(failure === 'unauthenticated' ? 'unauthenticated' : failure === 'forbidden' ? 'denied' : 'unavailable')
      })
    return () => controller.abort()
  }, [preselectedStudentId, reloadToken])

  const student = useMemo(() => options?.students.find((item) => item.id === studentId), [options, studentId])
  const primaryBinding = useMemo(() => options?.primaryBindings.find((item) => item.id === primaryRoleBindingId), [options, primaryRoleBindingId])
  const manifest = useMemo(() => options?.manifests.find((item) => item.id === manifestId), [manifestId, options])

  function changeBusinessField(change: () => void) {
    attempt.current.markBusinessFieldChanged()
    change()
    setValidationMessage('')
    setSubmitState((current) => current.kind === 'submitting' || current.kind === 'success' ? current : { kind: 'idle' })
  }

  function next() {
    setValidationMessage('')
    if (!options) return setValidationMessage('案件選項尚未載入，請稍後再試。')
    if (step === 1 && !student) return setValidationMessage('請先選擇一名學生。')
    if (step === 2 && (!validIntakeYear(intakeYear) || !primaryBinding)) return setValidationMessage('請輸入有效的入學年度並選擇主要顧問。')
    if (step === 3 && !manifest) return setValidationMessage('目前沒有可用的評估表版本。')
    setStep((current) => Math.min(current + 1, 4))
  }

  function back() {
    setValidationMessage('')
    setStep((current) => Math.max(current - 1, 1))
  }

  async function submitCase() {
    if (submissionLocked.current || accessState !== 'allowed') return
    setValidationMessage('')
    if (!student || !primaryBinding || !manifest || !validIntakeYear(intakeYear)) {
      setSubmitState({ kind: 'validation', requestId: null })
      return
    }

    submissionLocked.current = true
    setSubmitState({ kind: 'submitting' })
    try {
      const receipt = await createExistingStudentCase({
        student_id: student.id,
        intake_year: Number(intakeYear),
        admission_type: admissionType,
        primary_role_binding_id: primaryBinding.id,
        manifest_id: manifest.id,
      }, attempt.current.keyForSubmission())
      const authoritative = await getCase(receipt.id)
      if (
        authoritative.id !== receipt.id ||
        authoritative.recordVersion !== receipt.record_version ||
        authoritative.stage !== 'background_collection' ||
        authoritative.workflowStatus !== 'active'
      ) {
        throw new TypeError('Authoritative Case does not match the create receipt.')
      }
      attempt.current.complete()
      setSubmitState({ kind: 'success' })
      router.push(`/cases/${authoritative.id}`)
      router.refresh()
    } catch (error: unknown) {
      const failure = classifyCaseRequestFailure(error)
      const requestId = safeRequestId(error)
      if (failure === 'unauthenticated') {
        attempt.current.complete()
        setAccessState('unauthenticated')
      } else if (failure === 'forbidden') {
        attempt.current.complete()
        setAccessState('denied')
      } else if (failure === 'validation' || failure === 'not_found') {
        setSubmitState({ kind: 'validation', requestId })
      } else if (failure === 'conflict') {
        setSubmitState({ kind: 'conflict', requestId })
      } else {
        setSubmitState({ kind: 'unavailable', requestId })
      }
    } finally {
      submissionLocked.current = false
    }
  }

  if (accessState === 'loading') return <AccessMessage icon="clock" title="正在載入案件選項" detail="請稍候。" />
  if (accessState === 'unauthenticated') return <AccessMessage icon="lock" title="工作階段已失效" detail="請重新登入後再建立案件。" href="/login" action="重新登入" />
  if (accessState === 'denied') return <AccessMessage icon="shield" title="無法建立案件" detail="目前帳號沒有建立案件的權限。" href="/cases" action="返回案件" />
  if (accessState === 'unavailable') return <AccessMessage icon="x" title="案件服務暫時不可用" detail="請稍後重試。" onRetry={() => { setAccessState('loading'); setReloadToken((value) => value + 1) }} />
  if (!options) return null

  const pending = submitState.kind === 'submitting' || submitState.kind === 'success'
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/cases" className="quiet-link">案件</Link><Icon name="chevron-right" size={14} /><span>建立案件</span></div>
      <section><div className="eyebrow">K12 案件</div><h2 className="page-title">建立案件</h2><p className="page-subtitle">為已有學生建立案件，並指定入學設定與主要顧問。</p></section>

      <section className="workspace-section" aria-busy={pending}>
        <div className="wizard-steps" aria-label="建立案件步驟">{STEPS.map((item) => { const active = item.id === step; const complete = item.id < step; return <div key={item.id} className={`wizard-step ${active ? 'active' : ''} ${complete ? 'complete' : ''}`} aria-current={active ? 'step' : undefined}><div className="wizard-number">{complete ? <Icon name="check" size={14} /> : item.id}</div><span>{item.label}</span></div> })}</div>
        <div className="wizard-body">
          {step === 1 ? <StudentStep students={options.students} studentId={studentId} onSelect={(value) => changeBusinessField(() => setStudentId(value))} /> : null}
          {step === 2 ? <IdentityStep intakeYear={intakeYear} admissionType={admissionType} primaryBindingId={primaryRoleBindingId} primaryBindings={options.primaryBindings} onIntakeYear={(value) => changeBusinessField(() => setIntakeYear(value))} onAdmissionType={(value) => changeBusinessField(() => setAdmissionType(value))} onPrimaryBinding={(value) => changeBusinessField(() => setPrimaryRoleBindingId(value))} /> : null}
          {step === 3 ? <ManifestStep manifestId={manifestId} manifests={options.manifests} onChange={(value) => changeBusinessField(() => setManifestId(value))} /> : null}
          {step === 4 ? <ReviewStep studentName={student?.displayName} intakeYear={intakeYear} admissionType={admissionType} primaryBindingLabel={primaryBinding?.label} manifestLabel={manifest?.label} /> : null}
          {validationMessage ? <div className="form-error" role="alert"><Icon name="x" size={15} /><span>{validationMessage}</span></div> : null}
          <SubmitFeedback state={submitState} />
        </div>
        <div className="wizard-footer"><Link href="/cases" className="secondary-button" onClick={() => attempt.current.complete()}>取消</Link><div className="flex items-center gap-2">{step > 1 ? <button type="button" className="secondary-button" onClick={back} disabled={pending}>上一步</button> : null}{step < 4 ? <button type="button" className="primary-button" onClick={next} disabled={pending}>下一步<Icon name="arrow-right" size={15} /></button> : <button type="button" className="primary-button min-w-28" onClick={submitCase} disabled={pending} aria-busy={pending}><Icon name={pending ? 'clock' : 'check'} size={15} /><span aria-live="polite">{submitState.kind === 'success' ? '正在開啟案件…' : submitState.kind === 'submitting' ? '建立中…' : '建立案件'}</span></button>}</div></div>
      </section>
    </div>
  )
}

function StudentStep({ students, studentId, onSelect }: { readonly students: CaseWorkspaceOptions['students']; readonly studentId: string; readonly onSelect: (id: string) => void }) {
  return <div className="space-y-5"><div><h3 className="section-title">選擇已有學生</h3><p className="section-detail">案件會連結到已儲存的學生資料。</p></div>{students.length > 0 ? <Field label="學生" id="case-student" required><select id="case-student" name="student_id" value={studentId} onChange={(event) => onSelect(event.target.value)} required><option value="">選擇學生</option>{students.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></Field> : <div className="empty-state"><Icon name="users" size={20} /><strong>目前沒有可選擇的學生</strong><span>請先建立學生資料。</span></div>}<Link href="/students" className="quiet-link">前往學生名單 <Icon name="arrow-right" size={14} /></Link></div>
}

function IdentityStep({ intakeYear, admissionType, primaryBindingId, primaryBindings, onIntakeYear, onAdmissionType, onPrimaryBinding }: { readonly intakeYear: string; readonly admissionType: CaseAdmissionType; readonly primaryBindingId: string; readonly primaryBindings: CaseWorkspaceOptions['primaryBindings']; readonly onIntakeYear: (value: string) => void; readonly onAdmissionType: (value: CaseAdmissionType) => void; readonly onPrimaryBinding: (value: string) => void }) {
  return <div className="space-y-5"><div><h3 className="section-title">案件設定</h3><p className="section-detail">確認入學年度、申請類型和主要顧問。</p></div><div className="grid grid-cols-1 md:grid-cols-3 gap-4"><Field label="服務類型" id="case-application-type"><div id="case-application-type" className="locked-field"><Icon name="lock" size={14} />K12</div></Field><Field label="入學年度" id="case-intake-year" required><input id="case-intake-year" name="intake_year" type="number" min={2000} max={2200} inputMode="numeric" value={intakeYear} onChange={(event) => onIntakeYear(event.target.value)} required /></Field><Field label="申請類型" id="case-admission-type" required><select id="case-admission-type" name="admission_type" value={admissionType} onChange={(event) => onAdmissionType(event.target.value as CaseAdmissionType)} required><option value="s1_admission">中一入學</option><option value="transfer">插班</option></select></Field></div><Field label="主要顧問" id="case-primary-binding" required><select id="case-primary-binding" name="primary_role_binding_id" value={primaryBindingId} onChange={(event) => onPrimaryBinding(event.target.value)} disabled={primaryBindings.length === 0} required><option value="">選擇主要顧問</option>{primaryBindings.map((binding) => <option key={binding.id} value={binding.id}>{binding.label}</option>)}</select></Field><div className="inline-callout"><Icon name="shield" size={15} /><span>可選項只包含目前可指派的顧問。</span></div></div>
}

function ManifestStep({ manifestId, manifests, onChange }: { readonly manifestId: string; readonly manifests: CaseWorkspaceOptions['manifests']; readonly onChange: (value: string) => void }) {
  return <div className="space-y-5"><div><h3 className="section-title">選擇評估表版本</h3><p className="section-detail">案件建立後會沿用這個已批准版本。</p></div>{manifests.length > 0 ? <Field label="評估表版本" id="case-manifest" required><select id="case-manifest" name="manifest_id" value={manifestId} onChange={(event) => onChange(event.target.value)} required><option value="">選擇評估表版本</option>{manifests.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field> : <div className="empty-state"><Icon name="clock" size={20} /><strong>目前沒有可用的評估表版本</strong><span>請稍後再試或聯絡管理員。</span></div>}</div>
}

function ReviewStep({ studentName, intakeYear, admissionType, primaryBindingLabel, manifestLabel }: { readonly studentName?: string; readonly intakeYear: string; readonly admissionType: CaseAdmissionType; readonly primaryBindingLabel?: string; readonly manifestLabel?: string }) {
  return <div className="space-y-5"><div><h3 className="section-title">檢查並建立</h3><p className="section-detail">請確認以下案件資料。建立後將直接開啟案件詳情。</p></div><div className="review-list"><ReviewLine label="學生" value={studentName ?? '未選擇'} /><ReviewLine label="服務類型" value="K12" /><ReviewLine label="入學年度與申請類型" value={`${intakeYear} · ${admissionType === 's1_admission' ? '中一入學' : '插班'}`} /><ReviewLine label="主要顧問" value={primaryBindingLabel ?? '未選擇'} /><ReviewLine label="評估表版本" value={manifestLabel ?? '未選擇'} /></div></div>
}

function SubmitFeedback({ state }: { readonly state: SubmitState }) {
  if (state.kind === 'idle' || state.kind === 'submitting') return null
  if (state.kind === 'success') return <div className="preview-notice" role="status"><Icon name="check-circle" size={15} /><span>案件已建立，正在開啟案件詳情。</span></div>
  const message = state.kind === 'validation'
    ? '部分資料未通過檢查，請返回前一步修正。'
    : state.kind === 'conflict'
      ? '這名學生已有相同入學設定的進行中案件，請返回案件列表查看。'
      : state.kind === 'denied'
        ? '你的帳號目前無法建立案件。'
        : '案件服務暫時不可用，請稍後重試；重試不會重複建立案件。'
  const requestId = 'requestId' in state ? state.requestId : null
  return <div className="form-error" role="alert"><Icon name="x" size={15} /><span>{message}{requestId ? <small className="block mt-1">參考編號：{requestId}</small> : null}</span></div>
}

function AccessMessage({ icon, title, detail, href, action, onRetry }: { readonly icon: 'clock' | 'lock' | 'shield' | 'x'; readonly title: string; readonly detail: string; readonly href?: string; readonly action?: string; readonly onRetry?: () => void }) {
  return <div className="max-w-3xl mx-auto"><section className="workspace-section"><div className="empty-state"><Icon name={icon} size={20} /><strong>{title}</strong><span>{detail}</span>{href && action ? <Link href={href} className="primary-button mt-3">{action}</Link> : null}{onRetry ? <button type="button" className="secondary-button mt-3" onClick={onRetry}>重新載入</button> : null}</div></section></div>
}

function Field({ label, id, required, children }: { readonly label: string; readonly id: string; readonly required?: boolean; readonly children: ReactNode }) {
  return <div className="field-label"><label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>{children}</div>
}

function ReviewLine({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="review-line"><span>{label}</span><strong className="break-words">{value}</strong></div>
}

function validIntakeYear(value: string): boolean {
  const year = Number(value)
  return Number.isSafeInteger(year) && year >= 2000 && year <= 2200
}

function safeRequestId(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('requestId' in error)) return null
  const requestId = error.requestId
  return typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId) ? requestId : null
}
