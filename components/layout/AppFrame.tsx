'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import '@/components/ui/standard.css'
import { TopBar } from '@/components/layout/TopBar'
import { Card, Notice, Button } from '@/components/ui/standard'
import { ApiClientError, requestApi } from '@/lib/api/client'
import {
  capabilityForPath,
  defaultWorkspacePath,
  decodeWorkspaceAuth,
  hasWorkspaceCapability,
  isReleaseOneInternalRole,
  type WorkspaceAuthDto,
} from '@/components/layout/workspace-navigation'

type AuthState =
  | { readonly status: 'checking' }
  | { readonly status: 'authenticated'; readonly auth: WorkspaceAuthDto }
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'unavailable'; readonly requestId: string | null }

const EXCLUDED_INTERNAL_PREFIXES = ['/platform/billing', '/admin/crawler']

export function AppFrame({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const isPublic = pathname === '/login' || pathname.startsWith('/login/') || pathname.startsWith('/auth')
  const isExternalPortal = pathname === '/portal' || pathname.startsWith('/portal/')
  const isVisualFixture = pathname === '/cases/__fixtures/workspace' && process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_CASE_WORKSPACE_VISUAL_FIXTURE === 'true'
  const bypassAuth = isPublic || isExternalPortal || isVisualFixture
  const [authState, setAuthState] = useState<AuthState>(() => bypassAuth
    ? { status: 'authenticated', auth: null as unknown as WorkspaceAuthDto }
    : { status: 'checking' })

  useEffect(() => {
    if (bypassAuth) {
      setAuthState({ status: 'authenticated', auth: null as unknown as WorkspaceAuthDto })
      return
    }

    const controller = new AbortController()
    setAuthState({ status: 'checking' })
    requestApi({ path: '/api/v1/auth/me', signal: controller.signal }, decodeWorkspaceAuth)
      .then((auth) => {
        setAuthState({ status: 'authenticated', auth })
        if (pathname === '/') router.replace(defaultWorkspacePath(auth.capabilities))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiClientError && (error.status === 401 || error.code === 'UNAUTHENTICATED')) {
          setAuthState({ status: 'unauthenticated' })
          router.replace('/login')
          return
        }
        setAuthState({ status: 'unavailable', requestId: error instanceof ApiClientError ? error.requestId : null })
      })
    return () => controller.abort()
  }, [bypassAuth, pathname, router])


  if (isPublic || isExternalPortal) return <main className="min-h-screen">{children}</main>

  if (authState.status === 'checking') {
    return <main className="ui-shell ui-centered-state"><ShellState title="正在確認工作階段" detail="正在讀取目前身份與可用工作區。" /></main>
  }
  if (authState.status === 'unauthenticated') {
    return <main className="ui-shell ui-centered-state"><ShellState warning title="工作階段已失效" detail="請重新登入後繼續。" action={<Link className="ui-button ui-primary" href="/login">返回登入</Link>} /></main>
  }
  if (authState.status === 'unavailable') {
    return <main className="ui-shell ui-centered-state"><ShellState warning title="工作台暫時無法使用" detail="目前無法確認你的工作階段，請稍後重試。" requestId={authState.requestId} onRetry={() => window.location.reload()} /></main>
  }

  const auth = authState.auth
  if (!isVisualFixture && !isReleaseOneInternalRole(auth.role)) {
    return <main className="ui-shell ui-centered-state"><ShellState warning title="目前帳號無法進入工作台" detail="目前帳號沒有工作台權限。" action={<Link className="ui-button ui-primary" href="/login">返回登入</Link>} /></main>
  }
  if (!isVisualFixture && EXCLUDED_INTERNAL_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return <main className="ui-shell ui-centered-state"><ShellState warning title="目前無法使用此入口" detail="請返回工作台。" action={<Link className="ui-button ui-primary" href={defaultWorkspacePath(auth.capabilities)}>返回工作台</Link>} /></main>
  }

  const requiredCapability = capabilityForPath(pathname)
  if (!isVisualFixture && requiredCapability && !hasWorkspaceCapability(auth.capabilities, requiredCapability)) {
    const contractor = hasWorkspaceCapability(auth.capabilities, 'tasks.read') && !hasWorkspaceCapability(auth.capabilities, 'today.read')
    return <main className="ui-shell ui-centered-state"><ShellState warning title="目前帳號無法查看此工作區" detail={contractor ? 'Contractor 只能處理目前分派的任務。' : '目前帳號沒有此工作區的權限。'} action={contractor ? <Link className="ui-button ui-primary" href="/tasks">返回我的任務</Link> : undefined} /></main>
  }

  return (
    <div className="ui-shell">
      <TopBar auth={auth} />
      <main className="ui-content">{children}</main>
    </div>
  )
}

function ShellState({ title, detail, warning = false, action, requestId, onRetry }: {
  title: string; detail: string; warning?: boolean; action?: ReactNode; requestId?: string | null; onRetry?: () => void;
}) {
  return <Card title={title}><Notice warning={warning}>{detail}</Notice>
    {requestId && <p className="ui-muted">{requestId}</p>}
    {action}{onRetry && <Button onClick={onRetry}>重新載入</Button>}
  </Card>
}
