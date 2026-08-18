'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

type ViewState = 'loading' | 'empty' | 'denied' | 'expired' | 'unavailable' | 'ready'
interface Workspace { case_number: string; customer_facing_stage: string; last_customer_visible_update_at: string; school_targets: { name: string; status: string }[]; action_items: { title: string; deadline: string | null; completed: boolean }[]; messages: { body: string; published_at: string }[] }

export default function PortalWorkspacePage() {
  const router = useRouter()
  const [state, setState] = useState<ViewState>('loading')
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/v1/portal/workspace', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) return setState('expired')
        if (response.status === 403) return setState('denied')
        if (response.status === 503) return setState('unavailable')
        if (!response.ok) return setState('unavailable')
        const value = await response.json() as Workspace
        setWorkspace(value)
        setState(value.school_targets.length + value.action_items.length + value.messages.length === 0 ? 'empty' : 'ready')
      }).catch(() => { if (!controller.signal.aborted) setState('unavailable') })
    return () => controller.abort()
  }, [])

  async function signOut() { await fetch('/api/v1/portal/sessions', { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' }); router.replace('/portal/access') }
  if (state !== 'ready' && state !== 'empty') return <PortalState state={state} />
  if (!workspace) return <PortalState state="unavailable" />
  return (
    <main className="portal-shell portal-workspace">
      <header className="portal-workspace-header"><div><p className="portal-mark">案件 {workspace.case_number}</p><h1>{workspace.customer_facing_stage}</h1><p className="portal-muted">最近更新：{formatDate(workspace.last_customer_visible_update_at)}</p></div><button className="portal-secondary" onClick={signOut}>退出</button></header>
      {state === 'empty' && <section className="portal-panel"><h2>暫無新進度</h2><p className="portal-muted">顧問發布對客更新後會顯示在這裡。</p></section>}
      <section className="portal-grid">
        <PortalList title="學校進度" items={workspace.school_targets.map((item) => `${item.name} · ${item.status}`)} />
        <PortalList title="待辦事項" items={workspace.action_items.map((item) => `${item.completed ? '已完成' : '待處理'} · ${item.title}${item.deadline ? ` · ${item.deadline}` : ''}`)} />
        <PortalList title="最新消息" items={workspace.messages.map((item) => `${formatDate(item.published_at)} · ${item.body}`)} />
      </section>
    </main>
  )
}

function PortalState({ state }: { state: Exclude<ViewState, 'ready' | 'empty'> }) { const copy = { loading: '正在載入案件進度…', denied: '目前沒有查看此案件的權限。', expired: '工作階段已失效，請重新輸入訪問密鑰。', unavailable: '案件門戶暫時無法使用。' }[state]; return <main className="portal-shell"><section className="portal-panel" aria-live="polite"><h1>{copy}</h1>{state === 'expired' && <a href="/portal/access">返回訪問頁</a>}</section></main> }
function PortalList({ title, items }: { title: string; items: string[] }) { return <section className="portal-panel"><h2>{title}</h2>{items.length === 0 ? <p className="portal-muted">暫無項目</p> : <ul className="portal-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>}</section> }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-HK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hong_Kong' }).format(new Date(value)) }
