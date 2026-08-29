'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  StudentCreateIdempotencyAttempt,
  classifyStudentRequestFailure,
  createStudentWithPrimaryGuardian,
  precheckPotentialDuplicates,
  validateStudentCreateDraft,
  type PotentialDuplicateResult,
  type RelationshipType,
  type StudentCreateDraft,
  type StudentCreateValidation,
} from '@/modules/crm/client'

type AccessState = 'loading' | 'allowed' | 'denied' | 'unauthenticated' | 'error'
type SubmitState =
  | { readonly kind: 'idle' | 'submitting' | 'success' }
  | { readonly kind: 'validation' | 'conflict' | 'forbidden' | 'unavailable'; readonly requestId: string | null }

const INITIAL_DRAFT: StudentCreateDraft = {
  student: {
    display_name: '',
    date_of_birth: '',
    gender: '',
    contact_email: '',
    contact_phone: '',
  },
  primary_guardian: {
    display_name: '',
    email: '',
    phone: '',
    date_of_birth: '',
    gender: '',
    relationship_type: 'father',
    relationship_description: '',
    is_legal_guardian: true,
    is_emergency_contact: false,
    is_billing_contact: false,
    notification_consent: false,
  },
}

export function StudentCreateForm() {
  const router = useRouter()
  const attempt = useRef(new StudentCreateIdempotencyAttempt())
  const submissionLocked = useRef(false)
  const [accessState, setAccessState] = useState<AccessState>('loading')
  const [draft, setDraft] = useState<StudentCreateDraft>(INITIAL_DRAFT)
  const [validation, setValidation] = useState<StudentCreateValidation>({})
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' })
  const [accessReloadToken, setAccessReloadToken] = useState(0)
  const [guardianLookup, setGuardianLookup] = useState<PotentialDuplicateResult | null>(null)
  const [guardianLookupState, setGuardianLookupState] = useState<'idle' | 'searching' | 'ready'>('idle')
  const [guardianLookupError, setGuardianLookupError] = useState<string | null>(null)
  const [newGuardianConfirmed, setNewGuardianConfirmed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    getWorkspaceAccessSnapshot(controller.signal)
      .then((access) => {
        setAccessState(access.capabilities.some((capability) => String(capability) === 'students.create') ? 'allowed' : 'denied')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const failure = classifyStudentRequestFailure(error)
        setAccessState(failure === 'unauthenticated' ? 'unauthenticated' : 'error')
      })
    return () => controller.abort()
  }, [accessReloadToken])

  function changeStudent(field: keyof StudentCreateDraft['student'], value: string) {
    attempt.current.markBusinessFieldChanged()
    setDraft((current) => ({ ...current, student: { ...current.student, [field]: value } }))
    clearSubmissionFeedback()
  }

  function changeGuardian(
    field: keyof StudentCreateDraft['primary_guardian'],
    value: string | boolean,
  ) {
    attempt.current.markBusinessFieldChanged()
    setDraft((current) => ({
      ...current,
      primary_guardian: {
        ...current.primary_guardian,
        [field]: value,
        ...(field === 'existing_guardian_id' ? {} : { existing_guardian_id: undefined, warning_token: undefined }),
      },
    }))
    if (field !== 'existing_guardian_id') {
      setGuardianLookup(null)
      setGuardianLookupState('idle')
      setGuardianLookupError(null)
      setNewGuardianConfirmed(false)
    }
    clearSubmissionFeedback()
  }

  function clearSubmissionFeedback() {
    setValidation({})
    setSubmitState((current) => current.kind === 'submitting' ? current : { kind: 'idle' })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submissionLocked.current || accessState !== 'allowed') return

    const errors = validateStudentCreateDraft(draft)
    if (Object.keys(errors).length > 0) {
      setValidation(errors)
      setSubmitState({ kind: 'validation', requestId: null })
      return
    }

    const existingGuardianId = draft.primary_guardian.existing_guardian_id?.trim() ?? ''
    if (!existingGuardianId && guardianLookupState !== 'ready') {
      await lookupExistingGuardian()
      return
    }
    if (!existingGuardianId && (guardianLookup?.warnings.length ?? 0) > 0 && !newGuardianConfirmed) {
      setValidation({ guardianSelection: '請選擇已有監護人，或明確確認新建監護人。' })
      setSubmitState({ kind: 'validation', requestId: null })
      return
    }

    submissionLocked.current = true
    setValidation({})
    setSubmitState({ kind: 'submitting' })
    try {
      const result = await createStudentWithPrimaryGuardian(
        draft,
        attempt.current.keyForSubmission(),
      )
      attempt.current.complete()
      setSubmitState({ kind: 'success' })
      router.push(`/students/${result.student.id}`)
    } catch (error) {
      const failure = classifyStudentRequestFailure(error)
      const requestId = safeRequestId(error)
      if (failure === 'unauthenticated') {
        attempt.current.complete()
        setAccessState('unauthenticated')
      } else if (failure === 'forbidden') {
        attempt.current.complete()
        setAccessState('denied')
      } else if (failure === 'validation') {
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

  async function lookupExistingGuardian(): Promise<void> {
    const guardian = draft.primary_guardian
    if (!guardian.display_name.trim() && !guardian.email.trim() && !guardian.phone.trim()) {
      setGuardianLookupError('請先輸入監護人姓名、Email 或電話，再查找已有監護人。')
      setValidation({ guardianSelection: '至少輸入一項監護人資料才能查找。' })
      setSubmitState({ kind: 'validation', requestId: null })
      return
    }
    setGuardianLookupState('searching')
    setGuardianLookupError(null)
    setValidation({})
    try {
      const result = await precheckPotentialDuplicates({
        kind: 'guardian',
        name: guardian.display_name,
        email: guardian.email || null,
        phone: guardian.phone || null,
      })
      setGuardianLookup(result)
      setGuardianLookupState('ready')
      setNewGuardianConfirmed(result.warnings.length === 0)
      setDraft((current) => ({
        ...current,
        primary_guardian: {
          ...current.primary_guardian,
          existing_guardian_id: undefined,
          warning_token: result.warnings.length === 0 ? null : undefined,
        },
      }))
      setSubmitState({ kind: 'idle' })
      setValidation({})
      if (result.warnings.length === 0) setGuardianLookupError('未找到已有監護人；確認資料後可新建。')
    } catch (error: unknown) {
      setGuardianLookupState('idle')
      const failure = classifyStudentRequestFailure(error)
      if (failure === 'unauthenticated') setAccessState('unauthenticated')
      else if (failure === 'forbidden') setAccessState('denied')
      else setGuardianLookupError('暫時無法查找已有監護人，請稍後重試。')
      setSubmitState({ kind: 'validation', requestId: safeRequestId(error) })
    }
  }

  function chooseExistingGuardian(id: string) {
    attempt.current.markBusinessFieldChanged()
    setDraft((current) => ({
      ...current,
      primary_guardian: { ...current.primary_guardian, existing_guardian_id: id, warning_token: undefined },
    }))
    setNewGuardianConfirmed(false)
    setValidation({})
    setSubmitState({ kind: 'idle' })
  }

  function chooseNewGuardian() {
    attempt.current.markBusinessFieldChanged()
    setDraft((current) => ({
      ...current,
      primary_guardian: {
        ...current.primary_guardian,
        existing_guardian_id: undefined,
        warning_token: guardianLookup?.warning_token ?? null,
      },
    }))
    setNewGuardianConfirmed(true)
    setValidation({})
    setSubmitState({ kind: 'idle' })
  }

  if (accessState === 'loading') return <AccessMessage icon="clock" title="正在確認建立權限" detail="請稍候。" />
  if (accessState === 'unauthenticated') return <AccessMessage icon="lock" title="工作階段已失效" detail="請重新登入後再建立學生資料。" href="/login" action="重新登入" />
  if (accessState === 'denied') return <AccessMessage icon="shield" title="無法建立學生資料" detail="你的帳號目前沒有建立學生的權限。隱藏入口只改善使用體驗，服務端仍會獨立驗證每次保存。" href="/students" action="返回學生名單" />
  if (accessState === 'error') return <AccessMessage icon="x" title="暫時無法確認權限" detail="請稍後重試。" onRetry={() => { setAccessState('loading'); setAccessReloadToken((value) => value + 1) }} />

  const pending = submitState.kind === 'submitting' || submitState.kind === 'success'
  return (
    <form className="space-y-6" onSubmit={handleSubmit} noValidate>
      <section className="workspace-section space-y-5">
        <div><div className="eyebrow">步驟 1</div><h3 className="section-title mt-1">學生基本資料</h3><p className="section-detail">學生姓名必填；其他聯絡資料可稍後補充。</p></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="學生姓名" required error={validation.studentDisplayName} id="student-display-name">
            <input id="student-display-name" name="student_display_name" value={draft.student.display_name} onChange={(event) => changeStudent('display_name', event.target.value)} required autoComplete="off" aria-invalid={Boolean(validation.studentDisplayName)} aria-describedby={validation.studentDisplayName ? 'student-display-name-error' : undefined} />
          </Field>
          <Field label="出生日期" error={validation.studentDateOfBirth} id="student-date-of-birth">
            <input id="student-date-of-birth" name="student_date_of_birth" type="date" value={draft.student.date_of_birth} onChange={(event) => changeStudent('date_of_birth', event.target.value)} aria-invalid={Boolean(validation.studentDateOfBirth)} aria-describedby={validation.studentDateOfBirth ? 'student-date-of-birth-error' : undefined} />
          </Field>
          <Field label="學生 Email" error={validation.studentEmail} id="student-contact-email">
            <input id="student-contact-email" name="student_contact_email" type="email" value={draft.student.contact_email} onChange={(event) => changeStudent('contact_email', event.target.value)} autoComplete="email" autoCapitalize="none" spellCheck={false} aria-invalid={Boolean(validation.studentEmail)} aria-describedby={validation.studentEmail ? 'student-contact-email-error' : undefined} />
          </Field>
          <Field label="學生電話" id="student-contact-phone">
            <input id="student-contact-phone" name="student_contact_phone" type="tel" value={draft.student.contact_phone} onChange={(event) => changeStudent('contact_phone', event.target.value)} autoComplete="tel" />
          </Field>
        </div>
      </section>

      <section className="workspace-section space-y-5">
        <div><div className="eyebrow">步驟 2</div><h3 className="section-title mt-1">主要監護人</h3><p className="section-detail">先查找是否已有監護人；選擇已有資料會建立關係，不會重複建檔。只有確認沒有合適記錄時才新建。若新建，Email 和電話至少填寫一項。</p></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="監護人姓名" required error={validation.guardianDisplayName} id="guardian-display-name">
            <input id="guardian-display-name" name="guardian_display_name" value={draft.primary_guardian.display_name} onChange={(event) => changeGuardian('display_name', event.target.value)} required autoComplete="name" aria-invalid={Boolean(validation.guardianDisplayName)} aria-describedby={validation.guardianDisplayName ? 'guardian-display-name-error' : undefined} />
          </Field>
          <Field label="與學生關係" required id="guardian-relationship-type">
            <select id="guardian-relationship-type" name="relationship_type" value={draft.primary_guardian.relationship_type} onChange={(event) => changeGuardian('relationship_type', event.target.value as RelationshipType)} required>
              <option value="father">父親</option>
              <option value="mother">母親</option>
              <option value="other_guardian">其他監護人</option>
            </select>
          </Field>
          <Field label="監護人 Email" error={validation.guardianEmail} id="guardian-email">
            <input id="guardian-email" name="guardian_email" type="email" value={draft.primary_guardian.email} onChange={(event) => changeGuardian('email', event.target.value)} autoComplete="email" autoCapitalize="none" spellCheck={false} aria-invalid={Boolean(validation.guardianEmail ?? validation.guardianContact)} aria-describedby={[validation.guardianEmail && 'guardian-email-error', validation.guardianContact && 'guardian-contact-error'].filter(Boolean).join(' ') || undefined} />
          </Field>
          <Field label="監護人電話" id="guardian-phone">
            <input id="guardian-phone" name="guardian_phone" type="tel" value={draft.primary_guardian.phone} onChange={(event) => changeGuardian('phone', event.target.value)} autoComplete="tel" aria-invalid={Boolean(validation.guardianContact)} aria-describedby={validation.guardianContact ? 'guardian-contact-error' : undefined} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="secondary-button" onClick={() => void lookupExistingGuardian()} disabled={guardianLookupState === 'searching' || pending}>
            <Icon name={guardianLookupState === 'searching' ? 'clock' : 'search'} size={15} />
            {guardianLookupState === 'searching' ? '查找中…' : '查找已有監護人'}
          </button>
          {draft.primary_guardian.existing_guardian_id ? <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>已選擇現有監護人；保存時只建立 Student 與關係。</span> : null}
        </div>
        {guardianLookupError ? <p className="text-xs" role="status" style={{ color: 'var(--text-secondary)' }}>{guardianLookupError}</p> : null}
        {guardianLookup && guardianLookup.warnings.length > 0 && !draft.primary_guardian.existing_guardian_id ? (
          <div className="inline-callout" role="alert">
            <Icon name="users" size={15} />
            <div className="space-y-2 w-full">
              <strong>找到可能已有的監護人</strong>
              <p className="text-xs">以下顯示完整姓名與聯絡方式，請人工確認後選擇；系統不會依姓名或聯絡方式自動關聯。</p>
              <div className="space-y-2">
                {guardianLookup.warnings.map((candidate) => (
                  <label className="selection-card" key={candidate.id}>
                    <input type="radio" name="existing-guardian" value={candidate.id} onChange={() => chooseExistingGuardian(candidate.id)} />
                    <span className="min-w-0"><strong>{candidate.display_name_hint ?? '已有監護人'}</strong><small>{[candidate.email_hint, candidate.phone_hint].filter(Boolean).join(' · ') || '未提供聯絡資料'} · 命中：{candidate.matching_fields.join('、')}</small></span>
                  </label>
                ))}
              </div>
              <button type="button" className="secondary-button" onClick={chooseNewGuardian}>確認仍新建監護人</button>
            </div>
          </div>
        ) : null}
        {validation.guardianContact ? <p id="guardian-contact-error" role="alert" className="text-xs text-red-700">{validation.guardianContact}</p> : null}
        {validation.guardianSelection ? <p id="guardian-selection-error" role="alert" className="text-xs text-red-700">{validation.guardianSelection}</p> : null}
        <label className="flex items-start gap-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <input type="checkbox" name="is_legal_guardian" checked={draft.primary_guardian.is_legal_guardian} onChange={(event) => changeGuardian('is_legal_guardian', event.target.checked)} className="mt-1" />
          <span><strong className="block" style={{ color: 'var(--text-primary)' }}>法定監護人</strong><span className="text-xs">預設為是；如實際情況不同，請取消勾選。</span></span>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.primary_guardian.is_emergency_contact} onChange={(event) => changeGuardian('is_emergency_contact', event.target.checked)} />緊急聯絡人</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.primary_guardian.is_billing_contact} onChange={(event) => changeGuardian('is_billing_contact', event.target.checked)} />帳務聯絡人</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.primary_guardian.notification_consent} onChange={(event) => changeGuardian('notification_consent', event.target.checked)} />接收通知</label>
        </div>
      </section>

      <SubmitFeedback state={submitState} />

      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
        <Link href="/students" className="secondary-button justify-center" onClick={() => attempt.current.complete()}>取消</Link>
        <button type="submit" className="primary-button justify-center min-w-32" disabled={pending} aria-busy={pending}>
          <Icon name={pending ? 'clock' : 'check'} size={16} />
          <span aria-live="polite">{submitState.kind === 'success' ? '正在開啟學生資料…' : submitState.kind === 'submitting' ? '保存中…' : '建立學生'}</span>
        </button>
      </div>
    </form>
  )
}

