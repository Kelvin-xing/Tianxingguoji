'use client'

import { useRef, useState, type FormEvent, type ReactNode } from 'react'

import { Icon } from '@/components/workspace/Icon'
import {
  ProfileUpdateIdempotencyAttempt,
  classifyProfileMaintenanceFailure,
  updateGuardianProfile,
  updateStudentProfile,
  validateGuardianProfileDraft,
  validateStudentProfileDraft,
  type GuardianProfileDraft,
  type ProfileValidation,
  type StudentDetail,
  type StudentGuardianItem,
  type StudentProfileDraft,
} from '@/modules/crm/client'

type SubmitState =
  | { readonly kind: 'idle' | 'saving' | 'success' }
  | {
      readonly kind: 'validation' | 'stale' | 'conflict' | 'denied' | 'unauthenticated' | 'unavailable'
      readonly requestId: string | null
    }

interface EditorCallbacks {
  readonly onCancel: () => void
  readonly onSaved: () => void
  readonly onReload: () => void
}

export function StudentProfileEditor({
  student,
  onCancel,
  onSaved,
  onReload,
}: { readonly student: StudentDetail } & EditorCallbacks) {
  const attempt = useRef(new ProfileUpdateIdempotencyAttempt('student'))
  const savingLock = useRef(false)
  const [draft, setDraft] = useState<StudentProfileDraft>({
    display_name: student.displayName,
    date_of_birth: student.dateOfBirth ?? '',
    contact_email: student.contactEmail ?? '',
    contact_phone: student.contactPhone ?? '',
    expected_record_version: student.recordVersion,
  })
  const [validation, setValidation] = useState<ProfileValidation>({})
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' })

  function change(field: keyof Omit<StudentProfileDraft, 'expected_record_version'>, value: string) {
    attempt.current.markBusinessFieldChanged()
    setDraft((current) => ({ ...current, [field]: value }))
    setValidation({})
    setSubmitState({ kind: 'idle' })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (savingLock.current) return
    const errors = validateStudentProfileDraft(draft)
    if (Object.keys(errors).length > 0) {
      setValidation(errors)
      setSubmitState({ kind: 'validation', requestId: null })
      return
    }
    savingLock.current = true
    setValidation({})
    setSubmitState({ kind: 'saving' })
    try {
      await updateStudentProfile(student.id, draft, attempt.current.keyForSubmission())
      attempt.current.complete()
      setSubmitState({ kind: 'success' })
      onSaved()
    } catch (error) {
      setSubmitState(profileFailureState(error))
    } finally {
      savingLock.current = false
    }
  }

  return (
    <form className="mt-5 border-t pt-5 space-y-4" onSubmit={submit} noValidate aria-label="編輯學生基本資料">
      <div><h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>編輯學生資料</h4><p className="section-detail">修改基本資料後保存；取消不會保留未保存內容。</p></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ProfileField label="學生姓名" id="student-profile-display-name" required error={validation.displayName}>
          <input id="student-profile-display-name" value={draft.display_name} onChange={(event) => change('display_name', event.target.value)} required autoComplete="name" aria-invalid={Boolean(validation.displayName)} />
        </ProfileField>
        <ProfileField label="出生日期" id="student-profile-date-of-birth" error={validation.dateOfBirth}>
          <input id="student-profile-date-of-birth" type="date" value={draft.date_of_birth} onChange={(event) => change('date_of_birth', event.target.value)} aria-invalid={Boolean(validation.dateOfBirth)} />
        </ProfileField>
        <ProfileField label="學生 Email" id="student-profile-email" error={validation.email}>
          <input id="student-profile-email" type="email" value={draft.contact_email} onChange={(event) => change('contact_email', event.target.value)} autoComplete="email" autoCapitalize="none" spellCheck={false} aria-invalid={Boolean(validation.email)} />
        </ProfileField>
        <ProfileField label="學生電話" id="student-profile-phone" error={validation.phone}>
          <input id="student-profile-phone" type="tel" value={draft.contact_phone} onChange={(event) => change('contact_phone', event.target.value)} autoComplete="tel" aria-invalid={Boolean(validation.phone)} />
        </ProfileField>
      </div>
      <ProfileFeedback state={submitState} onReload={onReload} />
      <EditorActions
        pending={submitState.kind === 'saving' || submitState.kind === 'success'}
        saveLabel="保存學生資料"
        onCancel={() => { attempt.current.complete(); onCancel() }}
      />
    </form>
  )
}

