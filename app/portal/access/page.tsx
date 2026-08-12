'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'

type AccessState = 'empty' | 'loading' | 'denied' | 'expired' | 'unavailable'

export default function PortalAccessPage() {
  const router = useRouter()
  const [accessKey, setAccessKey] = useState('')
  const [state, setState] = useState<AccessState>('empty')

  async function redeem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setState('loading')
    try {
      const response = await fetch('/api/v1/portal/sessions', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_key: accessKey }),
      })
      setAccessKey('')
      if (response.ok) return router.replace('/portal/workspace')
      if (response.status === 401) return setState('expired')
      if (response.status === 503) return setState('unavailable')
      setState('denied')
    } catch { setState('unavailable') }
  }

  return (
    <main className="portal-shell">
      <section className="portal-panel" aria-labelledby="portal-access-title">
        <p className="portal-mark">天星案件門戶</p>
        <h1 id="portal-access-title">查看案件進度</h1>
        <p className="portal-muted">輸入顧問提供的訪問密鑰。密鑰不會加入網址或保存在此裝置。</p>
        <form onSubmit={redeem} className="portal-form">
          <label htmlFor="portal-access-key">訪問密鑰</label>
          <input id="portal-access-key" type="password" autoComplete="off" required minLength={16} value={accessKey} onChange={(event) => setAccessKey(event.target.value)} />
          <button type="submit" disabled={state === 'loading'}>{state === 'loading' ? '正在驗證…' : '進入案件門戶'}</button>
        </form>
        <div aria-live="polite" className="portal-state">
          {state === 'expired' && '密鑰無效或已失效，請向顧問索取新的密鑰。'}
          {state === 'denied' && '目前無法使用此案件門戶。'}
          {state === 'unavailable' && '案件門戶暫時無法使用，請稍後再試。'}
        </div>
      </section>
    </main>
  )
}
