'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'

import { createStudent, precheckPotentialDuplicates, type DuplicateWarningDto } from '@/components/crm/f2-contract'
import { ErrorState, LoadingState, StaleState, SuccessState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError } from '@/lib/api/client'

const RELATIONSHIP_TYPES = ['parent', 'father', 'mother', 'step_parent', 'stepfather', 'stepmother', 'adoptive_parent', 'adoptive_father', 'adoptive_mother', 'foster_parent', 'foster_father', 'foster_mother', 'grandparent', 'paternal_grandfather', 'paternal_grandmother', 'maternal_grandfather', 'maternal_grandmother', 'adult_sibling', 'adult_brother', 'adult_sister', 'uncle', 'aunt', 'court_appointed_guardian', 'institutional_guardian', 'other_relative', 'non_relative_guardian', 'other'] as const

type SubmitState = 'idle' | 'checking' | 'warning' | 'saving' | 'success' | 'unavailable' | 'error' | 'stale'

export function StudentIntake() {
  const [displayName, setDisplayName] = useState('')
  const [dateOfBirth, setDateOfBirth] = useState('')
  const [gender, setGender] = useState('not_disclosed')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [guardianName, setGuardianName] = useState('')
  const [guardianEmail, setGuardianEmail] = useState('')
  const [guardianPhone, setGuardianPhone] = useState('')
  const [relationshipType, setRelationshipType] = useState('parent')
  const [relationshipDescription, setRelationshipDescription] = useState('')
  const [warning, setWarning] = useState<DuplicateWarningDto | null>(null)
  const [warningToken, setWarningToken] = useState<string | null>(null)
  const [state, setState] = useState<SubmitState>('idle')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [receiptId, setReceiptId] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!displayName.trim() || !guardianName.trim() || (!guardianEmail.trim() && !guardianPhone.trim()) || relationshipType === 'other' && !relationshipDescription.trim()) {
      setState('error')
      return
    }
    if (!warningToken) {
      setState('checking')
      try {
        const duplicate = await precheckPotentialDuplicates({ kind: 'student', display_name: displayName.trim(), email: contactEmail.trim() || null, phone: contactPhone.trim() || null })
        if (duplicate.candidates.length > 0) {
          setWarning(duplicate)
          setState('warning')
          return
        }
        setWarningToken(duplicate.warning_token)
      } catch (error: unknown) {
        setRequestId(error instanceof ApiClientError ? error.requestId : null)
        setState(error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE' ? 'unavailable' : 'error')
        return
      }
    }
    await save(warningToken)
  }

  async function save(token: string | null) {
    setState('saving')
    const idempotencyKey = crypto.randomUUID()
    try {
      const receipt = await createStudent({
        display_name: displayName.trim(),
        date_of_birth: dateOfBirth || null,
        gender,
        contact_email: contactEmail.trim() || null,
        contact_phone: contactPhone.trim() || null,
        primary_guardian: {
          mode: 'new',
          display_name: guardianName.trim(),
          email: guardianEmail.trim() || null,
          phone: guardianPhone.trim() || null,
          relationship_type: relationshipType,
          relationship_description: relationshipDescription.trim() || null,
          flags: ['primary'],
        },
        ...(token ? { warning_token: token } : {}),
      }, idempotencyKey)
      const studentReceipt = receipt.student
      setReceiptId(studentReceipt && typeof studentReceipt === 'object' && 'id' in studentReceipt && typeof studentReceipt.id === 'string' ? studentReceipt.id : null)
      setState('success')
    } catch (error: unknown) {
      setRequestId(error instanceof ApiClientError ? error.requestId : null)
      if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setState('stale')
      else if (error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE') setState('unavailable')
      else setState('error')
    }
  }

  if (state === 'success') return <SuccessState title="Student 建档请求已完成" detail="服务端已返回明确 receipt；请从列表打开最新资料。" action={<Link href="/students" className="primary-button">返回 Student</Link>} />
  if (state === 'unavailable') return <UnavailableState title="CRM 建档服务尚未可用" detail="当前没有冻结的可执行保存 runtime；不会以 mock 或 preview adapter 冒充成功。" requestId={requestId} onRetry={() => setState('idle')} />
  if (state === 'stale') return <StaleState title="资料版本已变化" detail="请重新载入当前 Student 后再提交，系统不会自动重放旧命令。" requestId={requestId} onRetry={() => setState('idle')} />
  if (state === 'error') return <ErrorState title="请检查建档字段" detail="姓名、Primary Guardian 联系方式和 relationship description 必须符合冻结规则。" requestId={requestId} onRetry={() => setState('idle')} />

  return (
    <form className="space-y-6" onSubmit={submit}>
      {state === 'checking' || state === 'saving' ? <LoadingState title={state === 'checking' ? '正在检查疑似重复' : '正在提交 Student'} detail="请求会使用统一 envelope 和 Idempotency-Key。" /> : null}
      {state === 'warning' && warning ? <DuplicateWarning warning={warning} onContinue={() => { setWarningToken(warning.warning_token); setState('idle') }} onBack={() => { setWarning(null); setWarningToken(null); setState('idle') }} /> : null}
      <section className="workspace-section"><h3 className="section-title">Student</h3><div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4"><Field label="姓名 *"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></Field><Field label="出生日期"><input type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} /></Field><Field label="Gender"><select value={gender} onChange={(event) => setGender(event.target.value)}><option value="not_disclosed">未提供</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></Field><Field label="Email"><input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} /></Field><Field label="电话"><input value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} /></Field></div></section>
      <section className="workspace-section"><h3 className="section-title">Primary Guardian</h3><p className="section-detail">只创建或明确选择 Guardian；系统不会自动关联或合并重复记录。</p><div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4"><Field label="姓名 *"><input value={guardianName} onChange={(event) => setGuardianName(event.target.value)} required /></Field><Field label="Email 或电话至少一项"><input value={guardianEmail} onChange={(event) => setGuardianEmail(event.target.value)} /></Field><Field label="电话"><input value={guardianPhone} onChange={(event) => setGuardianPhone(event.target.value)} /></Field><Field label="Relationship *"><select value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)}>{RELATIONSHIP_TYPES.map((value) => <option value={value} key={value}>{value}</option>)}</select></Field><Field label="Other relationship description"><input value={relationshipDescription} onChange={(event) => setRelationshipDescription(event.target.value)} required={relationshipType === 'other'} /></Field></div></section>
      <div className="flex items-center justify-between gap-3"><Link href="/students" className="secondary-button">取消</Link><button className="primary-button" type="submit" disabled={state === 'checking' || state === 'saving'}>{warningToken ? '确认独立建档' : '检查并继续'}</button></div>
      {receiptId ? <p className="text-xs" role="status">Receipt: {receiptId}</p> : null}
    </form>
  )
}

function DuplicateWarning({ warning, onContinue, onBack }: { warning: DuplicateWarningDto; onContinue: () => void; onBack: () => void }) {
  return <section className="workspace-section" role="alert"><h3 className="section-title">疑似已有记录</h3><p className="section-detail">命中姓名、Email 或电话。请人工判断；系统不会自动关联、合并或创建 DuplicateCandidate。</p><div className="space-y-2 mt-4">{warning.candidates.map((candidate) => <div className="selection-card" key={`${candidate.kind}-${candidate.id}`}><span className="min-w-0"><strong>{candidate.kind === 'guardian' ? 'Guardian' : 'Student'} · {candidate.display_name}</strong><small>命中：{candidate.matched_fields.join('、')} · {candidate.contact_hint ?? '已脱敏'}</small></span></div>)}</div><div className="flex flex-wrap justify-end gap-2 mt-4"><button type="button" className="secondary-button" onClick={onBack}>返回修改</button><button type="button" className="primary-button" onClick={onContinue}>确认仍为独立记录并继续</button></div></section>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field-label"><span>{label}</span>{children}</label> }
