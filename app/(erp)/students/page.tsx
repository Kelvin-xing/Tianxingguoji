'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

import { Page, PageHeader, Card, Search, Select, Table, Tag, Empty, Button, SystemData, TranslatedText } from '@/components/ui/standard'
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

  useEffect(() => { queueMicrotask(load) }, [load])

  return <Page>
    <PageHeader title="學生與監護人" description="使用姓名或聯絡方式搜尋學生。" action={<Link href="/students/new" className="ui-button ui-primary"><Icon name="plus" size={16} />建立學生</Link>} />
    <Card>
      <div className="ui-filters">
        <Search label="搜尋學生" placeholder="姓名、電郵或電話" value={search} onChange={event => setSearch(event.target.value)} />
        <Select label="學生狀態" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="active">有效</option><option value="pending_delete">待刪除審查</option><option value="">全部</option></Select>
      </div>
      {loadState === 'loading' && <Empty title="正在載入學生資料" detail="請稍候。" />}
      {loadState === 'empty' && <Empty title="沒有符合條件的學生" detail="可清除搜尋或建立新的學生資料。" />}
      {loadState === 'denied' && <Empty title="無法查看學生資料" detail="目前帳號沒有查看學生資料的權限。" />}
      {(loadState === 'unavailable' || loadState === 'error') && <Empty title={loadState === 'unavailable' ? '學生服務暫時不可用' : '學生資料讀取失敗'} detail="請保留搜尋條件後重試。" action={<Button onClick={load}>重新載入</Button>} />}
      {loadState === 'ready' && <Table headings={['學生', '狀態', '更新時間', '']}>
        {students.map(student => <tr key={student.id}>
          <td><Link href={`/students/${student.id}`}><strong>{student.display_name}</strong></Link>{student.contact_hint && <div className="ui-muted">{student.contact_hint}</div>}</td>
          <td><Tag tone={student.status === 'active' ? 'primary' : 'warning'}>{student.status === 'active' ? '有效' : '待刪除審查'}</Tag></td>
          <td>{formatDate(student.updated_at)}</td>
          <td><Link href={`/students/${student.id}`} className="ui-button ui-text" aria-label="查看學生"><Icon name="chevron-right" size={16} /></Link></td>
        </tr>)}
      </Table>}
      {(loadState === 'ready' || loadState === 'empty') && <p className="ui-muted" aria-live="polite"><TranslatedText translationKey="studentUi.countPrefix" /> {students.length} <TranslatedText translationKey="studentUi.countSuffix" /></p>}
    </Card>
    {requestId && <SystemData>{requestId}</SystemData>}
  </Page>
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-HK')
}
