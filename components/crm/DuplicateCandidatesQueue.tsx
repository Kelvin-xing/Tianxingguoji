'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

import { Icon } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  DuplicateMutationIdempotencyAttempt,
  classifyDuplicateRequestFailure,
  createDuplicateCandidate,
  duplicateCandidateFingerprint,
  listDuplicateCandidates,
  searchDuplicateRecords,
  type DuplicateCandidateFilterStatus,
  type DuplicateCandidateSummary,
  type DuplicateEntityType,
  type DuplicateRecordSearchResult,
} from '@/modules/crm/client'

type QueueState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly items: readonly DuplicateCandidateSummary[] }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' }

type CreateState = 'idle' | 'creating' | 'validation' | 'conflict' | 'unavailable'

export function DuplicateCandidatesQueue() {
  const router = useRouter()
  const createAttempt = useRef(new DuplicateMutationIdempotencyAttempt('candidate'))
  const createLock = useRef(false)
  const [entityType, setEntityType] = useState<DuplicateEntityType>('student')
  const [status, setStatus] = useState<DuplicateCandidateFilterStatus>('review_required')
  const [leftRecord, setLeftRecord] = useState<DuplicateRecordSearchResult | null>(null)
  const [rightRecord, setRightRecord] = useState<DuplicateRecordSearchResult | null>(null)
  const [queue, setQueue] = useState<QueueState>({ kind: 'loading' })
  const [createState, setCreateState] = useState<CreateState>('idle')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const access = await getWorkspaceAccessSnapshot(controller.signal)
        if (!hasCapability(access.capabilities, 'students.duplicates.review')) {
          setQueue({ kind: 'denied' })
          return
        }
        const items = await listDuplicateCandidates(entityType, status, controller.signal)
        setQueue({ kind: 'ready', items })
      } catch (error) {
        if (controller.signal.aborted) return
        const failure = classifyDuplicateRequestFailure(error)
        setQueue({ kind: failure === 'unauthenticated' ? 'unauthenticated' : failure === 'forbidden' ? 'denied' : 'unavailable' })
      }
    })()
    return () => controller.abort()
  }, [entityType, status, reloadToken])

  function changeEntity(next: DuplicateEntityType) {
    createAttempt.current.complete()
    setEntityType(next)
    setLeftRecord(null)
    setRightRecord(null)
    setCreateState('idle')
    setQueue({ kind: 'loading' })
  }

  function changeStatus(next: DuplicateCandidateFilterStatus) {
    setQueue({ kind: 'loading' })
    setStatus(next)
  }

  async function createCandidate() {
    if (createLock.current) return
    if (leftRecord === null || rightRecord === null || leftRecord.id === rightRecord.id) {
      setCreateState('validation')
      return
    }
    createLock.current = true
    setCreateState('creating')
    try {
      const fingerprint = duplicateCandidateFingerprint(entityType, leftRecord.id, rightRecord.id)
      const created = await createDuplicateCandidate(
        entityType,
        leftRecord.id,
        rightRecord.id,
        createAttempt.current.keyFor(fingerprint),
      )
      createAttempt.current.complete()
      router.push(`/students/duplicates/${created.id}`)
    } catch (error) {
      const failure = classifyDuplicateRequestFailure(error)
      setCreateState(failure === 'validation' ? 'validation' : failure === 'conflict' ? 'conflict' : 'unavailable')
    } finally {
      createLock.current = false
    }
  }

  if (queue.kind === 'loading') return <PageState icon="clock" title="正在載入疑似重複資料" detail="請稍候。" />
  if (queue.kind === 'unauthenticated') return <PageState icon="lock" title="工作階段已失效" detail="請重新登入後再查看待處理資料。" href="/login" action="重新登入" />
  if (queue.kind === 'denied') return <PageState icon="shield" title="無法查看疑似重複資料" detail="你的帳號目前沒有審查這些資料的權限。" href="/students" action="返回學生名單" />
  if (queue.kind === 'unavailable') return <PageState icon="x" title="疑似重複資料服務暫時不可用" detail="請稍後重試。" onRetry={() => { setQueue({ kind: 'loading' }); setReloadToken((value) => value + 1) }} />

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <div className="eyebrow">資料品質</div>
        <h2 className="page-title">疑似重複資料審查</h2>
        <p className="page-subtitle">人工比較可能重複的學生或監護人資料，所有合併決定都需要明確確認。</p>
      </header>

      <section className="workspace-section" aria-labelledby="duplicate-create-heading">
        <div className="mb-5">
          <h3 id="duplicate-create-heading" className="section-title">建立人工審查候選</h3>
          <p className="section-detail">分別查詢並選擇兩筆資料；配對訊號由系統安全檢查，不會自動選擇或合併。</p>
        </div>
        <div className="space-y-5">
          <label className="field-label max-w-xs" htmlFor="duplicate-entity-type">
            <span>資料類型</span>
            <select id="duplicate-entity-type" value={entityType} onChange={(event) => changeEntity(event.target.value as DuplicateEntityType)} disabled={createState === 'creating'}>
              <option value="student">學生</option>
              <option value="guardian">監護人</option>
            </select>
          </label>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <RecordPicker key={`${entityType}-left`} side="left" title="資料一" entityType={entityType} selected={leftRecord} excludedId={rightRecord?.id ?? null} disabled={createState === 'creating'} onSelect={(record) => { createAttempt.current.rotate(); setLeftRecord(record); setCreateState('idle') }} />
            <RecordPicker key={`${entityType}-right`} side="right" title="資料二" entityType={entityType} selected={rightRecord} excludedId={leftRecord?.id ?? null} disabled={createState === 'creating'} onSelect={(record) => { createAttempt.current.rotate(); setRightRecord(record); setCreateState('idle') }} />
          </div>
          <CreateFeedback state={createState} />
          <div className="flex justify-end">
            <button type="button" className="primary-button justify-center min-w-36" disabled={createState === 'creating'} aria-busy={createState === 'creating'} onClick={createCandidate}>
              <Icon name={createState === 'creating' ? 'clock' : 'plus'} size={16} />
              {createState === 'creating' ? '建立中…' : '建立審查候選'}
            </button>
          </div>
        </div>
      </section>

      <section className="workspace-section" aria-labelledby="duplicate-queue-heading">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-5">
          <div><h3 id="duplicate-queue-heading" className="section-title">待處理清單</h3><p className="section-detail">只顯示安全標籤、配對訊號名稱和處理狀態。</p></div>
          <div className="flex flex-col sm:flex-row gap-3">
            <label className="field-label" htmlFor="duplicate-queue-entity"><span>資料類型</span><select id="duplicate-queue-entity" value={entityType} onChange={(event) => changeEntity(event.target.value as DuplicateEntityType)}><option value="student">學生</option><option value="guardian">監護人</option></select></label>
            <label className="field-label" htmlFor="duplicate-queue-status"><span>處理狀態</span><select id="duplicate-queue-status" value={status} onChange={(event) => changeStatus(event.target.value as DuplicateCandidateFilterStatus)}><option value="review_required">待人工審查</option><option value="merged">已完成合併決定</option></select></label>
          </div>
        </div>
        {queue.items.length === 0 ? <div className="empty-state"><Icon name="check-circle" size={20} /><strong>目前沒有符合條件的候選</strong><span>可調整資料類型或處理狀態。</span></div> : <div className="divide-y" style={{ borderColor: 'var(--border)' }}>{queue.items.map((candidate) => <CandidateRow key={candidate.id} candidate={candidate} />)}</div>}
        <div className="pt-4 text-xs" style={{ color: 'var(--text-muted)' }} aria-live="polite">共 {queue.items.length} 筆</div>
      </section>
    </div>
  )
}

