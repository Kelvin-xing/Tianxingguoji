import Link from 'next/link'
import { Icon } from '@/components/workspace/Icon'
import { previewCaseWorkspaceAdapter } from '@/modules/cases/server'

const documents = previewCaseWorkspaceAdapter.listCases().flatMap((record) => record.documents.map((document) => ({ ...document, caseId: record.id, caseNumber: record.case_number, studentName: record.student_name })))

export default function DocumentsPage() {
  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4"><div><div className="eyebrow">Operations · Evidence</div><h2 className="page-title">文件</h2><p className="page-subtitle">集中查看案件文件版本、掃描狀態與缺件風險。</p></div><button type="button" className="secondary-button" disabled title="Document API 尚未接通"><Icon name="upload" size={15} />上載文件</button></section>
      <section className="metric-strip"><Metric label="全部文件" value={String(documents.length)} tone="blue" /><Metric label="Clean" value={String(documents.filter((document) => document.status === 'clean').length)} tone="green" /><Metric label="待處理" value={String(documents.filter((document) => document.status !== 'clean').length)} tone="amber" /><Metric label="版本來源" value="Case" tone="violet" /></section>
      <section className="workspace-section overflow-hidden"><div className="preview-notice compact mb-4"><Icon name="shield" size={15} /><span>Preview adapter · 真實檔案儲存、quarantine 與 signed URL 尚未接通</span></div><div className="overflow-x-auto -mx-5"><table className="data-table min-w-[760px]"><thead><tr><th>文件</th><th>案件 / Student</th><th>Updated</th><th>Status</th><th /></tr></thead><tbody>{documents.map((document) => <tr key={document.id} className="data-row"><td><div className="flex items-center gap-2"><span className="work-icon blue"><Icon name="file-text" size={15} /></span><span className="table-primary">{document.name}</span></div></td><td><Link href={`/cases/${document.caseId}`} className="table-primary">{document.caseNumber}</Link><div className="table-secondary">{document.studentName}</div></td><td className="table-muted">{document.updated_at}</td><td><span className={`status-pill ${document.status === 'clean' ? 'status-success' : document.status === 'missing' ? 'status-warning' : ''}`}>{document.status}</span></td><td><Link href={`/cases/${document.caseId}#documents`} className="icon-button" title="查看案件文件" aria-label="查看案件文件"><Icon name="chevron-right" size={16} /></Link></td></tr>)}</tbody></table></div></section>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'blue' | 'amber' | 'violet' | 'green' }) { return <div className={`metric metric-${tone}`}><div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div><div className="mt-1 text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div></div> }
