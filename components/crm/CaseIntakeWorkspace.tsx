'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'

import { createK12Case, listIntakeOptions, type IntakeOptionsDto } from '@/components/crm/f2-contract'
import { DeniedState, ErrorState, LoadingState, StaleState, SuccessState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError } from '@/lib/api/client'

export function CaseIntakeWorkspace() {
  const [options, setOptions] = useState<IntakeOptionsDto | null>(null)
  const [studentId, setStudentId] = useState('')
  const [advisorId, setAdvisorId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [intakeYear, setIntakeYear] = useState(String(new Date().getFullYear() + 1))
  const [admissionType, setAdmissionType] = useState<'entry' | 'transfer'>('entry')
  const [signedAt, setSignedAt] = useState('')
  const signedAtInput = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'unavailable' | 'error' | 'stale' | 'success'>('loading')
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<{ readonly case_id: string; readonly assessment_url: string } | null>(null)

  useEffect(() => {
    const preselected = new URLSearchParams(window.location.search).get('studentId')
    if (preselected) setStudentId(preselected)
    void listIntakeOptions().then((value) => { setOptions(value); setStudentId((current) => current || value.students[0]?.id || ''); setAdvisorId(value.advisors[0]?.id || ''); setState('ready') }).catch((error: unknown) => {
      const code = error instanceof ApiClientError ? error.code : 'UNAVAILABLE'
      setErrorCode(code)
      setState(code === 'FORBIDDEN' ? 'denied' : 'unavailable')
    })
  }, [])

  const selectedStudent = useMemo(() => options?.students.find((item) => item.id === studentId), [options, studentId])
  const selectedAdvisor = useMemo(() => options?.advisors.find((item) => item.id === advisorId), [options, advisorId])
  const selectedSource = useMemo(() => options?.referral_sources.find((item) => item.id === sourceId), [options, sourceId])

  async function submit() {
    setErrorCode(null)
    const submittedSignedAt = signedAtInput.current?.value || signedAt
    if (!studentId || !advisorId || !intakeYear || !submittedSignedAt) { setState('error'); setErrorCode('VALIDATION_FAILED'); return }
    setState('loading')
    try {
      const result = await createK12Case({ student_id: studentId, primary_advisor_role_binding_id: advisorId, referral_source_id: sourceId || null, intake_year: Number(intakeYear), admission_type: admissionType, signed_at: new Date(submittedSignedAt).toISOString() }, crypto.randomUUID())
      setReceipt({ case_id: result.case_id, assessment_url: result.assessment_url }); setState('success')
    } catch (error: unknown) {
      setErrorCode(error instanceof ApiClientError ? error.code : 'CREATE_FAILED')
      if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setState('denied')
      else if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setState('stale')
      else setState(error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE' ? 'unavailable' : 'error')
    }
  }

  if (state === 'loading' && !options) return <LoadingState title="正在載入案件選項" detail="請稍候。" />
  if (state === 'denied') return <DeniedState title="目前帳號無法建立案件" detail="只有負責顧問可以建立案件。" onRetry={() => window.location.reload()} />
  if (state === 'unavailable') return <UnavailableState title="案件選項暫時不可用" detail="請稍後重試。" onRetry={() => window.location.reload()} />
  if (state === 'stale') return <StaleState title="案件資料已更新" detail="請重新載入選項後再試。" onRetry={() => window.location.reload()} />
  if (state === 'success' && receipt) return <SuccessState title="案件已建立" detail="案件已建立，可以開始填寫評估。" action={<div className="flex flex-wrap gap-2"><Link className="primary-button" href={receipt.assessment_url}>開啟評估</Link><Link className="secondary-button" href="/cases">返回案件</Link></div>} />
  if (state === 'error') return <ErrorState title="案件建立未完成" detail={errorCode === 'VALIDATION_FAILED' ? '請完成學生、主要顧問、入學年度和簽署時間。' : errorCode === 'CONFLICT' ? '該學生已有相同入學年度和申請類型的進行中案件。' : '請檢查資料後重試。'} onRetry={() => setState('ready')} />

  return <div className="workspace-section space-y-5"><div><h3 className="section-title">建立案件</h3><p className="section-detail">選擇學生、主要顧問和入學設定。</p></div><label className="field-label"><span>學生 *</span><select value={studentId} onChange={(event) => setStudentId(event.target.value)}><option value="">選擇學生</option>{options?.students.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label><label className="field-label"><span>主要顧問 *</span><select value={advisorId} onChange={(event) => setAdvisorId(event.target.value)}><option value="">選擇顧問</option>{options?.advisors.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label><label className="field-label"><span>推薦來源（可選）</span><select value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">不指定</option>{options?.referral_sources.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><label className="field-label"><span>入學年度 *</span><input type="number" min="2000" max="2200" value={intakeYear} onChange={(event) => setIntakeYear(event.target.value)} /></label><label className="field-label"><span>申請類型 *</span><select value={admissionType} onChange={(event) => setAdmissionType(event.target.value as typeof admissionType)}><option value="entry">首次入學</option><option value="transfer">插班</option></select></label></div><label className="field-label"><span>簽署時間（香港時間）*</span><input ref={signedAtInput} type="datetime-local" value={signedAt} onChange={(event) => setSignedAt(event.target.value)} onInput={(event) => setSignedAt(event.currentTarget.value)} onBlur={(event) => setSignedAt(event.currentTarget.value)} /></label><section className="inline-callout"><span>資料預覽：{selectedStudent?.display_name ?? '未選擇學生'} · {selectedAdvisor?.display_name ?? '未選擇顧問'} · {selectedSource?.display_name ?? '未指定推薦來源'} · {intakeYear} · {admissionType === 'entry' ? '首次入學' : '插班'} · {formatHongKong(signedAt)}</span></section><div className="flex justify-between gap-2"><Link href={studentId ? `/students/${studentId}` : '/cases'} className="secondary-button">取消</Link><button type="button" className="primary-button" onClick={() => void submit()} disabled={state === 'loading'}>建立案件</button></div></div>
}

function formatHongKong(value: string) {
  if (!value) return '未填寫'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '格式無效'
  return new Intl.DateTimeFormat('zh-HK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hong_Kong' }).format(parsed)
}
