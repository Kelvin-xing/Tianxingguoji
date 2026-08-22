'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { GuardianProfileEditor, StudentProfileEditor } from '@/components/crm/ProfileEditPanel'
import { Icon } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  classifyStudentRequestFailure,
  getGuardianRelationships,
  getStudent,
  type CurrentGuardianRelationship,
  type StudentDetail,
  type StudentGuardianItem,
} from '@/modules/crm/client'

type EditTarget = { readonly kind: 'student' } | { readonly kind: 'guardian'; readonly guardianId: string }

type DetailState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready'
      readonly student: StudentDetail
      readonly relationships: readonly CurrentGuardianRelationship[]
      readonly canManageGuardians: boolean
      readonly canManageProfiles: boolean
    }
  | { readonly kind: 'unauthenticated' | 'forbidden' | 'not_found' | 'error' }

export function StudentDetailView({ studentId }: { readonly studentId: string }) {
  const [state, setState] = useState<DetailState>({ kind: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const lastEditTrigger = useRef<HTMLButtonElement | null>(null)
  const successNotice = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      getStudent(studentId, controller.signal),
      getGuardianRelationships(studentId, controller.signal),
      getWorkspaceAccessSnapshot(controller.signal).catch(() => null),
    ])
      .then(([student, guardianView, access]) => {
        const guardianIds = new Set(student.guardians.map(({ id }) => id))
        if (guardianView.relationships.some(({ guardian }) => !guardianIds.has(guardian.id))) {
          throw new TypeError('Guardian profile data does not match the current relationship view.')
        }
        setState({
          kind: 'ready',
          student,
          relationships: guardianView.relationships,
          canManageGuardians: access?.capabilities.includes('students.guardians.manage') ?? false,
          canManageProfiles: access?.capabilities.includes('students.profiles.manage') ?? false,
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const failure = classifyStudentRequestFailure(error)
        if (failure === 'unauthenticated' || failure === 'forbidden' || failure === 'not_found') {
          setState({ kind: failure })
          return
        }
        setState({ kind: 'error' })
      })
    return () => controller.abort()
  }, [reloadToken, studentId])

  useEffect(() => {
    if (successMessage !== null && state.kind === 'ready') successNotice.current?.focus()
  }, [state, successMessage])

  function reloadAuthoritative() {
    setEditTarget(null)
    setState({ kind: 'loading' })
    setReloadToken((value) => value + 1)
  }

  function saved(message: string) {
    setSuccessMessage(message)
    reloadAuthoritative()
  }

  function beginEdit(target: EditTarget, trigger: HTMLButtonElement) {
    lastEditTrigger.current = trigger
    setSuccessMessage(null)
    setEditTarget(target)
  }

  function cancelEdit() {
    setEditTarget(null)
    queueMicrotask(() => lastEditTrigger.current?.focus())
  }

  if (state.kind === 'loading') return <DetailMessage icon="clock" title="正在載入學生資料" detail="請稍候。" />
  if (state.kind === 'unauthenticated') return <DetailMessage icon="lock" title="工作階段已失效" detail="請重新登入後再查看學生資料。" href="/login" action="重新登入" />
  if (state.kind === 'forbidden') return <DetailMessage icon="shield" title="無法查看學生資料" detail="你的帳號目前沒有查看此學生的權限。" href="/students" action="返回學生名單" />
  if (state.kind === 'not_found') return <DetailMessage icon="users" title="找不到學生資料" detail="這筆學生資料不存在或已無法查看。" href="/students" action="返回學生名單" />
  if (state.kind === 'error') return <DetailMessage icon="x" title="學生服務暫時不可用" detail="請稍後重試。" onRetry={() => { setState({ kind: 'loading' }); setReloadToken((value) => value + 1) }} />
  if (state.kind !== 'ready') return null

  const { student, relationships, canManageGuardians, canManageProfiles } = state
  const guardiansById = new Map(student.guardians.map((guardian) => [guardian.id, guardian] as const))
  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <Link href="/students" className="quiet-link">學生與監護人</Link>
        <Icon name="chevron-right" size={14} />
        <span className="truncate">{student.displayName}</span>
      </div>
      <section className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div><div className="eyebrow">學生資料</div><h2 className="page-title">{student.displayName}</h2><p className="page-subtitle">查看學生與目前有效的監護人聯絡資料。</p></div>
        <div className="flex flex-wrap items-center gap-2"><Link href={`/cases/new?student=${student.id}`} className="primary-button"><Icon name="plus" size={15} />建立案件</Link><span className={`status-pill ${student.status === 'active' ? 'status-success' : 'status-warning'}`}>{student.status === 'active' ? '有效' : '待刪除'}</span></div>
      </section>

      <section className="workspace-section">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4"><div><h3 className="section-title">學生基本資料</h3><p className="section-detail">此處顯示學生本人的身份與聯絡資料。</p></div>{canManageProfiles ? <button type="button" className="secondary-button" onClick={(event) => beginEdit({ kind: 'student' }, event.currentTarget)} disabled={editTarget?.kind === 'student'}><Icon name="settings" size={15} />編輯學生資料</button> : null}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4"><Info label="出生日期" value={student.dateOfBirth ?? '未提供'} /><Info label="聯絡 Email" value={student.contactEmail ?? '未提供'} /><Info label="聯絡電話" value={student.contactPhone ?? '未提供'} /><Info label="更新時間" value={formatDate(student.updatedAt)} /></div>
        {editTarget?.kind === 'student' ? <StudentProfileEditor student={student} onCancel={cancelEdit} onSaved={() => saved('學生資料已保存。')} onReload={reloadAuthoritative} /> : null}
      </section>

      {successMessage ? <div ref={successNotice} className="preview-notice" role="status" tabIndex={-1}><Icon name="check-circle" size={15} /><span>{successMessage}</span></div> : null}

      <section className="workspace-section" aria-labelledby="student-guardian-heading">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
          <div><h3 id="student-guardian-heading" className="section-title">監護人與聯絡關係</h3><p className="section-detail">顯示目前有效的主要與次要監護人；聯絡資料只顯示脫敏提示。</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>{relationships.length} 筆</span>
            {canManageGuardians ? <Link href={`/students/${student.id}/guardians`} className="secondary-button"><Icon name="settings" size={15} />管理監護人關係</Link> : null}
          </div>
        </div>
        {relationships.length === 0
          ? <div className="empty-state">目前沒有有效監護人關係。</div>
          : <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{relationships.map((relationship) => <GuardianSummary key={relationship.relationship_id} relationship={relationship} guardian={guardiansById.get(relationship.guardian.id)!} canManageProfiles={canManageProfiles} editing={editTarget?.kind === 'guardian' && editTarget.guardianId === relationship.guardian.id} onEdit={(trigger) => beginEdit({ kind: 'guardian', guardianId: relationship.guardian.id }, trigger)} onCancel={cancelEdit} onSaved={() => saved('監護人資料已保存。')} onReload={reloadAuthoritative} />)}</div>}
      </section>
    </div>
  )
}

