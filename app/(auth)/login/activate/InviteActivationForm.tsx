'use client'

import { useEffect, useState } from 'react'

export function InviteActivationForm() {
  const [credential, setCredential] = useState<string | null>(null)

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token')
    const timer = window.setTimeout(() => {
      setCredential(token && /^v1\.[A-Za-z0-9._-]+$/.test(token) ? token : '')
    }, 0)
    if (token) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    return () => window.clearTimeout(timer)
  }, [])

  if (credential === null) return <p className="section-detail">正在讀取邀請資料。</p>
  if (credential === '') return <p className="form-error" role="alert">確認連結無效，請使用邀請郵件內的完整連結。</p>

  return <form action="/api/v1/auth/invite-activations" method="post" className="space-y-4">
    <input type="hidden" name="activation_credential" value={credential} />
    <label className="block text-sm font-medium" htmlFor="display_name">暱稱</label>
    <input className="w-full" id="display_name" name="display_name" type="text" maxLength={100} autoComplete="nickname" required />
    <label className="block text-sm font-medium" htmlFor="password">設定密碼</label>
    <input className="w-full" id="password" name="password" type="password" minLength={8} maxLength={256} autoComplete="new-password" required />
    <label className="block text-sm font-medium" htmlFor="password_confirmation">確認密碼</label>
    <input className="w-full" id="password_confirmation" name="password_confirmation" type="password" minLength={8} maxLength={256} autoComplete="new-password" required />
    <button className="primary-button w-full justify-center" type="submit">啟用帳戶</button>
  </form>
}