function RecordPicker({ side, title, entityType, selected, excludedId, disabled, onSelect }: { readonly side: 'left' | 'right'; readonly title: string; readonly entityType: DuplicateEntityType; readonly selected: DuplicateRecordSearchResult | null; readonly excludedId: string | null; readonly disabled: boolean; readonly onSelect: (record: DuplicateRecordSearchResult) => void }) {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<{ readonly kind: 'idle' | 'searching' | 'validation' | 'unavailable'; readonly results: readonly DuplicateRecordSearchResult[] }>({ kind: 'idle', results: [] })

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = query.trim()
    if (normalized.length < 2 || normalized.length > 100) {
      setState({ kind: 'validation', results: [] })
      return
    }
    const controller = new AbortController()
    setState({ kind: 'searching', results: [] })
    try {
      const results = await searchDuplicateRecords(entityType, normalized, controller.signal)
      setState({ kind: 'idle', results })
    } catch {
      setState({ kind: 'unavailable', results: [] })
    }
  }

  return <fieldset className="border rounded-lg p-4 space-y-4" style={{ borderColor: 'var(--border)' }} disabled={disabled}>
    <legend className="px-1 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</legend>
    <form className="flex flex-col sm:flex-row gap-2" onSubmit={search} role="search">
      <label className="field-label flex-1" htmlFor={`duplicate-search-${side}`}><span>查詢{entityType === 'student' ? '學生' : '監護人'}</span><input id={`duplicate-search-${side}`} type="search" value={query} onChange={(event) => setQuery(event.target.value)} minLength={2} maxLength={100} autoComplete="off" /></label>
      <button type="submit" className="secondary-button self-end justify-center" disabled={state.kind === 'searching'} aria-busy={state.kind === 'searching'}><Icon name="search" size={15} />{state.kind === 'searching' ? '查詢中…' : '查詢'}</button>
    </form>
    {state.kind === 'validation' ? <p className="form-error" role="alert">請輸入 2 至 100 個字元。</p> : null}
    {state.kind === 'unavailable' ? <p className="form-error" role="alert">暫時無法查詢資料，請稍後重試。</p> : null}
    {selected ? <div className="preview-notice" role="status"><Icon name="check-circle" size={15} /><span>已選擇：{selected.display_label}{selected.contact_hint ? ` · ${selected.contact_hint}` : ''}</span></div> : null}
    {state.kind === 'idle' && state.results.length > 0 ? <div className="space-y-2" role="radiogroup" aria-label={`${title}查詢結果`}>{state.results.map((record) => {
      const unavailable = record.id === excludedId
      return <label key={record.id} className={`selection-card ${selected?.id === record.id ? 'selected' : ''} ${unavailable ? 'disabled' : ''}`}><input type="radio" name={`duplicate-record-${side}`} checked={selected?.id === record.id} disabled={unavailable} onChange={() => onSelect(record)} /><span className="selection-mark" aria-hidden="true" /><span className="min-w-0"><strong className="break-words">{record.display_label}</strong><small className="break-words">{record.contact_hint ?? '沒有聯絡提示'}</small></span></label>
    })}</div> : null}
    {state.kind === 'idle' && query.trim().length >= 2 && state.results.length === 0 ? <p className="text-xs" style={{ color: 'var(--text-muted)' }}>沒有找到可選資料。</p> : null}
  </fieldset>
}

