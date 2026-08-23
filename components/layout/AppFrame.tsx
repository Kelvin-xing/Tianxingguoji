'use client'

import type { ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const isPublic = pathname === '/login' || pathname.startsWith('/login/') || pathname.startsWith('/auth')
  const isExternalPortal = pathname === '/portal' || pathname.startsWith('/portal/')
  const isVisualFixture = pathname === '/cases/__fixtures/workspace' &&
    process.env.NODE_ENV === 'development' &&
    process.env.NEXT_PUBLIC_CASE_WORKSPACE_VISUAL_FIXTURE === 'true'
  const bypassAuthForVisualFixture = isPublic || isExternalPortal || isVisualFixture
  const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'unauthenticated'>(
    bypassAuthForVisualFixture ? 'authenticated' : 'checking',
  )
  const [desktopNavigationOpen, setDesktopNavigationOpen] = useState(true)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)

  useEffect(() => {
    if (bypassAuthForVisualFixture) {
      return
    }

    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setAuthState('checking')
    })
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('unauthenticated')
        if (!cancelled) setAuthState('authenticated')
      })
      .catch(() => {
        if (!cancelled) {
          setAuthState('unauthenticated')
          router.replace('/login')
        }
      })

    return () => {
      cancelled = true
    }
  }, [bypassAuthForVisualFixture, router])

  if (isPublic || isExternalPortal) {
    return <main className="min-h-screen">{children}</main>
  }

  if (authState !== 'authenticated') {
    return (
      <main className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {authState === 'checking' ? '正在確認工作階段…' : '正在返回登入頁…'}
        </div>
      </main>
    )
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar
        desktopOpen={desktopNavigationOpen}
        mobileOpen={mobileNavigationOpen}
        onCloseDesktop={() => {
          setDesktopNavigationOpen(false)
          setMobileNavigationOpen(false)
        }}
        onCloseMobile={() => setMobileNavigationOpen(false)}
      />
      <div className="flex-1 flex flex-col min-w-0" style={{ background: 'var(--bg)' }}>
        <TopBar
          desktopNavigationOpen={desktopNavigationOpen}
          onOpenDesktopNavigation={() => {
            setDesktopNavigationOpen(true)
            setMobileNavigationOpen(false)
          }}
          onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
        />
        <main className="flex-1 overflow-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  )
}
