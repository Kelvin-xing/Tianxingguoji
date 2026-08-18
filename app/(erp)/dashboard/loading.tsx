export default function DashboardRouteLoading() {
  return (
    <div aria-busy="true" aria-label="正在載入案件看板" className="space-y-4">
      <div className="h-12 w-full max-w-sm animate-pulse rounded-md" style={{ background: 'var(--border-subtle)' }} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-lg" style={{ background: 'var(--surface)' }} />)}
      </div>
      <div className="h-56 animate-pulse rounded-lg" style={{ background: 'var(--surface)' }} />
    </div>
  )
}
