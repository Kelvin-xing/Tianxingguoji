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
        <div><div className="eyebrow">CRM · Student / Guardian</div><h2 className="page-title">學生與監護人</h2><p className="page-subtitle">只顯示目前授權範圍的 active 或 pending delete Student；deleted 主檔不會進入列表。</p></div>
        <Link href="/students/new" className="primary-button"><Icon name="plus" size={16} />新建 Student</Link>
      </section>

      <section className="workspace-section overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4">
          <div><h3 className="section-title">Student 目錄</h3><p className="section-detail">搜尋只提交冻结的 q/status 查询；权限和业务关系由服务端重验。</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="search-field"><Icon name="search" size={15} /><input type="search" placeholder="姓名、Email 或电话" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜尋學生" /></label>
            <label className="select-field"><Icon name="filter" size={14} /><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} aria-label="學生狀態"><option value="active">Active</option><option value="pending_delete">Pending delete</option><option value="">全部</option></select></label>
          </div>
        </div>
        {loadState === 'loading' && <LoadingState title="正在載入 Student" detail="正在讀取 organization-scoped CRM DTO。" />}
        {loadState === 'empty' && <EmptyState title="沒有符合條件的 Student" detail="可清除搜尋或建立新的 Student。" action={<Link className="primary-button" href="/students/new">新建 Student</Link>} />}
        {loadState === 'denied' && <ErrorState title="无法访问 Student" detail="当前身份没有客户资料权限。" requestId={requestId} />}
        {loadState === 'unavailable' && <UnavailableState title="Student 服务暂时不可用" detail="CRM transport 尚未可用；表单和数据不会以 mock/preview 成功。" requestId={requestId} onRetry={load} />}
        {loadState === 'error' && <ErrorState title="Student 读取失败" detail="请保留筛选条件后重试。" requestId={requestId} onRetry={load} />}
        {loadState === 'ready' && <div className="overflow-x-auto -mx-5"><table className="data-table min-w-[720px]"><thead><tr><th>Student</th><th>联络提示</th><th>状态</th><th>更新</th><th /></tr></thead><tbody>{students.map((student) => <tr key={student.id} className="data-row"><td><Link href={`/students/${student.id}`} className="table-primary">{student.display_name}</Link><div className="table-secondary">{student.id}</div></td><td className="table-muted">{student.contact_hint ?? '未提供'}</td><td><span className={`status-pill ${student.status === 'active' ? 'status-success' : 'status-warning'}`}>{student.status === 'active' ? 'Active' : 'Pending delete'}</span></td><td className="table-muted">{formatDate(student.updated_at)}</td><td><Link href={`/students/${student.id}`} className="icon-button" title="查看 Student" aria-label="查看 Student"><Icon name="chevron-right" size={16} /></Link></td></tr>)}</tbody></table></div>}
      </section>
    </div>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-HK')
}