function DetailMessage({ icon, title, detail, href, action, onRetry }: { readonly icon: 'clock' | 'lock' | 'shield' | 'users' | 'x'; readonly title: string; readonly detail: string; readonly href?: string; readonly action?: string; readonly onRetry?: () => void }) {
  return <div className="max-w-3xl mx-auto"><section className="workspace-section"><div className="empty-state"><Icon name={icon} size={20} /><strong>{title}</strong><span>{detail}</span>{href && action ? <Link href={href} className="primary-button mt-3">{action}</Link> : null}{onRetry ? <button type="button" className="secondary-button mt-3" onClick={onRetry}>重新載入</button> : null}</div></section></div>
}

function Info({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div><div className="mt-1 text-sm font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{value}</div></div>
}

function GuardianSummary({ relationship, guardian, canManageProfiles, editing, onEdit, onCancel, onSaved, onReload }: { readonly relationship: CurrentGuardianRelationship; readonly guardian: StudentGuardianItem; readonly canManageProfiles: boolean; readonly editing: boolean; readonly onEdit: (trigger: HTMLButtonElement) => void; readonly onCancel: () => void; readonly onSaved: () => void; readonly onReload: () => void }) {
  const flags = [
    relationship.is_legal_guardian && '法定監護',
    relationship.is_emergency_contact && '緊急聯絡',
    relationship.is_billing_contact && '帳務聯絡',
    relationship.notification_consent && '接收通知',
  ].filter(Boolean)
  const contact = [relationship.guardian.email_hint, relationship.guardian.phone_hint]
    .filter(Boolean)
    .join(' · ')
  return (
    <article className="selection-card selected flex-col items-stretch">
      <div className="flex items-start gap-3 min-w-0">
        <span className="work-icon blue"><Icon name="user" size={15} /></span>
        <span className="min-w-0 flex-1">
          <strong className="break-words">{relationship.guardian.display_name}</strong>
          <small className="break-words">{relationshipLabel(relationship.relationship_type)} · {contact || '未提供聯絡提示'}</small>
          <small>{flags.length > 0 ? flags.join(' · ') : '一般聯絡'}</small>
        </span>
        <span className={`status-pill ${relationship.is_primary_contact ? 'status-success' : 'status-warning'} shrink-0`}>
          {relationship.is_primary_contact ? '主要聯絡人' : '次要聯絡人'}
        </span>
      </div>
      {canManageProfiles ? <button type="button" className="secondary-button mt-3 self-start" onClick={(event) => onEdit(event.currentTarget)} disabled={editing}><Icon name="settings" size={15} />編輯監護人資料</button> : null}
      {editing ? <GuardianProfileEditor guardian={guardian} onCancel={onCancel} onSaved={onSaved} onReload={onReload} /> : null}
    </article>
  )
}

function relationshipLabel(value: string): string {
  if (value === 'father') return '父親'
  if (value === 'mother') return '母親'
  if (value === 'other_guardian') return '其他監護人'
  return '監護人'
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未提供' : date.toLocaleDateString('zh-HK')
}
