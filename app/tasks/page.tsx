import Link from 'next/link'
import { Icon } from '@/components/workspace/Icon'
import { previewCaseWorkspaceAdapter } from '@/lib/case-workspace/adapter'

const tasks = previewCaseWorkspaceAdapter.listCases().flatMap((record) => record.tasks.map((task) => ({ ...task, caseId: record.id, caseNumber: record.case_number, studentName: record.student_name })))

export default function TasksPage() {
  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div><div className="eyebrow">Operations · Case tasks</div><h2 className="page-title">任務</h2><p className="page-subtitle">把案件下一步集中成今日可執行的工作清單。</p></div>
        <div className="preview-notice compact"><Icon name="shield" size={15} /><span>Preview adapter · 任務 mutation 尚未接通</span></div>
      </section>
      <section className="metric-strip">
        <Metric label="全部任務" value={String(tasks.length)} tone="blue" />
        <Metric label="待處理" value={String(tasks.filter((task) => task.status === 'todo').length)} tone="amber" />
        <Metric label="已完成" value={String(tasks.filter((task) => task.status === 'done').length)} tone="green" />
        <Metric label="Blocked" value={String(tasks.filter((task) => task.status === 'blocked').length)} tone="violet" />
      </section>
      <section className="workspace-section overflow-hidden">
        <div className="flex items-center justify-between gap-3 pb-4"><div><h3 className="section-title">工作佇列</h3><p className="section-detail">Owner、due date 和 blocker 都保留在 Task identity 內。</p></div><button type="button" className="secondary-button" disabled title="Task API 尚未接通"><Icon name="plus" size={15} />新增任務</button></div>
        <div className="overflow-x-auto -mx-5"><table className="data-table min-w-[760px]"><thead><tr><th>任務</th><th>案件 / Student</th><th>Owner</th><th>Due</th><th>Status</th><th /></tr></thead><tbody>{tasks.map((task) => <tr key={task.id} className="data-row"><td><div className="flex items-center gap-2"><span className={`work-icon ${task.status === 'blocked' ? 'warning' : 'blue'}`}><Icon name={task.status === 'done' ? 'check-circle' : 'clipboard'} size={15} /></span><span className="table-primary">{task.title}</span></div></td><td><Link href={`/cases/${task.caseId}`} className="table-primary">{task.caseNumber}</Link><div className="table-secondary">{task.studentName}</div></td><td className="table-muted">{task.owner}</td><td className="table-muted">{task.due_date}</td><td><span className={`status-pill ${task.status === 'blocked' ? 'status-warning' : task.status === 'done' ? 'status-success' : ''}`}>{task.status}</span></td><td><Link href={`/cases/${task.caseId}#tasks`} className="icon-button" title="查看案件任務" aria-label="查看案件任務"><Icon name="chevron-right" size={16} /></Link></td></tr>)}</tbody></table></div>
      </section>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'blue' | 'amber' | 'violet' | 'green' }) { return <div className={`metric metric-${tone}`}><div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div><div className="mt-1 text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div></div> }
