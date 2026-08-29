'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

import { EmptyState, ErrorState, LoadingState, UnavailableState } from '@/components/states/WorkspaceState'
import { Icon } from '@/components/workspace/Icon'
import { ApiClientError } from '@/lib/api/client'
import { listStudents, type StudentListItemDto } from '@/components/crm/f2-contract'

type LoadState = 'loading' | 'ready' | 'empty' | 'error' | 'unavailable' | 'denied'

export default function StudentsPage() {
  const [students, setStudents] = useState<readonly StudentListItemDto[]>([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'active' | 'pending_delete' | ''>('active')
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [requestId, setRequestId] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoadState('loading')
    setRequestId(null)
    void listStudents({ q: search, status: status || undefined })
      .then((items) => {
        setStudents(items)
        setLoadState(items.length === 0 ? 'empty' : 'ready')
      })
      .catch((error: unknown) => {
        setRequestId(error instanceof ApiClientError ? error.requestId : null)
        if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setLoadState('denied')
        else if (error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE') setLoadState('unavailable')
        else setLoadState('error')
      })
  }, [search, status])

  useEffect(() => { load() }, [load])

  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div><div className="eyebrow">CRM · 學生與監護人</div><h2 className="page-title">學生與監護人</h2><p className="page-subtitle">顯示目前可查看的有效學生資料；待刪除資料不會列出。</p></div>
        <Link href="/students/new" className="primary-button"><Icon name="plus" size={16} />建立學生</Link>
      </section>

      <section className="workspace-section overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4">
          <div><h3 className="section-title">學生目錄</h3><p className="section-detail">使用姓名或聯絡方式搜尋學生。</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="search-field"><Icon name="search" size={15} /><input type="search" placeholder="姓名、電郵或電話" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜尋學生" /></label>
            <label className="select-field"><Icon name="filter" size={14} /><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} aria-label="學生狀態"><option value="active">有效</option><option value="pending_delete">待刪除審查</option><option value="">全部</option></select></label>
          </div>
        </div>
        {loadState === 'loading' && <LoadingState title="正在載入學生資料" detail="請稍候。" />}
        {loadState === 'empty' && <EmptyState title="沒有符合條件的學生" detail="可清除搜尋或建立新的學生資料。" action={<Link className="primary-button" href="/students/new">建立學生</Link>} />}
        {loadState === 'denied' && <ErrorState title="無法查看學生資料" detail="目前帳號沒有查看學生資料的權限。" requestId={requestId} />}
        {loadState === 'unavailable' && <UnavailableState title="學生服務暫時不可用" detail="請稍後重試。" requestId={requestId} onRetry={load} />}
        {loadState === 'error' && <ErrorState title="學生資料讀取失敗" detail="請保留搜尋條件後重試。" requestId={requestId} onRetry={load} />}
        {loadState === 'ready' && <div className="overflow-x-auto -mx-5"><table className="data-table min-w-[720px]"><thead><tr><th>學生</th><th>聯絡方式</th><th>狀態</th><th>更新時間</th><th /></tr></thead><tbody>{students.map((student) => <tr key={student.id} className="data-row"><td><Link href={`/students/${student.id}`} className="table-primary">{student.display_name}</Link><div className="table-secondary">{student.id}</div></td><td className="table-muted">{student.contact_hint ?? '未提供'}</td><td><span className={`status-pill ${student.status === 'active' ? 'status-success' : 'status-warning'}`}>{student.status === 'active' ? '有效' : '待刪除審查'}</span></td><td className="table-muted">{formatDate(student.updated_at)}</td><td><Link href={`/students/${student.id}`} className="icon-button" title="查看學生" aria-label="查看學生"><Icon name="chevron-right" size={16} /></Link></td></tr>)}</tbody></table></div>}
      </section>
    </div>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-HK')
}
