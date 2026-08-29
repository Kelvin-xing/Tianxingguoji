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
  if (state === 'loading') return <LoadingState title="正在載入學生資料" detail="請稍候。" />
  if (state === 'denied') return <DeniedState title="無法查看學生資料" detail="目前帳號沒有查看此學生資料的權限。" requestId={requestId} action={<Link className="primary-button" href="/students">返回學生</Link>} />
  if (state === 'unavailable') return <UnavailableState title="學生服務暫時不可用" detail="請稍後重試。" requestId={requestId} onRetry={load} />
  if (state === 'stale') return <StaleState title="學生資料已更新" detail="請重新載入最新資料後再繼續。" requestId={requestId} onRetry={load} />
  if (state === 'empty') return <EmptyState title="學生資料不可用" detail="記錄不存在或不在目前授權範圍。" action={<Link className="primary-button" href="/students">返回學生</Link>} />
  if (state === 'error' || !student) return <ErrorState title="學生資料讀取失敗" detail="請保留目前頁面後重試。" requestId={requestId} onRetry={load} />
  return <div className="max-w-6xl mx-auto space-y-6"><div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/students" className="quiet-link">學生</Link><Icon name="chevron-right" size={14} /><span>{student.display_name}</span></div><section className="flex flex-col lg:flex-row lg:items-start justify-between gap-4"><div><div className="eyebrow">學生資料</div><h2 className="page-title">{student.display_name}</h2><p className="page-subtitle">查看學生及主要監護人資料。</p></div><div className="flex flex-wrap items-center gap-2"><span className={`status-pill ${student.status === 'active' ? 'status-success' : 'status-warning'}`}>{student.status === 'active' ? '有效' : '待刪除審查'}</span>{student.allowed_actions.includes('case.create') ? <Link href={`/cases/new?studentId=${encodeURIComponent(student.id)}`} className="primary-button"><Icon name="plus" size={15} />建立案件</Link> : null}</div></section><section className="workspace-section"><h3 className="section-title">基本資料</h3><div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mt-4"><Info label="出生日期" value={student.date_of_birth ?? '未提供'} /><Info label="年齡" value={deriveAge(student.date_of_birth)} /><Info label="性別" value={genderLabel(student.gender)} /><Info label="聯絡方式" value={student.contact_email ?? student.contact_phone ?? student.contact_hint ?? '未提供'} /></div></section><section className="workspace-section"><div className="flex items-center justify-between gap-3"><div><h3 className="section-title">主要監護人</h3><p className="section-detail">監護人與學生關係分開管理。</p></div><Link className="secondary-button" href={`/students/${student.id}/guardians`}>管理監護人</Link></div>{student.primary_guardian ? <div className="selection-card selected mt-4"><span className="work-icon blue"><Icon name="user" size={15} /></span><span className="min-w-0"><strong>{student.primary_guardian.display_name}</strong><small>{relationshipLabel(student.primary_guardian.relationship_type)} · {student.primary_guardian.email ?? student.primary_guardian.phone ?? '未提供聯絡方式'}</small><small>{student.primary_guardian.flags.map(flagLabel).join(' · ') || '主要監護人'}</small></span><span className="status-pill status-success">主要監護人</span></div> : <EmptyState title="目前沒有主要監護人" detail="請從監護人關係頁面新增或選擇。" />}</section></div>
}

function Info({ label, value }: { label: string; value: string }) { return <div><div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div><div className="mt-1 text-sm font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{value}</div></div> }
function deriveAge(value: string | null): string { if (!value) return '未提供'; const date = new Date(`${value}T00:00:00Z`); if (Number.isNaN(date.getTime())) return '未提供'; const now = new Date(); let age = now.getUTCFullYear() - date.getUTCFullYear(); const beforeBirthday = now.getUTCMonth() < date.getUTCMonth() || now.getUTCMonth() === date.getUTCMonth() && now.getUTCDate() < date.getUTCDate(); if (beforeBirthday) age -= 1; return age >= 0 ? String(age) : '未提供' }

function genderLabel(value: string | null): string {
  if (value === 'male') return '男'
  if (value === 'female') return '女'
  if (value === 'other') return '其他'
  return '未提供'
}

function relationshipLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = { parent: '家長', father: '父親', mother: '母親', other_guardian: '其他監護人', step_parent: '繼父母', adoptive_parent: '養父母', foster_parent: '寄養父母', grandparent: '祖父母', adult_sibling: '成年兄弟姊妹', uncle: '叔伯或舅父', aunt: '姑姨', other_relative: '其他親屬', non_relative_guardian: '非親屬監護人', court_appointed_guardian: '法院指定監護人', institutional_guardian: '機構監護人', other: '其他' }
  return labels[value] ?? '監護人'
}

function flagLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = { primary: '主要監護人', legal_guardian: '法定監護人', emergency_contact: '緊急聯絡人', billing_contact: '帳務聯絡人', notification_consent: '接收通知' }
  return labels[value] ?? '一般關係'
}
