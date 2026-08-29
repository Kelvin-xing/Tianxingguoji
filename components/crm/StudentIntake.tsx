'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'

import { createStudent, precheckPotentialDuplicates, type DuplicateWarningDto } from '@/components/crm/f2-contract'
import { ErrorState, LoadingState, StaleState, SuccessState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError } from '@/lib/api/client'

const RELATIONSHIP_TYPES = ['parent', 'father', 'mother', 'step_parent', 'stepfather', 'stepmother', 'adoptive_parent', 'adoptive_father', 'adoptive_mother', 'foster_parent', 'foster_father', 'foster_mother', 'grandparent', 'paternal_grandfather', 'paternal_grandmother', 'maternal_grandfather', 'maternal_grandmother', 'adult_sibling', 'adult_brother', 'adult_sister', 'uncle', 'aunt', 'court_appointed_guardian', 'institutional_guardian', 'other_relative', 'non_relative_guardian', 'other'] as const

const RELATIONSHIP_LABELS: Readonly<Record<typeof RELATIONSHIP_TYPES[number], string>> = {
  parent: '家長', father: '父親', mother: '母親', step_parent: '繼父母', stepfather: '繼父', stepmother: '繼母',
  adoptive_parent: '養父母', adoptive_father: '養父', adoptive_mother: '養母', foster_parent: '寄養父母', foster_father: '寄養父', foster_mother: '寄養母',
  grandparent: '祖父母', paternal_grandfather: '祖父', paternal_grandmother: '祖母', maternal_grandfather: '外祖父', maternal_grandmother: '外祖母',
  adult_sibling: '成年兄弟姊妹', adult_brother: '成年兄弟', adult_sister: '成年姊妹', uncle: '叔伯或舅父', aunt: '姑姨',
  court_appointed_guardian: '法院指定監護人', institutional_guardian: '機構監護人', other_relative: '其他親屬', non_relative_guardian: '非親屬監護人', other: '其他',
}

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
      await createStudent({
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
      setState('success')
    } catch (error: unknown) {
      setRequestId(error instanceof ApiClientError ? error.requestId : null)
      if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setState('stale')
      else if (error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE') setState('unavailable')
      else setState('error')
    }
  }

  if (state === 'success') return <SuccessState title="學生資料已建立" detail="可以從學生清單開啟最新資料。" action={<Link href="/students" className="primary-button">返回學生</Link>} />
  if (state === 'unavailable') return <UnavailableState title="學生資料服務暫時不可用" detail="請稍後重試。" requestId={requestId} onRetry={() => setState('idle')} />
  if (state === 'stale') return <StaleState title="資料版本已更新" detail="請重新載入目前學生資料後再提交。" requestId={requestId} onRetry={() => setState('idle')} />
  if (state === 'error') return <ErrorState title="請檢查建檔資料" detail="請確認姓名、主要監護人聯絡方式和關係說明。" requestId={requestId} onRetry={() => setState('idle')} />

  return (
    <form className="space-y-6" onSubmit={submit}>
      {state === 'checking' || state === 'saving' ? <LoadingState title={state === 'checking' ? '正在檢查可能重複資料' : '正在提交學生資料'} detail="請稍候。" /> : null}
      {state === 'warning' && warning ? <DuplicateWarning warning={warning} onContinue={() => { setWarningToken(warning.warning_token); setState('idle') }} onBack={() => { setWarning(null); setWarningToken(null); setState('idle') }} /> : null}
      <section className="workspace-section"><h3 className="section-title">學生資料</h3><div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4"><Field label="姓名 *"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></Field><Field label="出生日期"><input type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} /></Field><Field label="性別"><select value={gender} onChange={(event) => setGender(event.target.value)}><option value="not_disclosed">未提供</option><option value="male">男</option><option value="female">女</option><option value="other">其他</option></select></Field><Field label="電郵"><input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} /></Field><Field label="電話"><input value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} /></Field></div></section>
      <section className="workspace-section"><h3 className="section-title">主要監護人</h3><p className="section-detail">只建立或明確選擇監護人；系統不會自動關聯或合併重複記錄。</p><div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4"><Field label="姓名 *"><input value={guardianName} onChange={(event) => setGuardianName(event.target.value)} required /></Field><Field label="電郵或電話至少一項"><input value={guardianEmail} onChange={(event) => setGuardianEmail(event.target.value)} /></Field><Field label="電話"><input value={guardianPhone} onChange={(event) => setGuardianPhone(event.target.value)} /></Field><Field label="關係 *"><select value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)}>{RELATIONSHIP_TYPES.map((value) => <option value={value} key={value}>{RELATIONSHIP_LABELS[value]}</option>)}</select></Field><Field label="其他關係說明"><input value={relationshipDescription} onChange={(event) => setRelationshipDescription(event.target.value)} required={relationshipType === 'other'} /></Field></div></section>
      <div className="flex items-center justify-between gap-3"><Link href="/students" className="secondary-button">取消</Link><button className="primary-button" type="submit" disabled={state === 'checking' || state === 'saving'}>{warningToken ? '確認建立獨立資料' : '檢查並繼續'}</button></div>
    </form>
  )
}

function DuplicateWarning({ warning, onContinue, onBack }: { warning: DuplicateWarningDto; onContinue: () => void; onBack: () => void }) {
  return <section className="workspace-section" role="alert"><h3 className="section-title">可能已有相同資料</h3><p className="section-detail">姓名、電郵或電話可能與現有資料相符，請人工確認。</p><div className="space-y-2 mt-4">{warning.candidates.map((candidate) => <div className="selection-card" key={`${candidate.kind}-${candidate.id}`}><span className="min-w-0"><strong>{candidate.kind === 'guardian' ? '監護人' : '學生'} · {candidate.display_name}</strong><small>相符資料：{candidate.matched_fields.map(matchedFieldLabel).join('、')} · {candidate.contact_hint ?? '已隱藏'}</small></span></div>)}</div><div className="flex flex-wrap justify-end gap-2 mt-4"><button type="button" className="secondary-button" onClick={onBack}>返回修改</button><button type="button" className="primary-button" onClick={onContinue}>確認建立獨立資料</button></div></section>
}

function matchedFieldLabel(field: string): string {
  if (field === 'display_name') return '姓名'
  if (field === 'date_of_birth') return '出生日期'
  if (field === 'email' || field === 'contact_email') return '電郵'
  if (field === 'phone' || field === 'contact_phone') return '電話'
  return '聯絡資料'
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field-label"><span>{label}</span>{children}</label> }
