'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  DuplicateMutationIdempotencyAttempt,
  classifyDuplicateRequestFailure,
  correctDuplicateMerge,
  duplicateCorrectionFingerprint,
  duplicateMergeFingerprint,
  getDuplicateCandidate,
  mergeDuplicateCandidate,
  type DuplicateCandidateDetail,
  type DuplicateMergeDraft,
  type DuplicateProfile,
  type DuplicateSupportedField,
} from '@/modules/crm/client'

type ReviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly detail: DuplicateCandidateDetail; readonly canMerge: boolean }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable' }

type CommandState =
  | 'idle'
  | 'merging'
  | 'correcting'
  | 'validation'
  | 'stale'
  | 'conflict'
  | 'denied'
  | 'unavailable'
  | 'success'
  | 'corrected'

export function DuplicateCandidateReview({ candidateId }: { readonly candidateId: string }) {
  const mergeAttempt = useRef(new DuplicateMutationIdempotencyAttempt('merge'))
  const correctionAttempt = useRef(new DuplicateMutationIdempotencyAttempt('correction'))
  const mergeLock = useRef(false)
  const correctionLock = useRef(false)
  const noticeRef = useRef<HTMLDivElement>(null)
  const [review, setReview] = useState<ReviewState>({ kind: 'loading' })
  const [canonicalRecordId, setCanonicalRecordId] = useState('')
  const [sourceRecordId, setSourceRecordId] = useState('')
  const [fieldSelections, setFieldSelections] = useState<Partial<Record<DuplicateSupportedField, string>>>({})
  const [mergeConfirmed, setMergeConfirmed] = useState(false)
  const [correctionConfirmed, setCorrectionConfirmed] = useState(false)
  const [commandState, setCommandState] = useState<CommandState>('idle')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const access = await getWorkspaceAccessSnapshot(controller.signal)
        if (!hasCapability(access.capabilities, 'students.duplicates.review')) {
          setReview({ kind: 'denied' })
          return
        }
        const detail = await getDuplicateCandidate(candidateId, controller.signal)
        setReview({
          kind: 'ready',
          detail,
          canMerge: hasCapability(access.capabilities, 'students.duplicates.merge'),
        })
      } catch (error) {
        if (controller.signal.aborted) return
        const failure = classifyDuplicateRequestFailure(error)
        setReview({ kind: failure === 'unauthenticated' ? 'unauthenticated' : failure === 'forbidden' ? 'denied' : failure === 'not_found' ? 'not_found' : 'unavailable' })
      }
    })()
    return () => controller.abort()
  }, [candidateId, reloadToken])

  useEffect(() => {
    if (commandState === 'success' || commandState === 'corrected') noticeRef.current?.focus()
  }, [commandState])

  function changeIdentity(kind: 'canonical' | 'source', recordId: string) {
    mergeAttempt.current.rotate()
    if (kind === 'canonical') setCanonicalRecordId(recordId)
    else setSourceRecordId(recordId)
    setMergeConfirmed(false)
    setCommandState('idle')
  }

  function selectField(field: DuplicateSupportedField, recordId: string) {
    mergeAttempt.current.rotate()
    setFieldSelections((current) => ({ ...current, [field]: recordId }))
    setMergeConfirmed(false)
    setCommandState('idle')
  }

  function refreshAuthoritative() {
    mergeAttempt.current.complete()
    correctionAttempt.current.complete()
    setCanonicalRecordId('')
    setSourceRecordId('')
    setFieldSelections({})
    setMergeConfirmed(false)
    setCorrectionConfirmed(false)
    setCommandState('idle')
    setReview({ kind: 'loading' })
    setReloadToken((value) => value + 1)
  }

  async function merge() {
    if (review.kind !== 'ready' || !review.canMerge || review.detail.merge !== null || mergeLock.current) return
    const { detail } = review
    if (!mergeConfirmed || canonicalRecordId === '' || sourceRecordId === '' || canonicalRecordId === sourceRecordId) {
      setCommandState('validation')
      return
    }
    const source = profileFor(detail, sourceRecordId)
    const canonical = profileFor(detail, canonicalRecordId)
    const selections = detail.supported_fields.map((field) => ({ field_name: field, source_record_id: fieldSelections[field] ?? '' }))
    if (source === null || canonical === null || selections.some(({ source_record_id }) => source_record_id === '')) {
      setCommandState('validation')
      return
    }
    const draft: DuplicateMergeDraft = {
      source_record_id: sourceRecordId,
      canonical_record_id: canonicalRecordId,
      expected_candidate_record_version: detail.candidate.record_version,
      expected_source_record_version: source.record_version,
      expected_canonical_record_version: canonical.record_version,
      field_selections: selections,
    }
    mergeLock.current = true
    setCommandState('merging')
    try {
      const fingerprint = duplicateMergeFingerprint(detail.candidate.entity_type, draft, detail.supported_fields)
      await mergeDuplicateCandidate(detail.candidate.id, detail.candidate.entity_type, draft, detail.supported_fields, mergeAttempt.current.keyFor(fingerprint))
      mergeAttempt.current.complete()
      const authoritative = await getDuplicateCandidate(detail.candidate.id)
      setReview({ kind: 'ready', detail: authoritative, canMerge: review.canMerge })
      setCommandState('success')
    } catch (error) {
      setCommandState(commandFailure(error))
    } finally {
      mergeLock.current = false
    }
  }

  async function correct() {
    if (review.kind !== 'ready' || !review.canMerge || review.detail.merge?.status !== 'active' || correctionLock.current) return
    if (!correctionConfirmed) {
      setCommandState('validation')
      return
    }
    const mergeView = review.detail.merge
    correctionLock.current = true
    setCommandState('correcting')
    try {
      const fingerprint = duplicateCorrectionFingerprint(mergeView.id, mergeView.record_version)
      await correctDuplicateMerge(mergeView.id, mergeView.record_version, correctionAttempt.current.keyFor(fingerprint))
      correctionAttempt.current.complete()
      const authoritative = await getDuplicateCandidate(review.detail.candidate.id)
      setReview({ kind: 'ready', detail: authoritative, canMerge: review.canMerge })
      setCommandState('corrected')
    } catch (error) {
      setCommandState(commandFailure(error))
    } finally {
      correctionLock.current = false
    }
  }

  if (review.kind === 'loading') return <PageState icon="clock" title="正在載入比較資料" detail="請稍候。" />
  if (review.kind === 'unauthenticated') return <PageState icon="lock" title="工作階段已失效" detail="請重新登入後再查看比較資料。" href="/login" action="重新登入" />
  if (review.kind === 'denied') return <PageState icon="shield" title="無法查看比較資料" detail="你的帳號目前沒有審查這筆資料的權限。" href="/students/duplicates" action="返回待處理清單" />
  if (review.kind === 'not_found') return <PageState icon="users" title="找不到審查候選" detail="這筆候選不存在或已無法查看。" href="/students/duplicates" action="返回待處理清單" />
  if (review.kind === 'unavailable') return <PageState icon="x" title="比較資料服務暫時不可用" detail="請稍後重試。" onRetry={() => { setReview({ kind: 'loading' }); setReloadToken((value) => value + 1) }} />

  const { detail, canMerge } = review
  const pending = commandState === 'merging' || commandState === 'correcting'
  return <div className="max-w-6xl mx-auto space-y-6">
    <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/students/duplicates" className="quiet-link">疑似重複資料</Link><Icon name="chevron-right" size={14} /><span>人工比較</span></div>
    <header className="flex flex-col md:flex-row md:items-start md:justify-between gap-4"><div><div className="eyebrow">資料品質</div><h2 className="page-title">人工比較資料</h2><p className="page-subtitle">逐項核對兩筆資料，再決定是否合併及各欄位採用哪一筆來源。</p></div><div className="flex flex-wrap gap-2"><span className="status-pill status-warning">{detail.candidate.entity_type === 'student' ? '學生' : '監護人'}</span><span className={`status-pill ${detail.merge?.status === 'corrected' ? 'status-warning' : detail.candidate.status === 'merged' ? 'status-success' : 'status-warning'}`}>{statusLabel(detail)}</span><span className="status-pill">版本 {detail.candidate.record_version}</span></div></header>

    {(commandState === 'success' || commandState === 'corrected') ? <div ref={noticeRef} className="preview-notice" role="status" tabIndex={-1}><Icon name="check-circle" size={15} /><span>{commandState === 'success' ? '合併決定已儲存，頁面已重新載入最新資料。' : '更正已儲存，兩筆原始資料與既有歷史均獲保留。'}</span></div> : null}

    <section className="workspace-section" aria-labelledby="duplicate-comparison-heading">
      <div className="mb-5"><h3 id="duplicate-comparison-heading" className="section-title">資料並排比較</h3><p className="section-detail">左右兩欄均為目前權威資料；系統不會預先判定採用哪一筆。</p></div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 lg:divide-x" style={{ borderColor: 'var(--border)' }}>
        <ProfileColumn title="資料一" profile={detail.left_profile} fields={detail.supported_fields} />
        <ProfileColumn title="資料二" profile={detail.right_profile} fields={detail.supported_fields} />
      </div>
    </section>

    {detail.merge === null ? <section className="workspace-section" aria-labelledby="duplicate-decision-heading">
      <div className="mb-5"><h3 id="duplicate-decision-heading" className="section-title">合併決定</h3><p className="section-detail">主要資料、來源資料和每個欄位都必須由你明確選擇；沒有預設值。</p></div>
      {!canMerge ? <ReadOnlyNotice /> : <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <IdentityChoice legend="選擇主要資料" name="canonical-record" detail={detail} selected={canonicalRecordId} disabled={pending} onChange={(id) => changeIdentity('canonical', id)} />
          <IdentityChoice legend="選擇來源資料" name="source-record" detail={detail} selected={sourceRecordId} disabled={pending} onChange={(id) => changeIdentity('source', id)} />
        </div>
        <fieldset className="space-y-4" disabled={pending}><legend className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>逐欄選擇資料來源</legend>{detail.supported_fields.map((field) => <FieldChoice key={field} field={field} detail={detail} selected={fieldSelections[field] ?? ''} onChange={(id) => selectField(field, id)} />)}</fieldset>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={mergeConfirmed} onChange={(event) => { mergeAttempt.current.rotate(); setMergeConfirmed(event.target.checked); setCommandState('idle') }} disabled={pending} /><span>我確認來源資料、原始欄位和歷史紀錄都會保留；此操作不會刪除任何學生、監護人、關係或案件。</span></label>
        <CommandFeedback state={commandState} onReload={refreshAuthoritative} />
        <div className="flex justify-end"><button type="button" className="primary-button justify-center min-w-36" onClick={merge} disabled={pending} aria-busy={commandState === 'merging'}><Icon name={commandState === 'merging' ? 'clock' : 'check'} size={16} />{commandState === 'merging' ? '儲存中…' : '確認合併決定'}</button></div>
      </div>}
    </section> : <section className="workspace-section" aria-labelledby="duplicate-result-heading">
      <div className="mb-5"><h3 id="duplicate-result-heading" className="section-title">目前合併結果</h3><p className="section-detail">原始資料和歷史仍然保留；此處只顯示目前有效的人工決定。</p></div>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4"><ResultInfo label="主要資料" value={labelFor(detail, detail.merge.canonical_record_id)} /><ResultInfo label="來源資料" value={labelFor(detail, detail.merge.source_record_id)} /><ResultInfo label="決定狀態" value={detail.merge.status === 'active' ? '目前有效' : '已更正'} /></dl>
      {detail.merge.status === 'corrected' ? <div className="preview-notice mt-5" role="status"><Icon name="check-circle" size={15} /><span>這項合併決定已透過更正紀錄撤回，來源資料已恢復為獨立資料；既有歷史沒有被刪除。</span></div> : !canMerge ? <ReadOnlyNotice /> : <div className="mt-6 border-t pt-5 space-y-4" style={{ borderColor: 'var(--border)' }}><div><h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>更正合併決定</h4><p className="section-detail">更正會新增一筆紀錄並恢復來源資料，不會改寫或刪除既有合併歷史。</p></div><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={correctionConfirmed} onChange={(event) => { correctionAttempt.current.rotate(); setCorrectionConfirmed(event.target.checked); setCommandState('idle') }} disabled={pending} /><span>我確認要更正目前合併決定，並保留兩筆資料與完整歷史。</span></label><CommandFeedback state={commandState} onReload={refreshAuthoritative} /><div className="flex justify-end"><button type="button" className="secondary-button justify-center min-w-36" onClick={correct} disabled={pending} aria-busy={commandState === 'correcting'}><Icon name={commandState === 'correcting' ? 'clock' : 'rotate-ccw'} size={16} />{commandState === 'correcting' ? '更正中…' : '確認更正'}</button></div></div>}
    </section>}
  </div>
}

