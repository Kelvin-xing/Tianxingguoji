'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import { Icon } from '@/components/workspace/Icon'

interface StudentListItem {
  id: string
  displayName: string
  dateOfBirth: string | null
  status: 'active' | 'pending_delete'
  primaryGuardianName: string | null
  updatedAt: string
}

export default function StudentsPage() {
  const [students, setStudents] = useState<StudentListItem[]>([])
  const [search, setSearch] = useState('')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')

  function loadStudents() {
    setLoadState('loading')
    fetch('/api/v1/students', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as { data?: { students?: StudentListItem[] } }
        if (!response.ok || !payload.data?.students) throw new Error('STUDENTS_UNAVAILABLE')
        setStudents(payload.data.students)
        setLoadState('ready')
      })
      .catch(() => setLoadState('error'))
  }

  useEffect(() => {
    loadStudents()
  }, [])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return students.filter((student) => !query ||
      `${student.displayName} ${student.primaryGuardianName ?? ''} ${student.id}`
        .toLowerCase().includes(query))
  }, [search, students])

  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div><div className="eyebrow">CRM · Student identity</div><h2 className="page-title">學生與監護人</h2><p className="page-subtitle">Student 保存學生身份資料；ServiceCase 另行保存每次申請案件。</p></div>
        <Link href="/cases/new" className="primary-button"><Icon name="plus" size={16} />為學生建立案件</Link>
      </section>

      <section className="workspace-section overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4">
          <div><h3 className="section-title">Student 目錄</h3><p className="section-detail">目前只顯示 PostgreSQL 中的本地合成資料，不使用前端 Mock。</p></div>
          <label className="search-field"><Icon name="search" size={15} /><input type="search" placeholder="搜尋學生或監護人" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜尋學生" /></label>
        </div>
        {loadState === 'loading' && <div className="empty-state"><Icon name="clock" size={20} /><strong>正在載入學生</strong><span>讀取 organization-scoped CRM data…</span></div>}
        {loadState === 'error' && <div className="empty-state"><Icon name="x" size={20} /><strong>學生服務暫時不可用</strong><span>請確認登入工作階段和本地 PostgreSQL runtime。</span><button type="button" className="secondary-button mt-3" onClick={loadStudents}>重新載入</button></div>}
        {loadState === 'ready' && <><div className="overflow-x-auto -mx-5"><table className="data-table min-w-[720px]"><thead><tr><th>學生</th><th>出生日期</th><th>主要聯絡人</th><th>資料狀態</th><th>更新時間</th><th /></tr></thead><tbody>{filtered.map((student) => <tr key={student.id} className="data-row"><td><Link href={`/students/${student.id}`} className="table-primary">{student.displayName}</Link><div className="table-secondary">{student.id}</div></td><td className="table-muted">{student.dateOfBirth ?? '未提供'}</td><td className="table-muted">{student.primaryGuardianName ?? '未設定'}</td><td><span className={`status-pill ${student.status === 'active' ? 'status-success' : 'status-warning'}`}>{student.status === 'active' ? '有效' : '待刪除'}</span></td><td className="table-muted">{formatDate(student.updatedAt)}</td><td><Link href={`/students/${student.id}`} className="icon-button" title="查看學生" aria-label="查看學生"><Icon name="chevron-right" size={16} /></Link></td></tr>)}</tbody></table>{filtered.length === 0 && <div className="empty-state">找不到符合條件的學生。</div>}</div><div className="pt-4 text-xs" style={{ color: 'var(--text-muted)' }}>顯示 {filtered.length} / {students.length} 位學生 · PostgreSQL authoritative read</div></>}
      </section>
    </div>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-HK')
}
