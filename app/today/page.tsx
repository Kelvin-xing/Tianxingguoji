import Link from 'next/link'
import { Icon } from '@/components/workspace/Icon'
import { previewCaseWorkspaceAdapter } from '@/lib/case-workspace/adapter'

const mockCases = previewCaseWorkspaceAdapter.listCases()
const urgentCases = mockCases.filter((item) => item.blockers.length > 0)
const dueTasks = mockCases.flatMap((item) => item.tasks.filter((task) => task.status !== 'done').map((task) => ({ ...task, caseNumber: item.case_number, caseId: item.id }))).slice(0, 5)
const stageCounts = mockCases.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.stage_label]: (acc[item.stage_label] || 0) + 1 }), {})

export default function TodayPage() {
  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Tuesday · 04 August 2026</div>
          <h2 className="page-title">今日工作</h2>
          <p className="page-subtitle">把需要人工判斷的案件，集中在一個可以快速處理的工作面。</p>
        </div>
        <Link href="/cases/new" className="primary-button"><Icon name="plus" size={16} />建立案件</Link>
      </section>

      <section className="metric-strip" aria-label="工作摘要">
        <Metric label="進行中案件" value={String(mockCases.filter((item) => item.stage !== 'closed').length)} detail="本組織" tone="blue" />
        <Metric label="需要處理" value={String(urgentCases.length)} detail="有 blocker 的案件" tone="amber" />
        <Metric label="未完成任務" value={String(dueTasks.length)} detail="按到期日排序" tone="violet" />
        <Metric label="本週更新" value={String(mockCases.filter((item) => item.updated_at.startsWith('2026-08')).length)} detail="案件活動" tone="green" />
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,.8fr)] gap-5">
        <section className="workspace-section">
          <SectionHeader icon="briefcase" title="需要你判斷的案件" detail="先處理有 blocker 或接近下一個 deadline 的項目" actionLabel="查看全部" actionHref="/cases" />
          <div className="divide-y" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            {urgentCases.map((item) => (
              <Link href={`/cases/${item.id}`} key={item.id} className="work-row group">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="work-icon warning"><Icon name="clock" size={16} /></div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>{item.case_number}</span>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{item.stage_label}</span>
                    </div>
                    <div className="mt-1 text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{item.student_name}</div>
                    <div className="mt-1 text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{item.blockers.join(' · ')}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span>{item.advisor}</span><Icon name="chevron-right" size={15} />
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section className="workspace-section">
          <SectionHeader icon="clipboard" title="任務佇列" detail="即將到期的工作" actionLabel="案件列表" actionHref="/cases" />
          <div className="divide-y" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            {dueTasks.map((task) => (
              <Link href={`/cases/${task.caseId}#tasks`} key={task.id} className="work-row group">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{task.title}</div>
                  <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{task.caseNumber} · {task.owner}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-medium" style={{ color: task.status === 'blocked' ? '#b45309' : 'var(--text-secondary)' }}>{task.status === 'blocked' ? '被阻塞' : task.due_date}</div>
                  <Icon name="chevron-right" size={15} className="ml-auto mt-1" style={{ color: 'var(--text-muted)' }} />
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <section className="workspace-section">
        <SectionHeader icon="activity" title="案件脈搏" detail="目前案件在流程中的分布" actionLabel="案件列表" actionHref="/cases" />
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          {Object.entries(stageCounts).map(([label, value]) => (
            <div key={label} className="p-3 rounded-md" style={{ background: 'var(--bg)', border: '1px solid var(--border-subtle)' }}>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div>
              <div className="mt-1 text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>{label}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="preview-notice"><Icon name="shield" size={15} /><span>Preview adapter · 目前頁面使用 synthetic case data，尚未寫入 Neon。</span></div>
    </div>
  )
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'blue' | 'amber' | 'violet' | 'green' }) {
  return <div className={`metric metric-${tone}`}><div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div><div className="mt-1 text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div><div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>{detail}</div></div>
}

function SectionHeader({ icon, title, detail, actionLabel, actionHref }: { icon: 'activity' | 'briefcase' | 'clipboard'; title: string; detail: string; actionLabel: string; actionHref: string }) {
  return <div className="flex items-start justify-between gap-4 pb-4"><div className="flex items-start gap-2.5"><div className="section-icon"><Icon name={icon} size={16} /></div><div><h3 className="section-title">{title}</h3><p className="section-detail">{detail}</p></div></div><Link href={actionHref} className="quiet-link">{actionLabel}<Icon name="arrow-right" size={14} /></Link></div>
}
