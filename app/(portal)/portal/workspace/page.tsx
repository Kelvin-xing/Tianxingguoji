'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getPortalWorkspace, logoutPortal, type PortalWorkspaceDto } from '@/components/portal/f5-client'

type ViewState = 'loading' | 'empty' | 'denied' | 'expired' | 'unavailable' | 'ready'
type Workspace = PortalWorkspaceDto

export default function PortalWorkspacePage() {
  const router = useRouter()
  const [state, setState] = useState<ViewState>('loading')
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    getPortalWorkspace()
      .then((value) => {
        if (value.status === 'paused' || value.status === 'closed') return setState('denied')
        if (value.status === 'expired' || value.status === 'revoked') return setState('expired')
        setWorkspace(value)
        setState(value.schools.length + value.applications.length + value.documents.length === 0 ? 'empty' : 'ready')
      }).catch((error) => { if (!controller.signal.aborted) setState(error instanceof Error && 'status' in error && (error as {status?: number}).status === 401 ? 'expired' : 'unavailable') })
    return () => controller.abort()
  }, [])

  async function signOut() { await logoutPortal(); router.replace('/portal/access') }
  if (state !== 'ready' && state !== 'empty') return <PortalState state={state} />
  if (!workspace) return <PortalState state="unavailable" />
  return (
    <main className="portal-shell portal-workspace">
      <header className="portal-workspace-header"><div><p className="portal-mark">案件進度</p><h1>{workspace.stage}</h1>{workspace.student && <p className="portal-muted">學生：{workspace.student.display_name}</p>}</div><button className="portal-secondary" onClick={signOut}>退出</button></header>
      {state === 'empty' && <section className="portal-panel"><h2>暫無新進度</h2><p className="portal-muted">顧問發布對客更新後會顯示在這裡。</p></section>}
      <section className="portal-grid">
        <PortalList title="已確認學校" items={workspace.schools.map((item) => `${item.name} · ${item.status}`)} />
        <PortalList title="申請狀態" items={workspace.applications.map((item) => `${item.school_name} · ${item.status}`)} />
        <PortalList title="已發布文件" items={workspace.documents.map((item) => `${item.name} · ${formatDate(item.published_at)}`)} />
      </section>
    </main>
  )
}

function PortalState({ state }: { state: Exclude<ViewState, 'ready' | 'empty'> }) { const copy = { loading: '正在載入案件進度…', denied: '目前沒有查看此案件的權限。', expired: '工作階段已失效，請重新輸入訪問密鑰。', unavailable: '案件門戶暫時無法使用。' }[state]; return <main className="portal-shell"><section className="portal-panel" aria-live="polite"><h1>{copy}</h1>{state === 'expired' && <a href="/portal/access">返回訪問頁</a>}</section></main> }
function PortalList({ title, items }: { title: string; items: string[] }) { return <section className="portal-panel"><h2>{title}</h2>{items.length === 0 ? <p className="portal-muted">暫無項目</p> : <ul className="portal-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>}</section> }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-HK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hong_Kong' }).format(new Date(value)) }
