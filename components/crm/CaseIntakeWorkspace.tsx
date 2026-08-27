'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import { createK12Case, listIntakeOptions, type IntakeOptionsDto } from '@/components/crm/f2-contract'
import { ErrorState, LoadingState, StaleState, SuccessState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError } from '@/lib/api/client'

export function CaseIntakeWorkspace() {
  const [options, setOptions] = useState<IntakeOptionsDto | null>(null)
  const [studentId, setStudentId] = useState('')
  const [advisorId, setAdvisorId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [intakeYear, setIntakeYear] = useState(String(new Date().getFullYear() + 1))
  const [admissionType, setAdmissionType] = useState<'entry' | 'transfer'>('entry')
  const [signedAt, setSignedAt] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'error' | 'stale' | 'success'>('loading')
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<{ readonly case_id: string; readonly assessment_url: string } | null>(null)

  useEffect(() => {
    const preselected = new URLSearchParams(window.location.search).get('studentId')
    if (preselected) setStudentId(preselected)
    void listIntakeOptions().then((value) => { setOptions(value); setStudentId((current) => current || value.students[0]?.id || ''); setAdvisorId(value.advisors[0]?.id || ''); setState('ready') }).catch((error: unknown) => { setErrorCode(error instanceof ApiClientError ? error.code : 'UNAVAILABLE'); setState('unavailable') })
  }, [])

  const selectedStudent = useMemo(() => options?.students.find((item) => item.id === studentId), [options, studentId])
  const selectedAdvisor = useMemo(() => options?.advisors.find((item) => item.id === advisorId), [options, advisorId])
  const selectedSource = useMemo(() => options?.referral_sources.find((item) => item.id === sourceId), [options, sourceId])

  async function submit() {
    setErrorCode(null)
    if (!studentId || !advisorId || !intakeYear || !signedAt) { setState('error'); setErrorCode('VALIDATION_FAILED'); return }
    setState('loading')
    try {
      const result = await createK12Case({ student_id: studentId, primary_advisor_role_binding_id: advisorId, referral_source_id: sourceId || null, intake_year: Number(intakeYear), admission_type: admissionType, signed_at: new Date(signedAt).toISOString() }, crypto.randomUUID())
      setReceipt({ case_id: result.case_id, assessment_url: result.assessment_url }); setState('success')
    } catch (error: unknown) {
      setErrorCode(error instanceof ApiClientError ? error.code : 'CREATE_FAILED')
      if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setState('stale')
      else setState(error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE' ? 'unavailable' : 'error')
    }
  }

  if (state === 'loading' && !options) return <LoadingState title="正在载入 Case intake options" detail="只使用服务端 allowlisted active Student、Advisor 与 ReferralSource。" />
  if (state === 'unavailable') return <UnavailableState title="Case intake 尚未可用" detail={`冻结的 intake-options transport 当前不可用${errorCode ? `（${errorCode}）` : ''}；不会使用旧 manifest picker 或 preview adapter。`} onRetry={() => window.location.reload()} />
  if (state === 'stale') return <StaleState title="Case intake 版本已变化" detail="服务端拒绝了过期提交；请重新载入选项后再试。" onRetry={() => window.location.reload()} />
  if (state === 'success' && receipt) return <SuccessState title="Case 已建立" detail="服务端 receipt 已确认，案件进入 background_collection；Assessment 使用 canonical URL。" action={<div className="flex flex-wrap gap-2"><Link className="primary-button" href={receipt.assessment_url}>打开 Assessment</Link><Link className="secondary-button" href="/cases">返回 Cases</Link></div>} />
  if (state === 'error') return <ErrorState title="Case 建立未完成" detail={errorCode === 'VALIDATION_FAILED' ? '请完成 Student、Advisor、intake year 与 signed_at。' : `服务端返回 ${errorCode ?? 'CREATE_FAILED'}；请修正后重试，不会自动重放旧命令。`} onRetry={() => setState('ready')} />

  return <div className="workspace-section space-y-5"><div><h3 className="section-title">Case intake</h3><p className="section-detail">只有具备 Advisor create capability 的身份可提交；Founder 单独、Admin 与 Contractor 由服务端拒绝。</p></div><label className="field-label"><span>Active Student *</span><select value={studentId} onChange={(event) => setStudentId(event.target.value)}><option value="">选择 Student</option>{options?.students.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label><label className="field-label"><span>Primary Advisor *</span><select value={advisorId} onChange={(event) => setAdvisorId(event.target.value)}><option value="">选择 Advisor</option>{options?.advisors.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label><label className="field-label"><span>Referral Source（可选，仅 active）</span><select value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">不指定</option>{options?.referral_sources.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><label className="field-label"><span>Intake year *</span><input type="number" min="2000" max="2200" value={intakeYear} onChange={(event) => setIntakeYear(event.target.value)} /></label><label className="field-label"><span>Admission type *</span><select value={admissionType} onChange={(event) => setAdmissionType(event.target.value as typeof admissionType)}><option value="entry">Entry</option><option value="transfer">Transfer</option></select></label></div><label className="field-label"><span>Signed at（香港時間）*</span><input type="datetime-local" value={signedAt} onChange={(event) => setSignedAt(event.target.value)} /></label><section className="inline-callout"><span>Review：{selectedStudent?.display_name ?? '未选择 Student'} · {selectedAdvisor?.display_name ?? '未选择 Advisor'} · {selectedSource?.display_name ?? '无 Referral Source'} · {intakeYear} · {admissionType} · signed_at {formatHongKong(signedAt)}</span></section><div className="flex justify-between gap-2"><Link href={studentId ? `/students/${studentId}` : '/cases'} className="secondary-button">取消</Link><button type="button" className="primary-button" onClick={() => void submit()} disabled={state === 'loading'}>创建 Case</button></div></div>
}

function formatHongKong(value: string) {
  if (!value) return '未填写'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '格式无效'
  return new Intl.DateTimeFormat('zh-HK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hong_Kong' }).format(parsed)
}
