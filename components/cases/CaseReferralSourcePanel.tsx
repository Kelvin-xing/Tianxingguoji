'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  CaseReferralSourceIdempotencyAttempt,
  assignCaseReferralSource,
  caseReferralSourceFingerprint,
  classifyCaseReferralSourceFailure,
  getCaseReferralSourceAssignments,
  type CaseReferralSourceAssignment,
  type CaseReferralSourceAssignments,
} from '@/modules/cases/client'
import {
  classifyReferralSourceFailure,
  listReferralSources,
  type ReferralSource,
  type ReferralSourceType,
} from '@/modules/crm/client'

type LoadState = 'loading' | 'ready' | 'unauthenticated' | 'denied' | 'unavailable'
type Notice = 'success' | 'validation' | 'stale' | 'conflict' | 'denied' | 'unavailable' | null

export function CaseReferralSourcePanel({ caseId }: { readonly caseId: string }) {
  const mounted = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const inFlight = useRef(false)
  const sourceSelect = useRef<HTMLSelectElement | null>(null)
  const attempt = useRef<CaseReferralSourceIdempotencyAttempt | null>(null)
  if (attempt.current === null) attempt.current = new CaseReferralSourceIdempotencyAttempt()

  const [state, setState] = useState<LoadState>('loading')
  const [view, setView] = useState<CaseReferralSourceAssignments | null>(null)
  const [activeSources, setActiveSources] = useState<readonly ReferralSource[]>([])
  const [canAssign, setCanAssign] = useState(false)
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [confirmedReplacement, setConfirmedReplacement] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const load = useCallback(async () => {
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setState('loading')
    try {
      const [assignments, access] = await Promise.all([
        getCaseReferralSourceAssignments(caseId, nextController.signal),
        getWorkspaceAccessSnapshot(nextController.signal),
      ])
      if (!mounted.current || nextController.signal.aborted) return
      const nextCanAssign = access.capabilities.some((item) => String(item) === 'cases.referral_sources.assign')
      const sources = nextCanAssign ? (await listReferralSources('active', nextController.signal)).items : []
      if (!mounted.current || nextController.signal.aborted) return
      setView(assignments)
      setCanAssign(nextCanAssign)
      setActiveSources(sources)
      setState('ready')
    } catch (error) {
      if (!mounted.current || nextController.signal.aborted) return
      const caseFailure = classifyCaseReferralSourceFailure(error)
      const sourceFailure = classifyReferralSourceFailure(error)
      setView(null)
      setActiveSources([])
      setCanAssign(false)
      setState(
        caseFailure === 'unauthenticated' || sourceFailure === 'unauthenticated' ? 'unauthenticated'
          : caseFailure === 'forbidden' || sourceFailure === 'forbidden' ? 'denied'
            : 'unavailable',
      )
    } finally {
      if (controller.current === nextController) controller.current = null
    }
  }, [caseId])

  useEffect(() => {
    mounted.current = true
    queueMicrotask(() => { if (mounted.current) void load() })
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [load])

  useEffect(() => {
    if (notice === 'success' || notice === 'stale' || notice === 'conflict') sourceSelect.current?.focus()
  }, [notice])

  function changeSelection(value: string) {
    setSelectedSourceId(value)
    setConfirmedReplacement(false)
    setNotice(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current || saving || !canAssign || view === null) return
    if (selectedSourceId === '' || selectedSourceId === view.current?.referral_source_id) {
      setNotice('validation')
      return
    }
    if (view.current !== null && !confirmedReplacement) {
      setNotice('validation')
      return
    }
    const draft = {
      referral_source_id: selectedSourceId,
      expected_current_assignment_record_version: view.current?.record_version ?? null,
    } as const
    inFlight.current = true
    setSaving(true)
    setNotice(null)
    try {
      const receipt = await assignCaseReferralSource(
        caseId,
        draft,
        attempt.current!.keyFor(caseReferralSourceFingerprint(caseId, draft)),
      )
      const authoritative = await getCaseReferralSourceAssignments(caseId)
      if (authoritative.current?.id !== receipt.id || authoritative.current.record_version !== receipt.record_version) {
        throw new TypeError('Case referral source authority mismatch.')
      }
      if (!mounted.current) return
      attempt.current!.complete()
      setView(authoritative)
      setSelectedSourceId('')
      setConfirmedReplacement(false)
      setNotice('success')
    } catch (error) {
      if (!mounted.current) return
      const failure = classifyCaseReferralSourceFailure(error)
      if (failure === 'stale' || failure === 'conflict') {
        attempt.current!.rotate()
        try {
          const authoritative = await getCaseReferralSourceAssignments(caseId)
          if (!mounted.current) return
          setView(authoritative)
          setSelectedSourceId('')
          setConfirmedReplacement(false)
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

  if (state !== 'ready' || view === null) {
    const title = state === 'loading' ? '正在載入案件推薦來源'
      : state === 'unauthenticated' ? '工作階段已失效'
        : state === 'denied' ? '無法查看案件推薦來源'
          : '推薦來源服務暫時不可用'
    const detail = state === 'loading' ? '請稍候。'
      : state === 'unauthenticated' ? '請重新登入後再查看。'
        : state === 'denied' ? '目前帳號沒有查看此案件來源的權限。'
          : '請稍後重試，已儲存的案件資料不受影響。'
    return <section className="workspace-section" aria-busy={state === 'loading'}><div className="empty-state"><strong>{title}</strong><div className="mt-1">{detail}</div>{state === 'unavailable' ? <button type="button" className="secondary-button mt-3" onClick={() => void load()}>重新載入</button> : null}</div></section>
  }

  return (
    <section className="workspace-section" aria-labelledby="case-referral-source-title" aria-busy={saving}>
      <div className="mb-5">
        <h3 id="case-referral-source-title" className="section-title">案件推薦來源</h3>
        <p className="section-detail">更換來源會結束目前關聯並新增一筆記錄；既有歷史及當時的來源名稱、類型與版本會保留。</p>
      </div>

      {notice ? <NoticeView notice={notice} /> : null}

      <div className="space-y-5">
        <div>
          <h4 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>目前來源</h4>
          {view.current ? <AssignmentView assignment={view.current} current /> : <div className="empty-state py-6"><strong>尚未設定推薦來源</strong><div className="mt-1">本案目前沒有來源關聯。</div></div>}
        </div>

        {canAssign ? (
          <form onSubmit={submit} className="border-t pt-5 space-y-4" style={{ borderColor: 'var(--border-subtle)' }}>
            <div>
              <h4 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{view.current ? '更換推薦來源' : '設定推薦來源'}</h4>
              <p className="section-detail">只能選擇目前有效的來源。</p>
            </div>
            {activeSources.length === 0 ? <div className="inline-callout warning"><Icon name="clock" size={16} /><span>目前沒有可用的推薦來源。</span></div> : (
              <label className="field-label max-w-xl">
                選擇有效來源
                <select ref={sourceSelect} value={selectedSourceId} disabled={saving} required onChange={(event) => changeSelection(event.target.value)}>
                  <option value="">請選擇</option>
                  {activeSources.map((source) => <option key={source.id} value={source.id} disabled={source.id === view.current?.referral_source_id}>{source.display_name} · {sourceTypeLabel(source.source_type)}</option>)}
                </select>
              </label>
            )}
            {view.current !== null && selectedSourceId !== '' ? (
              <label className="inline-callout warning max-w-2xl">
                <input type="checkbox" aria-label="確認更換目前來源" checked={confirmedReplacement} disabled={saving} onChange={(event) => { setConfirmedReplacement(event.target.checked); setNotice(null) }} />
                <span>我確認更換目前來源。原關聯會轉入歷史，不會被覆寫或刪除。</span>
              </label>
            ) : null}
            <button type="submit" className="primary-button" disabled={saving || activeSources.length === 0} aria-busy={saving}><Icon name="check" size={15} />{saving ? '正在儲存' : view.current ? '確認更換來源' : '儲存來源'}</button>
          </form>
        ) : <div className="inline-callout"><Icon name="lock" size={16} /><span>你可以查看案件來源與歷史，但目前不能變更來源。</span></div>}

        <div className="border-t pt-5" style={{ borderColor: 'var(--border-subtle)' }}>
          <h4 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>歷史關聯</h4>
          <p className="section-detail">每筆記錄顯示建立關聯當時保留的來源資料。</p>
          {view.history.length === 0 ? <div className="empty-state py-6">尚無歷史關聯。</div> : <ul className="mt-3 divide-y" style={{ borderColor: 'var(--border-subtle)' }}>{view.history.map((item) => <li key={item.id}><AssignmentView assignment={item} /></li>)}</ul>}
        </div>
      </div>
    </section>
  )
}

function AssignmentView({ assignment, current = false }: { readonly assignment: CaseReferralSourceAssignment; readonly current?: boolean }) {
  return <div className="py-3 flex flex-col sm:flex-row sm:items-start justify-between gap-2"><div className="min-w-0"><strong className="table-primary break-words">{assignment.source_display_name}</strong><div className="table-secondary">{sourceTypeLabel(assignment.source_type)} · 來源版本 {assignment.source_record_version}</div><div className="table-secondary">開始 {formatDate(assignment.starts_at)}{assignment.ends_at ? ` · 結束 ${formatDate(assignment.ends_at)}` : ''}</div></div>{current ? <span className="status-pill status-success self-start">目前使用</span> : <span className="status-pill self-start">已結束</span>}</div>
}

function NoticeView({ notice }: { readonly notice: Exclude<Notice, null> }) {
  const success = notice === 'success'
  const message = success ? '案件推薦來源已更新，資料已重新載入。'
    : notice === 'validation' ? '請選擇不同的有效來源；更換目前來源時也要完成確認。'
      : notice === 'stale' ? '案件來源已有較新版本，已重新載入，請再次確認。'
        : notice === 'conflict' ? '目前案件或來源狀態不接受這項變更，資料已重新載入。'
          : notice === 'denied' ? '目前帳號不能變更此案件的推薦來源。'
            : '結果暫時無法確認，請稍後重試；重試不會重複建立關聯。'
  return <div className={success ? 'inline-callout mb-4' : 'form-error mb-4'} role={success ? 'status' : 'alert'}><Icon name={success ? 'check-circle' : 'x'} size={16} /><span>{message}</span></div>
}

function sourceTypeLabel(type: ReferralSourceType): string {
  const labels: Readonly<Record<ReferralSourceType, string>> = {
    customer_referral: '客戶推薦', employee_referral: '員工推薦', school_referral: '學校推薦',
    partner_referral: '合作夥伴推薦', website: '網站', social_media: '社交媒體',
    paid_advertising: '付費廣告', event: '活動', walk_in: '直接查詢', other: '其他', unknown: '未知',
  }
  return labels[type]
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-HK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hong_Kong' }).format(new Date(value))
}
