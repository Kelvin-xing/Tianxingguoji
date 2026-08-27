'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

import { getStudent, type StudentDetailDto } from '@/components/crm/f2-contract'
import { DeniedState, EmptyState, ErrorState, LoadingState, StaleState, UnavailableState } from '@/components/states/WorkspaceState'
import { Icon } from '@/components/workspace/Icon'
import { ApiClientError } from '@/lib/api/client'

export function StudentDetailWorkspace({ studentId }: { readonly studentId: string }) {
  const [student, setStudent] = useState<StudentDetailDto | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'denied' | 'unavailable' | 'error' | 'stale'>('loading')
  const [requestId, setRequestId] = useState<string | null>(null)
  const load = useCallback(() => {
    setState('loading')
    void getStudent(studentId).then((value) => { setStudent(value); setState('ready') }).catch((error: unknown) => {
      setRequestId(error instanceof ApiClientError ? error.requestId : null)
      if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setState('denied')
      else if (error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE') setState('unavailable')
      else if (error instanceof ApiClientError && error.code === 'STALE_VERSION') setState('stale')
      else if (error instanceof ApiClientError && error.code === 'NOT_FOUND') setState('empty')
      else setState('error')
    })
  }, [studentId])
  useEffect(() => { load() }, [load])
  if (state === 'loading') return <LoadingState title="正在载入 Student" detail="正在读取服务端 allowlisted DTO。" />
  if (state === 'denied') return <DeniedState title="无法访问此 Student" detail="当前身份没有该客户资料权限；不会泄露对象是否存在。" requestId={requestId} action={<Link className="primary-button" href="/students">返回 Student</Link>} />
  if (state === 'unavailable') return <UnavailableState title="Student 服务暂时不可用" detail="请稍后重试；不会使用旧 preview adapter。" requestId={requestId} onRetry={load} />
  if (state === 'stale') return <StaleState title="Student 版本已变化" detail="请重新载入最新资料后再继续。" requestId={requestId} onRetry={load} />
  if (state === 'empty') return <EmptyState title="Student 不可用" detail="记录不存在或不在目前授权范围。" action={<Link className="primary-button" href="/students">返回 Student</Link>} />
  if (state === 'error' || !student) return <ErrorState title="Student 读取失败" detail="请保留当前路径后重试。" requestId={requestId} onRetry={load} />
  return <div className="max-w-6xl mx-auto space-y-6"><div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/students" className="quiet-link">Student</Link><Icon name="chevron-right" size={14} /><span>{student.display_name}</span></div><section className="flex flex-col lg:flex-row lg:items-start justify-between gap-4"><div><div className="eyebrow">CRM · Student 360</div><h2 className="page-title">{student.display_name}</h2><p className="page-subtitle">只显示服务端 DTO 与 allowed_actions。</p></div><div className="flex flex-wrap items-center gap-2"><span className={`status-pill ${student.status === 'active' ? 'status-success' : 'status-warning'}`}>{student.status === 'active' ? 'Active' : 'Pending delete'}</span>{student.allowed_actions.includes('case.create') ? <Link href={`/cases/new?studentId=${encodeURIComponent(student.id)}`} className="primary-button"><Icon name="plus" size={15} />新建 Case</Link> : null}</div></section><section className="workspace-section"><h3 className="section-title">基本资料</h3><div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mt-4"><Info label="DOB" value={student.date_of_birth ?? '未提供'} /><Info label="年龄" value={deriveAge(student.date_of_birth)} /><Info label="Gender" value={student.gender ?? '未提供'} /><Info label="Contact" value={student.contact_email ?? student.contact_phone ?? student.contact_hint ?? '未提供'} /></div></section><section className="workspace-section"><div className="flex items-center justify-between gap-3"><div><h3 className="section-title">Primary Guardian</h3><p className="section-detail">Guardian 与 relationship 是独立的 CRM 记录。</p></div><Link className="secondary-button" href={`/students/${student.id}/guardians`}>管理 Guardian</Link></div>{student.primary_guardian ? <div className="selection-card selected mt-4"><span className="work-icon blue"><Icon name="user" size={15} /></span><span className="min-w-0"><strong>{student.primary_guardian.display_name}</strong><small>{student.primary_guardian.relationship_type} · {student.primary_guardian.email ?? student.primary_guardian.phone ?? '未提供联络'}</small><small>{student.primary_guardian.flags.join(' · ') || 'Primary'}</small></span><span className="status-pill status-success">Primary</span></div> : <EmptyState title="没有当前 Primary Guardian" detail="这是服务端数据不变量，需要 CRM 关系入口处理；不会在前端自动补建。" />}</section><div className="preview-notice"><Icon name="shield" size={15} /><span>所有写操作消费 allowed_actions、Idempotency-Key 与 expected_record_version；服务端仍会重新授权。</span></div></div>
}

function Info({ label, value }: { label: string; value: string }) { return <div><div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div><div className="mt-1 text-sm font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{value}</div></div> }
function deriveAge(value: string | null): string { if (!value) return '不可计算'; const date = new Date(`${value}T00:00:00Z`); if (Number.isNaN(date.getTime())) return '不可计算'; const now = new Date(); let age = now.getUTCFullYear() - date.getUTCFullYear(); const beforeBirthday = now.getUTCMonth() < date.getUTCMonth() || now.getUTCMonth() === date.getUTCMonth() && now.getUTCDate() < date.getUTCDate(); if (beforeBirthday) age -= 1; return age >= 0 ? String(age) : '不可计算' }
