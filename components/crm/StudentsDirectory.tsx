'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import { Icon } from '@/components/workspace/Icon'
import { getWorkspaceAccessSnapshot } from '@/modules/access/client'
import {
  classifyStudentRequestFailure,
  listStudents,
  type StudentListItem,
} from '@/modules/crm/client'

type LoadState = 'loading' | 'ready' | 'denied' | 'unauthenticated' | 'error'

export function StudentsDirectory() {
  const [students, setStudents] = useState<readonly StudentListItem[]>([])
  const [search, setSearch] = useState('')
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [canCreate, setCanCreate] = useState(false)
  const [canReviewDeletionRequests, setCanReviewDeletionRequests] = useState(false)
  const [canReadReferralSources, setCanReadReferralSources] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      listStudents(controller.signal),
      getWorkspaceAccessSnapshot(controller.signal),
    ])
      .then(([records, access]) => {
        setStudents(records)
        setCanCreate(access.capabilities.some((capability) => String(capability) === 'students.create'))
        setCanReviewDeletionRequests(access.capabilities.some((capability) => String(capability) === 'students.deletion.review'))
        setCanReadReferralSources(access.capabilities.some((capability) => String(capability) === 'referral_sources.read'))
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const failure = classifyStudentRequestFailure(error)
        setLoadState(failure === 'unauthenticated' ? 'unauthenticated' : failure === 'forbidden' ? 'denied' : 'error')
      })
    return () => controller.abort()
  }, [reloadToken])

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('zh-HK')
    return students.filter((student) => !query ||
      `${student.displayName} ${student.primaryGuardianName ?? ''}`
        .toLocaleLowerCase('zh-HK').includes(query))
  }, [search, students])

  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <div className="eyebrow">學生資料</div>
          <h2 className="page-title">學生與監護人</h2>
          <p className="page-subtitle">管理學生基本資料、主要監護人與聯絡方式。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {loadState === 'ready' && canReadReferralSources ? (
            <Link href="/referral-sources" className="secondary-button">
              <Icon name="briefcase" size={16} />推薦來源
            </Link>
          ) : null}
          {loadState === 'ready' && canReviewDeletionRequests ? (
            <Link href="/students/deletion-requests" className="secondary-button">
              <Icon name="shield" size={16} />查看待刪除審查
            </Link>
          ) : null}
          {loadState === 'ready' && canCreate ? (
            <Link href="/students/new" className="primary-button">
              <Icon name="plus" size={16} />新增學生
            </Link>
          ) : null}
          <Link href="/cases/new" className="secondary-button">
            <Icon name="briefcase" size={16} />建立案件
          </Link>
        </div>
      </section>

      <section className="workspace-section overflow-hidden" aria-busy={loadState === 'loading'}>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4">
          <div>
            <h3 className="section-title">學生名單</h3>
            <p className="section-detail">顯示目前已儲存的學生資料。</p>
          </div>
          <label className="search-field">
            <Icon name="search" size={15} />
            <input
              type="search"
              placeholder="搜尋學生或監護人"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="搜尋學生"
              disabled={loadState !== 'ready'}
            />
          </label>
        </div>

        {loadState === 'loading' ? <DirectoryState icon="clock" title="正在載入學生" detail="請稍候。" /> : null}
        {loadState === 'unauthenticated' ? <DirectoryState icon="lock" title="工作階段已失效" detail="請重新登入後再查看學生資料。" actionHref="/login" actionLabel="重新登入" /> : null}
        {loadState === 'denied' ? <DirectoryState icon="shield" title="無法查看學生資料" detail="你的帳號目前沒有查看此名單的權限。" /> : null}
        {loadState === 'error' ? <DirectoryState icon="x" title="學生服務暫時不可用" detail="請稍後重試。" onRetry={() => { setLoadState('loading'); setReloadToken((value) => value + 1) }} /> : null}

        {loadState === 'ready' ? (
          <>
            {students.length === 0 ? (
              <DirectoryState
                icon="users"
                title="尚未建立學生資料"
                detail={canCreate ? '新增第一位學生及其主要監護人。' : '目前沒有可顯示的學生。'}
                actionHref={canCreate ? '/students/new' : undefined}
                actionLabel={canCreate ? '新增學生' : undefined}
              />
            ) : (
              <div className="overflow-x-auto -mx-5">
                <table className="data-table min-w-[720px]">
                  <thead><tr><th>學生</th><th>出生日期</th><th>主要聯絡人</th><th>資料狀態</th><th>更新時間</th><th /></tr></thead>
                  <tbody>{filtered.map((student) => <StudentRow key={student.id} student={student} />)}</tbody>
                </table>
                {filtered.length === 0 ? <div className="empty-state">找不到符合條件的學生。</div> : null}
              </div>
            )}
            <div className="pt-4 text-xs" style={{ color: 'var(--text-muted)' }} aria-live="polite">
              顯示 {filtered.length} / {students.length} 位學生
            </div>
          </>
        ) : null}
      </section>
    </div>
  )
}

function StudentRow({ student }: { readonly student: StudentListItem }) {
  return (
    <tr className="data-row">
      <td><Link href={`/students/${student.id}`} className="table-primary">{student.displayName}</Link></td>
      <td className="table-muted">{student.dateOfBirth ?? '未提供'}</td>
      <td className="table-muted">{student.primaryGuardianName ?? '未設定'}</td>
      <td><span className={`status-pill ${student.status === 'active' ? 'status-success' : 'status-warning'}`}>{student.status === 'active' ? '有效' : '待刪除'}</span></td>
      <td className="table-muted">{formatDate(student.updatedAt)}</td>
      <td><Link href={`/students/${student.id}`} className="icon-button" title="查看學生" aria-label={`查看 ${student.displayName}`}><Icon name="chevron-right" size={16} /></Link></td>
    </tr>
  )
}

function DirectoryState({
  icon,
  title,
  detail,
  actionHref,
  actionLabel,
  onRetry,
}: {
  readonly icon: 'clock' | 'lock' | 'shield' | 'users' | 'x';
  readonly title: string;
  readonly detail: string;
  readonly actionHref?: string;
  readonly actionLabel?: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={20} />
      <strong>{title}</strong>
      <span>{detail}</span>
      {actionHref && actionLabel ? <Link href={actionHref} className="primary-button mt-3">{actionLabel}</Link> : null}
      {onRetry ? <button type="button" className="secondary-button mt-3" onClick={onRetry}>重新載入</button> : null}
    </div>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未提供' : date.toLocaleDateString('zh-HK')
}