function ProfileColumn({ title, profile, fields }: { readonly title: string; readonly profile: DuplicateProfile; readonly fields: readonly DuplicateSupportedField[] }) {
  return <article className="min-w-0 py-2 lg:px-6 first:pl-0 last:pr-0"><h4 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>{title}</h4><dl className="space-y-4">{fields.map((field) => <div key={field}><dt className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{fieldLabel(field)}</dt><dd className="mt-1 text-sm font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{profileValue(profile, field)}</dd></div>)}</dl></article>
}

function IdentityChoice({ legend, name, detail, selected, disabled, onChange }: { readonly legend: string; readonly name: string; readonly detail: DuplicateCandidateDetail; readonly selected: string; readonly disabled: boolean; readonly onChange: (recordId: string) => void }) {
  return <fieldset className="space-y-2" disabled={disabled}><legend className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{legend}</legend>{[detail.candidate.left_record, detail.candidate.right_record].map((record, index) => <label key={record.id} className={`selection-card ${selected === record.id ? 'selected' : ''}`}><input type="radio" name={name} checked={selected === record.id} onChange={() => onChange(record.id)} /><span className="selection-mark" aria-hidden="true" /><span><strong>{index === 0 ? '資料一' : '資料二'}</strong><small className="break-words">{record.display_label}</small></span></label>)}</fieldset>
}

function FieldChoice({ field, detail, selected, onChange }: { readonly field: DuplicateSupportedField; readonly detail: DuplicateCandidateDetail; readonly selected: string; readonly onChange: (recordId: string) => void }) {
  return <fieldset className="border-t pt-4" style={{ borderColor: 'var(--border)' }}><legend className="text-xs font-semibold pr-2" style={{ color: 'var(--text-primary)' }}>{fieldLabel(field)}</legend><div className="grid grid-cols-1 md:grid-cols-2 gap-2"><FieldOption name={`field-${field}`} title="採用資料一" profile={detail.left_profile} field={field} selected={selected} onChange={onChange} /><FieldOption name={`field-${field}`} title="採用資料二" profile={detail.right_profile} field={field} selected={selected} onChange={onChange} /></div></fieldset>
}

function FieldOption({ name, title, profile, field, selected, onChange }: { readonly name: string; readonly title: string; readonly profile: DuplicateProfile; readonly field: DuplicateSupportedField; readonly selected: string; readonly onChange: (recordId: string) => void }) {
  return <label className={`selection-card ${selected === profile.id ? 'selected' : ''}`}><input type="radio" name={name} checked={selected === profile.id} onChange={() => onChange(profile.id)} /><span className="selection-mark" aria-hidden="true" /><span className="min-w-0"><strong>{title}</strong><small className="break-words">{profileValue(profile, field)}</small></span></label>
}

function CommandFeedback({ state, onReload }: { readonly state: CommandState; readonly onReload: () => void }) {
  if (state === 'idle' || state === 'merging' || state === 'correcting' || state === 'success' || state === 'corrected') return null
  if (state === 'stale') return <div className="form-error" role="alert"><Icon name="x" size={15} /><span>資料已被其他操作更新。請重新載入最新版本後再確認。<button type="button" className="secondary-button mt-3" onClick={onReload}>重新載入最新資料</button></span></div>
  const message = state === 'validation' ? '請完成主要資料、來源資料、每個欄位來源和確認選項。' : state === 'conflict' ? '這項操作與目前資料狀態衝突，請重新載入後檢查。' : state === 'denied' ? '你的帳號目前無法執行這項操作。' : '服務暫時不可用，請稍後重試；不確定結果的重試不會重複寫入。'
  return <div className="form-error" role="alert"><Icon name="x" size={15} /><span>{message}</span></div>
}

function ReadOnlyNotice() { return <div className="preview-notice" role="status"><Icon name="shield" size={15} /><span>你可以查看並比較資料，但目前沒有合併或更正權限。</span></div> }
function ResultInfo({ label, value }: { readonly label: string; readonly value: string }) { return <div><dt className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</dt><dd className="mt-1 text-sm font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{value}</dd></div> }
function PageState({ icon, title, detail, href, action, onRetry }: { readonly icon: 'clock' | 'lock' | 'shield' | 'users' | 'x'; readonly title: string; readonly detail: string; readonly href?: string; readonly action?: string; readonly onRetry?: () => void }) { return <div className="max-w-3xl mx-auto"><section className="workspace-section"><div className="empty-state"><Icon name={icon} size={20} /><strong>{title}</strong><span>{detail}</span>{href && action ? <Link href={href} className="primary-button mt-3">{action}</Link> : null}{onRetry ? <button type="button" className="secondary-button mt-3" onClick={onRetry}>重新載入</button> : null}</div></section></div> }

function profileFor(detail: DuplicateCandidateDetail, recordId: string): DuplicateProfile | null { if (detail.left_profile.id === recordId) return detail.left_profile; if (detail.right_profile.id === recordId) return detail.right_profile; return null }
function labelFor(detail: DuplicateCandidateDetail, recordId: string): string { return detail.candidate.left_record.id === recordId ? detail.candidate.left_record.display_label : detail.candidate.right_record.id === recordId ? detail.candidate.right_record.display_label : '不可用' }
function hasCapability(capabilities: readonly unknown[], expected: string): boolean { return capabilities.some((capability) => String(capability) === expected) }
function commandFailure(error: unknown): CommandState { const failure = classifyDuplicateRequestFailure(error); if (failure === 'stale') return 'stale'; if (failure === 'conflict') return 'conflict'; if (failure === 'validation') return 'validation'; if (failure === 'forbidden' || failure === 'not_found' || failure === 'unauthenticated') return 'denied'; return 'unavailable' }
function statusLabel(detail: DuplicateCandidateDetail): string { if (detail.merge?.status === 'corrected') return '已更正'; if (detail.candidate.status === 'merged') return '已完成合併決定'; return '待人工審查' }
function fieldLabel(field: DuplicateSupportedField): string { if (field === 'display_name') return '姓名'; if (field === 'date_of_birth') return '出生日期'; if (field === 'contact_email' || field === 'email') return '電郵'; return '電話' }
function profileValue(profile: DuplicateProfile, field: DuplicateSupportedField): string { const value = field in profile ? profile[field as keyof DuplicateProfile] : null; return typeof value === 'string' && value.length > 0 ? value : '未提供' }
