import { Icon } from '@/components/workspace/Icon'

type LoginPageProps = {
  searchParams: Promise<{ error?: string | string[] | undefined }>
}

const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  access_denied: '登入驗證未完成，請重新嘗試或聯絡管理員。',
  access_disabled: '此公司帳戶目前已停用。',
  authentication_failed: '登入驗證失敗，請重新嘗試或聯絡管理員。',
  configuration: '登入服務尚未完成部署設定，請聯絡管理員。',
  email_not_verified: '此公司帳戶的電郵尚未驗證。',
  invalid_callback: '登入連結已失效，請重新開始登入。',
  logout_pending: '登出請求尚未完全確認，請稍後重新登入。',
  not_invited: '此帳戶尚未獲邀加入工作台。',
  session_limit: '目前登入工作階段已達上限，請先登出其他裝置。',
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams
  const errorCode = typeof query.error === 'string' ? query.error : undefined
  const errorMessage = errorCode
    ? LOGIN_ERROR_MESSAGES[errorCode] ?? '登入流程未完成，請重新嘗試或聯絡管理員。'
    : undefined

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_.95fr]" style={{ background: 'var(--bg)' }}>
      <div className="hidden lg:flex flex-col justify-between p-12 xl:p-16" style={{ background: 'var(--sidebar-bg)', color: '#fff' }}>
        <div><div className="flex items-center gap-3"><div className="w-9 h-9 rounded-md flex items-center justify-center" style={{ background: 'var(--sidebar-active)' }}><Icon name="sparkles" size={18} /></div><div><div className="font-semibold">天星顧問</div><div className="text-xs" style={{ color: 'var(--sidebar-text-muted)' }}>Case workspace</div></div></div><div className="max-w-md mt-24"><div className="eyebrow" style={{ color: '#93c5fd' }}>Internal operations</div><h1 className="text-4xl font-semibold leading-tight mt-3">把每一個案件，<br />變成可協作的工作面。</h1><p className="mt-5 text-sm leading-7" style={{ color: 'var(--sidebar-text)' }}>從 Student 360 到 ServiceCase、學校目標、文件與任務，所有需要判斷的資訊放在同一個 context。</p></div></div>
        <div className="text-xs" style={{ color: 'var(--sidebar-text-muted)' }}>Release 1 · Cognito invite-only access</div>
      </div>
      <div className="flex items-center justify-center p-6 sm:p-10"><div className="w-full max-w-md"><div className="lg:hidden flex items-center gap-3 mb-12"><div className="w-9 h-9 rounded-md flex items-center justify-center" style={{ background: 'var(--sidebar-active)', color: '#fff' }}><Icon name="sparkles" size={18} /></div><div><div className="font-semibold" style={{ color: 'var(--text-primary)' }}>天星顧問</div><div className="text-xs" style={{ color: 'var(--text-muted)' }}>Case workspace</div></div></div><div className="mb-8"><div className="eyebrow">Company access</div><h2 className="text-2xl font-semibold mt-2" style={{ color: 'var(--text-primary)' }}>登入工作台</h2><p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>使用管理員邀請的公司帳戶登入。案件與學生資料只會在你的 organization scope 內顯示。</p></div>{errorMessage && <div className="form-error mb-4" role="alert"><Icon name="shield" size={15} /><span>{errorMessage}</span></div>}<a href="/api/auth/login" className="primary-button w-full justify-center"><Icon name="log-in" size={16} />使用公司帳戶登入</a><div className="mt-8 flex items-start gap-2 text-xs leading-5" style={{ color: 'var(--text-muted)' }}><Icon name="shield" size={15} className="shrink-0 mt-0.5" />登入由 Cognito Managed Login 處理；應用程式只使用香港 runtime 管理的 opaque session。</div></div></div>
    </div>
  )
}
