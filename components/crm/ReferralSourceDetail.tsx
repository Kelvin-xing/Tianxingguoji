'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  ReferralSourceIdempotencyAttempt,
  classifyReferralSourceFailure,
  deactivateReferralSource,
  getReferralSource,
  referralSourceUpdateFingerprint,
  updateReferralSource,
  type ReferralSource,
  type ReferralSourceType,
} from '@/modules/crm/client'

type LoadState = 'loading' | 'ready' | 'unauthenticated' | 'denied' | 'not_found' | 'unavailable'
type Notice = 'success' | 'validation' | 'stale' | 'conflict' | 'denied' | 'unavailable' | null

export function ReferralSourceDetail({ sourceId }: { readonly sourceId: string }) {
  const mounted = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const inFlight = useRef(false)
  const attempt = useRef<ReferralSourceIdempotencyAttempt | null>(null)
  const editTrigger = useRef<HTMLButtonElement | null>(null)
  const nameInput = useRef<HTMLInputElement | null>(null)
  if (attempt.current === null) attempt.current = new ReferralSourceIdempotencyAttempt()

  const [state, setState] = useState<LoadState>('loading')
  const [source, setSource] = useState<ReferralSource | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [inactivate, setInactivate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const load = useCallback(async () => {
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setState('loading')
    try {
      const [nextSource, access] = await Promise.all([
        getReferralSource(sourceId, nextController.signal),
        getWorkspaceAccessSnapshot(nextController.signal),
      ])
      if (!mounted.current || nextController.signal.aborted) return
      if (!access.capabilities.some((item) => String(item) === 'referral_sources.read')) {
        setState('denied')
        setSource(null)
        return
      }
      setSource(nextSource)
      setCanManage(access.capabilities.some((item) => String(item) === 'referral_sources.manage'))
      setDisplayName(nextSource.display_name)
      setDescription(nextSource.description ?? '')
      setInactivate(false)
      setState('ready')
    } catch (error) {
      if (!mounted.current || nextController.signal.aborted) return
      const failure = classifyReferralSourceFailure(error)
      setSource(null)
      setCanManage(false)
      setState(failure === 'unauthenticated' ? 'unauthenticated' : failure === 'forbidden' ? 'denied' : failure === 'not_found' ? 'not_found' : 'unavailable')
    } finally {
      if (controller.current === nextController) controller.current = null
    }
  }, [sourceId])

  useEffect(() => {
    mounted.current = true
    queueMicrotask(() => { if (mounted.current) void load() })
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [load])

  useEffect(() => {
    if (editing) nameInput.current?.focus()
    else if (notice === 'success' || notice === 'stale' || notice === 'conflict') editTrigger.current?.focus()
  }, [editing, notice])

  function cancel() {
    if (saving || source === null) return
    attempt.current!.complete()
    setDisplayName(source.display_name)
    setDescription(source.description ?? '')
    setInactivate(false)
    setNotice(null)
    setEditing(false)
    queueMicrotask(() => editTrigger.current?.focus())
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current || saving || source === null || !canManage) return
    const nextName = displayName.trim()
    const nextDescription = source.source_type === 'other' ? description.trim() : null
    const profileChanged = nextName !== source.display_name || nextDescription !== source.description
    if (nextName.length < 1 || nextName.length > 200 ||
        (source.source_type === 'other' && description.trim().length === 0) ||
        (!profileChanged && !inactivate) || (profileChanged && inactivate)) {
      setNotice('validation')
      return
    }
    const draft = {
      expected_record_version: source.record_version,
      display_name: nextName,
      source_type: source.source_type,
      description: nextDescription,
    } as const
    inFlight.current = true
    setSaving(true)
    setNotice(null)
    try {
      const receipt = inactivate
        ? await deactivateReferralSource(
            source.id,
            { expected_record_version: source.record_version, reason_code: 'record.lifecycle.referral_source_deactivated' },
            attempt.current!.keyFor(JSON.stringify({ source_id: source.id, action: 'deactivate', expected_record_version: source.record_version })),
          )
        : await updateReferralSource(
            source.id,
            draft,
            attempt.current!.keyFor(referralSourceUpdateFingerprint(source.id, draft)),
          )
      const authoritative = await getReferralSource(source.id)
      if (authoritative.record_version !== receipt.referral_source.record_version) {
        throw new TypeError('ReferralSource authority mismatch.')
      }
      if (!mounted.current) return
      attempt.current!.complete()
      setSource(authoritative)
      setDisplayName(authoritative.display_name)
      setDescription(authoritative.description ?? '')
      setInactivate(false)
      setEditing(false)
      setNotice('success')
      queueMicrotask(() => editTrigger.current?.focus())
    } catch (error) {
      if (!mounted.current) return
      const failure = classifyReferralSourceFailure(error)
      if (failure === 'stale' || failure === 'conflict') {
        attempt.current!.rotate()
        try {
          const authoritative = await getReferralSource(source.id)
          if (!mounted.current) return
          setSource(authoritative)
          setDisplayName(authoritative.display_name)
          setDescription(authoritative.description ?? '')
          setInactivate(false)
          setEditing(false)
          setNotice(failure)
        } catch {
          setNotice('unavailable')
        }
      } else {
        if (failure !== 'unavailable') attempt.current!.rotate()
        setNotice(failure === 'validation' ? 'validation' : failure === 'forbidden' || failure === 'unauthenticated' ? 'denied' : 'unavailable')
      }
    } finally {
      inFlight.current = false
      if (mounted.current) setSaving(false)
    }
  }

  if (state !== 'ready' || source === null) {
    const content = state === 'loading' ? ['正在載入推薦來源', '請稍候。']
      : state === 'unauthenticated' ? ['工作階段已失效', '請重新登入後再查看推薦來源。']
        : state === 'denied' ? ['無法查看推薦來源', '目前帳號沒有查看此資料的權限。']
          : state === 'not_found' ? ['找不到推薦來源', '這筆資料不存在或目前不可見。']
            : ['推薦來源服務暫時不可用', '請稍後重試。']
    return <div className="max-w-[900px] mx-auto"><section className="workspace-section" aria-busy={state === 'loading'}><div className="empty-state"><strong>{content[0]}</strong><div className="mt-1">{content[1]}</div>{state === 'unauthenticated' ? <Link href="/login" className="primary-button mt-3">重新登入</Link> : null}{state === 'unavailable' ? <button type="button" className="secondary-button mt-3" onClick={() => void load()}>重新載入</button> : null}</div></section></div>
  }

  return (
    <div className="max-w-[900px] mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <Link href="/referral-sources" className="quiet-link">推薦來源</Link><Icon name="chevron-right" size={14} /><span>來源詳情</span>
      </div>
      <section className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow">推薦來源</div>
          <h2 className="page-title break-words">{source.display_name}</h2>
          <p className="page-subtitle">{sourceTypeLabel(source.source_type)} · 版本 {source.record_version}</p>
        </div>
        <span className={`status-pill ${source.status === 'active' ? 'status-success' : 'status-warning'} self-start`}>{source.status === 'active' ? '有效' : '已停用'}</span>
      </section>

      {notice ? <NoticeView notice={notice} /> : null}

      <section className="workspace-section" aria-labelledby="referral-source-details-title" aria-busy={saving}>
        <div className="flex items-start justify-between gap-3 mb-5">
          <div>
            <h3 id="referral-source-details-title" className="section-title">來源資料</h3>
            <p className="section-detail">來源類型建立後不能更改；停用後不能重新啟用。</p>
          </div>
          {canManage && !editing ? <button ref={editTrigger} type="button" className="secondary-button" onClick={() => { setNotice(null); setEditing(true) }}><Icon name="settings" size={15} />編輯來源</button> : null}
        </div>

        {editing ? (
          <form onSubmit={submit} className="space-y-4">
            <label className="field-label">顯示名稱<input ref={nameInput} value={displayName} maxLength={200} required disabled={saving} onChange={(event) => { setDisplayName(event.target.value); setNotice(null) }} /></label>
            <div><div className="field-label">來源類型</div><div className="locked-field mt-2">{sourceTypeLabel(source.source_type)}</div></div>
            {source.source_type === 'other' ? <label className="field-label">其他來源說明<input value={description} maxLength={500} required disabled={saving} onChange={(event) => { setDescription(event.target.value); setNotice(null) }} /></label> : null}
            {source.status === 'active' ? (
              <label className="inline-callout warning">
                <input type="checkbox" aria-label="停用此來源" checked={inactivate} disabled={saving} onChange={(event) => { setInactivate(event.target.checked); setNotice(null) }} />
                <span><strong>停用此來源</strong><br />停用後仍會保留既有案件歷史，但不能再建立新的案件關聯，也不能重新啟用。</span>
              </label>
            ) : <div className="inline-callout warning"><Icon name="lock" size={16} /><span>此來源已停用；可以更新顯示名稱，但不能重新啟用。</span></div>}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="secondary-button" disabled={saving} onClick={cancel}>取消</button>
              <button type="submit" className="primary-button" disabled={saving} aria-busy={saving}><Icon name="check" size={15} />{saving ? '正在儲存' : '儲存來源'}</button>
            </div>
          </form>
        ) : (
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Info label="顯示名稱" value={source.display_name} />
            <Info label="來源類型" value={sourceTypeLabel(source.source_type)} />
            <Info label="狀態" value={source.status === 'active' ? '有效' : '已停用'} />
          </dl>
        )}
      </section>
    </div>
  )
}

function NoticeView({ notice }: { readonly notice: Exclude<Notice, null> }) {
  const success = notice === 'success'
  const message = success ? '推薦來源已更新，資料已重新載入。'
    : notice === 'validation' ? '請輸入有效資料並只執行一項變更；其他來源必須保留說明。'
      : notice === 'stale' ? '資料已有較新版本，已重新載入，請再次確認。'
        : notice === 'conflict' ? '目前狀態不接受這項變更，資料已重新載入。'
          : notice === 'denied' ? '目前帳號不能更新推薦來源。'
            : '結果暫時無法確認，請稍後重試；重試不會重複更新。'
  return <div className={success ? 'inline-callout' : 'form-error'} role={success ? 'status' : 'alert'} tabIndex={-1}><Icon name={success ? 'check-circle' : 'x'} size={16} /><span>{message}</span></div>
}

function Info({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</dt><dd className="mt-1 text-sm font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{value}</dd></div>
}

function sourceTypeLabel(type: ReferralSourceType): string {
  const labels: Readonly<Record<ReferralSourceType, string>> = {
    customer_referral: '客戶推薦', employee_referral: '員工推薦', school_referral: '學校推薦',
    partner_referral: '合作夥伴推薦', website: '網站', social_media: '社交媒體',
    paid_advertising: '付費廣告', event: '活動', walk_in: '直接查詢', other: '其他', unknown: '未知',
  }
  return labels[type]
}
