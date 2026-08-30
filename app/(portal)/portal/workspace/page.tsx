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
        setWorkspace(value)
        setState(value.schools.length + value.action_items.length + value.messages.length === 0 ? 'empty' : 'ready')
      }).catch((error) => { if (!controller.signal.aborted) setState(error instanceof Error && 'status' in error && (error as {status?: number}).status === 401 ? 'expired' : 'unavailable') })
    return () => controller.abort()
  }, [])

  async function signOut() { await logoutPortal(); router.replace('/portal/access') }
  if (state !== 'ready' && state !== 'empty') return <PortalState state={state} />
  if (!workspace) return <PortalState state="unavailable" />
  return (
    <main className="portal-shell portal-workspace">
      <header className="portal-workspace-header"><div><p className="portal-mark">案件進度</p><h1>{stageLabel(workspace.stage)}</h1><p className="portal-muted">更新時間：{formatDate(workspace.updated_at)}</p></div><button className="portal-secondary" onClick={signOut}>退出</button></header>
      {state === 'empty' && <section className="portal-panel"><h2>暫無新進度</h2><p className="portal-muted">顧問發布對客更新後會顯示在這裡。</p></section>}
      <section className="portal-grid">
        <PortalList title="已確認學校" items={workspace.schools.map((item) => `${item.name} · ${statusLabel(item.status)}`)} />
        <PortalList title="行動項目" items={workspace.action_items.map((item) => `${item.title}${item.deadline ? ` · ${formatDate(item.deadline)}` : ''} · ${item.completed ? '已完成' : '待處理'}`)} />
        <PortalList title="最新消息" items={workspace.messages.map((item) => `${item.body} · ${formatDate(item.published_at)}`)} />
      </section>
    </main>
  )
}

function PortalState({ state }: { state: Exclude<ViewState, 'ready' | 'empty'> }) { const copy = { loading: '正在載入案件進度…', denied: '目前沒有查看此案件的權限。', expired: '工作階段已失效，請重新輸入訪問密鑰。', unavailable: '案件門戶暫時無法使用。' }[state]; return <main className="portal-shell"><section className="portal-panel" aria-live="polite"><h1>{copy}</h1>{state === 'expired' && <a href="/portal/access">返回訪問頁</a>}</section></main> }
function PortalList({ title, items }: { title: string; items: string[] }) { return <section className="portal-panel"><h2>{title}</h2>{items.length === 0 ? <p className="portal-muted">暫無項目</p> : <ul className="portal-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>}</section> }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-HK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hong_Kong' }).format(new Date(value)) }

function stageLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    signed: '已簽約', background_collection: '背景資料收集', school_selection_confirmed: '選校已確認',
    interview_preparation: '面試準備', application_in_progress: '申請處理中', application_submitted: '已提交申請',
    awaiting_result: '等待結果', offer_confirmed: '錄取已確認', closed: '已結案',
  }
  return labels[value] ?? (/[\u3400-\u9fff]/.test(value) ? value : '案件進度')
}

function statusLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    candidate: '候選', preparing: '準備中', submitted: '已提交', interview: '面試中',
    accepted: '已錄取', rejected: '已拒絕', pending: '待處理', in_progress: '處理中',
  }
  return labels[value] ?? (/[\u3400-\u9fff]/.test(value) ? value : '處理中')
}
