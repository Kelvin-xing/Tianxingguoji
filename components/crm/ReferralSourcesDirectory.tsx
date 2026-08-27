'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  REFERRAL_SOURCE_STATUSES,
  REFERRAL_SOURCE_TYPES,
  ReferralSourceIdempotencyAttempt,
  classifyReferralSourceFailure,
  createReferralSource,
  getReferralSource,
  listReferralSources,
  referralSourceCreateFingerprint,
  type ReferralSource,
  type ReferralSourceStatus,
  type ReferralSourceType,
} from '@/modules/crm/client'

type LoadState = 'loading' | 'ready' | 'unauthenticated' | 'denied' | 'unavailable'
type Notice = 'success' | 'validation' | 'conflict' | 'denied' | 'unavailable' | null
type StatusFilter = ReferralSourceStatus | 'all'

export function ReferralSourcesDirectory() {
  const mounted = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  const nameInput = useRef<HTMLInputElement | null>(null)
  const attempt = useRef<ReferralSourceIdempotencyAttempt | null>(null)
  if (attempt.current === null) attempt.current = new ReferralSourceIdempotencyAttempt()

  const [state, setState] = useState<LoadState>('loading')
  const [sources, setSources] = useState<readonly ReferralSource[]>([])
  const [canManage, setCanManage] = useState(false)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [displayName, setDisplayName] = useState('')
  const [sourceType, setSourceType] = useState<ReferralSourceType>('website')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const load = useCallback(async (nextFilter: StatusFilter) => {
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setState('loading')
    try {
      const [nextSources, access] = await Promise.all([
        listReferralSources(nextFilter === 'all' ? undefined : nextFilter, nextController.signal),
        getWorkspaceAccessSnapshot(nextController.signal),
      ])
      if (!mounted.current || nextController.signal.aborted) return
      const canRead = access.capabilities.some((item) => String(item) === 'referral_sources.read')
      if (!canRead) {
        setSources([])
        setCanManage(false)
        setState('denied')
        return
      }
      setSources(nextSources.items)
      setCanManage(access.capabilities.some((item) => String(item) === 'referral_sources.manage'))
      setState('ready')
    } catch (error) {
      if (!mounted.current || nextController.signal.aborted) return
      const failure = classifyReferralSourceFailure(error)
      setSources([])
      setCanManage(false)
      setState(failure === 'unauthenticated' ? 'unauthenticated' : failure === 'forbidden' ? 'denied' : 'unavailable')
    } finally {
      if (controller.current === nextController) controller.current = null
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    queueMicrotask(() => { if (mounted.current) void load(filter) })
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [filter, load])

  useEffect(() => {
    if (notice === 'success') nameInput.current?.focus()
  }, [notice])

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || saving || !canManage) return
    const draft = {
      display_name: displayName.trim(),
      source_type: sourceType,
      description: sourceType === 'other' ? description.trim() : null,
    } as const
    if (draft.display_name.length < 1 || draft.display_name.length > 200 ||
        (sourceType === 'other' && description.trim().length === 0)) {
      setNotice('validation')
      return
    }
    submitting.current = true
    setSaving(true)
    setNotice(null)
    try {
      const fingerprint = referralSourceCreateFingerprint(draft)
      const receipt = await createReferralSource(draft, attempt.current!.keyFor(fingerprint))
      const authoritative = await getReferralSource(receipt.referral_source.id)
      if (authoritative.record_version !== receipt.referral_source.record_version) {
        throw new TypeError('ReferralSource authority mismatch.')
      }
      const nextSources = await listReferralSources(filter === 'all' ? undefined : filter)
      if (!mounted.current) return
      attempt.current!.complete()
      setSources(nextSources.items)
      setDisplayName('')
      setSourceType('website')
      setDescription('')
      setNotice('success')
    } catch (error) {
      if (!mounted.current) return
      const failure = classifyReferralSourceFailure(error)
      if (failure !== 'unavailable') attempt.current!.rotate()
      setNotice(
        failure === 'validation' ? 'validation'
          : failure === 'conflict' || failure === 'stale' ? 'conflict'
            : failure === 'forbidden' || failure === 'unauthenticated' ? 'denied'
              : 'unavailable',
      )
    } finally {
      submitting.current = false
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="eyebrow">客戶來源</div>
          <h2 className="page-title">推薦來源</h2>
          <p className="page-subtitle">維護經批准的客戶推薦、網站、活動及其他來源資料。</p>
        </div>
        <label className="select-field self-start md:self-auto">
          <Icon name="filter" size={15} />
          <span className="sr-only">篩選來源狀態</span>
          <select
            aria-label="篩選來源狀態"
            value={filter}
            disabled={state === 'loading'}
            onChange={(event) => {
              setNotice(null)
              setFilter(event.target.value as StatusFilter)
            }}
          >
            <option value="all">全部狀態</option>
            {REFERRAL_SOURCE_STATUSES.map((status) => (
              <option value={status} key={status}>{statusLabel(status)}</option>
            ))}
          </select>
        </label>
      </section>

      {canManage && state === 'ready' ? (
        <section className="workspace-section" aria-labelledby="create-referral-source-title">
          <div className="mb-4">
            <h3 id="create-referral-source-title" className="section-title">新增推薦來源</h3>
            <p className="section-detail">名稱可以重複；來源類型建立後不能更改。</p>
          </div>
          <form onSubmit={submitCreate} className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(12rem,0.45fr)_auto] gap-3 items-end" aria-busy={saving}>
            <label className="field-label">
              顯示名稱
              <input
                ref={nameInput}
                value={displayName}
                maxLength={200}
                required
                disabled={saving}
                autoComplete="off"
                onChange={(event) => { setDisplayName(event.target.value); setNotice(null) }}
              />
            </label>
            <label className="field-label">
              來源類型
              <select
                value={sourceType}
                disabled={saving}
                onChange={(event) => {
                  const nextType = event.target.value as ReferralSourceType
                  setSourceType(nextType)
                  if (nextType !== 'other') setDescription('')
                  setNotice(null)
                }}
              >
                {REFERRAL_SOURCE_TYPES.map((type) => <option value={type} key={type}>{sourceTypeLabel(type)}</option>)}
              </select>
            </label>
            {sourceType === 'other' ? (
              <label className="field-label md:col-span-2">
                其他來源說明
                <input value={description} maxLength={500} required disabled={saving} onChange={(event) => { setDescription(event.target.value); setNotice(null) }} />
              </label>
            ) : null}
            <button type="submit" className="primary-button" disabled={saving} aria-busy={saving}>
              <Icon name="plus" size={15} />{saving ? '正在建立' : '建立來源'}
            </button>
          </form>
          <NoticeView notice={notice} />
        </section>
      ) : null}

      <section className="workspace-section" aria-busy={state === 'loading'} aria-labelledby="referral-source-list-title">
        <div className="mb-4">
          <h3 id="referral-source-list-title" className="section-title">來源名單</h3>
          <p className="section-detail">已停用來源仍保留供案件歷史查閱，但不能建立新的案件關聯。</p>
        </div>
        {state === 'loading' ? <State title="正在載入推薦來源" detail="請稍候。" /> : null}
        {state === 'unauthenticated' ? <State title="工作階段已失效" detail="請重新登入後再查看推薦來源。" href="/login" /> : null}
        {state === 'denied' ? <State title="無法查看推薦來源" detail="目前帳號沒有查看推薦來源的權限。" /> : null}
        {state === 'unavailable' ? <State title="推薦來源服務暫時不可用" detail="請稍後重試。" onRetry={() => void load(filter)} /> : null}
        {state === 'ready' && sources.length === 0 ? <State title="目前沒有推薦來源" detail="此篩選條件下沒有可顯示的資料。" /> : null}
        {state === 'ready' && sources.length > 0 ? (
          <ul className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {sources.map((source) => (
              <li key={source.id} className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/referral-sources/${source.id}`} className="table-primary break-words">{source.display_name}</Link>
                  <div className="table-secondary">{sourceTypeLabel(source.source_type)} · 版本 {source.record_version}</div>
                </div>
                <span className={`status-pill ${source.status === 'active' ? 'status-success' : 'status-warning'} self-start sm:self-auto`}>
                  {statusLabel(source.status)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  )
}

function NoticeView({ notice }: { readonly notice: Notice }) {
  if (notice === null) return null
  const message = notice === 'success' ? '推薦來源已建立，名單已重新載入。'
    : notice === 'validation' ? '請填寫 1 至 200 個字的顯示名稱；其他來源也必須填寫說明。'
      : notice === 'conflict' ? '資料已改變或本次操作有衝突，請確認後再試。'
        : notice === 'denied' ? '目前帳號不能建立推薦來源。'
          : '結果暫時無法確認，請稍後重試；重試不會重複建立。'
  return <div className={notice === 'success' ? 'inline-callout mt-4' : 'form-error mt-4'} role={notice === 'success' ? 'status' : 'alert'}><Icon name={notice === 'success' ? 'check-circle' : 'x'} size={16} /><span>{message}</span></div>
}

function State({ title, detail, href, onRetry }: { readonly title: string; readonly detail: string; readonly href?: string; readonly onRetry?: () => void }) {
  return <div className="empty-state"><strong>{title}</strong><div className="mt-1">{detail}</div>{href ? <Link href={href} className="primary-button mt-3">重新登入</Link> : null}{onRetry ? <button type="button" className="secondary-button mt-3" onClick={onRetry}>重新載入</button> : null}</div>
}

function sourceTypeLabel(type: ReferralSourceType): string {
  const labels: Readonly<Record<ReferralSourceType, string>> = {
    customer_referral: '客戶推薦', employee_referral: '員工推薦', school_referral: '學校推薦',
    partner_referral: '合作夥伴推薦', website: '網站', social_media: '社交媒體',
    paid_advertising: '付費廣告', event: '活動', walk_in: '直接查詢', other: '其他', unknown: '未知',
  }
  return labels[type]
}

function statusLabel(status: ReferralSourceStatus): string {
  return status === 'active' ? '有效' : '已停用'
}