function CandidateRow({ candidate }: { readonly candidate: DuplicateCandidateSummary }) {
  return <article className="py-4 first:pt-0 last:pb-0 flex flex-col md:flex-row md:items-center gap-4">
    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="status-pill status-warning">{candidate.entity_type === 'student' ? '學生' : '監護人'}</span><span className={`status-pill ${candidate.status === 'merged' ? 'status-success' : 'status-warning'}`}>{candidate.status === 'merged' ? '已完成合併決定' : '待人工審查'}</span><span className="text-xs" style={{ color: 'var(--text-muted)' }}>版本 {candidate.record_version}</span></div><h4 className="mt-2 text-sm font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{candidate.left_record.display_label} / {candidate.right_record.display_label}</h4><p className="mt-1 text-xs break-words" style={{ color: 'var(--text-muted)' }}>配對訊號：{candidate.matching_signals.map(signalLabel).join('、')}</p></div>
    <Link href={`/students/duplicates/${candidate.id}`} className="secondary-button justify-center shrink-0">查看比較<Icon name="chevron-right" size={15} /></Link>
  </article>
}

function CreateFeedback({ state }: { readonly state: CreateState }) {
  if (state === 'idle' || state === 'creating') return null
  const message = state === 'validation' ? '請明確選擇兩筆不同的資料。' : state === 'conflict' ? '這組資料已有待處理或已完成的決定，請重新載入清單。' : '服務暫時不可用，請稍後重試；重試不會重複建立候選。'
  return <div className="form-error" role="alert"><Icon name="x" size={15} /><span>{message}</span></div>
}

function PageState({ icon, title, detail, href, action, onRetry }: { readonly icon: 'clock' | 'lock' | 'shield' | 'x'; readonly title: string; readonly detail: string; readonly href?: string; readonly action?: string; readonly onRetry?: () => void }) {
  return <div className="max-w-3xl mx-auto"><section className="workspace-section"><div className="empty-state"><Icon name={icon} size={20} /><strong>{title}</strong><span>{detail}</span>{href && action ? <Link href={href} className="primary-button mt-3">{action}</Link> : null}{onRetry ? <button type="button" className="secondary-button mt-3" onClick={onRetry}>重新載入</button> : null}</div></section></div>
}

function hasCapability(capabilities: readonly unknown[], expected: string): boolean {
  return capabilities.some((capability) => String(capability) === expected)
}

function signalLabel(signal: string): string {
  if (signal === 'display_name') return '姓名'
  if (signal === 'date_of_birth') return '出生日期'
  if (signal === 'email') return '電郵'
  return '電話'
}