export function GuardianProfileEditor({
  guardian,
  onCancel,
  onSaved,
  onReload,
}: { readonly guardian: StudentGuardianItem } & EditorCallbacks) {
  const attempt = useRef(new ProfileUpdateIdempotencyAttempt('guardian'))
  const savingLock = useRef(false)
  const [draft, setDraft] = useState<GuardianProfileDraft>({
    display_name: guardian.displayName,
    email: guardian.email ?? '',
    phone: guardian.phone ?? '',
    expected_record_version: guardian.recordVersion,
  })
  const [validation, setValidation] = useState<ProfileValidation>({})
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' })

  function change(field: keyof Omit<GuardianProfileDraft, 'expected_record_version'>, value: string) {
    attempt.current.markBusinessFieldChanged()
    setDraft((current) => ({ ...current, [field]: value }))
    setValidation({})
    setSubmitState({ kind: 'idle' })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (savingLock.current) return
    const errors = validateGuardianProfileDraft(draft)
    if (Object.keys(errors).length > 0) {
      setValidation(errors)
      setSubmitState({ kind: 'validation', requestId: null })
      return
    }
    savingLock.current = true
    setValidation({})
    setSubmitState({ kind: 'saving' })
    try {
      await updateGuardianProfile(guardian.id, draft, attempt.current.keyForSubmission())
      attempt.current.complete()
      setSubmitState({ kind: 'success' })
      onSaved()
    } catch (error) {
      setSubmitState(profileFailureState(error))
    } finally {
      savingLock.current = false
    }
  }

  return (
    <form className="mt-4 border-t pt-4 space-y-4" onSubmit={submit} noValidate aria-label="編輯監護人基本資料">
      <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>編輯監護人資料</h4>
      <div className="grid grid-cols-1 gap-3">
        <ProfileField label="監護人姓名" id="guardian-profile-name" required error={validation.displayName}>
          <input id="guardian-profile-name" value={draft.display_name} onChange={(event) => change('display_name', event.target.value)} required autoComplete="name" aria-invalid={Boolean(validation.displayName)} />
        </ProfileField>
        <ProfileField label="監護人 Email" id="guardian-profile-email" error={validation.email}>
          <input id="guardian-profile-email" type="email" value={draft.email} onChange={(event) => change('email', event.target.value)} autoComplete="email" autoCapitalize="none" spellCheck={false} aria-invalid={Boolean(validation.email ?? validation.contact)} />
        </ProfileField>
        <ProfileField label="監護人電話" id="guardian-profile-phone" error={validation.phone}>
          <input id="guardian-profile-phone" type="tel" value={draft.phone} onChange={(event) => change('phone', event.target.value)} autoComplete="tel" aria-invalid={Boolean(validation.phone ?? validation.contact)} />
        </ProfileField>
      </div>
      {validation.contact ? <p role="alert" className="text-xs text-red-700">{validation.contact}</p> : null}
      <ProfileFeedback state={submitState} onReload={onReload} />
      <EditorActions
        pending={submitState.kind === 'saving' || submitState.kind === 'success'}
        saveLabel="保存監護人資料"
        onCancel={() => { attempt.current.complete(); onCancel() }}
      />
    </form>
  )
}

function ProfileField({ label, id, required, error, children }: { readonly label: string; readonly id: string; readonly required?: boolean; readonly error?: string; readonly children: ReactNode }) {
  const errorId = `${id}-error`
  return <div className="field-label"><label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>{children}{error ? <span id={errorId} role="alert" className="text-[11px] font-normal text-red-700">{error}</span> : null}</div>
}

function EditorActions({ pending, saveLabel, onCancel }: { readonly pending: boolean; readonly saveLabel: string; readonly onCancel: () => void }) {
  return <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2"><button type="button" className="secondary-button justify-center" onClick={onCancel} disabled={pending}>取消</button><button type="submit" className="primary-button justify-center min-w-36" disabled={pending} aria-busy={pending}><Icon name={pending ? 'clock' : 'check'} size={16} /><span aria-live="polite">{pending ? '保存中…' : saveLabel}</span></button></div>
}

function ProfileFeedback({ state, onReload }: { readonly state: SubmitState; readonly onReload: () => void }) {
  if (state.kind === 'idle' || state.kind === 'saving' || state.kind === 'success') return null
  if (state.kind === 'stale') return <div className="form-error" role="alert"><Icon name="x" size={15} /><span>這筆資料已被更新。請重新載入最新資料後再編輯。<button type="button" className="secondary-button mt-3" onClick={onReload}>重新載入最新資料</button></span></div>
  const message = state.kind === 'validation'
    ? '部分資料未通過檢查，請修正後再保存。'
    : state.kind === 'conflict'
      ? '這次保存與先前操作衝突，請修改資料後再提交。'
      : state.kind === 'unauthenticated'
        ? '工作階段已失效，請重新登入。'
        : state.kind === 'denied'
          ? '你的帳號目前無法修改這筆資料。'
          : '資料服務暫時不可用，請稍後重試；重試不會重複保存。'
  const requestId = 'requestId' in state ? state.requestId : null
  return <div className="form-error" role="alert"><Icon name="x" size={15} /><span>{message}{requestId ? <small className="block mt-1">參考編號：{requestId}</small> : null}</span></div>
}

function profileFailureState(error: unknown): SubmitState {
  const failure = classifyProfileMaintenanceFailure(error)
  const requestId = safeRequestId(error)
  if (failure === 'stale') return { kind: 'stale', requestId }
  if (failure === 'validation') return { kind: 'validation', requestId }
  if (failure === 'conflict') return { kind: 'conflict', requestId }
  if (failure === 'forbidden' || failure === 'not_found') return { kind: 'denied', requestId }
  if (failure === 'unauthenticated') return { kind: 'unauthenticated', requestId }
  return { kind: 'unavailable', requestId }
}

function safeRequestId(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('requestId' in error)) return null
  const requestId = error.requestId
  return typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId) ? requestId : null
}
