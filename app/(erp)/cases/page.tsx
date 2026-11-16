'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { Page, PageHeader, Card, Input, Select, Table, Tag, Notice, Empty, Button } from '@/components/ui/standard'
import type { CaseStage } from '@/types'
import { ApiClientError } from '@/lib/api/client'
import { listCases } from '@/components/crm/f2-contract'

interface CaseListItem {
  id: string
  caseNumber: string
  studentId: string
  studentName: string
  intakeYear: number
  admissionType: string
  stage: CaseStage
  updatedAt: string
}

const caseStageLabels: Record<CaseStage, string> = {
  signed: '已簽約',
  background_collection: '背景資料收集',
  school_selection_confirmed: '選校已確認',
  application_in_progress: '申請處理中',
  interview_preparation: '面試準備',
  application_submitted: '已遞交申請',
  awaiting_result: '等待結果',
  offer_confirmed: 'Offer 已確認',
  closed: '已結案',
}

type CaseStatusFilter = 'all' | 'active' | 'closed'

const caseStatusLabels: Record<CaseStatusFilter, string> = {
  all: '全部狀態',
  active: '進行中',
  closed: '已結案',
}

export default function CasesPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<CaseStatusFilter>('all')
  const [stage, setStage] = useState<CaseStage | 'all'>('all')
  const [caseRecords, setCaseRecords] = useState<CaseListItem[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')

  function loadCases() {
    setLoadState('loading')
    listCases()
      .then((items) => {
        setCaseRecords(items.map((item) => ({
          id: item.id,
          caseNumber: item.case_number,
          studentId: item.student_id,
          studentName: item.student_name,
          intakeYear: item.intake_year,
          admissionType: item.admission_type,
          stage: item.stage as CaseStage,
          updatedAt: item.updated_at,
        })))
        setLoadState('ready')
      })
      .catch((error: unknown) => setLoadState(error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE' ? 'error' : 'error'))
  }

  useEffect(() => {
    queueMicrotask(loadCases)
  }, [])

  const filtered = useMemo(() => caseRecords.filter((item) => {
    const query = search.trim().toLowerCase()
    const matchesSearch = !query || `${item.caseNumber} ${item.studentName} ${item.studentId}`.toLowerCase().includes(query)
    const matchesStatus = status === 'all' || (status === 'closed' ? item.stage === 'closed' : item.stage !== 'closed')
    return matchesSearch && matchesStatus && (stage === 'all' || item.stage === stage)
  }), [caseRecords, search, stage, status])

  return <Page>
    <PageHeader title="案件" description="管理學生、選校、任務與文件。"
      action={<Link href="/cases/new" className="ui-button ui-primary">建立案件</Link>} />
    <Card title="案件清單">
      <p className="ui-muted">{loadState === 'ready' ? <>共 {caseRecords.length} 宗案件，使用篩選查看需要的資料。</> : '使用篩選查看需要的資料。'}</p>
      <div className="ui-filters">
        <Input type="search" label="搜尋案件" placeholder="搜尋案件或學生" value={search} onChange={event => setSearch(event.target.value)} />
        <Select label="案件狀態" value={status} onChange={event => setStatus(event.target.value as CaseStatusFilter)}>
          {Object.entries(caseStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select>
        <Select label="案件階段" value={stage} onChange={event => setStage(event.target.value as CaseStage | 'all')}>
          <option value="all">全部階段</option>
          {Object.entries(caseStageLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select>
      </div>
      {loadState === 'loading' && <Notice>正在載入案件 · 請稍候。</Notice>}
      {loadState === 'error' && <Notice warning>案件服務暫時不可用 · 請稍後重試。<Button onClick={loadCases}>重新載入</Button></Notice>}
      {loadState === 'ready' && <>
        {filtered.length ? <Table headings={['學生', '案件', '階段', '更新時間']}>
          {filtered.map(item => <CaseRow key={item.id} item={item} />)}
        </Table> : <Empty title="找不到符合條件的案件。" />}
        <footer className="ui-pagination">顯示 {filtered.length} / {caseRecords.length} 案件</footer>
      </>}
    </Card>
  </Page>
}

function CaseRow({ item }: { item: CaseListItem }) {
  const { t } = useTranslation()
  return <tr>
    <td><div className="ui-name-links"><Link href={`/cases/${item.id}`} className="ui-link"><strong>{item.studentName || '未命名學生'}</strong></Link>
      <Link href={`/students/${item.studentId}`} className="ui-subtle-link">{t('caseUi.viewStudent')}</Link></div>
      <p className="ui-muted">{item.intakeYear} · {item.admissionType === 'entry' ? '首次入學' : item.admissionType === 's1_admission' ? 'S1 入學' : item.admissionType === 'transfer' ? '插班' : item.admissionType}</p>
    </td>
    <td><Link href={`/cases/${item.id}`} className="ui-link">{item.caseNumber}</Link></td>
    <td><Tag tone={item.stage === 'closed' ? 'neutral' : 'primary'}>{caseStageLabels[item.stage]}</Tag></td>
    <td>{formatDate(item.updatedAt)}</td>
  </tr>
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-HK')
}
