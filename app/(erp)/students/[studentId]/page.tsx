import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { Icon } from '@/components/workspace/Icon'
import { getStudentReadRuntime, StudentReadError } from '@/modules/crm/server'
import { requireIdentityActor } from '@/modules/identity/web'
import { ApiContractError } from '@/modules/shared/public'

export const dynamic = 'force-dynamic'

export default async function StudentDetailPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params
  let student
  try {
    student = await getStudentReadRuntime().service.findStudent(await requireIdentityActor(), studentId)
  } catch (error) {
    if (error instanceof ApiContractError && error.code === 'UNAUTHENTICATED') redirect('/login')
    if (error instanceof StudentReadError && error.code === 'STUDENT_ID_INVALID') notFound()
    throw error
  }
  if (!student) notFound()

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/students" className="quiet-link">學生與監護人</Link><Icon name="chevron-right" size={14} /><span>{student.displayName}</span></div>
      <section className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div><div className="eyebrow">CRM · Student 360</div><h2 className="page-title">{student.displayName}</h2><p className="page-subtitle">{student.id}</p></div>
        <div className="flex items-center gap-2"><Link href={`/cases/new?student=${student.id}`} className="primary-button"><Icon name="plus" size={15} />建立案件</Link><span className={`status-pill ${student.status === 'active' ? 'status-success' : 'status-warning'}`}>{student.status === 'active' ? '有效' : '待刪除'}</span></div>
      </section>

      <section className="workspace-section">
        <div className="mb-4"><h3 className="section-title">學生身份資料</h3><p className="section-detail">這些欄位屬於 CRM Student，不代表任何一次申請案件。</p></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4"><Info label="出生日期" value={student.dateOfBirth ?? '未提供'} /><Info label="聯絡 Email" value={student.contactEmail ?? '未提供'} /><Info label="聯絡電話" value={student.contactPhone ?? '未提供'} /><Info label="更新時間" value={formatDate(student.updatedAt)} /></div>
      </section>

      <section className="workspace-section">
        <div className="flex items-center justify-between gap-3 mb-4"><div><h3 className="section-title">監護人與聯絡關係</h3><p className="section-detail">Guardian 是獨立身份，關係表記錄誰是主要、緊急及帳務聯絡人。</p></div><span className="text-xs" style={{ color: 'var(--text-muted)' }}>{student.guardians.length} 筆有效關係</span></div>
        {student.guardians.length === 0 ? <div className="empty-state">目前沒有有效監護人關係。</div> : <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{student.guardians.map((guardian) => <div key={guardian.id} className="selection-card selected"><span className="work-icon blue"><Icon name="user" size={15} /></span><span className="min-w-0 flex-1"><strong>{guardian.displayName}</strong><small>{guardian.relationshipType} · {guardian.email ?? '未提供 Email'} · {guardian.phone ?? '未提供電話'}</small><small>{[guardian.isPrimaryContact && '主要聯絡', guardian.isLegalGuardian && '法定監護', guardian.isEmergencyContact && '緊急聯絡', guardian.isBillingContact && '帳務聯絡'].filter(Boolean).join(' · ')}</small></span>{guardian.isPrimaryContact && <span className="status-pill status-success">Primary</span>}</div>)}</div>}
      </section>

      <div className="preview-notice"><Icon name="shield" size={15} /><span>PostgreSQL authoritative read · 此頁不再讀取 mockStudents；Assessment、任務和文件會在對應模組接通後顯示。</span></div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div><div className="mt-1 text-sm font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{value}</div></div>
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-HK')
}