function Field({ label, required, error, id, children }: { readonly label: string; readonly required?: boolean; readonly error?: string; readonly id: string; readonly children: React.ReactNode }) {
  const errorId = `${id}-error`
  return <div className="field-label"><label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>{children}{error ? <span id={errorId} role="alert" className="text-[11px] font-normal text-red-700">{error}</span> : null}</div>
}

function SubmitFeedback({ state }: { readonly state: SubmitState }) {
  if (state.kind === 'idle' || state.kind === 'submitting') return null
  if (state.kind === 'success') return <div className="preview-notice" role="status"><Icon name="check-circle" size={15} /><span>學生與主要監護人已建立，正在開啟學生資料。</span></div>
  const message = state.kind === 'validation'
    ? '部分資料未通過檢查，請修正後再保存。'
    : state.kind === 'conflict'
      ? '這次保存無法完成。請確認資料後重新提交。'
      : state.kind === 'forbidden'
        ? '你的帳號無法建立學生資料。'
        : '學生服務暫時不可用，請稍後重試；重試不會重複建立資料。'
  const requestId = 'requestId' in state ? state.requestId : null
  return <div className="form-error" role="alert"><Icon name="x" size={15} /><span>{message}{requestId ? <small className="block mt-1">參考編號：{requestId}</small> : null}</span></div>
}

function AccessMessage({ icon, title, detail, href, action, onRetry }: { readonly icon: 'clock' | 'lock' | 'shield' | 'x'; readonly title: string; readonly detail: string; readonly href?: string; readonly action?: string; readonly onRetry?: () => void }) {
  return <section className="workspace-section"><div className="empty-state"><Icon name={icon} size={20} /><strong>{title}</strong><span>{detail}</span>{href && action ? <Link href={href} className="primary-button mt-3">{action}</Link> : null}{onRetry ? <button type="button" className="secondary-button mt-3" onClick={onRetry}>重新載入</button> : null}</div></section>
}

function safeRequestId(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('requestId' in error)) return null
  const requestId = error.requestId
  return typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId) ? requestId : null
}
