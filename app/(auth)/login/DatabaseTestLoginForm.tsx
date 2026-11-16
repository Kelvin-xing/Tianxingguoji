'use client'

import { useRef, useState, type FormEvent } from 'react'

import { Button, Input } from '@/components/ui/standard'
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
      <Input label="帳戶電郵"
        id="email"
        name="email"
        type="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
      />

      <Input label="密碼"
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />

      <Button
        variant="primary"
        type="submit"
        disabled={pending}
        aria-busy={pending}
      >
        <span className="inline-flex min-w-28 items-center justify-center gap-2" aria-live="polite">
          <Icon name={pending ? 'clock' : 'log-in'} size={16} />
          {pending ? '登入中…' : '登入工作台'}
        </span>
      </Button>
    </form>
  )
}
