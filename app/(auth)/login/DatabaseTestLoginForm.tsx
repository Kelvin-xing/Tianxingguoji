'use client'

import { useRef, useState, type FormEvent } from 'react'

import { Icon } from '@/components/workspace/Icon'

export function DatabaseTestLoginForm() {
  const submissionLocked = useRef(false)
  const [pending, setPending] = useState(false)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (submissionLocked.current) {
      event.preventDefault()
      return
    }

    submissionLocked.current = true
    setPending(true)
  }

  return (
    <form
      action="/api/v1/auth/login"
      method="post"
      encType="application/x-www-form-urlencoded"
      className="space-y-4"
      onSubmit={handleSubmit}
    >
      <div className="field-label">
        <label htmlFor="email">測試帳號電郵</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </div>

      <div className="field-label">
        <label htmlFor="password">密碼</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <button
        className="primary-button w-full justify-center"
        type="submit"
        disabled={pending}
        aria-busy={pending}
      >
        <span className="inline-flex min-w-28 items-center justify-center gap-2" aria-live="polite">
          <Icon name={pending ? 'clock' : 'log-in'} size={16} />
          {pending ? '登入中…' : '登入測試工作台'}
        </span>
      </button>
    </form>
  )
}
